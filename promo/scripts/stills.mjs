import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));
mkdirSync("out/stills", { recursive: true });
const browser = process.env.REMOTION_BROWSER_EXECUTABLE;
const requested = process.argv.slice(2).map(Number);
if (requested.some((frame) => !Number.isInteger(frame) || frame < 0))
  throw new Error("Frame numbers must be nonnegative integers.");
for (const frame of requested.length
  ? requested
  : [0, 66, 138, 182, 232, 310, 374, 410, 468, 518, 563]) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@remotion/cli/remotion-cli.js",
      "still",
      "src/index.ts",
      "LatexReview",
      `out/stills/${frame}.png`,
      `--frame=${frame}`,
      "--scale=1.6",
      "--log=error",
      ...(browser ? [`--browser-executable=${browser}`] : []),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
