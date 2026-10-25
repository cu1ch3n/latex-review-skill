import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "../../src/server.ts";
import { Repo } from "../../src/core/git.ts";
import { diffUnits } from "../../src/core/changes.ts";
import { now } from "../../src/core/files.ts";
import type { Task } from "../../src/types.ts";
export const METHOD = "paper/sections/method.tex";
const lines = (prefix: string) =>
  Array.from({ length: 20 }, (_, i) => `${prefix} sentence ${i}.`).join("\n");
export const MAIN = String.raw`\documentclass{article}
\usepackage{hyperref}
\begin{document}
\section{Introduction}\label{sec:intro}
${lines("Intro")}
\input{sections/method}
\section{Conclusion}\label{sec:end}
We conclude.
\end{document}
`;
export const BODY = String.raw`\section{Method}
\label{sec:method}
${lines("Method")}
\subsection{Details}
\label{sec:details}
${lines("Detail")}
`;
export class Fixture {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-ts-"));
  root = path.join(this.base, "repo");
  repo: Repo;
  apps: App[] = [];
  constructor() {
    fs.mkdirSync(this.root);
    this.repo = new Repo(this.root);
    this.repo.run(["init", "-q"]);
    this.repo.run(["config", "user.name", "Test"]);
    this.repo.run(["config", "user.email", "test@localhost"]);
    this.write("paper/main.tex", MAIN);
    this.write(METHOD, BODY);
    this.write(".gitignore", "*.aux\n");
    this.repo.run(["add", "."]);
    this.repo.run(["commit", "-qm", "initial"]);
  }
  write(file: string, text: string | Buffer, root = this.root) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  read(file: string, root = this.root) {
    return fs.readFileSync(path.join(root, file), "utf8");
  }
  edit(task: Task, file: string, old: string, next: string) {
    const text = this.read(file, task.worktree);
    if (!text.includes(old)) throw new Error("Missing edit: " + old);
    this.write(file, text.replace(old, next), task.worktree);
  }
  app() {
    const app = new App(this.root);
    app.url = "http://127.0.0.1:9";
    this.apps.push(app);
    return app;
  }
  async close() {
    for (const app of this.apps) await app.close();
    fs.rmSync(this.base, { recursive: true, force: true });
  }
}
export function fakeRound(app: App, name: string) {
  const task = app.tasks.get(name),
    after = app.tasks.snapshot(task),
    before = task.accepted,
    number = (app.review.latestRound(name)?.number ?? 0) + 1,
    units = diffUnits(app.repo, before, after);
  app.store.execute(
    "INSERT INTO rounds(task,number,before,after,units,summary,created) VALUES(?,?,?,?,?,?,?)",
    name,
    number,
    before,
    after,
    JSON.stringify(units),
    JSON.stringify({ warnings: [], targets: [], builds: [] }),
    now(),
  );
  return app.review.round(name, number);
}
