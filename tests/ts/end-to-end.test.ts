import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { App } from "../../src/server.ts";
import { Builder, BuildError } from "../../src/core/build.ts";
import { which } from "../../src/core/process.ts";
import { prepareDemo, applyDemo } from "../../examples/demo.ts";
import { Fixture, METHOD } from "./helpers.ts";
const tex = Boolean(which("latexmk") && which("pdflatex"));
it.skipIf(!tex)(
  "compiles the bundled paper, renders all seven edits and completes review",
  async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-e2e-")),
      { root, plan } = prepareDemo(base),
      app = new App(root);
    try {
      const task = app.tasks.create(plan.task, plan.title, [plan.section]);
      applyDemo(task.worktree, plan);
      const job = app.publisher.submit(task.name);
      await app.publisher.join();
      const result = app.publisher.job(job.id);
      expect(result.status, JSON.stringify(result.result)).toBe("done");
      expect(result.result.changes).toBe(7);
      const detail = app.review.roundDetail(task.name, 1);
      expect(detail.units.some((u) => u.kind === "figure")).toBe(true);
      expect(detail.units.some((u) => u.visual === "identical")).toBe(true);
      expect(detail.units.every((u) => u.visual !== "unmapped")).toBe(true);
      const state = app.review.decide(task.name, {
        action: "accept",
        round: 1,
        changes: detail.units.map((u) => u.id),
      });
      expect(
        Object.values(state.decisions).every((d) => d === "accepted"),
      ).toBe(true);
      expect(app.review.summary(task.name).state).toBe("done");
      app.review.undo(task.name, state.undo!.id);
      expect(app.review.summary(task.name).state).toBe("reviewing");
    } finally {
      await app.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  },
  120000,
);
it.skipIf(!tex)(
  "shares a cached compilation and retains useful logs on failure",
  async () => {
    const f = new Fixture(),
      app = f.app();
    try {
      const builder = new Builder(app.project, app.repo),
        [a, b] = await Promise.all([
          builder.build("HEAD"),
          builder.build("HEAD"),
        ]);
      expect(a).toEqual(b);
      expect(fs.existsSync(a.pdf)).toBe(true);
      f.write(METHOD, "\\thiscommanddoesnotexist\n");
      const revision = app.repo.snapshot(["paper"]);
      try {
        await builder.build(revision);
        throw new Error("Should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(BuildError);
        const e = error as BuildError;
        expect(e.details.join(" ")).toContain("Undefined control sequence");
        expect(fs.existsSync(e.log!)).toBe(true);
      }
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "a decision arriving during compilation is included in the published round",
  async () => {
    const f = new Fixture(),
      app = f.app();
    const { vi } = await import("vitest"),
      { fakeRound } = await import("./helpers.ts");
    try {
      const task = app.tasks.create("during");
      f.edit(task, METHOD, "Method sentence 2.", "First proposal.");
      fakeRound(app, task.name);
      f.edit(task, METHOD, "Detail sentence 15.", "Second proposal.");
      const original = Builder.prototype.build;
      let decided = false;
      const spy = vi
        .spyOn(Builder.prototype, "build")
        .mockImplementation(async function (
          this: Builder,
          ...args: Parameters<Builder["build"]>
        ) {
          const result = await original.apply(this, args);
          if (!decided) {
            decided = true;
            app.review.decide(task.name, {
              action: "accept",
              round: 1,
              changes: ["c001"],
              id: "during-build",
            });
          }
          return result;
        });
      try {
        const job = app.publisher.submit(task.name);
        await app.publisher.join();
        expect(
          app.publisher.job(job.id).status,
          JSON.stringify(app.publisher.job(job.id).result),
        ).toBe("done");
        const round = app.review.round(task.name, 2);
        expect(round.before).toBe(app.tasks.get(task.name).accepted);
        expect(round.units).toHaveLength(1);
        expect(round.units[0].new_text).toContain("Second proposal.");
        expect(round.units[0].new_text).not.toContain("First proposal.");
      } finally {
        spy.mockRestore();
      }
    } finally {
      await f.close();
    }
  },
  120000,
);
it.skipIf(!tex)(
  "partial builds retain cross-chapter references and preload excluded macros",
  async () => {
    const f = new Fixture();
    f.write(
      "paper/main.tex",
      String.raw`\documentclass{book}
\usepackage{hyperref}
\begin{document}
\include{sections/one}
\include{sections/two}
\end{document}
`,
    );
    f.write(
      "paper/sections/one.tex",
      String.raw`\chapter{One}\label{one}
\input{macros/one}
First chapter.
`,
    );
    f.write(
      "paper/macros/one.tex",
      String.raw`\newcommand{\sharedmacro}{shared definition}`,
    );
    f.write(
      "paper/sections/two.tex",
      String.raw`\chapter{Two}
This uses the \sharedmacro{} from Chapter~\ref{one}.
`,
    );
    f.write(
      ".latex-review.json",
      JSON.stringify({ preload: { "sections/one": "macros/one.tex" } }),
    );
    f.repo.run(["add", "."]);
    f.repo.run(["commit", "-qm", "Book fixture"]);
    const app = f.app();
    try {
      const before = app.repo.rev("HEAD");
      f.write(
        "paper/sections/two.tex",
        f
          .read("paper/sections/two.tex")
          .replace("This uses", "This carefully uses"),
      );
      const after = app.repo.snapshot(["paper"]),
        builder = new Builder(app.project, app.repo),
        targets = builder.plan(before, after, ["paper/sections/two.tex"]);
      expect(targets).toEqual(["sections/two"]);
      const seed = await builder.build(before),
        partial = await builder.build(after, targets, seed);
      expect(partial.warnings).toEqual([]);
      expect(fs.existsSync(partial.pdf)).toBe(true);
      expect(
        fs.readFileSync(path.join(partial.cwd, "build/main.aux"), "utf8"),
      ).toContain("sections/one.aux");
    } finally {
      await f.close();
    }
  },
  120000,
);
