import fs from "node:fs";
import path from "node:path";
import { renderRound } from "./round.ts";
import type { RenderRequest } from "../types.ts";
const file = process.argv[2];
if (!file) throw new Error("Expected a renderer request file.");
renderRound(
  JSON.parse(fs.readFileSync(file, "utf8")) as RenderRequest,
  path.dirname(file),
);
