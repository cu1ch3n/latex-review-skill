import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Fixture, fakeRound, METHOD } from "./helpers.ts";
import { createServer, App } from "../../src/server.ts";
import { Builder } from "../../src/core/build.ts";
import { sleep } from "../../src/core/files.ts";
let f: Fixture, app: App, server: ReturnType<typeof createServer>;
beforeEach(() => {
  f = new Fixture();
  app = f.app();
  server = createServer(app);
});
afterEach(async () => {
  await server.close();
  await f.close();
  vi.restoreAllMocks();
});
const headers = () => ({
  host: "127.0.0.1:9",
  origin: app.url,
  "x-review-token": app.csrf,
});
it("requires localhost origin and token for mutation", async () => {
  expect(
    (
      await server.inject({
        url: "/api/info",
        headers: { host: "evil.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { host: "127.0.0.1:9" },
        payload: { name: "test" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await server.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { ...headers(), origin: "http://evil.example" },
        payload: { name: "test" },
      })
    ).statusCode,
  ).toBe(403);
  const response = await server.inject({
    method: "POST",
    url: "/api/tasks",
    headers: headers(),
    payload: { name: "test" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().task).toBe("test");
  expect(
    (await server.inject({ url: "/api/tasks", headers: headers() })).json()
      .tasks,
  ).toHaveLength(1);
});
it("validates action schemas and serves immutable compressed vectors", async () => {
  const task = app.tasks.create("test");
  f.edit(task, METHOD, "Method sentence 2.", "new");
  fakeRound(app, "test");
  const invalid = await server.inject({
    method: "POST",
    url: "/api/tasks/test/decide",
    headers: headers(),
    payload: { action: "toString", changes: ["c001"], round: 1 },
  });
  expect(invalid.statusCode).toBe(400);
  const directory = path.join(app.state, "rounds/test/001");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "s0001.svg"),
    "<svg>" + '<path d="M0 0 L1 1"/>'.repeat(1000) + "</svg>",
  );
  const response = await server.inject({
    url: "/files/test/1/s0001.svg",
    headers: { ...headers(), "accept-encoding": "gzip" },
  });
  expect(response.headers["cache-control"]).toContain("immutable");
  expect(response.headers["content-encoding"]).toBe("gzip");
  expect(
    (
      await server.inject({
        url: "/files/test/1/state.sqlite3",
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
});
it("schedules distinct tasks concurrently but serializes the same task", async () => {
  f.write(".latex-review.json", JSON.stringify({ build_workers: 2 }));
  for (const name of ["a", "b", "c"]) app.tasks.create(name);
  const active = new Set<string>(),
    calls: string[] = [],
    release = new Map<string, () => void>();
  let peak = 0;
  vi.spyOn(app.publisher, "pruneCache").mockResolvedValue();
  vi.spyOn(app.publisher, "publish").mockImplementation(async (job) => {
    const key =
      job.task === "a" ? (calls.includes("a1") ? "a2" : "a1") : job.task;
    expect(active.has(job.task)).toBe(false);
    active.add(job.task);
    peak = Math.max(peak, active.size);
    calls.push(key);
    await new Promise<void>((resolve) => release.set(key, resolve));
    active.delete(job.task);
    if (key === "a1") throw new Error("Expected failure");
    return { outcome: "empty" };
  });
  const waitFor = async (key: string) => {
    for (let i = 0; i < 100 && !release.has(key); i++) await sleep(10);
    expect(release.has(key)).toBe(true);
  };
  const a1 = app.publisher.submit("a");
  await waitFor("a1");
  const a2 = app.publisher.submit("a");
  expect(app.publisher.submit("a").id).toBe(a2.id);
  const b = app.publisher.submit("b");
  await waitFor("b");
  const c = app.publisher.submit("c");
  expect(calls).toEqual(["a1", "b"]);
  release.get("b")!();
  await waitFor("c");
  release.get("a1")!();
  await waitFor("a2");
  release.get("c")!();
  release.get("a2")!();
  await app.publisher.join();
  expect([a1, a2, b, c].map((j) => app.publisher.job(j.id).status)).toEqual([
    "failed",
    "done",
    "done",
    "done",
  ]);
  expect(peak).toBe(2);
});
it("waits for cache cleanup before starting newly queued builds", async () => {
  app.tasks.create("a");
  let finish!: () => void;
  vi.spyOn(Builder.prototype, "prune").mockImplementation(
    () => new Promise<void>((r) => (finish = r)),
  );
  const publish = vi
    .spyOn(app.publisher, "publish")
    .mockResolvedValue({ outcome: "empty" });
  const cleaning = app.publisher.pruneCache();
  app.publisher.submit("a");
  await sleep(10);
  expect(publish).not.toHaveBeenCalled();
  app.publisher.stop();
  finish();
  await cleaning;
  await app.publisher.join();
});
