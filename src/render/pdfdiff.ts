import { opcodes } from "../core/diff.ts";
import type { Mark, Position, Rect } from "../types.ts";
import { containsCenter, PdfDocument, union, type Raster } from "./pdf.ts";
export const normalize = (text: string) =>
  text.normalize("NFKC").replaceAll("\u00ad", "");
interface Glyph {
  text: string;
  rect: Rect;
  pair: number;
  page: number;
  space: boolean;
}
interface Word {
  text: string;
  rect: Rect;
  pair: number;
  page: number;
}
export function extract(
  document: PdfDocument,
  positions: Position[],
): [Glyph[], Word[]] {
  const glyphs: Glyph[] = [],
    words: Word[] = [];
  positions.forEach((position, pair) => {
    const page = document.page(position.page),
      clip = position.clip;
    for (const line of page.lines) {
      let space = true;
      for (const char of line.chars) {
        if (!containsCenter(clip, char.rect)) {
          space = true;
          continue;
        }
        for (const value of normalize(char.text)) {
          if (/\s/u.test(value)) space = true;
          else {
            glyphs.push({
              text: value,
              rect: char.rect,
              space,
              pair,
              page: position.page,
            });
            space = false;
          }
        }
      }
    }
    for (const word of page.words)
      if (containsCenter(clip, word.rect))
        words.push({
          text: normalize(word.text),
          rect: word.rect,
          pair,
          page: position.page,
        });
  });
  for (let i = glyphs.length - 2; i > 0; i--) {
    const a = glyphs[i - 1],
      b = glyphs[i],
      c = glyphs[i + 1];
    if (
      b.text === "-" &&
      /\p{L}/u.test(a.text) &&
      /\p{Ll}/u.test(c.text) &&
      (b.pair !== c.pair || c.rect[1] > b.rect[1] + 3)
    ) {
      c.space = false;
      glyphs.splice(i, 1);
    }
  }
  return [glyphs, words];
}
function tokens(glyphs: Glyph[]) {
  const result: { text: string; start: number; end: number }[] = [];
  let previousWord = false;
  glyphs.forEach((glyph, i) => {
    const word = /[\p{L}\p{N}_]/u.test(glyph.text);
    if (result.length && word && previousWord && !glyph.space) {
      result.at(-1)!.text += glyph.text;
      result.at(-1)!.end = i + 1;
    } else result.push({ text: glyph.text, start: i, end: i + 1 });
    previousWord = word;
  });
  return result;
}
export function mergeRects(rects: Rect[]): Rect[] {
  const result: Rect[] = [];
  for (const rect of [...rects].sort(
    (a, b) => Math.round(a[1] / 2) - Math.round(b[1] / 2) || a[0] - b[0],
  )) {
    let merged = false;
    for (let i = result.length - 1; i >= Math.max(0, result.length - 12); i--) {
      const previous = result[i];
      if (
        Math.abs(previous[1] - rect[1]) < 1.7 &&
        Math.abs(previous[3] - rect[3]) < 2 &&
        rect[0] - previous[2] >= -1 &&
        rect[0] - previous[2] < 4
      ) {
        result[i] = union(previous, rect);
        merged = true;
        break;
      }
    }
    if (!merged) result.push([...rect]);
  }
  return result;
}
function marks(
  glyphs: Glyph[],
  indices: number[],
  words: Word[],
  kind: Mark["kind"],
): Record<number, Mark[]> {
  const selected = new Map<number, Rect[]>();
  for (const i of new Set(indices)) {
    const g = glyphs[i];
    if (!selected.has(g.pair)) selected.set(g.pair, []);
    selected.get(g.pair)!.push(g.rect);
  }
  return Object.fromEntries(
    [...selected].map(([pair, rects]) => {
      const boxes = words
        .filter(
          (w) =>
            w.pair === pair && rects.some((r) => containsCenter(w.rect, r)),
        )
        .map((w) => w.rect);
      return [
        pair,
        mergeRects(boxes.length ? boxes : rects).map((rect) => ({
          kind,
          rect,
        })),
      ];
    }),
  );
}
export function joined(words: Word[]) {
  const result: string[] = [];
  let previous: Word | null = null;
  for (const word of words) {
    const last = result.at(-1) ?? "";
    if (
      previous &&
      /\p{L}-$/u.test(last) &&
      /^\p{Ll}/u.test(word.text) &&
      (word.pair !== previous.pair || word.rect[1] > previous.rect[3] - 2)
    )
      result[result.length - 1] = last.slice(0, -1) + word.text;
    else result.push(word.text);
    previous = word;
  }
  return result;
}
export function textChanges(
  oldDocument: PdfDocument | null,
  newDocument: PdfDocument | null,
  left: Position[],
  right: Position[],
) {
  const [a, aw] = left.length
      ? extract(oldDocument!, left)
      : ([[], []] as [Glyph[], Word[]]),
    [b, bw] = right.length
      ? extract(newDocument!, right)
      : ([[], []] as [Glyph[], Word[]]),
    at = tokens(a),
    bt = tokens(b);
  const removed: number[] = [],
    added: number[] = [],
    movedA: number[] = [],
    movedB: number[] = [];
  const indices = (t: ReturnType<typeof tokens>, i: number, j: number) =>
    t
      .slice(i, j)
      .flatMap((t) =>
        Array.from({ length: t.end - t.start }, (_, k) => t.start + k),
      );
  for (const [tag, i, j, x, y] of opcodes(
    at.map((t) => t.text),
    bt.map((t) => t.text),
  )) {
    const ai = indices(at, i, j),
      bi = indices(bt, x, y);
    if (tag !== "equal") {
      removed.push(...ai);
      added.push(...bi);
      continue;
    }
    ai.forEach((u, index) => {
      const v = bi[index],
        old = a[u],
        next = b[v],
        p = left[old.pair],
        q = right[next.pair],
        r = old.rect,
        s = next.rect;
      if (
        old.pair !== next.pair ||
        [
          r[0] - p.clip[0] - s[0] + q.clip[0],
          r[1] - p.clip[1] - s[1] + q.clip[1],
          r[2] - r[0] - s[2] + s[0],
          r[3] - r[1] - s[3] + s[1],
        ].some((d) => Math.abs(d) > 0.65)
      ) {
        movedA.push(u);
        movedB.push(v);
      }
    });
  }
  const changed = Boolean(removed.length || added.length),
    oldWords = joined(aw),
    newWords = joined(bw),
    edits = changed
      ? opcodes(oldWords, newWords)
          .filter((o) => o[0] !== "equal")
          .map(([, i, j, x, y]) => {
            const old = oldWords.slice(i, j).join(" "),
              next = newWords.slice(x, y).join(" ");
            return {
              old: old.slice(0, 180),
              new: next.slice(0, 180),
              truncated: old.length > 180 || next.length > 180,
            };
          })
      : [];
  return {
    old_marks: marks(
      a,
      changed ? removed : movedA,
      aw,
      changed ? "removed" : "moved",
    ),
    new_marks: marks(
      b,
      changed ? added : movedB,
      bw,
      changed ? "added" : "moved",
    ),
    text_changed: changed,
    moved: Boolean(movedA.length || movedB.length),
    text_available: Boolean(a.length || b.length),
    edits,
  };
}
export function pixelDifference(old: Raster | null, next: Raster | null) {
  const width = Math.max(old?.width ?? 0, next?.width ?? 0),
    height = Math.max(old?.height ?? 0, next?.height ?? 0);
  let count = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let difference = 0;
      for (let c = 0; c < 3; c++) {
        const value = (image: Raster | null) =>
          image && x < image.width && y < image.height
            ? image.pixels[
                y * image.stride +
                  x * image.channels +
                  Math.min(c, image.channels - 1)
              ]
            : 255;
        difference +=
          Math.abs(value(old) - value(next)) * [0.299, 0.587, 0.114][c];
      }
      if (difference >= 24) count++;
    }
  return count;
}
