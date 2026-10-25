import fs from "node:fs";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { Fixture, METHOD, BODY, MAIN } from "./helpers.ts";
import { cleanPath, merge3, within } from "../../src/core/git.ts";
import { loadProject, detectMain } from "../../src/core/config.ts";
import {
  buildOutline,
  resolveSections,
  selectedRanges,
  deepestNode,
} from "../../src/core/outline.ts";
import {
  diffUnits,
  applyUnits,
  revertUnits,
  scopeViolations,
} from "../../src/core/changes.ts";
import { affectedTargets, errors, warnings } from "../../src/core/build.ts";
import { wordDiff } from "../../src/web/model.ts";
let f: Fixture;
beforeEach(() => {
  f = new Fixture();
});
afterEach(async () => f.close());
describe("Git snapshots", () => {
  it("preserves HEAD and index including staged and unstaged changes", () => {
    f.write("paper/main.tex", "staged\n");
    f.write("notes.txt", "staged outside source\n");
    f.repo.run(["add", "."]);
    f.write("paper/main.tex", "unstaged\n");
    f.write("paper/new.tex", "new\n");
    f.write("elsewhere.tex", "outside\n");
    const head = f.repo.rev("HEAD"),
      index = fs.readFileSync(path.join(f.root, ".git/index")),
      rev = f.repo.snapshot(["paper"]);
    expect(f.repo.blob(rev, "paper/main.tex")?.toString()).toBe("unstaged\n");
    expect(f.repo.blob(rev, "paper/new.tex")).not.toBeNull();
    expect(f.repo.blob(rev, "notes.txt")).not.toBeNull();
    expect(f.repo.blob(rev, "elsewhere.tex")).toBeNull();
    expect(f.repo.rev("HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(f.root, ".git/index"))).toEqual(index);
  });
  it("reads missing files, privately commits added/deleted files and exports", () => {
    const head = f.repo.rev("HEAD");
    expect(f.repo.blobs(head, ["paper/main.tex", "missing", "paper"])).toEqual({
      "paper/main.tex": Buffer.from(MAIN),
      missing: null,
      paper: null,
    });
    const rev = f.repo.commitWith(
      head,
      {
        [METHOD]: null,
        "paper/main.tex": Buffer.from("changed\n"),
        "new.tex": Buffer.from("new"),
      },
      "test",
    );
    expect(f.repo.changedFiles(head, rev)).toEqual([
      "new.tex",
      "paper/main.tex",
      METHOD,
    ]);
    expect(f.repo.rev("HEAD")).toBe(head);
    const out = path.join(f.base, "export");
    f.repo.export(head, "paper", out);
    expect(fs.readFileSync(path.join(out, "main.tex"), "utf8")).toBe(MAIN);
  });
  it("rejects escaping exported symlinks", () => {
    fs.symlinkSync("../../outside", path.join(f.root, "paper/link"));
    const rev = f.repo.snapshot(["paper"]);
    expect(() =>
      f.repo.export(rev, "paper", path.join(f.base, "export")),
    ).toThrow("outside");
  });
  it.each(["../x", "/etc/passwd", ".git/config"])(
    "rejects unsafe path %s",
    (value) => expect(() => cleanPath(value)).toThrow(),
  );
  it("merges independent edits and reports overlaps", () => {
    const b = (s: string) => Buffer.from(s);
    expect(
      merge3(b("A\nb\nc\nd\ne\n"), b("a\nb\nc\nd\ne\n"), b("a\nb\nc\nd\nE\n")),
    ).toEqual([b("A\nb\nc\nd\nE\n"), false]);
    expect(merge3(b("x\n"), b("a\n"), b("y\n"))[1]).toBe(true);
    expect(merge3(null, b("a"), null)).toEqual([null, false]);
    expect(within("paper-old/a", ["paper"])).toBe(false);
    expect(cleanPath("./paper/")).toBe("paper");
  });
});
describe("configuration", () => {
  it("detects main and source directory", () => {
    expect(detectMain(f.root)).toBe("paper/main.tex");
    expect(loadProject(f.root)).toMatchObject({
      main: "paper/main.tex",
      source_dir: "paper",
      engine: "pdflatex",
      build_workers: 1,
    });
  });
  it("detects magic engine and latexmk defaults", () => {
    f.write("paper/main.tex", "% !TeX program = lualatex\n" + MAIN);
    expect(loadProject(f.root).engine).toBe("lualatex");
    f.write("paper/main.tex", MAIN);
    f.write("paper/latexmkrc", "@default_files=('main.tex');\n$pdf_mode = 5;");
    expect(loadProject(f.root).engine).toBe("xelatex");
  });
  it.each([
    { mian: "x" },
    { engine: "tex" },
    { main: "missing.tex" },
    { source_dir: "other" },
    { worktrees: "inside" },
    ...[0, 9, true, "2", 1.5].map((build_workers) => ({ build_workers })),
    { figures: "no" },
    { preload: null },
    { dependencies: [] },
    { partial_builds: "false" },
  ])("rejects invalid settings %j", (settings) => {
    f.write(".latex-review.json", JSON.stringify(settings));
    expect(() => loadProject(f.root)).toThrow();
  });
  it("does not silently ignore malformed JSON", () => {
    f.write(".latex-review.json", "{broken");
    expect(() => loadProject(f.root)).toThrow("not valid JSON");
  });
});
describe("outline and units", () => {
  it("selects labeled sections and nested ranges", () => {
    const files: Record<string, string> = {
        "paper/main.tex": MAIN,
        [METHOD]: BODY,
      },
      nodes = buildOutline(
        (name) => files[name] ?? null,
        "paper/main.tex",
      ).nodes;
    expect(nodes.map((n) => [n.number, n.title])).toEqual([
      ["1", "Introduction"],
      ["2", "Method"],
      ["2.1", "Details"],
      ["3", "Conclusion"],
    ]);
    expect(
      resolveSections(nodes, ["2", "sec:method", "label:sec:method"]),
    ).toEqual(["label:sec:method"]);
    const [ranges] = selectedRanges(nodes, ["label:sec:method"]);
    expect(ranges[METHOD]).toEqual([[1, 44]]);
    expect(deepestNode(nodes, METHOD, 30, 30)?.title).toBe("Details");
  });
  it("groups nearby edits and applies distant hunks independently", () => {
    const head = f.repo.rev("HEAD");
    f.write(
      METHOD,
      BODY.replace("Method sentence 1.", "One.")
        .replace("Method sentence 3.", "Three.")
        .replace("Detail sentence 12.", "Twelve."),
    );
    const after = f.repo.snapshot(["paper"]),
      units = diffUnits(f.repo, head, after);
    expect(units).toHaveLength(2);
    const old = f.repo.blob(head, METHOD),
      next = f.repo.blob(after, METHOD);
    expect(applyUnits(old, next, [units[1]])?.toString()).toBe(
      BODY.replace("Detail sentence 12.", "Twelve."),
    );
    expect(revertUnits(old, next, units)).toEqual(old);
    expect(applyUnits(old, next, units)).toEqual(next);
  });
  it("preserves missing final newline and binary files", () => {
    const head = f.repo.rev("HEAD");
    f.write(METHOD, BODY + "Appended");
    f.write("paper/a.bin", Buffer.from([0, 1]));
    const after = f.repo.snapshot(["paper"]),
      units = diffUnits(f.repo, head, after);
    expect(units.find((u) => u.kind === "binary")?.whole_file).toBe(true);
    expect(
      applyUnits(
        f.repo.blob(head, METHOD),
        f.repo.blob(after, METHOD),
        units.filter((u) => u.file === METHOD),
      )?.toString(),
    ).toBe(BODY + "Appended");
  });
  it("enforces line and file scope", () => {
    const head = f.repo.rev("HEAD"),
      scope = {
        ranges: { [METHOD]: [[4, 10] as [number, number]] },
        paths: [METHOD],
        sections: [],
      };
    f.write(METHOD, BODY.replace("Method sentence 5.", "Inside."));
    expect(
      scopeViolations(f.repo, head, f.repo.snapshot(["paper"]), scope),
    ).toEqual([]);
    f.write(METHOD, BODY.replace("Method sentence 15.", "Outside."));
    expect(
      scopeViolations(f.repo, head, f.repo.snapshot(["paper"]), scope),
    ).toEqual([METHOD + ":18"]);
  });
});
describe("compiler diagnostics and source diff", () => {
  it("resolves shared input owners and falls back for global files", () => {
    const files = {
      "a.tex": "\\input{shared}",
      "b.tex": "\\input{shared}",
      "shared.tex": "text",
      "main.tex": "root",
    };
    expect(affectedTargets(files, ["shared.tex"], ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(affectedTargets(files, ["main.tex"], ["a", "b"])).toEqual(["full"]);
  });
  it("extracts compiler warnings and errors", () => {
    expect(
      warnings(
        "LaTeX Warning: Reference `missing' on page 1 undefined\nLaTeX Warning: Label `dup' multiply defined",
      ),
    ).toEqual(["Label defined twice: dup", "Undefined reference: missing"]);
    expect(errors("! Undefined control sequence.\nl.4 \\broken")).toEqual([
      "Undefined control sequence.  [l.4 \\broken]",
    ]);
  });
  it.each([
    ["one old word", "one new term"],
    ["a b c", "x b y"],
    [
      "\\noindent Since a type variable's meaning now\ndepends on its bound, our two new guards must also be context-aware.",
      "\\noindent Since type variables now depend on their bounds, both guards must be context-aware.",
    ],
  ])("source diff reconstructs both inputs", (before, after) => {
    const diff = wordDiff(before, after);
    expect(
      diff
        .filter((p) => p.type !== "ins")
        .map((p) => p.text)
        .join(""),
    ).toBe(before);
    expect(
      diff
        .filter((p) => p.type !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe(after);
  });
});
it("seeded edit sequences reconstruct both sides through arbitrary hunk subsets", () => {
  let seed = 0x5eed123;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const before = Array.from(
      { length: 45 },
      (_, i) => `line ${i}: repeated text\n`,
    ).join(""),
    head = f.repo.commitWith(
      f.repo.rev("HEAD"),
      { [METHOD]: Buffer.from(before) },
      "fuzz baseline",
    );
  for (let sample = 0; sample < 100; sample++) {
    const lines = before.match(/[^\n]*\n/g)!;
    for (let k = 0; k < 8; k++) {
      const index = random(lines.length + 1),
        kind = random(3);
      lines.splice(
        index,
        kind === 0 ? 0 : 1,
        ...(kind === 1 ? [] : [`mutation ${sample}-${k}: α beta\\gamma\n`]),
      );
    }
    if (random(2)) lines[lines.length - 1] = lines.at(-1)!.trimEnd();
    const next = Buffer.from(lines.join("")),
      after = f.repo.commitWith(head, { [METHOD]: next }, "fuzz snapshot"),
      units = diffUnits(f.repo, head, after),
      old = Buffer.from(before);
    expect(applyUnits(old, next, units)).toEqual(next);
    expect(revertUnits(old, next, units)).toEqual(old);
    const chosen = units.filter(() => Boolean(random(2))),
      other = units.filter((u) => !chosen.includes(u));
    expect(applyUnits(old, next, chosen)).toEqual(
      revertUnits(old, next, other),
    );
  }
});
