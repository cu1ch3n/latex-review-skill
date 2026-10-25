import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Repo } from "./git.ts";
import { listFiles, readJson, writeJson, withLock, now } from "./files.ts";
import { stripComments } from "./outline.ts";
import { signature, type Project } from "./config.ts";
import { run, runAsync } from "./process.ts";
import type { BuildInfo } from "../types.ts";
export class BuildError extends Error {
  constructor(
    message: string,
    public details: string[] = [],
    public log?: string,
  ) {
    super(message);
  }
}
const AUXILIARY = new Set([
  ".aux",
  ".bbl",
  ".brf",
  ".toc",
  ".lof",
  ".lot",
  ".loe",
  ".out",
  ".thm",
]);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const includes = (text: string) =>
  [...stripComments(text).matchAll(/^\s*\\include\{([^}]+)\}/gm)].map((m) =>
    m[1].trim(),
  );
export function affectedTargets(
  texts: Record<string, string>,
  changed: string[],
  targets: string[],
) {
  const owners: Record<string, Set<string>> = {};
  function visit(file: string, target: string, seen: Set<string>) {
    if (!path.posix.extname(file)) file += ".tex";
    if (seen.has(file) || !(file in texts)) return;
    seen.add(file);
    (owners[file] ??= new Set()).add(target);
    for (const m of stripComments(texts[file]).matchAll(
      /\\(?:input|include|subfile)\{([^}]+)\}/g,
    ))
      visit(path.posix.normalize(m[1].trim()), target, seen);
  }
  targets.forEach((t) => visit(t, t, new Set()));
  const selected = new Set<string>();
  for (const file of changed) {
    if (!owners[file]) return ["full"];
    for (const owner of owners[file]) selected.add(owner);
  }
  return [...selected].sort();
}
export function errors(text: string) {
  const lines = text.split("\n"),
    result: string[] = [];
  for (const [i, line] of lines.entries())
    if (/^(\S[^:\n]*):(\d+): (.+)$/.test(line) || line.startsWith("! ")) {
      const context = lines
        .slice(i + 1, i + 8)
        .find((l) => /^l\.\d+ /.test(l))
        ?.trim();
      result.push(
        line.replace(/^! |^\.\//, "") + (context ? `  [${context}]` : ""),
      );
      if (result.length === 8) break;
    }
  return result;
}
export function warnings(text: string) {
  const patterns: [RegExp, string][] = [
    [/LaTeX Warning: Reference `([^']+)' on page/g, "Undefined reference: "],
    [/Warning: Citation [`']([^']+)' on page/g, "Undefined citation: "],
    [
      /LaTeX Warning: Label `([^']+)' multiply defined/g,
      "Label defined twice: ",
    ],
    [/Missing character: There is no (\S+)/g, "Missing glyph: "],
  ];
  return [
    ...new Set(
      patterns.flatMap(([re, label]) =>
        [...text.matchAll(re)].map((m) => label + m[1]),
      ),
    ),
  ].sort();
}
export class Builder {
  cache: string;
  constructor(
    public project: Project,
    public repo: Repo,
  ) {
    this.cache = path.join(project.state, "cache/builds");
  }
  documentTexts(rev: string) {
    const files = this.repo
        .files(rev, this.project.doc_dir)
        .filter((f) => f.endsWith(".tex")),
      blobs = this.repo.blobs(rev, files);
    return Object.fromEntries(
      files.map((f) => [
        path.posix.relative(this.project.doc_dir || ".", f),
        blobs[f]?.toString() ?? "",
      ]),
    );
  }
  plan(before: string, after: string, changed: string[]) {
    const p = this.project,
      old = this.documentTexts(before),
      next = this.documentTexts(after),
      main = path.posix.basename(p.main),
      targets = includes(next[main] ?? "");
    if (
      !p.partial_builds ||
      targets.length < 2 ||
      JSON.stringify(targets) !== JSON.stringify(includes(old[main] ?? ""))
    )
      return ["full"];
    if (p.doc_dir && changed.some((f) => !f.startsWith(p.doc_dir + "/")))
      return ["full"];
    const local = changed.map((f) => path.posix.relative(p.doc_dir || ".", f)),
      selected = new Set([
        ...affectedTargets(old, local, targets),
        ...affectedTargets(next, local, targets),
      ]);
    if (selected.has("full") || !selected.size) return ["full"];
    for (const name of [...selected])
      for (const dependency of p.dependencies[name] ?? [])
        selected.add(dependency);
    return targets.filter((t) => selected.has(t));
  }
  async build(
    rev: string,
    targets = ["full"],
    seed: BuildInfo | null = null,
  ): Promise<BuildInfo> {
    const p = this.project,
      partial = JSON.stringify(targets) !== '["full"]';
    if (partial && !seed)
      throw new BuildError(
        "A partial build needs a completed full build to start from.",
      );
    let version: string;
    try {
      version = run(p.engine, ["--version"]).stdout.toString().split("\n")[0];
    } catch {
      throw new BuildError(
        `${p.engine} was not found. Install TeX Live (or MacTeX) with latexmk.`,
      );
    }
    const tree = this.repo.treeId(rev, p.source_dir),
      key = hash(
        JSON.stringify([
          tree,
          targets,
          seed?.key ?? null,
          signature(p),
          version,
          hash(fs.readFileSync(fileURLToPath(import.meta.url))),
        ]),
      ).slice(0, 32),
      folder = path.join(this.cache, key);
    return withLock(path.join(this.cache, key + ".lock"), async () => {
      const cached = readJson<BuildInfo | null>(
        path.join(folder, "result.json"),
        null,
      );
      if (cached && fs.existsSync(cached.pdf)) {
        fs.utimesSync(folder, new Date(), new Date());
        return cached;
      }
      fs.rmSync(folder, { recursive: true, force: true });
      const source = path.join(folder, "src");
      this.repo.export(rev, p.source_dir, source);
      const cwd = path.join(
          source,
          path.posix.relative(p.source_dir || ".", p.doc_dir || "."),
        ),
        main = path.posix.basename(p.main),
        job = path.posix.basename(main, ".tex"),
        out = path.join(cwd, "build");
      fs.mkdirSync(out, { recursive: true });
      for (const target of includes(
        fs.readFileSync(path.join(cwd, main), "utf8"),
      ))
        fs.mkdirSync(path.join(out, path.dirname(target)), { recursive: true });
      const args = [
        "-norc",
        ...(p.latexmkrc
          ? ["-r", path.posix.relative(p.doc_dir || ".", p.latexmkrc)]
          : []),
        { pdflatex: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[
          p.engine
        ],
        "-outdir=build",
        `-jobname=${job}`,
        "-synctex=1",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
      ];
      if (partial) {
        const seedOut = path.dirname(seed!.pdf);
        for (const file of listFiles(seedOut))
          if (AUXILIARY.has(path.extname(file))) {
            const target = path.join(out, path.relative(seedOut, file));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (!fs.existsSync(target)) fs.copyFileSync(file, target);
          }
        const preload = Object.entries(p.preload)
          .filter(
            ([name, file]) =>
              !targets.includes(name) && fs.existsSync(path.join(cwd, file)),
          )
          .map(([, file]) => `\\input{${file}}`)
          .join("");
        args.push(
          `-usepretex=\\includeonly{${targets.join(",")}}` +
            (preload ? `\\AtBeginDocument{${preload}}` : ""),
        );
      }
      args.push(main);
      const transcript = path.join(folder, "latexmk.log"),
        fd = fs.openSync(transcript, "w"),
        started = now();
      let failure: Error | null = null;
      try {
        await runAsync("latexmk", args, {
          cwd,
          timeout: 1800000,
          output: (chunk) => fs.writeSync(fd, chunk),
        });
      } catch (error) {
        failure = error as Error;
      } finally {
        fs.closeSync(fd);
      }
      const pdf = path.join(out, job + ".pdf"),
        log = path.join(out, job + ".log"),
        logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      if (failure || !fs.existsSync(pdf)) {
        const details = errors(logText),
          kept = path.join(p.state, "logs", key + ".log");
        fs.mkdirSync(path.dirname(kept), { recursive: true });
        fs.copyFileSync(fs.existsSync(log) ? log : transcript, kept);
        const tail = fs.readFileSync(transcript, "utf8").split("\n").slice(-25);
        fs.rmSync(folder, { recursive: true, force: true });
        throw new BuildError(
          failure?.message.includes("ENOENT")
            ? "latexmk was not found. Install TeX Live or MacTeX."
            : "LaTeX failed to compile.",
          details.length ? details : tail,
          kept,
        );
      }
      const result: BuildInfo = {
        key,
        tree,
        targets,
        root: source,
        cwd,
        pdf,
        seconds: Math.round((now() - started) * 10) / 10,
        warnings: warnings(logText),
      };
      writeJson(path.join(folder, "result.json"), result);
      return result;
    });
  }
  async prune(keep: Set<string>, maxAge = 3 * 86400) {
    if (!fs.existsSync(this.cache)) return;
    for (const entry of fs.readdirSync(this.cache, { withFileTypes: true })) {
      const folder = path.join(this.cache, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.endsWith(".lock") &&
        !keep.has(entry.name) &&
        now() - fs.statSync(folder).mtimeMs / 1000 > maxAge
      )
        await withLock(
          path.join(this.cache, entry.name + ".lock"),
          async () => {
            fs.rmSync(folder, { recursive: true, force: true });
          },
        );
    }
  }
}
