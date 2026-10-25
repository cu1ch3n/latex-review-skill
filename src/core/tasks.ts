import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Repo, cleanPath } from "./git.ts";
import { readJson, writeJson, now } from "./files.ts";
import { buildOutline, resolveSections, selectedRanges } from "./outline.ts";
import type { Task, Scope } from "../types.ts";
import type { App } from "../server.ts";
export const GENERATED = [
  ".aux",
  ".log",
  ".out",
  ".toc",
  ".lof",
  ".lot",
  ".loe",
  ".fls",
  ".fdb_latexmk",
  ".synctex.gz",
  ".bbl",
  ".blg",
  ".bcf",
  ".run.xml",
  ".xdv",
  ".dvi",
  ".nav",
  ".snm",
  ".vrb",
  ".idx",
  ".ilg",
  ".ind",
];
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
export function taskMarker(folder: string): [string, string | null] {
  const repo = new Repo(folder),
    marker = readJson<{ root: string; task: string } | null>(
      path.join(repo.gitDir(), "latex-review.json"),
      null,
    );
  return marker ? [marker.root, marker.task] : [repo.toplevel(), null];
}
export function revisionReader(repo: Repo, rev: string, folder: string) {
  const files = repo.files(rev, folder).filter((p) => p.endsWith(".tex")),
    blobs = repo.blobs(rev, files);
  return (file: string) => blobs[file]?.toString() ?? null;
}
export class Tasks {
  constructor(public app: App) {}
  get(name: string, openOnly = true): Task {
    const task = this.app.store.one<Task>(
      "SELECT * FROM tasks WHERE name=?",
      name,
    );
    if (!task || (openOnly && task.closed))
      throw new Error(`No open review task named ${JSON.stringify(name)}.`);
    return task;
  }
  list() {
    return this.app.store.all<Task>(
      "SELECT * FROM tasks WHERE closed IS NULL ORDER BY created",
    );
  }
  snapshot(task: Task) {
    return new Repo(task.worktree).snapshot(
      [this.app.project.source_dir, ...task.scope.paths],
      GENERATED,
    );
  }
  create(
    name?: string,
    title?: string,
    sections: string[] = [],
    files: string[] = [],
  ): Task {
    const { app } = this,
      project = app.project;
    if (sections.length && files.length)
      throw new Error("Choose sections or files for the scope, not both.");
    title = (title || name || "LaTeX review").trim().slice(0, 120);
    const explicit = Boolean(name);
    name ||= slug(title) || "review-" + randomBytes(3).toString("hex");
    if (!NAME.test(name))
      throw new Error(
        "Task names use lowercase letters, digits and hyphens (at most 64 characters).",
      );
    let candidate = name,
      suffix = 1;
    for (;;) {
      const existing = app.store.one<Task>(
        "SELECT * FROM tasks WHERE name=?",
        candidate,
      );
      if (!existing || existing.closed) break;
      if (this.matches(existing, sections, files)) return existing;
      if (explicit)
        throw new Error(
          `Task ${JSON.stringify(name)} already exists with a different scope. Finish it first or choose another name.`,
        );
      candidate = `${name.slice(0, 60)}-${++suffix}`;
    }
    name = candidate;
    if (!app.repo.hasHead())
      throw new Error(
        "The repository needs at least one commit before a review can start.",
      );
    if (
      app.repo.text(["for-each-ref", "--count=1", `refs/latex-review/${name}/`])
    )
      throw new Error(
        `Task name ${JSON.stringify(name)} is still used by another working tree.`,
      );
    const worktree = path.join(project.worktrees, name);
    if (fs.existsSync(worktree))
      throw new Error(
        `The folder ${worktree} already exists. Remove it or choose another name.`,
      );
    const paths = files.map(cleanPath),
      base = app.repo.snapshot([project.source_dir, ...paths], GENERATED);
    let scope: Scope;
    if (sections.length) {
      const outline = buildOutline(
        revisionReader(app.repo, base, project.doc_dir),
        project.main,
      );
      const [ranges, chosen] = selectedRanges(
        outline.nodes,
        resolveSections(outline.nodes, sections),
      );
      scope = { sections: chosen, ranges, paths: Object.keys(ranges).sort() };
    } else
      scope = {
        sections: [],
        ranges: null,
        paths: paths.length ? paths : [project.source_dir],
      };
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    app.repo.run(["worktree", "add", "--detach", worktree, base]);
    try {
      writeJson(path.join(new Repo(worktree).gitDir(), "latex-review.json"), {
        task: name,
        root: project.root,
      });
      app.repo.updateRef(`refs/latex-review/${name}/base`, base);
      app.store.transaction(() => {
        app.store.execute(
          "DELETE FROM writes WHERE action IN (SELECT id FROM actions WHERE task=?)",
          name,
        );
        app.store.execute("DELETE FROM tasks WHERE name=?", name);
        for (const table of ["rounds", "actions", "messages", "jobs"])
          app.store.execute(`DELETE FROM ${table} WHERE task=?`, name);
        app.store.execute(
          "INSERT INTO tasks(name,title,worktree,base,accepted,scope,created) VALUES(?,?,?,?,?,?,?)",
          name,
          title,
          worktree,
          base,
          base,
          JSON.stringify(scope),
          now(),
        );
      });
    } catch (error) {
      app.repo.run(["worktree", "remove", "--force", worktree], {
        check: false,
      });
      app.repo.deleteRefs(`refs/latex-review/${name}/`);
      throw error;
    }
    return this.get(name);
  }
  matches(task: Task, sections: string[], files: string[]) {
    if (!sections.length && !files.length) return true;
    if (sections.length) {
      const known = new Set(
        task.scope.sections.flatMap((s) => [
          s.id,
          s.id.replace(/^label:/, ""),
          s.number,
          s.title,
        ]),
      );
      return sections.every((s) => known.has(s.trim().replace(/^label:/, "")));
    }
    return (
      task.scope.ranges === null &&
      JSON.stringify(files.map(cleanPath).sort()) ===
        JSON.stringify([...task.scope.paths].sort())
    );
  }
  async finish(name: string, force = false) {
    const app = this.app,
      task = this.get(name);
    if (app.publisher.busy(name))
      throw new Error(
        "A round is still being built. Wait for it before finishing.",
      );
    const counts = app.review.counts(name),
      problems: string[] = [];
    if (counts.pending || counts.commented)
      problems.push(
        `${counts.pending} pending and ${counts.commented} commented changes`,
      );
    const leftover = fs.existsSync(task.worktree)
      ? app.repo.changedFiles(task.accepted, this.snapshot(task))
      : [];
    if (leftover.length)
      problems.push(
        "edits not in the manuscript in " + leftover.slice(0, 5).join(", "),
      );
    if (problems.length && !force)
      throw new Error(
        `The task still has ${problems.join("; ")}. Publish and finish the review first, or use --force to discard them.`,
      );
    if (fs.existsSync(task.worktree))
      app.repo.run(["worktree", "remove", "--force", task.worktree]);
    app.repo.run(["worktree", "prune"], { check: false });
    app.repo.deleteRefs(`refs/latex-review/${name}/`);
    fs.rmSync(path.join(app.state, "rounds", name), {
      recursive: true,
      force: true,
    });
    app.store.execute("UPDATE tasks SET closed=? WHERE name=?", now(), name);
    await app.publisher.pruneCache();
    return {
      changed: app.repo.changedFiles(task.base, task.accepted),
      discarded: counts,
    };
  }
}
