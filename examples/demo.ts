import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { Repo } from "../src/core/git.ts";
import { connect, type Client } from "../src/client.ts";
import { sleep } from "../src/core/files.ts";
import type { TaskInfo, JobResult } from "../src/types.ts";
const here = path.dirname(fileURLToPath(import.meta.url));
export interface DemoPlan {
  task: string;
  title: string;
  section: string;
  edits: { file: string; old: string; new: string }[];
}
export function prepareDemo(base: string) {
  const root = path.join(base, "example-paper");
  if (fs.existsSync(root))
    throw new Error(`${root} already exists; choose another --dir.`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(here, "paper"), path.join(root, "paper"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    "*.aux\n*.log\n*.pdf\n*.synctex.gz\n*.fdb_latexmk\n*.fls\n*.out\n",
  );
  const repo = new Repo(root);
  repo.run(["init", "-q"]);
  repo.run(["add", "."]);
  repo.run([
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@localhost",
    "commit",
    "-qm",
    "Example paper",
  ]);
  return {
    root,
    plan: JSON.parse(
      fs.readFileSync(path.join(here, "agent-edits.json"), "utf8"),
    ) as DemoPlan,
  };
}
export function applyDemo(worktree: string, plan: DemoPlan) {
  for (const edit of plan.edits) {
    const file = path.join(worktree, edit.file),
      text = fs.readFileSync(file, "utf8");
    if (!text.includes(edit.old))
      throw new Error(`Edit not applicable: ${edit.file}`);
    fs.writeFileSync(file, text.replace(edit.old, edit.new));
  }
}
export async function waitJob(client: Client, id: string) {
  for (;;) {
    const result = await client.get<JobResult & { status: string }>(
      "/api/jobs/" + id,
    );
    if (result.status === "done") return result;
    if (result.status === "failed") throw new Error(JSON.stringify(result));
    await sleep(250);
  }
}
async function main() {
  const options = new Command()
      .option("--dir <directory>")
      .option("--no-open")
      .parse()
      .opts<{ dir?: string; open: boolean }>(),
    base = options.dir
      ? path.resolve(options.dir)
      : fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-demo-")),
    { root, plan } = prepareDemo(base),
    client = await connect(root);
  const task = await client.post<TaskInfo>("/api/tasks", {
    name: plan.task,
    title: plan.title,
    sections: [plan.section],
  });
  applyDemo(task.worktree, plan);
  console.log("Compiling both versions…");
  const job = await client.post<{ job: string }>(
      `/api/tasks/${task.task}/publish`,
    ),
    result = await waitJob(client, job.job);
  console.log(
    `Round ${result.round}: ${result.changes} changes ready at\n\n${task.url}\n\nRepository: ${root}\nWorktree: ${task.worktree}\nCopy PDF text with your usual copy shortcut, or use Copy reference for file/line/page context.`,
  );
  if (options.open) {
    const { spawn } = await import("node:child_process");
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [task.url], {
      stdio: "ignore",
    }).on("error", () => {});
  }
  console.log(
    `\nClean up:\nnode scripts/review.mjs --repo ${root} --task ${task.task} finish --force\nnode scripts/review.mjs --repo ${root} server stop`,
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
