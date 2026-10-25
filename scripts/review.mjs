#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const supported = (version) => {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 22);
};
if (!supported(process.versions.node)) {
  // Use an already installed compatible Node without changing the user's default.
  const nvm = process.env.NVM_DIR || path.join(os.homedir(), ".nvm"),
    versions = path.join(nvm, "versions/node");
  const candidates = [
    ...(fs.existsSync(versions)
      ? fs
          .readdirSync(versions)
          .filter(supported)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((v) => path.join(versions, v, "bin/node"))
      : []),
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .map((dir) => path.join(dir, "node")),
  ];
  let binary;
  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) continue;
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status === 0 && supported(result.stdout.trim())) {
      binary = candidate;
      break;
    }
  }
  if (binary) {
    const result = spawnSync(
      binary,
      [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: path.dirname(binary) + path.delimiter + process.env.PATH,
        },
      },
    );
    process.exitCode = result.status ?? 1;
  } else {
    console.log(
      JSON.stringify({
        error: "Node.js 22.22 or newer is required.",
        next: "Install Node 22.22+ and run this command again.",
      }),
    );
    process.exitCode = 1;
  }
} else {
  try {
    const { register } = await import("tsx/esm/api");
    register();
    const { main } = await import("../src/cli.ts");
    await main();
  } catch (error) {
    console.log(
      JSON.stringify({
        error: error.message,
        next: "Run npm ci and npm run build in the skill folder.",
      }),
    );
    process.exitCode = 1;
  }
}
