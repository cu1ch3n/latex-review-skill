import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/runtime.ts";
import { run, runAsync, which } from "../src/core/process.ts";
import { listFiles, writeJson } from "../src/core/files.ts";
export const RAFT = {
  repository: "https://github.com/ongardie/dissertation.git",
  revision: "0c10ea1b53d73bf6d163bdde8e4141a1cbd8f36a",
  title: "Consensus: Bridging Theory and Practice",
  author: "Diego Ongaro",
  license: "CC-BY-4.0",
  url: "https://github.com/ongardie/dissertation",
};
export async function prepareFixture() {
  const upstream = path.join(ROOT, ".cache/fixtures/raft"),
    target = path.join(ROOT, ".cache/corpus/raft");
  if (fs.existsSync(path.join(target, ".git"))) return target;
  if (!which("rsvg-convert"))
    throw new Error(
      "The Raft corpus needs rsvg-convert (brew install librsvg, or apt install librsvg2-bin).",
    );
  fs.mkdirSync(path.dirname(upstream), { recursive: true });
  if (!fs.existsSync(path.join(upstream, ".git")))
    await runAsync(
      "git",
      ["clone", "--no-checkout", RAFT.repository, upstream],
      { timeout: 180000 },
    );
  run("git", ["checkout", "--detach", RAFT.revision], { cwd: upstream });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(upstream, target, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes(".git"),
  });
  for (const file of listFiles(target).filter((f) => f.endsWith(".svg")))
    await runAsync("rsvg-convert", [
      "--format",
      "pdf",
      "--output",
      file.replace(/\.svg$/, ".pdf"),
      file,
    ]);
  for (const file of listFiles(target).filter(
    (f) => path.basename(f) === "Makefrag",
  )) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /^([^\s:]+\.pdf):\s+([^\s]+\.svg)\s*\n\tinkscape[^\n]* -i ([^\s]+)/gm,
    ))
      await runAsync("rsvg-convert", [
        "--format",
        "pdf",
        "--export-id",
        match[3],
        "--output",
        path.join(target, match[1]),
        path.join(target, match[2]),
      ]);
  }
  writeJson(path.join(target, ".latex-review.json"), {
    main: "main.tex",
    source_dir: "",
    partial_builds: false,
    figures: [],
  });
  run("git", ["init", "-q"], { cwd: target });
  run("git", ["config", "user.name", "LaTeX review corpus"], { cwd: target });
  run("git", ["config", "user.email", "corpus@localhost"], { cwd: target });
  run("git", ["add", "--force", "."], { cwd: target });
  run(
    "git",
    [
      "commit",
      "-qm",
      `Pinned ${RAFT.author} dissertation ${RAFT.revision}; SVG assets converted with librsvg`,
    ],
    { cwd: target },
  );
  writeJson(path.join(path.dirname(target), "raft-provenance.json"), RAFT);
  return target;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.join(ROOT, "scripts/prepare-fixture.ts")
)
  console.log(await prepareFixture());
