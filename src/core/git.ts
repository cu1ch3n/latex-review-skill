import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, which } from "./process.ts";
import { same } from "./files.ts";
const IDENTITY = {
  GIT_AUTHOR_NAME: "latex-review",
  GIT_AUTHOR_EMAIL: "latex-review@localhost",
  GIT_COMMITTER_NAME: "latex-review",
  GIT_COMMITTER_EMAIL: "latex-review@localhost",
};
export class GitError extends Error {}
let binary: string | undefined;
export function gitBinary() {
  if (binary) return binary;
  binary = which("git") ?? "git";
  try {
    const candidate = path.join(
      run(binary, ["--exec-path"]).stdout.toString().trim(),
      "git",
    );
    fs.accessSync(candidate, fs.constants.X_OK);
    binary = candidate;
  } catch {
    /* The PATH executable remains usable. */
  }
  return binary;
}
export const within = (file: string, scopes: readonly string[]) =>
  scopes.some(
    (scope) =>
      !scope ||
      scope === "." ||
      file === scope ||
      file.startsWith(scope.replace(/\/+$/, "") + "/"),
  );
export function cleanPath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (normalized.startsWith("/") || parts.includes("..") || parts[0] === ".git")
    throw new Error(`Use a repository-relative path: ${value}`);
  return parts.join("/");
}
function temporary<T>(prefix: string, work: (folder: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
export class Repo {
  constructor(public root: string) {
    this.root = path.resolve(root);
  }
  run(
    args: string[],
    options: {
      input?: string | Buffer;
      env?: NodeJS.ProcessEnv;
      check?: boolean;
      timeout?: number;
    } = {},
  ) {
    try {
      return run(
        gitBinary(),
        ["-c", "core.quotepath=off", "--literal-pathspecs", ...args],
        { cwd: this.root, ...options },
      ).stdout;
    } catch (error) {
      throw new GitError((error as Error).message);
    }
  }
  text(args: string[], options: Parameters<Repo["run"]>[1] = {}) {
    return this.run(args, options).toString().trim();
  }
  toplevel() {
    return fs.realpathSync(this.text(["rev-parse", "--show-toplevel"]));
  }
  gitDir() {
    return fs.realpathSync(this.text(["rev-parse", "--absolute-git-dir"]));
  }
  rev(name: string) {
    return this.text(["rev-parse", "--verify", "--quiet", name + "^{commit}"]);
  }
  hasHead() {
    return (
      this.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
        check: false,
      }).length > 0
    );
  }
  blobs(rev: string, paths: string[]) {
    const names = [...new Set(paths)];
    const result: Record<string, Buffer | null> = {};
    if (!names.length) return result;
    const output = this.run(["cat-file", "--batch", "-z"], {
      input: names.map((p) => `${rev}:${p}\0`).join(""),
    });
    let offset = 0;
    for (const name of names) {
      const end = output.indexOf(10, offset),
        header = output.subarray(offset, end).toString().split(" ");
      offset = end + 1;
      const size = Number(header[2]);
      result[name] =
        header[1] === "blob" && Number.isFinite(size)
          ? output.subarray(offset, offset + size)
          : null;
      if (Number.isFinite(size)) offset += size + 1;
    }
    return result;
  }
  blob(rev: string, file: string) {
    return this.blobs(rev, [file])[file];
  }
  files(rev: string, folder = "") {
    return this.run([
      "ls-tree",
      "-r",
      "-z",
      "--name-only",
      rev,
      ...(folder ? ["--", folder] : []),
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
  }
  changedFiles(before: string, after: string) {
    return this.run([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      before,
      after,
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
  }
  mode(rev: string, file: string) {
    return this.text(["ls-tree", rev, "--", file]).split(/\s+/)[0] || null;
  }
  treeId(rev: string, folder = "") {
    return this.text([
      "rev-parse",
      folder ? `${rev}:${folder}` : `${rev}^{tree}`,
    ]);
  }
  hashObject(data: Buffer) {
    return this.text(["hash-object", "-w", "--stdin"], { input: data });
  }
  commitTree(tree: string, parent: string | null, message: string) {
    return this.text(
      [
        "commit-tree",
        "--no-gpg-sign",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ],
      { env: { ...process.env, ...IDENTITY } },
    );
  }
  updateRef(ref: string, value: string) {
    this.run(["update-ref", ref, value]);
  }
  deleteRefs(prefix: string) {
    const refs = this.text(["for-each-ref", "--format=%(refname)", prefix])
      .split("\n")
      .filter(Boolean);
    if (refs.length)
      this.run(["update-ref", "--stdin"], {
        input: refs.map((r) => `delete ${r}\n`).join(""),
      });
  }
  snapshot(include: string[] = [], exclude: readonly string[] = []) {
    const head = this.rev("HEAD");
    const staged = this.run([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=A",
      "-z",
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    const tree = temporary("latex-review-index-", (folder) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: path.join(folder, "index"),
      };
      const capture = () => {
        this.run(["read-tree", head], { env });
        this.run(["add", "-u"], { env });
        const untracked = this.run(
          ["ls-files", "--others", "--exclude-standard", "-z"],
          { env },
        )
          .toString()
          .split("\0");
        const chosen = new Set([
          ...untracked.filter(
            (p) =>
              p &&
              within(p, include) &&
              !exclude.some((suffix) => p.endsWith(suffix)),
          ),
          ...staged.filter((p) => fs.existsSync(path.join(this.root, p))),
        ]);
        if (chosen.size)
          this.run(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            env,
            input: [...chosen].sort().join("\0") + "\0",
          });
        return this.text(["write-tree"], { env });
      };
      const first = capture();
      if (first !== capture() || head !== this.rev("HEAD"))
        throw new GitError(
          "Files changed while the snapshot was taken. Wait for saves to finish and retry.",
        );
      return first;
    });
    return this.commitTree(tree, head, "latex-review snapshot");
  }
  commitWith(
    parent: string,
    contents: Record<string, Buffer | null>,
    message: string,
  ) {
    const tree = temporary("latex-review-index-", (folder) => {
      const env = {
        ...process.env,
        GIT_INDEX_FILE: path.join(folder, "index"),
      };
      this.run(["read-tree", parent], { env });
      for (const [file, data] of Object.entries(contents).sort()) {
        if (data === null)
          this.run(["update-index", "--force-remove", "--", file], { env });
        else
          this.run(
            [
              "update-index",
              "--add",
              "--cacheinfo",
              `${this.mode(parent, file) || "100644"},${this.hashObject(data)},${file}`,
            ],
            { env },
          );
      }
      return this.text(["write-tree"], { env });
    });
    return this.commitTree(tree, parent, message);
  }
  export(rev: string, folder: string, destination: string) {
    fs.mkdirSync(destination, { recursive: true });
    const files = this.files(rev, folder),
      blobs = this.blobs(rev, files);
    const links: [string, string][] = [];
    for (const file of files) {
      const relative = path.posix.relative(folder || ".", file);
      cleanPath(relative);
      const target = path.join(destination, relative),
        data = blobs[file];
      if (data === null) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const mode = this.mode(rev, file);
      if (mode === "120000") {
        const link = data.toString(),
          resolved = path.resolve(path.dirname(target), link);
        if (
          path.isAbsolute(link) ||
          !resolved.startsWith(path.resolve(destination) + path.sep)
        )
          throw new GitError(
            `A link in the snapshot points outside the document: ${file}`,
          );
        links.push([target, link]);
      } else
        fs.writeFileSync(target, data, {
          mode: mode === "100755" ? 0o755 : 0o644,
        });
    }
    for (const [target, link] of links) fs.symlinkSync(link, target);
  }
}
export function merge3(
  ours: Buffer | null,
  base: Buffer | null,
  theirs: Buffer | null,
): [Buffer | null, boolean] {
  if (same(ours, base) || same(ours, theirs)) return [theirs, false];
  if (same(theirs, base)) return [ours, false];
  if (
    ours === null ||
    base === null ||
    theirs === null ||
    [ours, base, theirs].some((b) => b.includes(0))
  )
    return [null, true];
  return temporary("latex-review-merge-", (folder) => {
    const files = ["ours", "base", "theirs"].map((name) =>
      path.join(folder, name),
    );
    [ours, base, theirs].forEach((data, i) => fs.writeFileSync(files[i], data));
    const result = run(gitBinary(), ["merge-file", "-p", ...files], {
      check: false,
    });
    return [result.stdout, result.status !== 0];
  });
}
