import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ROOT } from "../runtime.ts";
import { Builder, BuildError } from "./build.ts";
import { diffUnits, scopeViolations } from "./changes.ts";
import { isFigure } from "./config.ts";
import { now, readJson, writeJson } from "./files.ts";
import { runAsync } from "./process.ts";
import type { App } from "../server.ts";
import type {
  Job,
  JobResult,
  RenderedRound,
  RenderRequest,
  Round,
} from "../types.ts";
export class PublishError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
    public next = "",
    public log?: string,
  ) {
    super(message);
  }
}
class Stale extends Error {}
export async function render(output: string, request: RenderRequest) {
  const file = path.join(output, "request.json");
  writeJson(file, request);
  try {
    await runAsync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "src/render/worker.ts"), file],
      { cwd: ROOT, timeout: 1200000 },
    );
  } catch (error) {
    throw new PublishError(
      "Rendering the PDF comparison failed.",
      [
        (error as Error).message,
        ...String((error as { stderr?: Buffer }).stderr ?? "")
          .trim()
          .split("\n")
          .slice(-12),
      ],
      "Fix the renderer error, then publish again.",
    );
  }
  fs.rmSync(file, { force: true });
}
export class Publisher {
  private pruning: Promise<void> | null = null;
  pending = new Map<string, string>();
  running = new Map<string, Promise<void>>();
  queue: string[] = [];
  stopping = false;
  constructor(public app: App) {
    app.store.execute(
      "UPDATE jobs SET status='failed', finished=?, result=? WHERE status IN ('queued','running')",
      now(),
      JSON.stringify({
        error: "The review server restarted during the build.",
        next: "Publish again.",
      }),
    );
  }
  submit(name: string) {
    this.app.tasks.get(name);
    if (this.stopping)
      throw new Error(
        "The review server is stopping. Publish again after it restarts.",
      );
    const current = this.pending.get(name);
    if (current) {
      const job = this.job(current);
      if (job.status === "queued") return job;
    }
    const id = randomBytes(8).toString("hex");
    this.app.store.execute(
      "INSERT INTO jobs(id,task,status,created) VALUES(?,?,'queued',?)",
      id,
      name,
      now(),
    );
    this.pending.set(name, id);
    if (!this.running.has(name)) this.queue.push(id);
    queueMicrotask(() => this.drain());
    return this.job(id);
  }
  job(id: string) {
    const job = this.app.store.one<Job>("SELECT * FROM jobs WHERE id=?", id);
    if (!job) throw new Error("Unknown job " + id);
    return job;
  }
  current(name: string) {
    return this.app.store.one<Job>(
      "SELECT * FROM jobs WHERE task=? ORDER BY created DESC,rowid DESC LIMIT 1",
      name,
    );
  }
  busy(name?: string) {
    return name ? this.pending.has(name) : this.pending.size > 0;
  }
  ahead(job: Job) {
    return this.app.store.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') AND created<?",
      job.created,
    )!.n;
  }
  update(
    id: string,
    fields: Partial<Pick<Job, "phase" | "status" | "finished">> & {
      result?: JobResult;
    },
  ) {
    const entries = Object.entries(fields);
    this.app.store.execute(
      "UPDATE jobs SET " +
        entries.map(([key]) => key + "=?").join(",") +
        " WHERE id=?",
      ...entries.map(([key, value]) =>
        key === "result" ? JSON.stringify(value) : (value as string | number),
      ),
      id,
    );
  }
  stop() {
    this.stopping = true;
  }
  async join() {
    await Promise.resolve();
    while (this.running.size || this.pruning)
      await Promise.allSettled([
        ...this.running.values(),
        ...(this.pruning ? [this.pruning] : []),
      ]);
  }
  private drain() {
    if (this.pruning) return;
    while (
      !this.stopping &&
      this.queue.length &&
      this.running.size < this.app.project.build_workers
    ) {
      const id = this.queue.shift()!,
        job = this.job(id);
      this.update(id, { status: "running" });
      const promise = Promise.resolve().then(() => this.work(job));
      this.running.set(job.task, promise);
    }
  }
  private async work(job: Job) {
    try {
      let result: JobResult;
      for (;;) {
        try {
          result = await this.publish(job);
          break;
        } catch (error) {
          if (!(error instanceof Stale)) throw error;
          if (this.stopping)
            throw new Error("Server stopped during publication.");
        }
      }
      this.update(job.id, { status: "done", result, finished: now() });
    } catch (error) {
      const result: JobResult =
        error instanceof PublishError
          ? {
              error: error.message,
              details: error.details,
              next: error.next,
              ...(error.log ? { log: error.log } : {}),
            }
          : { error: (error as Error).message, next: "Publish again." };
      this.update(job.id, { status: "failed", result, finished: now() });
    } finally {
      this.running.delete(job.task);
      if (this.pending.get(job.task) === job.id) this.pending.delete(job.task);
      else if (!this.stopping) this.queue.push(this.pending.get(job.task)!);
      this.drain();
      if (!this.pending.size && !this.stopping) await this.pruneCache();
    }
  }
  async publish(job: Pick<Job, "id" | "task">): Promise<JobResult> {
    const app = this.app,
      name = job.task,
      project = app.project;
    let task = app.tasks.get(name);
    if (!fs.existsSync(task.worktree))
      throw new PublishError(
        `The task worktree ${task.worktree} no longer exists.`,
        [],
        "Run `finish --force`, then start a new task.",
      );
    this.update(job.id, { phase: "snapshot" });
    const after = app.tasks.snapshot(task);
    task = app.tasks.get(name);
    const before = task.accepted,
      latest = app.review.latestRound(name),
      decided = app.review.lastChange(name),
      violations = scopeViolations(app.repo, task.base, after, task.scope);
    if (violations.length)
      throw new PublishError(
        "Some edits are outside the task scope: " +
          violations.slice(0, 10).join(", "),
        [
          "Allowed: " +
            (task.scope.sections.length
              ? task.scope.sections.map((s) => `${s.number} ${s.title}`)
              : task.scope.paths
            ).join(", "),
        ],
        "Undo edits outside the scope, then publish again.",
      );
    if (
      latest &&
      latest.before === before &&
      app.repo.treeId(latest.after) === app.repo.treeId(after)
    )
      return {
        outcome: "unchanged",
        round: latest.number,
        changes: latest.units.length,
      };
    const files = app.repo.changedFiles(before, after);
    if (!files.length) return { outcome: "empty", round: null, changes: 0 };
    const units = diffUnits(app.repo, before, after, (f) =>
      isFigure(project, f),
    );
    this.update(job.id, { phase: "build" });
    const builder = new Builder(project, app.repo),
      targets = builder.plan(before, after, files);
    let seed = null,
      old,
      next;
    try {
      seed = targets[0] !== "full" ? await builder.build(task.base) : null;
      old = await builder.build(before, targets, seed);
    } catch (error) {
      if (error instanceof BuildError)
        throw new PublishError(
          "The accepted text does not compile, so there is nothing to compare against.",
          error.details,
          "Fix the accepted document or undo the change that broke it, then publish again.",
          error.log,
        );
      throw error;
    }
    try {
      next = await builder.build(after, targets, seed);
    } catch (error) {
      if (error instanceof BuildError)
        throw new PublishError(
          "Your edits do not compile.",
          error.details,
          "Fix the LaTeX errors in the worktree, then publish again.",
          error.log,
        );
      throw error;
    }
    if (app.review.lastChange(name) !== decided) throw new Stale();
    const warnings = next.warnings.filter((w) => !old.warnings.includes(w));
    this.update(job.id, { phase: "render" });
    const number = (latest?.number ?? 0) + 1,
      rounds = path.join(app.state, "rounds", name),
      final = path.join(rounds, String(number).padStart(3, "0")),
      output = final + ".pending-" + randomBytes(4).toString("hex");
    fs.mkdirSync(output, { recursive: true });
    const summary = {
      warnings,
      targets,
      builds: [seed, old, next].filter((b) => b !== null).map((b) => b.key),
    };
    try {
      await render(output, {
        main: project.main,
        source_dir: project.source_dir,
        figures: project.figures,
        old,
        new: next,
        units,
      });
      if (app.review.lastChange(name) !== decided) throw new Stale();
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(output, final);
      app.store.execute(
        "INSERT INTO rounds(task,number,before,after,units,summary,created) VALUES(?,?,?,?,?,?,?)",
        name,
        number,
        before,
        after,
        JSON.stringify(units),
        JSON.stringify(summary),
        now(),
      );
      app.repo.updateRef(`refs/latex-review/${name}/round-${number}`, after);
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
    const visual = readJson<RenderedRound>(path.join(final, "round.json"), {
        units: {},
        sections: [],
        loose: [],
      }),
      kinds: Record<string, number> = {};
    for (const unit of Object.values(visual.units))
      kinds[unit.visual] = (kinds[unit.visual] ?? 0) + 1;
    return {
      outcome: "published",
      round: number,
      changes: units.length,
      kinds,
      warnings,
    };
  }
  async pruneCache() {
    if (this.pruning) return this.pruning;
    if (this.busy()) return;
    const keep = new Set(
      this.app.store
        .all<Pick<Round, "summary">>(
          "SELECT summary FROM rounds JOIN tasks ON rounds.task=tasks.name WHERE tasks.closed IS NULL",
        )
        .flatMap((r) => r.summary.builds ?? []),
    );
    this.pruning = new Builder(this.app.project, this.app.repo).prune(keep);
    try {
      await this.pruning;
    } catch (error) {
      console.error("Build cache cleanup:", error);
    } finally {
      this.pruning = null;
      this.drain();
    }
  }
}
