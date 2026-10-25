import fs from "node:fs";
import path from "node:path";
import { run } from "../core/process.ts";
import { argument, buildOutline } from "../core/outline.ts";
import { listFiles } from "../core/files.ts";
import { PdfDocument, type PdfPage, type OutlineEntry } from "./pdf.ts";
import type {
  BuildInfo,
  Heading,
  Position,
  Span,
  SourceBox,
} from "../types.ts";
const MAX_LOOKUPS = 80;
const BOUNDARY =
  /^\s*\\(?:\[|\]|begin\{|end\{|input\{|include\{|(?:sub)*section\*?\{|chapter\*?\{|paragraph\{)/;
export type Box = SourceBox;
export type Intervals = Map<number, Span[]>;
export class Build {
  document: PdfDocument;
  locator: Locator;
  margins: Margins;
  figures: FigureLocator;
  outline: Heading[];
  constructor(
    public info: BuildInfo,
    public main: string,
    public sourceDir: string,
  ) {
    this.document = new PdfDocument(info.pdf);
    this.margins = new Margins(this.document);
    this.locator = new Locator(this);
    this.outline = buildOutline((n) => this.read(n), main).nodes;
    this.figures = new FigureLocator(this);
  }
  path(name: string) {
    return path.join(
      this.info.root,
      path.posix.relative(this.sourceDir || ".", name),
    );
  }
  read(name: string) {
    const file = this.path(name);
    return fs.existsSync(file) && fs.statSync(file).isFile()
      ? fs.readFileSync(file, "utf8")
      : null;
  }
  close() {
    this.document.close();
  }
}
export function sourceRange(
  lines: string[],
  start: number,
  end: number,
  whole = false,
): Span {
  if (!lines.length) return [1, 0];
  if (whole) return [1, lines.length];
  start = Math.min(Math.max(1, start), lines.length);
  end = Math.min(Math.max(1, end), lines.length);
  const lower = Math.max(1, start - 60),
    upper = Math.min(lines.length, end + 60);
  while (
    start > lower &&
    lines[start - 2].trim() &&
    !BOUNDARY.test(lines[start - 2])
  )
    start--;
  while (end < upper && lines[end].trim() && !BOUNDARY.test(lines[end])) end++;
  return [start, end];
}
export function textBounds(page: PdfPage): Span {
  const blocks = page.blocks.filter((b) => b.text.trim());
  return blocks.length
    ? [
        Math.max(0, Math.min(...blocks.map((b) => b.rect[0])) - 8),
        Math.min(page.width, Math.max(...blocks.map((b) => b.rect[2])) + 8),
      ]
    : [0, page.width];
}
const textBlocks = (page: PdfPage) =>
  page.blocks
    .filter((b) => b.text.trim())
    .sort((a, b) => a.rect[1] - b.rect[1]);
export class Margins {
  header: number | null = null;
  footer: number | null = null;
  constructor(document: PdfDocument) {
    const sample =
        document.length > 40
          ? [
              ...new Set(
                Array.from({ length: 40 }, (_, i) =>
                  Math.round((i * (document.length - 1)) / 39),
                ),
              ),
            ]
          : Array.from({ length: document.length }, (_, i) => i),
      tops = new Map<number, number>(),
      bottoms = new Map<number, number>();
    const add = (counts: Map<number, number>, n: number) =>
      counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const number of sample) {
      const blocks = textBlocks(document.page(number));
      if (blocks.length < 2) continue;
      if (blocks[1].rect[1] - blocks[0].rect[3] >= 8)
        add(tops, Math.round(blocks[0].rect[3]));
      if (
        blocks.at(-1)!.rect[1] -
          Math.max(...blocks.slice(0, -1).map((b) => b.rect[3])) >=
        8
      )
        add(bottoms, Math.round(blocks.at(-1)!.rect[1]));
    }
    const best = (counts: Map<number, number>) =>
        [...counts].sort((a, b) => b[1] - a[1])[0],
      top = best(tops),
      bottom = best(bottoms),
      needed = Math.max(3, 0.3 * sample.length);
    if (top && top[1] >= needed) this.header = top[0] + 1;
    if (bottom && bottom[1] >= needed) this.footer = bottom[0] - 1;
  }
  body(page: PdfPage): Span {
    const blocks = textBlocks(page).filter(
      (b) =>
        !(this.header !== null && b.rect[3] <= this.header + 1) &&
        !(this.footer !== null && b.rect[1] >= this.footer - 1),
    );
    return blocks.length
      ? [
          Math.max(0, Math.min(...blocks.map((b) => b.rect[1])) - 6),
          Math.min(page.height, Math.max(...blocks.map((b) => b.rect[3])) + 6),
        ]
      : [(this.header ?? 36) + 4, (this.footer ?? page.height - 36) - 4];
  }
}
export class Locator {
  cache = new Map<string, Box[]>();
  constructor(public build: Build) {}
  lookup(file: string, line: number): Box[] {
    const key = `${file}:${line}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const result = run(
        "synctex",
        ["view", "-i", `${line}:0:${file}`, "-o", this.build.info.pdf],
        { check: false },
      ).stdout.toString(),
      records: Box[] = [],
      shipped = new Set<number>(),
      margins = this.build.margins;
    for (const block of result.split(/^Page:/m).slice(1)) {
      const fields = Object.fromEntries(
          [...block.matchAll(/^(x|y|h|v|W|H):([\d.+-]+)/gm)].map((m) => [
            m[1],
            Number(m[2]),
          ]),
        ),
        page = Number(block.split("\n")[0]) - 1,
        { y, v, H: height } = fields;
      if (
        ![page, y, v, height].every(Number.isFinite) ||
        y < v - height - 4 ||
        y > v + 4
      )
        continue;
      if (
        (margins.header !== null && y < margins.header) ||
        (margins.footer !== null && y > margins.footer)
      )
        shipped.add(page);
      else
        records.push([
          page,
          Math.min(y, v - height),
          Math.max(y, v),
          fields.h,
          fields.h + fields.W,
        ]);
    }
    const filtered = records.filter((r) => !shipped.has(r[0]));
    this.cache.set(key, filtered);
    return filtered;
  }
  boxes(name: string, start: number, end: number) {
    const file = this.build.path(name);
    if (!fs.existsSync(file) || path.extname(file) !== ".tex") return [];
    const result: Box[] = [];
    for (
      let line = Math.max(1, start);
      line <= end && line < Math.max(1, start) + MAX_LOOKUPS;
      line++
    )
      result.push(...this.lookup(file, line));
    return result;
  }
  locate(name: string, start: number, end: number, whole = false): Position[] {
    const file = this.build.path(name);
    if (!fs.existsSync(file) || path.extname(file) !== ".tex") return [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    [start, end] = sourceRange(lines, start, end, whole);
    let wanted = Array.from(
      { length: Math.max(0, end - start + 1) },
      (_, i) => i + start,
    ).filter(
      (n) => lines[n - 1].trim() && !lines[n - 1].trimStart().startsWith("%"),
    );
    if (wanted.length > MAX_LOOKUPS) {
      const step = wanted.length / MAX_LOOKUPS;
      wanted = [
        ...new Set([
          ...Array.from(
            { length: MAX_LOOKUPS },
            (_, i) => wanted[Math.floor(i * step)],
          ),
          wanted[0],
          wanted.at(-1)!,
        ]),
      ].sort((a, b) => a - b);
    }
    const positions = new Map<
      string,
      { page: number; column: number; points: Span[] }
    >();
    for (const n of wanted)
      for (const [page, y0, y1, x0, x1] of this.lookup(file, n))
        if (page >= 0 && page < this.build.document.length) {
          const column =
            !whole && x0 !== undefined && x1 !== undefined
              ? this.build.document.page(page).column([x0, y0, x1, y1])
              : -1;
          const key = `${page}:${column}`;
          if (!positions.has(key))
            positions.set(key, { page, column, points: [] });
          positions.get(key)!.points.push([y0, y1]);
        }
    return [...positions.values()]
      .sort((a, b) => a.page - b.page || a.column - b.column)
      .map(({ page: number, column, points }) => {
        const page = this.build.document.page(number),
          [columnLeft, columnRight] = page.columnBounds(column);
        let top = Math.max(0, Math.min(...points.map((p) => p[0])) - 14),
          bottom = Math.min(
            page.height,
            Math.max(...points.map((p) => p[1])) + 16,
          );
        for (const block of page.blocks)
          if (
            block.rect[1] < bottom &&
            block.rect[3] > top &&
            block.rect[0] < columnRight &&
            block.rect[2] > columnLeft &&
            block.rect[3] - block.rect[1] < 180
          ) {
            top = Math.min(top, block.rect[1] - 8);
            bottom = Math.max(bottom, block.rect[3] + 8);
          }
        const [bodyTop, bodyBottom] = this.build.margins.body(page);
        top = Math.max(
          top,
          Math.min(bodyTop, Math.min(...points.map((p) => p[0]))),
        );
        bottom = Math.min(
          bottom,
          Math.max(bodyBottom, Math.max(...points.map((p) => p[1]))),
        );
        const [left, right] = textBounds(page);
        return {
          page: number,
          clip: [
            Math.max(left, columnLeft),
            Math.max(0, top),
            Math.min(right, columnRight),
            Math.min(page.height, bottom),
          ],
          label: page.label,
        };
      });
  }
}
const FLOAT_STRUCTURE =
  /^\s*(%|\\(begin|end)\{(figure|table)\*?\}|\\(caption|label|centering)\b)/;
export const contentLines = (text: string) =>
  text
    .split("\n")
    .flatMap((line, i) =>
      line.trim() && !FLOAT_STRUCTURE.test(line) ? [i + 1] : [],
    );
export class FigureLocator {
  labels = new Map<string, [string, string]>();
  constructor(public build: Build) {
    for (const file of listFiles(path.dirname(build.info.pdf)).filter((f) =>
      f.endsWith(".aux"),
    ))
      for (const line of fs.readFileSync(file, "utf8").split("\n"))
        if (line.startsWith("\\newlabel")) {
          const [label, end] = argument(line, "\\newlabel".length),
            [value] = argument(line, end);
          if (!value || !label) continue;
          const fields: string[] = [];
          let i = 0;
          while (i < value.length) {
            const [field, next] = argument(value, i);
            if (field === null) break;
            fields.push(field);
            i = next;
          }
          if (fields.length >= 4)
            this.labels.set(label, [fields[0], fields[3]]);
        }
  }
  locate(name: string): Position[] {
    const text = this.build.read(name);
    if (text === null) return [];
    const result: Position[] = [];
    for (const match of text.matchAll(/\\label\{([^}]+)\}/g)) {
      const [number, anchor] = this.labels.get(match[1]) ?? ["", ""],
        destination = this.build.document.destination(
          "#nameddest=" + encodeURIComponent(anchor),
        );
      if (!destination || !anchor.startsWith("figure.")) continue;
      const page = this.build.document.page(destination.page);
      let top = destination.y;
      const captions = [
        "Figure ",
        "Fig. ",
        "Abbildung ",
        "Figure~",
        "图 ",
        "图",
      ].flatMap((prefix) =>
        [":", "："].flatMap((colon) => page.search(prefix + number + colon)),
      );
      if (!captions.length) continue;
      const caption = captions.sort(
          (a, b) => Math.abs(a[1] - top) - Math.abs(b[1] - top),
        )[0],
        bottom =
          Math.max(
            caption[3],
            ...page.blocks
              .filter((b) => b.rect[1] < caption[3] && b.rect[3] > caption[1])
              .map((b) => b.rect[3]),
          ) + 10;
      const content = contentLines(text)
        .slice(0, MAX_LOOKUPS)
        .flatMap((line) =>
          this.build.locator.lookup(this.build.path(name), line),
        )
        .filter(
          ([p, y0]) =>
            p === destination.page &&
            caption[1] - 0.8 * page.height < y0 &&
            y0 < caption[1],
        )
        .map(([, y0]) => y0);
      top = Math.min(top, ...content);
      const [left, right] = textBounds(page);
      result.push({
        page: destination.page,
        clip: [left, Math.max(0, top - 6), right, bottom],
        label: page.label,
      });
    }
    return result;
  }
}
export function entryFor(node: Heading, toc: OutlineEntry[]) {
  const names = [
    node.kind + "." + node.number,
    ...(["chapter", "section"].includes(node.kind)
      ? ["appendix." + node.number]
      : []),
  ];
  let matches = toc.flatMap((row, i) => (names.includes(row.name) ? [i] : []));
  if (!matches.length)
    matches = toc.flatMap((row, i) =>
      row.title.trim().toLowerCase() === node.title.trim().toLowerCase() ||
      row.title.trim().toLowerCase() ===
        `${node.number} ${node.title}`.trim().toLowerCase()
        ? [i]
        : [],
    );
  if (matches.length !== 1)
    throw new Error(
      `Heading ${node.number} ${JSON.stringify(node.title)} is not uniquely in the PDF outline.`,
    );
  return matches[0];
}
export function position(
  document: PdfDocument,
  row: OutlineEntry,
): [number, number] {
  if (row.page < 0 || row.page >= document.length)
    throw new Error("The heading is outside this PDF.");
  return [row.page, Math.max(0, row.y - 4)];
}
export function addInterval(
  intervals: Intervals,
  page: number,
  top: number,
  bottom: number,
) {
  if (bottom - top <= 2) return;
  const merged: Span[] = [];
  for (const [a, b] of [
    ...(intervals.get(page) ?? []),
    [top, bottom] as Span,
  ].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 20) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  intervals.set(page, merged);
}
export function subtractInterval(
  intervals: Intervals,
  page: number,
  top: number,
  bottom: number,
) {
  intervals.set(
    page,
    (intervals.get(page) ?? []).flatMap(([a, b]) =>
      b <= top || a >= bottom
        ? [[a, b] as Span]
        : [
            ...(top - a > 2 ? [[a, top] as Span] : []),
            ...(b - bottom > 2 ? [[bottom, b] as Span] : []),
          ],
    ),
  );
}
export function sectionIntervals(
  build: Build,
  node: Heading,
  figureFiles: (file: string) => boolean,
): [Intervals, string[]] {
  const document = build.document,
    toc = document.outline,
    index = entryFor(node, toc),
    [startPage, top] = position(document, toc[index]),
    boundary = toc
      .slice(index + 1)
      .find((row) => row.level <= toc[index].level && row.page >= 0),
    [endPage, bottom] = boundary
      ? position(document, boundary)
      : [document.length - 1, document.page(document.length - 1).height - 60],
    intervals: Intervals = new Map();
  for (let page = startPage; page <= endPage; page++) {
    const [bodyTop, bodyBottom] = build.margins.body(document.page(page));
    addInterval(
      intervals,
      page,
      page === startPage ? top : bodyTop,
      page === endPage ? bottom : bodyBottom,
    );
  }
  const own = new Set(node.files.filter(figureFiles));
  const following = boundary
    ? build.outline.find((candidate) => {
        try {
          return toc[entryFor(candidate, toc)] === boundary;
        } catch {
          return false;
        }
      })
    : null;
  if (following)
    for (const file of following.files)
      if (!own.has(file) && figureFiles(file))
        for (const r of build.figures.locate(file))
          subtractInterval(intervals, r.page, r.clip[1], r.clip[3]);
  const missing: string[] = [];
  for (const file of own) {
    const found = build.figures.locate(file);
    if (!found.length) missing.push(file);
    for (const r of found) addInterval(intervals, r.page, r.clip[1], r.clip[3]);
  }
  return [intervals, missing];
}
