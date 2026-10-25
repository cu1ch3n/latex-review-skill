import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { Fixture, METHOD, BODY, fakeRound } from "./helpers.ts";
import { safePath } from "../../src/core/review.ts";
import { App } from "../../src/server.ts";
import type { Task, ActionKind } from "../../src/types.ts";
let f: Fixture, app: App, task: Task;
beforeEach(() => {
  f = new Fixture();
  app = f.app();
  task = app.tasks.create("polish", "Polish", [], ["paper"]);
});
afterEach(async () => f.close());
function two() {
  f.edit(task, METHOD, "Method sentence 2.", "Agent A.");
  f.edit(task, METHOD, "Detail sentence 15.", "Agent B.");
  return fakeRound(app, task.name);
}
function decide(
  action: ActionKind,
  changes: string[],
  id: string = action,
  body = "",
) {
  return app.review.decide(task.name, {
    action,
    changes,
    id,
    body,
    round: app.review.latestRound(task.name)!.number,
  });
}
it("accept merges with user edits and leaves HEAD/index untouched", () => {
  two();
  f.write(METHOD, BODY.replace("Detail sentence 3.", "User edit."));
  const head = app.repo.rev("HEAD"),
    index = fs.readFileSync(path.join(f.root, ".git/index"));
  const state = decide("accept", ["c001"]);
  expect(f.read(METHOD)).toBe(
    BODY.replace("Method sentence 2.", "Agent A.").replace(
      "Detail sentence 3.",
      "User edit.",
    ),
  );
  expect(state.decisions).toEqual({ c001: "accepted", c002: "pending" });
  expect(app.repo.rev("HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
  expect(
    app.repo.blob(app.tasks.get(task.name).accepted, METHOD)?.toString(),
  ).not.toContain("User edit.");
});
it("undo proceeds one decision at a time and preserves later edits", () => {
  two();
  decide("accept", ["c001"], "first");
  decide("accept", ["c002"], "second");
  expect(() => app.review.undo(task.name, "first")).toThrow();
  f.write(
    METHOD,
    f.read(METHOD).replace("Method sentence 15.", "Later user edit."),
  );
  app.review.undo(task.name, "second");
  const state = app.review.undo(task.name, "first");
  expect(state.decisions).toEqual({ c001: "pending", c002: "pending" });
  expect(state.undo).toBeNull();
  expect(f.read(METHOD)).toBe(
    BODY.replace("Method sentence 15.", "Later user edit."),
  );
  expect(app.tasks.get(task.name).accepted).toBe(task.base);
});
it("overlapping accept writes nothing", () => {
  two();
  f.write(
    METHOD,
    BODY.replace("Method sentence 2.", "User rewrote this line."),
  );
  const before = f.read(METHOD);
  expect(() => decide("accept", ["c001"])).toThrow(
    "changed in your manuscript",
  );
  expect(f.read(METHOD)).toBe(before);
  expect(app.review.pageState(task.name).decisions.c001).toBe("pending");
});
it("undo refuses to overwrite new edits on an accepted line", () => {
  two();
  decide("accept", ["c001"]);
  f.write(
    METHOD,
    f.read(METHOD).replace("Agent A.", "User changed accepted line."),
  );
  expect(() => app.review.undo(task.name, "accept")).toThrow("Can't undo");
  expect(app.review.pageState(task.name).undo?.id).toBe("accept");
});
it("reject reverts agent worktree and undo restores it", () => {
  two();
  decide("reject", ["c002"]);
  expect(f.read(METHOD, task.worktree)).not.toContain("Agent B.");
  expect(f.read(METHOD)).toBe(BODY);
  app.review.undo(task.name, "reject");
  expect(f.read(METHOD, task.worktree)).toContain("Agent B.");
});
it("reject preserves agent edits made after publication and reports them", () => {
  two();
  f.edit(task, METHOD, "Agent B.", "Agent B, edited again.");
  decide("accept", ["c001"]);
  decide("reject", ["c002"]);
  const feedback = app.review.feedback(task.name);
  expect(feedback.feedback.at(-1)?.not_reverted).toEqual([METHOD]);
  expect(feedback.state).toBe("revise");
});
it("accept and undo added/deleted files", () => {
  f.write("paper/new.tex", "New file.\n", task.worktree);
  fs.unlinkSync(path.join(task.worktree, "paper/main.tex"));
  const round = fakeRound(app, task.name);
  decide(
    "accept",
    round.units.map((u) => u.id),
  );
  expect(fs.existsSync(path.join(f.root, "paper/new.tex"))).toBe(true);
  expect(fs.existsSync(path.join(f.root, "paper/main.tex"))).toBe(false);
  app.review.undo(task.name, "accept");
  expect(fs.existsSync(path.join(f.root, "paper/new.tex"))).toBe(false);
  expect(fs.existsSync(path.join(f.root, "paper/main.tex"))).toBe(true);
});
it("comments, note cursors and undo remain consistent", () => {
  two();
  decide("comment", ["c001"], "remark", "Keep this precise.");
  expect(app.review.pageState(task.name).comments.c001).toBe(
    "Keep this precise.",
  );
  const first = app.review.feedback(task.name);
  app.review.note(task.name, "Pause here.");
  const next = app.review.feedback(task.name, first.cursor);
  expect(next.feedback).toHaveLength(1);
  expect(next.feedback[0]).toMatchObject({ kind: "note", text: "Pause here." });
  app.review.undo(task.name, "remark");
  expect(app.review.pageState(task.name).decisions.c001).toBe("pending");
  expect(
    app.review.feedback(task.name, first.cursor).feedback.at(-1)?.kind,
  ).toBe("undo");
});
it("action retry is idempotent but conflicting reuse is rejected", () => {
  two();
  const first = decide("accept", ["c001"], "retry");
  expect(decide("accept", ["c001"], "retry").decisions).toEqual(
    first.decisions,
  );
  expect(app.review.feedback(task.name).feedback).toHaveLength(1);
  expect(() => decide("reject", ["c002"], "retry")).toThrow("already used");
});
it("old rounds stay inspectable while stale decisions are rejected", () => {
  two();
  fakeRound(app, task.name);
  expect(app.review.pageState(task.name, 1).round).toBe(1);
  expect(app.review.pageState(task.name, 1).latest).toBe(2);
  expect(() =>
    app.review.decide(task.name, {
      action: "accept",
      changes: ["c001"],
      round: 1,
    }),
  ).toThrow("newer round");
});
it("recovery completes a journaled accept after restart", () => {
  const round = two(),
    target = path.join(f.root, METHOD),
    after = Buffer.from(BODY.replace("Method sentence 2.", "Agent A.")),
    accepted = app.repo.commitWith(
      task.accepted,
      { [METHOD]: after },
      "accept",
    );
  app.review.record(
    "crash",
    task,
    round,
    "accept",
    ["c001"],
    "",
    { accepted_before: task.accepted, accepted_after: accepted },
    [[target, Buffer.from(BODY), after]],
  );
  fs.writeFileSync(target, after);
  app.review.recover();
  expect(app.review.pageState(task.name).decisions.c001).toBe("accepted");
  expect(app.tasks.get(task.name).accepted).toBe(accepted);
  expect(app.review.feedback(task.name).feedback).toHaveLength(1);
  app.review.recover();
  expect(app.review.feedback(task.name).feedback).toHaveLength(1);
});
it("refuses a write through a symlink outside the manuscript", () => {
  const out = path.join(f.base, "outside");
  fs.mkdirSync(out);
  fs.symlinkSync(out, path.join(f.root, "paper/escape"));
  expect(() => safePath(f.root, "paper/escape/file.tex")).toThrow();
});
it("reattaches matching scopes and requires explicit force before discarding", async () => {
  expect(app.tasks.create("polish").worktree).toBe(task.worktree);
  expect(() => app.tasks.create("polish", "Different", [], [METHOD])).toThrow(
    "different scope",
  );
  two();
  await expect(app.tasks.finish(task.name)).rejects.toThrow("pending");
  await app.tasks.finish(task.name, true);
  expect(app.tasks.list()).toEqual([]);
  expect(fs.existsSync(task.worktree)).toBe(false);
  expect(app.repo.text(["for-each-ref", "refs/latex-review/polish/"])).toBe("");
});
it("recreating a finished task clears its old write journal", async () => {
  two();
  decide("accept", ["c001"], "reused-id");
  app.review.undo(task.name, "reused-id");
  await app.tasks.finish(task.name, true);
  task = app.tasks.create("polish");
  two();
  expect(() => decide("accept", ["c001"], "reused-id")).not.toThrow();
});
it("a reused comment id cannot silently discard changed opinion text", () => {
  two();
  decide("comment", ["c001"], "same-comment", "First opinion.");
  expect(() =>
    decide("comment", ["c001"], "same-comment", "A different opinion."),
  ).toThrow("already used");
  expect(app.review.feedback(task.name).feedback[0].text).toBe(
    "First opinion.",
  );
});
it("a conflicting accept-all writes none of the otherwise mergeable changes", () => {
  f.edit(task, "paper/main.tex", "Intro sentence 2.", "Agent intro edit.");
  f.edit(task, METHOD, "Detail sentence 15.", "Agent method edit.");
  fakeRound(app, task.name);
  const mainBefore = f.read("paper/main.tex");
  f.write(
    METHOD,
    BODY.replace("Detail sentence 15.", "User rewrote the second change."),
  );
  const before = f.read(METHOD);
  expect(() => decide("accept", ["c001", "c002"], "all")).toThrow(
    "changed in your manuscript",
  );
  expect(f.read(METHOD)).toBe(before);
  expect(f.read("paper/main.tex")).toBe(mainBefore);
  expect(app.review.pageState(task.name).decisions).toEqual({
    c001: "pending",
    c002: "pending",
  });
});
