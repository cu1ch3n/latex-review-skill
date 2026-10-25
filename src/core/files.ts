import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export function atomicWrite(
  file: string,
  data: string | Uint8Array,
  mode?: number,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    const fd = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) fs.chmodSync(temporary, mode);
    else if (fs.existsSync(file))
      fs.chmodSync(temporary, fs.statSync(file).mode & 0o7777);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function readBytes(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export function same(a: Uint8Array | null, b: Uint8Array | null) {
  return a === null || b === null ? a === b : Buffer.from(a).equals(b);
}
export function writeOrDelete(file: string, data: Uint8Array | null) {
  if (data === null) fs.rmSync(file, { force: true });
  else atomicWrite(file, data);
}
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (e) {
    if (
      e instanceof SyntaxError ||
      (e as NodeJS.ErrnoException).code === "ENOENT"
    )
      return fallback;
    throw e;
  }
}
export function writeJson(file: string, value: unknown, mode?: number) {
  atomicWrite(file, JSON.stringify(value, null, 2) + "\n", mode);
}
export async function acquireLock(file: string, retry = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, "a"));
  return lockfile.lock(file, {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: retry ? { retries: 1800, minTimeout: 100, maxTimeout: 500 } : 0,
  });
}
export async function withLock<T>(
  file: string,
  work: () => Promise<T>,
  retry = true,
) {
  const release = await acquireLock(file, retry);
  try {
    return await work();
  } finally {
    await release();
  }
}
export function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? listFiles(path.join(root, e.name))
        : [path.join(root, e.name)],
    );
}
export const now = () => Date.now() / 1000;
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
