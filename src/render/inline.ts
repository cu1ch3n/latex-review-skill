import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { opcodes as compare, similarity } from "../core/diff.ts";
import type {
  Block,
  Card,
  Heading,
  Mark,
  Op,
  Pair,
  Position,
  Rect,
  Span,
  Strip,
} from "../types.ts";
import { Build, sectionIntervals, type Box, type Intervals } from "./locate.ts";
import { containsCenter, intersect, intersects, PdfDocument } from "./pdf.ts";
import { textChanges } from "./pdfdiff.ts";
const RUN_GAP = 3,
  JOIN_GAP = 90,
  MARGIN = 900;
export interface Row {
  page: number;
  rect: Rect;
  text: string;
  column?: number;
}
type Region = [number, number, number, number];
type PairRef = [number, number];
interface Group {
  top: number;
  bottom: number;
  pairs: PairRef[];
}
interface Piece {
  kind: "context" | "change";
  page: number;
  top: number;
  bottom: number;
  pairs?: PairRef[];
  parts?: Box[];
}
type Planned = Piece | { kind: "gap" };
export function textRows(document: PdfDocument, intervals: Intervals): Row[] {
  const rows: Row[] = [];
  for (const [page, spans] of [...intervals].sort((a, b) => a[0] - b[0]))
    for (const line of document.page(page).lines) {
      const text = line.text.trim().replace(/\s+/g, " ");
      if (
        text &&
        spans.some(
          ([a, b]) =>
            a <= (line.rect[1] + line.rect[3]) / 2 &&
            (line.rect[1] + line.rect[3]) / 2 <= b,
        )
      )
        rows.push({
          page,
          rect: line.rect,
          text,
          column: document.page(page).column(line.rect),
        });
    }
  return rows.sort(
    (a, b) =>
      a.page - b.page ||
      (document.page(a.page).twoColumns
        ? 0
        : a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]),
  );
}
export function pairRelocated(
  regions: Region[],
  oldRows: Row[],
  newRows: Row[],
) {
  const removed = regions.filter((r) => r[0] < r[1] && r[2] === r[3]),
    added = regions.filter((r) => r[0] === r[1] && r[2] < r[3]),
    result = regions.filter((r) => !removed.includes(r) && !added.includes(r));
  while (removed.length && added.length) {
    const candidates = removed
        .flatMap((a) =>
          added.map((b) => ({
            a,
            b,
            score: similarity(
              oldRows
                .slice(a[0], a[1])
                .map((r) => r.text)
                .join(" ")
                .split(/\s+/),
              newRows
                .slice(b[2], b[3])
                .map((r) => r.text)
                .join(" ")
                .split(/\s+/),
            ),
          })),
        )
        .sort((a, b) => b.score - a.score),
      { a, b } = candidates[0];
    removed.splice(removed.indexOf(a), 1);
    added.splice(added.indexOf(b), 1);
    let [i, j] = a,
      [, , x, y] = b;
    while (i < j && x < y && oldRows[i].text === newRows[x].text) {
      i++;
      x++;
    }
    while (i < j && x < y && oldRows[j - 1].text === newRows[y - 1].text) {
      j--;
      y--;
    }
    if (i < j || x < y) result.push([i, j, x, y]);
  }
  return [...result, ...removed, ...added].sort(
    (a, b) => a[2] - b[2] || a[0] - b[0],
  );
}
export function aligned(old: Row[], next: Row[]): [Row[], Row[]][] {
  const offsets = (rows: Row[]): [Span[], number] => {
    let total = 0;
    const result = rows.map((r) => {
      const span: Span = [total, total + r.text.length];
      total += r.text.length + 1;
      return span;
    });
    return [result, Math.max(total, 1)];
  };
  const [newOffsets, newTotal] = offsets(next),
    pieces: {
      page: number;
      rows: Row[];
      start: number;
      end: number;
      old: Row[];
    }[] = [];
  next.forEach((row, i) => {
    const [start, end] = newOffsets[i],
      previous = pieces.at(-1);
    if (previous?.page === row.page && previous.rows[0].column === row.column) {
      previous.rows.push(row);
      previous.end = end;
    } else pieces.push({ page: row.page, rows: [row], start, end, old: [] });
  });
  const [spans, oldTotal] = offsets(old);
  old.forEach((row, i) => {
    const middle = ((spans[i][0] + spans[i][1]) / 2 / oldTotal) * newTotal;
    (pieces.find((p) => middle < p.end + 1) ?? pieces.at(-1))?.old.push(row);
  });
  return pieces.map((p) => [p.old, p.rows]);
}
export function lineBefore(
  rows: Row[],
  index: number,
  previousPage = false,
): number | null {
  if (!index) return null;
  if (!previousPage) return index - 1;
  if (index >= rows.length) return null;
  let k = index - 1;
  while (k >= 0 && rows[k].page === rows[index].page) k--;
  return k >= 0 ? k : null;
}
export function balancedTextPairs(
  card: Card,
  oldRows: Row[],
  newRows: Row[],
  opcodes: Op[],
  oldDocument: PdfDocument,
  document: PdfDocument,
): Pair[] | null {
  const own = card.own;
  const touches = (rows: Row[], side: "old" | "new") => {
    if (own && (own.old.length || own.new.length))
      return rows.some((row) =>
        own[side].some(
          ([page, top, bottom, left, right]) =>
            row.page === page &&
            row.rect[1] < bottom &&
            row.rect[3] > top &&
            (left === undefined ||
              right === undefined ||
              !Number.isFinite(left + right) ||
              (row.rect[0] < right && row.rect[2] > left)),
        ),
      );
    return card.pairs.some((pair) => {
      const position = pair[side];
      if (!position) return false;
      const marks = pair[side === "old" ? "before_marks" : "after_marks"],
        rects = marks.length ? marks.map((m) => m.rect) : [position.clip];
      return rows.some(
        (row) =>
          row.page === position.page &&
          rects.some((r) => intersects(row.rect, r)),
      );
    });
  };
  const selected = pairRelocated(
      opcodes
        .filter(
          ([tag, i, j, x, y]) =>
            tag !== "equal" &&
            (touches(oldRows.slice(i, j), "old") ||
              touches(newRows.slice(x, y), "new")),
        )
        .map(([, i, j, x, y]) => [i, j, x, y]),
      oldRows,
      newRows,
    ),
    runs: Region[] = [];
  for (const [i, j, x, y] of selected) {
    const last = runs.at(-1);
    if (
      last &&
      i - last[1] >= 0 &&
      i - last[1] <= RUN_GAP &&
      x - last[3] >= 0 &&
      x - last[3] <= RUN_GAP
    ) {
      last[1] = j;
      last[3] = y;
    } else runs.push([i, j, x, y]);
  }
  if (!runs.length || runs.every(([, , x, y]) => x === y)) return null;
  const positions = (rows: Row[], doc: PdfDocument) => {
    const result: Position[] = [];
    for (const row of rows) {
      const previous = result.at(-1),
        page = doc.page(row.page),
        [left, right] = page.columnBounds(row.column ?? -1);
      if (
        previous?.page === row.page &&
        previous.clip[0] === left &&
        previous.clip[2] === right
      )
        previous.clip[3] = Math.max(previous.clip[3], row.rect[3] + 2);
      else
        result.push({
          page: row.page,
          clip: [left, row.rect[1] - 2, right, row.rect[3] + 2],
          label: page.label,
        });
    }
    return result;
  };
  const left: Position[] = [],
    right: Position[] = [],
    links: [number | null, number | null][] = [];
  for (const [i, j, x, y] of runs) {
    for (const previousPage of [false, true]) {
      const a = lineBefore(oldRows, i, previousPage),
        b = lineBefore(newRows, x, previousPage);
      if (
        (a !== null && oldRows[a].text.endsWith("-")) ||
        (b !== null && newRows[b].text.endsWith("-"))
      ) {
        left.push(
          ...positions(a === null ? [] : oldRows.slice(a, a + 1), oldDocument),
        );
        right.push(
          ...positions(b === null ? [] : newRows.slice(b, b + 1), document),
        );
        break;
      }
    }
    if (x === y) {
      const old = positions(oldRows.slice(i, j), oldDocument);
      links.push(...old.map((_, k): [number, null] => [left.length + k, null]));
      left.push(...old);
      continue;
    }
    for (const [old, next] of aligned(
      oldRows.slice(i, j),
      newRows.slice(x, y),
    )) {
      right.push(...positions(next, document));
      const olds = positions(old, oldDocument);
      links.push(
        ...(olds.length
          ? olds.map((_, k): [number, number] => [
              left.length + k,
              right.length - 1,
            ])
          : [[null, right.length - 1] as [null, number]]),
      );
      left.push(...olds);
    }
  }
  const marks = textChanges(oldDocument, document, left, right),
    shown = new Set<number | null>();
  return links.map(([a, b]) => {
    const pair: Pair = {
      old: a === null ? null : left[a],
      new: b === null ? null : right[b],
      before_marks: a === null ? [] : (marks.old_marks[a] ?? []),
      after_marks: b === null || shown.has(b) ? [] : (marks.new_marks[b] ?? []),
    };
    // Line-based balancing can stop at different occurrences of repeated text
    // in narrow columns. Retain the word marks from the complete source-local
    // paragraph, instead of treating unequal crop tails as new edits.
    for (const side of ["old", "new"] as const) {
      const position = pair[side],
        doc = side === "old" ? oldDocument : document;
      if (!position || !doc.page(position.page).twoColumns) continue;
      const field = side === "old" ? "before_marks" : "after_marks";
      pair[field] =
        side === "new" && shown.has(b)
          ? []
          : card.pairs
              .filter((p) => p[side]?.page === position.page)
              .flatMap((p) => p[field])
              .filter((mark) => containsCenter(position.clip, mark.rect));
    }
    shown.add(b);
    return pair;
  });
}
export function withoutMoves(
  opcodes: Op[],
  oldTexts: string[],
  newTexts: string[],
  minimum = 2,
): Op[] {
  const ops = opcodes.filter((o) => o[0] !== "equal").map((o) => [...o] as Op),
    equal = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
  for (const a of ops)
    for (const b of ops) {
      if (a === b) continue;
      let moved = oldTexts.slice(b[1], b[2]);
      if (moved.length >= minimum && a[4] - a[3] >= moved.length) {
        if (equal(newTexts.slice(a[3], a[3] + moved.length), moved)) {
          a[3] += moved.length;
          b[2] = b[1];
        } else if (equal(newTexts.slice(a[4] - moved.length, a[4]), moved)) {
          a[4] -= moved.length;
          b[2] = b[1];
        }
      }
      moved = newTexts.slice(b[3], b[4]);
      if (moved.length >= minimum && a[2] - a[1] >= moved.length) {
        if (equal(oldTexts.slice(a[1], a[1] + moved.length), moved)) {
          a[1] += moved.length;
          b[4] = b[3];
        } else if (equal(oldTexts.slice(a[2] - moved.length, a[2]), moved)) {
          a[2] -= moved.length;
          b[4] = b[3];
        }
      }
    }
  return ops
    .filter(([, i, j, x, y]) => i < j || x < y)
    .map(([, i, j, x, y]) => [
      i < j && x < y ? "replace" : i < j ? "delete" : "insert",
      i,
      j,
      x,
      y,
    ]);
}
export function changedLineBounds(
  document: PdfDocument,
  position: Position,
  marks: Mark[],
): Span {
  const lines = document
    .page(position.page)
    .lines.filter((l) => marks.some((m) => intersects(l.rect, m.rect)));
  return lines.length
    ? [
        Math.max(
          position.clip[1],
          Math.min(...lines.map((l) => l.rect[1])) - 2,
        ),
        Math.min(
          position.clip[3],
          Math.max(...lines.map((l) => l.rect[3])) + 2,
        ),
      ]
    : [position.clip[1], position.clip[3]];
}
export function snap(
  document: PdfDocument,
  number: number,
  top: number,
  bottom: number,
  limit = 10,
): Span {
  const page = document.page(number),
    ink = (y0: number, y1: number): [Span, boolean[]] => {
      y0 = Math.max(0, y0);
      y1 = Math.min(page.height, y1);
      if (y1 - y0 < 1) return [[y0, y1], []];
      const image = page.raster([0, y0, page.width, y1], 2, true);
      return [
        [y0, y1],
        Array.from({ length: image.height }, (_, r) =>
          image.pixels
            .subarray(r * image.stride, r * image.stride + image.width)
            .some((p) => p < 200),
        ),
      ];
    };
  let [clip, rows] = ink(bottom, bottom + limit),
    index = rows.findIndex((filled) => !filled);
  if (index >= 0)
    bottom = clip[0] + (index * (clip[1] - clip[0])) / rows.length;
  else if (rows.length) bottom = clip[1];
  [clip, rows] = ink(top - limit, top);
  index = rows.findLastIndex((filled) => !filled);
  if (index >= 0)
    top = clip[0] + ((index + 1) * (clip[1] - clip[0])) / rows.length;
  else if (rows.length) top = clip[0];
  return [top, bottom];
}
export function groupedRegions(
  cards: [number, Card][],
  intervals: Intervals,
  snapped?: (page: number, top: number, bottom: number) => Span,
) {
  const result = new Map<number, Group[]>();
  for (const [index, card] of cards)
    card.pairs.forEach((pair, pairIndex) => {
      const position = pair.new;
      if (!position) return;
      for (const [start, end] of intervals.get(position.page) ?? []) {
        let top = Math.max(start, position.clip[1]),
          bottom = Math.min(end, position.clip[3]);
        if (bottom > top && snapped)
          [top, bottom] = snapped(position.page, top, bottom);
        if (bottom > top) {
          if (!result.has(position.page)) result.set(position.page, []);
          result
            .get(position.page)!
            .push({ top, bottom, pairs: [[index, pairIndex]] });
        }
      }
    });
  for (const [page, regions] of result) {
    const merged: Group[] = [];
    for (const region of regions.sort((a, b) => a.top - b.top)) {
      const last = merged.at(-1),
        shared =
          last && region.pairs.some(([i]) => last.pairs.some(([j]) => i === j));
      if (
        last &&
        (region.top <= last.bottom ||
          (shared && region.top - last.bottom <= JOIN_GAP))
      ) {
        last.bottom = Math.max(last.bottom, region.bottom);
        last.pairs.push(...region.pairs);
      } else merged.push(region);
    }
    result.set(page, merged);
  }
  return result;
}
export function contextPlan(
  intervals: Intervals,
  groups: Map<number, Group[]>,
): Piece[] {
  const plan: Piece[] = [];
  for (const [page, spans] of [...intervals].sort((a, b) => a[0] - b[0]))
    for (const [start, end] of spans) {
      let cursor = start;
      for (const group of groups.get(page) ?? []) {
        const top = Math.max(start, group.top),
          bottom = Math.min(end, group.bottom);
        if (bottom <= top) continue;
        if (top > cursor)
          plan.push({ kind: "context", page, top: cursor, bottom: top });
        plan.push({ kind: "change", page, top, bottom, pairs: group.pairs });
        cursor = bottom;
      }
      if (cursor < end)
        plan.push({ kind: "context", page, top: cursor, bottom: end });
    }
  return plan;
}
export function foldContext(plan: Piece[], margin = MARGIN): Planned[] {
  let total = 0;
  const offsets = plan.map((p) => {
      const offset = total;
      total += p.bottom - p.top;
      return offset;
    }),
    changes = plan.flatMap((p, i) =>
      p.kind === "change"
        ? [[offsets[i], offsets[i] + p.bottom - p.top] as Span]
        : [],
    );
  if (!changes.length) return plan;
  const result: Planned[] = [];
  plan.forEach((piece, i) => {
    if (piece.kind === "change") {
      result.push(piece);
      return;
    }
    const height = piece.bottom - piece.top,
      offset = offsets[i],
      keep = changes
        .map(([a, b]): Span => [
          Math.max(0, a - margin - offset),
          Math.min(height, b + margin - offset),
        ])
        .filter(([a, b]) => b > a)
        .sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (let [low, high] of keep) {
      low = Math.max(low, cursor);
      if (high <= low) continue;
      if (low > cursor) result.push({ kind: "gap" });
      result.push({ ...piece, top: piece.top + low, bottom: piece.top + high });
      cursor = high;
    }
    if (cursor < height) result.push({ kind: "gap" });
  });
  return result.filter(
    (p, i) => p.kind !== "gap" || i === 0 || result[i - 1].kind !== "gap",
  );
}
export function acrossPages(plan: Planned[]) {
  const result: Planned[] = [];
  for (const original of plan) {
    let piece = original;
    if (piece.kind === "change") {
      let k = result.length;
      while (k) {
        const p = result[k - 1];
        if (p.kind !== "context" || p.bottom - p.top >= 12) break;
        k--;
      }
      const previous = k ? result[k - 1] : null;
      if (
        previous?.kind === "change" &&
        previous.parts!.at(-1)![0] !== piece.page &&
        previous.pairs!.some(
          ([i]) =>
            piece.kind === "change" && piece.pairs!.some(([j]) => i === j),
        )
      ) {
        result.splice(k);
        previous.parts!.push([piece.page, piece.top, piece.bottom]);
        previous.pairs!.push(...piece.pairs!);
        continue;
      }
      piece = { ...piece, parts: [[piece.page, piece.top, piece.bottom]] };
    }
    result.push(piece);
  }
  return result;
}
export class Strips {
  count = 0;
  constructor(public out: string) {}
  write(
    document: PdfDocument,
    number: number,
    top: number,
    bottom: number,
    marks: Mark[] = [],
    side = "",
  ): Strip | null {
    const page = document.page(number);
    top = Math.max(0, top);
    bottom = Math.min(page.height, bottom);
    if (bottom - top < 0.1) return null;
    const svg = page.svg(top, bottom),
      digest = createHash("sha256")
        .update(svg)
        .update(JSON.stringify(marks))
        .update(side)
        .digest("hex")
        .slice(0, 12),
      name = `s${String(++this.count).padStart(4, "0")}-${digest}`,
      clean = marks.length ? name + "-clean.svg" : name + ".svg";
    fs.writeFileSync(path.join(this.out, clean), svg);
    if (marks.length) {
      const color = side === "old" ? "#c72938" : "#1f8c52",
        overlays = marks
          .map((mark) => {
            const r = intersect(mark.rect, [0, top, page.width, bottom]);
            if (r[2] <= r[0] || r[3] <= r[1]) return "";
            const x = r[0],
              y = r[1] - top,
              width = r[2] - r[0],
              height = r[3] - r[1],
              strike = y + height * 0.55;
            return (
              `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity=".18"/>` +
              (side === "old"
                ? `<path d="M ${x} ${strike} H ${r[2]}" stroke="${color}" stroke-width=".45"/>`
                : "")
            );
          })
          .join("");
      fs.writeFileSync(
        path.join(this.out, name + ".svg"),
        svg.replace("</svg>", overlays + "</svg>"),
      );
    }
    const text = page.lines
      .map((line) => {
        const chars = line.chars
          .filter((char) =>
            containsCenter([0, top, page.width, bottom], char.rect),
          )
          .map((char) => ({
            text: char.text,
            rect: [
              char.rect[0],
              char.rect[1] - top,
              char.rect[2],
              char.rect[3] - top,
            ] as Rect,
          }));
        return { text: chars.map((c) => c.text).join(""), chars };
      })
      .filter((line) => line.text.trim());
    return {
      src: name + ".svg",
      clean,
      width: Math.round(page.width * 100) / 100,
      height: Math.round((bottom - top) * 100) / 100,
      page: number + 1,
      label: page.label,
      text,
    };
  }
}
export function renderSection(
  old: Build,
  next: Build,
  node: Heading,
  inputCards: [number, Card][],
  strips: Strips,
  figureFiles: (file: string) => boolean,
): [Block[], number[], number] {
  const [intervals, missing] = sectionIntervals(next, node, figureFiles),
    cards: [number, Card][] = structuredClone(inputCards);
  let oldRows: Row[] = [],
    newRows: Row[] = [],
    opcodes: Op[] = [];
  if (cards.some(([, card]) => card.comparison === "text")) {
    const oldNode = old.outline.find((n) => n.id === node.id);
    if (oldNode)
      try {
        const [oldIntervals] = sectionIntervals(old, oldNode, figureFiles);
        oldRows = textRows(old.document, oldIntervals);
        newRows = textRows(next.document, intervals);
        const a = oldRows.map((r) => r.text),
          b = newRows.map((r) => r.text);
        opcodes = withoutMoves(compare(a, b), a, b);
      } catch {
        /* Missing PDF heading: use the source-local crops. */
      }
  }
  for (const [, card] of cards) {
    if (card.comparison !== "text" || figureFiles(card.file)) continue;
    if (opcodes.length) {
      const balanced = balancedTextPairs(
        card,
        oldRows,
        newRows,
        opcodes,
        old.document,
        next.document,
      );
      if (balanced) {
        card.pairs = balanced;
        continue;
      }
    }
    for (const pair of card.pairs)
      if (
        pair.old &&
        pair.new &&
        pair.before_marks.length &&
        pair.after_marks.length
      ) {
        [pair.old.clip[1], pair.old.clip[3]] = changedLineBounds(
          old.document,
          pair.old,
          pair.before_marks,
        );
        [pair.new.clip[1], pair.new.clip[3]] = changedLineBounds(
          next.document,
          pair.new,
          pair.after_marks,
        );
      }
  }
  const plan = acrossPages(
      foldContext(
        contextPlan(
          intervals,
          groupedRegions(cards, intervals, (p, a, b) =>
            snap(next.document, p, a, b),
          ),
        ),
      ),
    ),
    byIndex = new Map(cards),
    blocks: Block[] = [],
    located = new Set<number>();
  for (const piece of plan) {
    if (piece.kind === "gap") {
      blocks.push({ kind: "gap" });
      continue;
    }
    if (piece.kind === "context") {
      const image = strips.write(
        next.document,
        piece.page,
        piece.top,
        piece.bottom,
      );
      if (image) blocks.push({ kind: "context", image });
      continue;
    }
    const indices = [...new Set(piece.pairs!.map(([i]) => i))].sort(
      (a, b) => a - b,
    );
    indices.forEach((i) => located.add(i));
    const pairs = piece.pairs!.map(([i, j]) => byIndex.get(i)!.pairs[j]),
      identical = indices.every(
        (i) => byIndex.get(i)!.comparison === "identical",
      );
    const regions = identical
        ? []
        : pairs.flatMap((pair) =>
            pair.old
              ? [
                  {
                    page: pair.old.page,
                    top: pair.old.clip[1],
                    bottom: pair.old.clip[3],
                    marks: pair.before_marks,
                  },
                ]
              : [],
          ),
      merged: typeof regions = [];
    for (const region of regions.sort(
      (a, b) => a.page - b.page || a.top - b.top,
    )) {
      const last = merged.at(-1);
      if (
        last &&
        region.page === last.page &&
        region.top <= last.bottom + JOIN_GAP
      ) {
        last.bottom = Math.max(last.bottom, region.bottom);
        last.marks.push(...region.marks);
      } else merged.push({ ...region, marks: [...region.marks] });
    }
    const before = merged
        .map((r) =>
          strips.write(
            old.document,
            r.page,
            ...snap(old.document, r.page, r.top, r.bottom),
            r.marks,
            "old",
          ),
        )
        .filter((s): s is Strip => s !== null),
      after = piece
        .parts!.map(([page, top, bottom]) =>
          strips.write(
            next.document,
            page,
            top,
            bottom,
            pairs
              .filter((p) => p.new?.page === page)
              .flatMap((p) => p.after_marks),
            "new",
          ),
        )
        .filter((s): s is Strip => s !== null),
      edited = pairs.some((p) =>
        [...p.before_marks, ...p.after_marks].some((m) => m.kind !== "moved"),
      );
    blocks.push({
      kind: "change",
      units: indices.map((i) => byIndex.get(i)!.id),
      identical,
      reflow:
        !identical &&
        !edited &&
        indices.every((i) => byIndex.get(i)!.comparison === "text"),
      before,
      after,
    });
  }
  return [
    blocks,
    cards.map(([i]) => i).filter((i) => !located.has(i)),
    missing.length,
  ];
}
