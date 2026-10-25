import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, it, expect } from "vitest";
import { Fixture, METHOD, fakeRound } from "./helpers.ts";
import { createServer, App } from "../../src/server.ts";
import { ROOT, codeVersion } from "../../src/runtime.ts";
import { runAsync } from "../../src/core/process.ts";
import { writeJson, sleep } from "../../src/core/files.ts";
import type { Feedback, Task } from "../../src/types.ts";
let f: Fixture, app: App, server: ReturnType<typeof createServer>, task: Task;
beforeEach(async () => {
  f = new Fixture();
  app = f.app();
  server = createServer(app);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  app.url = `http://127.0.0.1:${address.port}`;
  writeJson(path.join(app.state, "server/connection.json"), {
    url: app.url,
    port: address.port,
    pid: process.pid,
    version: codeVersion(),
    root: app.root,
  });
  task = app.tasks.create("polish");
  f.edit(task, METHOD, "Method sentence 2.", "Agent A.");
  f.edit(task, METHOD, "Detail sentence 15.", "Agent B.");
  fakeRound(app, task.name);
});
afterEach(async () => {
  await server.close();
  await f.close();
});
async function cli(...args: string[]) {
  const result = await runAsync(
    process.execPath,
    [path.join(ROOT, "scripts/review.mjs"), "--repo", task.worktree, ...args],
    { cwd: ROOT, timeout: 20000 },
  );
  return JSON.parse(result.toString().trim().split("\n").at(-1)!) as Feedback;
}
async function post(route: string, data: unknown) {
  const response = await fetch(app.url + `/api/tasks/${task.name}/` + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": app.csrf },
    body: JSON.stringify(data),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
}
it("CLI obtains every comment, note and source location without browser access", async () => {
  const long = "保留这个公式，解释边界。".repeat(600);
  await post("decide", {
    id: "first",
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: long,
  });
  await post("decide", {
    id: "second",
    action: "comment",
    round: 1,
    changes: ["c002"],
    body: "Second independent opinion.",
  });
  for (let i = 0; i < 250; i++)
    await post("note", { body: `Opinion ${i}: keep this context.` });
  const answer = await cli("feedback");
  expect(answer.state).toBe("revise");
  expect(answer.feedback).toHaveLength(252);
  expect(answer.feedback[0].text).toBe(long);
  expect(answer.feedback[0].changes?.[0]).toMatchObject({
    file: METHOD,
    old: "Method sentence 2.",
    new: "Agent A.",
  });
  expect(answer.feedback.at(-1)?.text).toBe("Opinion 249: keep this context.");
  expect((await cli("feedback")).feedback).toEqual([]);
  expect((await cli("feedback", "--all")).feedback).toEqual(answer.feedback);
});
it("CLI wait sees comments after final decision and a note wakes an unfinished review", async () => {
  const waiting = cli("feedback", "--wait");
  await sleep(250);
  await post("decide", {
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: "Clarify the invariant.",
  });
  await post("decide", { action: "accept", round: 1, changes: ["c002"] });
  const result = await waiting;
  expect(result.feedback.map((i) => i.kind)).toEqual(["comment", "accept"]);
  expect(result.feedback[0].text).toBe("Clarify the invariant.");
  f.edit(task, METHOD, "Agent A.", "Agent A, revised.");
  fakeRound(app, task.name);
  const again = cli("feedback", "--wait");
  await sleep(250);
  await post("note", { body: "Pause and reconsider the proof." });
  const interrupted = await again;
  expect(interrupted.state).toBe("reviewing");
  expect(interrupted.feedback[0].text).toBe("Pause and reconsider the proof.");
});
it("delivered opinions can be replayed and corrected by undo across rounds", async () => {
  await post("decide", {
    id: "comment",
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: "First opinion.",
  });
  const delivered = await cli("feedback");
  expect(delivered.feedback[0].text).toBe("First opinion.");
  await post("undo", { id: "comment" });
  const corrected = await cli("feedback");
  expect(corrected.feedback[0]).toMatchObject({
    kind: "undo",
    undid: "comment",
  });
  expect((await cli("feedback", "--all")).feedback).toEqual([]);
  await post("decide", {
    id: "replacement",
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: "Corrected opinion.",
  });
  f.edit(task, METHOD, "Agent A.", "Agent A revised.");
  const second = fakeRound(app, task.name);
  expect(
    app.review
      .roundDetail(task.name, second.number)
      .units.find((u) => u.id === "c001")?.history?.[0].comment,
  ).toBe("Corrected opinion.");
  expect(
    (await cli("feedback", "--all")).feedback.find((i) => i.kind === "comment")
      ?.text,
  ).toBe("Corrected opinion.");
});
it("CLI reports compiler diagnostics and log path directly", async () => {
  app.store.execute(
    "INSERT INTO jobs(id,task,status,phase,result,created) VALUES('broken',?,'failed','build',?,?)",
    task.name,
    JSON.stringify({
      error: "Your edits do not compile.",
      details: ["main.tex:17: Undefined control sequence"],
      log: "/tmp/compile.log",
      next: "Fix the macro.",
    }),
    Date.now() / 1000 + 1,
  );
  const result = await cli("feedback", "--wait");
  expect(result.state).toBe("build_failed");
  expect(result.build_error).toMatchObject({
    details: ["main.tex:17: Undefined control sequence"],
    log: "/tmp/compile.log",
  });
});
it("replaying all opinions does not consume the normal delivery cursor", async () => {
  await post("decide", {
    id: "replay",
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: "Keep this opinion available.",
  });
  const replay = await cli("feedback", "--all"),
    firstDelivery = await cli("feedback");
  expect(firstDelivery.feedback).toEqual(replay.feedback);
  expect((await cli("feedback")).feedback).toEqual([]);
});
it("delegated accept-all completes the CLI wait and one CLI undo restores the batch", async () => {
  const waiting = cli("feedback", "--wait");
  await sleep(250);
  const accepted = await cli("accept", "--all", "--round", "1");
  expect(accepted.counts).toMatchObject({ accepted: 2, pending: 0 });
  const answer = await waiting;
  expect(answer.state).toBe("done");
  expect(answer.feedback).toHaveLength(1);
  expect(answer.feedback[0]).toMatchObject({
    kind: "accept",
    changes: ["c001", "c002"],
  });
  expect(f.read(METHOD)).toContain("Agent A.");
  expect(f.read(METHOD)).toContain("Agent B.");
  const undone = await cli("undo");
  expect(undone.counts).toMatchObject({ accepted: 0, pending: 2 });
  expect(f.read(METHOD)).not.toContain("Agent A.");
  expect(f.read(METHOD)).not.toContain("Agent B.");
});
it("accept-all preserves existing comments and rejects a stale round", async () => {
  await post("decide", {
    id: "keep-comment",
    action: "comment",
    round: 1,
    changes: ["c001"],
    body: "This still needs revision.",
  });
  await expect(cli("accept", "--all", "--round", "9")).rejects.toThrow();
  expect(app.review.pageState(task.name).decisions.c002).toBe("pending");
  const accepted = await cli("accept", "--all");
  expect(accepted.counts).toMatchObject({
    accepted: 1,
    commented: 1,
    pending: 0,
  });
  expect(accepted.state).toBe("revise");
  expect((await cli("feedback", "--all")).feedback[0].text).toBe(
    "This still needs revision.",
  );
});
