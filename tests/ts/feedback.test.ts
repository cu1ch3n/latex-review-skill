import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { Fixture } from "./helpers.ts";
import { feedback } from "../../src/cli.ts";
import { Client } from "../../src/client.ts";
import type { Feedback } from "../../src/types.ts";
let f: Fixture;
beforeEach(() => {
  f = new Fixture();
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.close();
});
const response = (
  state: Feedback["state"],
  cursor: number,
  items: Feedback["feedback"] = [],
): Feedback => ({
  task: "test",
  title: "Test",
  state,
  round: 1,
  counts: { pending: 1, accepted: 0, rejected: 0, commented: 0 },
  next: "",
  cursor,
  feedback: items,
});
const cursor = () => path.join(f.root, ".git/latex-review/agents/test.cursor");
it.each(["reviewing", "building"] as const)(
  "a user message interrupts an unlimited wait while %s",
  async (state) => {
    const client = new Client("unused", ""),
      get = vi
        .spyOn(client, "get")
        .mockImplementation(
          async (route) =>
            (route.includes("/feedback?")
              ? response(state, 9, [
                  { id: 9, kind: "note", round: 1, text: "Pause here." },
                ])
              : { url: "http://localhost/review" }) as never,
        ),
      output = vi.fn();
    await feedback(client, f.root, "test", null, false, output);
    expect(output.mock.calls[0][0].feedback[0].text).toBe("Pause here.");
    expect(fs.readFileSync(cursor(), "utf8")).toBe("9");
    expect(get).toHaveBeenCalledTimes(2);
  },
);
it("waits through partial comments without advancing the delivered cursor", async () => {
  fs.mkdirSync(path.dirname(cursor()), { recursive: true });
  fs.writeFileSync(cursor(), "7");
  const client = new Client("unused", ""),
    partial = {
      id: 8,
      kind: "comment" as const,
      round: 1,
      text: "Keep the example.",
    },
    queue = [
      response("building", 7),
      response("reviewing", 8, [partial]),
      response("revise", 9, [partial, { id: 9, kind: "accept", round: 1 }]),
    ];
  vi.spyOn(client, "get").mockImplementation(async (route) => {
    if (!route.includes("/feedback?")) return { url: "review" } as never;
    expect(route).toContain("after=7");
    expect(fs.readFileSync(cursor(), "utf8")).toBe("7");
    return queue.shift() as never;
  });
  const output = vi.fn(),
    work = feedback(client, f.root, "test", null, false, output);
  await vi.runAllTimersAsync();
  await work;
  expect(output).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(cursor(), "utf8")).toBe("9");
});
it("returns on timeout and never consumes undelivered output", async () => {
  const client = new Client("unused", "");
  vi.spyOn(client, "get").mockImplementation(
    async (route) =>
      (route.includes("/feedback?")
        ? response("reviewing", 4)
        : { url: "review" }) as never,
  );
  const output = vi.fn(),
    work = feedback(client, f.root, "test", 5, false, output);
  await vi.runAllTimersAsync();
  await work;
  expect(output.mock.calls[0][0].waited).toBe(5);
  fs.unlinkSync(cursor());
  await expect(
    feedback(client, f.root, "test", 0, false, () => {
      throw new Error("stdout failed");
    }),
  ).rejects.toThrow("stdout failed");
  expect(fs.existsSync(cursor())).toBe(false);
});
