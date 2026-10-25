import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { listFiles } from "./core/files.ts";
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEB = path.join(ROOT, "dist/web");
let version: string | undefined;
export function codeVersion() {
  if (!version) {
    const digest = createHash("sha256");
    for (const file of [
      ...listFiles(path.join(ROOT, "src")),
      ...listFiles(WEB),
      path.join(ROOT, "package-lock.json"),
    ].sort())
      digest
        .update(path.relative(ROOT, file) + "\0")
        .update(fs.readFileSync(file));
    version = digest.digest("hex").slice(0, 16);
  }
  return version;
}
