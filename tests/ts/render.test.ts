import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import { mupdf, PdfDocument, containsCenter } from "../../src/render/pdf.ts";
import { textChanges, pixelDifference } from "../../src/render/pdfdiff.ts";
import {
  Strips,
  textRows,
  balancedTextPairs,
  withoutMoves,
  changedLineBounds,
  foldContext,
} from "../../src/render/inline.ts";
import { typesetWords } from "../../src/render/round.ts";
import { opcodes } from "../../src/core/diff.ts";
import type { Card, Position } from "../../src/types.ts";
const documents: PdfDocument[] = [];
const folders: string[] = [];
it("keeps at least a page of context on each side of an isolated edit", () => {
  const plan = foldContext([
    { kind: "context", page: 0, top: 0, bottom: 2000 },
    { kind: "change", page: 0, top: 2000, bottom: 2050 },
    { kind: "context", page: 0, top: 2050, bottom: 4000 },
  ]);
  const visible = plan.filter((p) => p.kind === "context");
  expect(visible).toHaveLength(2);
  for (const part of visible)
    if (part.kind === "context")
      expect(part.bottom - part.top).toBeGreaterThanOrEqual(720);
});
export function document(pages: string[]) {
  const doc = new mupdf.PDFDocument(),
    font = new mupdf.Font("Helvetica"),
    resource = doc.addSimpleFont(font);
  for (const text of pages) {
    const content =
      "BT /F1 12 Tf 30 550 Td 18 TL " +
      text
        .split("\n")
        .map(
          (line, i) =>
            (i ? "T* " : "") + "(" + line.replace(/[()\\]/g, "\\$&") + ") Tj",
        )
        .join("\n") +
      " ET";
    const page = doc.addPage(
      [0, 0, 600, 600],
      0,
      { Font: { F1: resource } },
      content,
    );
    doc.insertPage(-1, page);
    page.destroy();
  }
  const buffer = doc.saveToBuffer("");
  const result = new PdfDocument(buffer.asUint8Array());
  buffer.destroy();
  resource.destroy();
  font.destroy();
  doc.destroy();
  documents.push(result);
  return result;
}
const positions = (doc: PdfDocument): Position[] =>
  Array.from({ length: doc.length }, (_, page) => ({
    page,
    clip: [0, 0, 600, 600],
    label: String(page + 1),
  }));
const compare = (a: PdfDocument, b: PdfDocument) =>
  textChanges(a, b, positions(a), positions(b));
