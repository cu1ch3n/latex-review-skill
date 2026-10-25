import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App, createServer } from "../../src/server.ts";
import { prepareDemo, applyDemo } from "../../examples/demo.ts";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "latex-review-browser-")),
  { root, plan } = prepareDemo(base),
  app = new App(root),
  server = createServer(app);
app.url = "http://127.0.0.1:4174";
const task = app.tasks.create(plan.task, plan.title, [plan.section]);
applyDemo(task.worktree, plan);
const job = app.publisher.submit(task.name);
await app.publisher.join();
if (app.publisher.job(job.id).status !== "done")
  throw new Error(JSON.stringify(app.publisher.job(job.id)));
await server.listen({ host: "127.0.0.1", port: 4174 });
async function close() {
  await server.close();
  await app.close();
  fs.rmSync(base, { recursive: true, force: true });
  process.exit();
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
