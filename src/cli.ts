import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Command, CommanderError } from "commander";
import { ROOT } from "./runtime.ts";
import {
  Client,
  connect,
  serverHome,
  stop,
  type ServerInfo,
} from "./client.ts";
import { atomicWrite, sleep } from "./core/files.ts";
import { run, which } from "./core/process.ts";
import { taskMarker } from "./core/tasks.ts";
import { ENGINES } from "./core/config.ts";
import type { Feedback, JobResult, Summary, PageState } from "./types.ts";
interface Info extends Summary {
  worktree: string;
  url: string;
  viewing: boolean;
}
class Failure extends Error {
  constructor(public payload: { error: string; [key: string]: unknown }) {
    super(payload.error);
  }
}
export const emit = (value: unknown) => console.log(JSON.stringify(value));
function openBrowser(url: string) {
  const child = spawn(
    process.platform === "darwin" ? "open" : "xdg-open",
    [url],
    { detached: true, stdio: "ignore" },
  );
  child.on("error", () => {});
  child.unref();
}
export async function doctor() {
  const texHint =
    process.platform === "darwin"
      ? "Install MacTeX, or BasicTeX with latexmk."
      : "Install TeX Live, e.g. apt install latexmk texlive-latex-recommended.";
  const checks: { name: string; ok: boolean; detail: string; hint?: string }[] =
    [];
  const check = (name: string, ok: boolean, detail: string, hint: string) =>
    checks.push({ name, ok, detail, ...(ok ? {} : { hint }) });
  check(
    "platform",
    process.platform !== "win32",
    process.platform,
    "Use macOS, Linux or WSL.",
  );
  check(
    "node",
    Number(process.versions.node.split(".")[0]) > 22 ||
      (Number(process.versions.node.split(".")[0]) === 22 &&
        Number(process.versions.node.split(".")[1]) >= 22),
    process.version,
    "Install Node.js 22.22 or newer.",
  );
  for (const tool of ["git", "latexmk", "synctex"]) {
    const binary = which(tool);
    check(
      tool,
      Boolean(binary),
      binary
        ? run(binary, ["--version"], { check: false })
            .stdout.toString()
            .split("\n")[0]
            .slice(0, 80)
        : "not found",
      tool === "git" ? "Install Git." : texHint,
    );
  }
  const engines = ENGINES.filter((e) => which(e));
  check(
    "tex engines",
    Boolean(engines.length),
    engines.join(", ") || "none found",
    texHint,
  );
  try {
    const mupdf = await import("mupdf");
    const doc = new mupdf.PDFDocument();
    doc.destroy();
    check("pdf renderer", true, "MuPDF WebAssembly", "");
  } catch (error) {
    check(
      "pdf renderer",
      false,
      (error as Error).message,
      "Run npm ci in the skill folder.",
    );
  }
  check(
    "review UI",
    fs.existsSync(path.join(ROOT, "dist/web/index.html")),
    fs.existsSync(path.join(ROOT, "dist/web/index.html"))
      ? "React production build ready"
      : "not built",
    "Run npm run build in the skill folder.",
  );
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checks,
    next: ok
      ? `Ready. Try the example with npm --prefix ${ROOT} run demo -- --no-open.`
      : "Fix the failed checks, then run doctor again.",
  };
}
async function context(command: Command, requireTask = false) {
  const options = command.optsWithGlobals<{ repo: string; task?: string }>(),
    [root, marker] = taskMarker(options.repo);
  if (options.task && marker && options.task !== marker)
    throw new Error(
      `This worktree belongs to task ${marker}; run other tasks from the main repository.`,
    );
  const task = options.task || marker;
  if (requireTask && !task)
    throw new Error("Run this inside a task worktree, or pass --task NAME.");
  return { root, task };
}
export async function feedback(
  client: Client,
  root: string,
  task: string,
  wait: number | null,
  all: boolean,
  output = emit,
) {
  const file = path.join(
      path.dirname(serverHome(root)),
      "agents",
      task + ".cursor",
    ),
    after = all
      ? 0
      : Number(
          fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() || 0 : 0,
        ),
    deadline = wait === null ? Infinity : Date.now() + wait * 1000;
  let value: Feedback;
  for (;;) {
    try {
      value = await client.get<Feedback>(
        `/api/tasks/${encodeURIComponent(task)}/feedback?after=${after}`,
      );
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error as Error).name === "TimeoutError"
      ) {
        await sleep(500);
        client = await connect(root);
        continue;
      }
      throw error;
    }
    if (
      value.feedback.some((i) => i.kind === "note") ||
      !["reviewing", "building"].includes(value.state) ||
      Date.now() >= deadline
    )
      break;
    await sleep(Math.min(1000, deadline - Date.now()));
  }
  const info = await client.get<Info>(`/api/tasks/${encodeURIComponent(task)}`);
  output({
    ...value,
    url: info.url,
    ...(wait && Date.now() >= deadline ? { waited: wait } : {}),
  });
  if (!all) atomicWrite(file, String(value.cursor));
}
export async function main(argv = process.argv) {
  const program = new Command()
    .name("latex-review")
    .description("Review LaTeX edits as selectable PDF diffs.")
    .option(
      "--repo <path>",
      "Document repository or task worktree",
      process.cwd(),
    )
    .option("--task <name>", "Task outside its worktree")
    .exitOverride();
  const collect = (value: string, previous: string[]) => [...previous, value];
  program.command("doctor").action(async () => {
    const result = await doctor();
    emit(result);
    if (!result.ok) process.exitCode = 1;
  });
  program
    .command("start [name]")
    .option(
      "--section <selector>",
      "Section number, title or label",
      collect,
      [],
    )
    .option("--file <path>", "Scoped file or folder", collect, [])
    .option("--title <text>")
    .option("--open")
    .action(
      async (
        name: string | undefined,
        options: {
          section: string[];
          file: string[];
          title?: string;
          open?: boolean;
        },
        command: Command,
      ) => {
        const { root, task } = await context(command);
        if (task && name && name !== task)
          throw new Error(
            `This worktree already belongs to task ${task}. Start new tasks from the main repository.`,
          );
        const client = await connect(root),
          info = task
            ? await client.get<Info>(`/api/tasks/${encodeURIComponent(task)}`)
            : await client.post<Info>("/api/tasks", {
                ...(name ? { name } : {}),
                ...(options.title ? { title: options.title } : {}),
                sections: options.section,
                files: options.file,
              });
        if (info.state === "editing")
          info.next = `Edit only inside ${info.worktree}, then run \`publish\` from there.`;
        if (options.open) openBrowser(info.url);
        emit(info);
      },
    );
  program
    .command("publish")
    .option("--no-wait")
    .option("--timeout <seconds>", "Seconds to wait", "900")
    .option("--open")
    .action(
      async (
        options: { wait: boolean; timeout: string; open?: boolean },
        command: Command,
      ) => {
        const { root, task } = await context(command, true),
          client = await connect(root),
          name = encodeURIComponent(task!),
          timeout = Number(options.timeout);
        if (!Number.isFinite(timeout) || timeout < 0)
          throw new Error("--timeout must be nonnegative.");
        const job = await client.post<{ job: string; status: string }>(
          `/api/tasks/${name}/publish`,
        );
        if (!options.wait) {
          emit({
            task,
            ...job,
            next: "The round is building. Run `status` or `publish` again later.",
          });
          return;
        }
        const deadline = Date.now() + timeout * 1000;
        let result: JobResult & { status: string; phase: string };
        for (;;) {
          result = await client.get(`/api/jobs/${job.job}`);
          if (["done", "failed"].includes(result.status)) break;
          if (Date.now() > deadline) {
            emit({
              task,
              job: job.job,
              status: "building",
              phase: result.phase,
              next: "Still building. Run `publish` again to keep waiting.",
            });
            return;
          }
          await sleep(500);
        }
        const info = await client.get<Info>(`/api/tasks/${name}`);
        if (result.status === "failed")
          throw new Failure({
            error: result.error || "Publish failed.",
            details: result.details ?? [],
            log: result.log,
            next: result.next,
          });
        emit({
          task,
          round: result.round,
          changes: result.changes,
          url: info.url,
          viewing: info.viewing,
          ...(result.outcome === "published"
            ? {
                kinds: result.kinds,
                warnings: result.warnings,
                next: `Share round ${result.round} with the user: ${info.url}. Keep this turn open and run \`feedback --wait\`; continue automatically when it returns.`,
              }
            : {
                message:
                  result.outcome === "unchanged"
                    ? `Nothing new since round ${result.round}.`
                    : "The worktree matches the accepted text; there is nothing to review.",
                next: info.next,
              }),
        });
        if (options.open && !info.viewing) openBrowser(info.url);
      },
    );
  program
    .command("feedback")
    .option(
      "--wait [seconds]",
      "Wait for completion or a message; optional timeout",
      "0",
    )
    .option("--all")
    .action(
      async (
        options: { wait: string | true; all?: boolean },
        command: Command,
      ) => {
        const { root, task } = await context(command, true),
          wait = options.wait === true ? null : Number(options.wait);
        if (
          wait !== null &&
          (!Number.isFinite(wait) || wait < 0 || wait > 3600)
        )
          throw new Error("--wait must be between 0 and 3600 seconds.");
        await feedback(
          await connect(root),
          root,
          task!,
          wait,
          Boolean(options.all),
        );
      },
    );
  program
    .command("accept [changes...]")
    .description(
      "Accept explicitly delegated changes without opening the browser",
    )
    .option("--all", "Accept every pending change in the latest round")
    .option("--round <number>", "Require this exact round")
    .action(
      async (
        changes: string[],
        options: { all?: boolean; round?: string },
        command: Command,
      ) => {
        if (options.all && changes.length)
          throw new Error("Use --all or a list of change IDs.");
        if (!options.all && !changes.length)
          throw new Error("Specify change IDs or --all.");
        const { root, task } = await context(command, true),
          client = await connect(root),
          route = `/api/tasks/${encodeURIComponent(task!)}`;
        const state = await client.get<PageState>(route + "/state");
        if (state.closed || !state.latest)
          throw new Error("There is no open published round to accept.");
        if (
          options.round !== undefined &&
          Number(options.round) !== state.latest
        )
          throw new Error(
            "A different round is current. Read status before accepting it.",
          );
        const chosen = options.all
          ? Object.keys(state.decisions).filter(
              (id) => state.decisions[id] === "pending",
            )
          : changes;
        const result = chosen.length
          ? await client.post<PageState>(route + "/decide", {
              action: "accept",
              round: state.latest,
              changes: chosen,
            })
          : state;
        emit({
          ...(await client.get<Info>(route)),
          accepted: chosen,
          changes: chosen.length,
          undo: result.undo,
          ...(chosen.length
            ? {}
            : { message: "No pending changes to accept." }),
        });
      },
    );
  program
    .command("undo")
    .description("Undo the latest decision, including a batch acceptance")
    .action(async (_options, command: Command) => {
      const { root, task } = await context(command, true),
        client = await connect(root),
        route = `/api/tasks/${encodeURIComponent(task!)}`;
      const state = await client.get<PageState>(route + "/state");
      if (!state.undo) throw new Error("There is no current decision to undo.");
      const result = await client.post<PageState & { restored: string[] }>(
        route + "/undo",
        { id: state.undo.id },
      );
      emit({
        ...(await client.get<Info>(route)),
        restored: result.restored,
        undo: result.undo,
      });
    });
  program.command("status").action(async (_options, command: Command) => {
    const { root, task } = await context(command, true);
    emit(
      await (
        await connect(root)
      ).get(`/api/tasks/${encodeURIComponent(task!)}`),
    );
  });
  program.command("list").action(async (_options, command: Command) => {
    const { root } = await context(command);
    const result = await (
      await connect(root)
    ).get<{ tasks: unknown[] }>("/api/tasks");
    emit({ tasks: result.tasks });
  });
  program
    .command("finish")
    .option("--force")
    .action(async (options: { force?: boolean }, command: Command) => {
      const { root, task } = await context(command, true),
        result = await (
          await connect(root)
        ).post<{ changed_files: string[] }>(
          `/api/tasks/${encodeURIComponent(task!)}/finish`,
          { force: Boolean(options.force) },
        );
      emit({
        ...result,
        next: result.changed_files.length
          ? `Accepted changes remain in ${root}, uncommitted. The task worktree was removed.`
          : "The task worktree was removed. No changes were accepted.",
      });
    });
  program
    .command("server <action>")
    .option("--force")
    .action(
      async (
        action: string,
        options: { force?: boolean },
        command: Command,
      ) => {
        const { root } = await context(command);
        if (action === "stop") {
          const stopped = await stop(root, Boolean(options.force));
          emit({ running: false, ...(stopped ? { stopped } : {}) });
        } else if (action === "status") {
          const client = await connect(root, false);
          if (!client) emit({ running: false });
          else {
            const { csrf: _token, ...info } =
              await client.get<ServerInfo>("/api/info");
            emit({ running: true, ...info });
          }
        } else throw new Error("Use server status or server stop.");
      },
    );
  program
    .command("serve", { hidden: true })
    .requiredOption("--root <path>")
    .option("--port <number>", "", "0")
    .option("--idle <seconds>", "", "43200")
    .action(async (options: { root: string; port: string; idle: string }) => {
      const { serve } = await import("./server.ts");
      await serve(options.root, Number(options.port), Number(options.idle));
    });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    emit(
      error instanceof Failure
        ? error.payload
        : { error: (error as Error).message },
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