afterEach(() => {
  documents.splice(0).forEach((d) => d.close());
  folders
    .splice(0)
    .forEach((f) => fs.rmSync(f, { recursive: true, force: true }));
});
it("marks whole words including deleted suffixes", () => {
  const old = document([
      "Since a type variable's meaning now depends on its bound,\nour two new guards must also be context-aware.",
    ]),
    next = document([
      "Since type variables now depend on their bounds, both guards must be context-aware.",
    ]),
    result = compare(old, next);
  const marked = next
    .page(0)
    .words.filter((w) =>
      result.new_marks[0].some((m) => containsCenter(m.rect, w.rect)),
    )
    .map((w) => w.text);
  expect(marked).toEqual(["variables", "depend", "their", "bounds,", "both"]);
});
it("does not mark unchanged words following a replacement", () => {
  const old = document(["The extensions add the following types."]),
    next = document(["We add the following types."]),
    result = compare(old, next);
  expect(result.edits).toEqual([
    { old: "The extensions", new: "We", truncated: false },
  ]);
  expect(
    result.new_marks[0].every(
      (m) => m.rect[2] <= next.page(0).search("We")[0][2] + 0.1,
    ),
  ).toBe(true);
});
it("ignores partial adjacent-line glyphs at crop edges", () => {
  const old = document(["Unchanged context\nThe old word."]),
    next = document(["Unchanged context\nThe new word."]),
    a = positions(old),
    b = positions(next);
  a[0].clip[1] = old.page(0).search("context")[0][3] - 0.5;
  b[0].clip[1] = next.page(0).search("context")[0][3] + 0.5;
  expect(textChanges(old, next, a, b).edits).toEqual([
    { old: "old", new: "new", truncated: false },
  ]);
});
it.each([
  ["the bounds", "the\nbounds"],
  ["A func-\ntion returns.", "A function returns."],
  ["alpha beta gamma delta", "alpha beta\ngamma delta"],
])("treats wrapping and hyphenation as movement", (a, b) => {
  const result = compare(document([a]), document([b]));
  expect(result.text_changed).toBe(false);
  expect(result.moved).toBe(true);
});
it.each([
  ["now here", "nowhere"],
  ["order-irrelevant", "orderirrelevant"],
  ["x + y", "x - y"],
])("detects semantic differences %s", (a, b) =>
  expect(compare(document([a]), document([b])).text_changed).toBe(true),
);
it("handles page relocation and empty sides", () => {
  const old = document(["alpha beta gamma delta"]),
    next = document(["alpha beta", "gamma delta"]);
  expect(compare(old, next).text_changed).toBe(false);
  const added = textChanges(null, next, [], positions(next));
  expect(added.old_marks).toEqual({});
  expect(added.new_marks[1]).toBeTruthy();
  expect(
    pixelDifference(null, next.page(0).raster([0, 20, 600, 100])),
  ).toBeGreaterThan(0);
});
it("detects pixel and color changes", () => {
  const raster = {
      width: 1,
      height: 1,
      channels: 3,
      stride: 3,
      pixels: new Uint8Array([255, 0, 0]),
    },
    other = { ...raster, pixels: new Uint8Array([0, 130, 0]) };
  expect(pixelDifference(raster, raster)).toBe(0);
  expect(pixelDifference(raster, other)).toBe(1);
});
it("distinguishes comments and rewrapping from paragraph changes", () => {
  expect(typesetWords("binds $x$, checks $e$.\n")).toEqual(
    typesetWords("binds $x$,\n  checks $e$.\n"),
  );
  expect(typesetWords("a % old note\nb\n")).toEqual(
    typesetWords("a % new note\nb\n"),
  );
  expect(typesetWords("one\n\ntwo\n")).not.toEqual(typesetWords("one two\n"));
});
it("emits vector strips with selectable text and unmarked clean version", () => {
  const doc = document(["A changed word"]),
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "review-strip-"));
  folders.push(folder);
  const strip = new Strips(folder).write(
    doc,
    0,
    20,
    100,
    [{ kind: "added", rect: doc.page(0).search("changed")[0] }],
    "new",
  )!;
  expect(strip.text?.map((l) => l.text).join(" ")).toBe("A changed word");
  expect(strip.height).toBe(80);
  expect(fs.readFileSync(path.join(folder, strip.src), "utf8")).toContain(
    "<svg",
  );
  expect(fs.readFileSync(path.join(folder, strip.src), "utf8")).not.toBe(
    fs.readFileSync(path.join(folder, strip.clean), "utf8"),
  );
  expect(doc.page(0).text()).toBe("A changed word");
});
it("keeps a moved float outside the edit and pairs relocated sentences", () => {
  const unchanged = Array.from(
    { length: 6 },
    (_, i) => `Figure row ${i} with unchanged rules`,
  );
  const old = document([
      "Since a type variable's meaning now depends on its bound,\nour two new guards must also be context-aware.",
      unchanged.join("\n"),
    ]),
    next = document([
      unchanged.join("\n"),
      "Since type variables now depend on their bounds, both guards must be context-aware.",
    ]);
  const intervals = new Map([
      [0, [[0, 600] as [number, number]]],
      [1, [[0, 600] as [number, number]]],
    ]),
    a = textRows(old, intervals),
    b = textRows(next, intervals),
    ops = opcodes(
      a.map((r) => r.text),
      b.map((r) => r.text),
    );
  const card: Card = {
    id: "c001",
    file: "main.tex",
    comparison: "text",
    pairs: [
      {
        old: positions(old)[0],
        new: positions(next)[1],
        before_marks: [],
        after_marks: [],
      },
    ],
    own: { old: [[0, 35, 90]], new: [[1, 35, 70]] },
  };
  const pairs = balancedTextPairs(card, a, b, ops, old, next)!;
  expect(pairs).toHaveLength(1);
  expect(pairs[0].old?.page).toBe(0);
  expect(pairs[0].new?.page).toBe(1);
  expect(old.page(0).text(pairs[0].old!.clip)).toContain("context-aware.");
  expect(next.page(1).text(pairs[0].new!.clip)).not.toContain("Figure");
});
it("filters moved unchanged lines", () => {
  const a = ["a", "b", "moved 1", "moved 2", "float 1", "float 2", "edited"],
    b = ["a", "b", "float 1", "float 2", "moved 1", "moved 2", "edited, new"];
  expect(withoutMoves(opcodes(a, b), a, b)).toEqual([["replace", 6, 7, 6, 7]]);
});
it("does not expand a word edit into the preceding heading", () => {
  const doc = document(["Section heading\nWe changed this word."]);
  const [top, bottom] = changedLineBounds(doc, positions(doc)[0], [
    { kind: "added", rect: doc.page(0).search("changed")[0] },
  ]);
  expect(doc.page(0).text([0, top, 600, bottom])).toBe("We changed this word.");
});
it("comment-only lines neither create paragraphs nor introduce spaces", () => {
  expect(typesetWords("a\n% annotation\nb\n")).toEqual(typesetWords("a\nb\n"));
  expect(typesetWords("foo% annotation\n  bar")).toEqual(
    typesetWords("foobar"),
  );
  expect(typesetWords("100\\% sure")).not.toEqual(typesetWords("100% sure"));
  expect(typesetWords("a\\\\% comment\nb")).toEqual(typesetWords("a\\\\b"));
});
