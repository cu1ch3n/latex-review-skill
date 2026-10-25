import fs from "node:fs";
import * as mupdf from "mupdf";
import type { Rect } from "../types.ts";
export { mupdf };
export const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
export const intersect = (a: Rect, b: Rect): Rect => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];
export const intersects = (a: Rect, b: Rect) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
export const containsCenter = (a: Rect, b: Rect) =>
  a[0] <= (b[0] + b[2]) / 2 &&
  (b[0] + b[2]) / 2 <= a[2] &&
  a[1] <= (b[1] + b[3]) / 2 &&
  (b[1] + b[3]) / 2 <= a[3];
export interface Character {
  text: string;
  rect: Rect;
}
export interface Word {
  text: string;
  rect: Rect;
}
export interface Line {
  text: string;
  rect: Rect;
  chars: Character[];
}
export interface TextBlock {
  text: string;
  rect: Rect;
  lines: Line[];
}
export interface OutlineEntry {
  level: number;
  title: string;
  uri: string;
  name: string;
  page: number;
  y: number;
}
export interface Raster {
  width: number;
  height: number;
  channels: number;
  stride: number;
  pixels: Uint8Array;
}
export class PdfPage {
  private columns?: boolean;
  raw: mupdf.Page;
  bounds: Rect;
  blocks: TextBlock[] = [];
  lines: Line[] = [];
  words: Word[] = [];
  label: string;
  constructor(
    document: mupdf.Document,
    public number: number,
  ) {
    this.raw = document.loadPage(number);
    this.bounds = this.raw.getBounds();
    this.label = this.raw.getLabel() || String(number + 1);
    const text = this.raw.toStructuredText(
      "preserve-whitespace,preserve-ligatures",
    );
    let block: TextBlock, line: Line;
    text.walk({
      beginTextBlock: (rect) => {
        block = { rect, text: "", lines: [] };
        this.blocks.push(block);
      },
      beginLine: (rect) => {
        line = { rect, text: "", chars: [] };
        block.lines.push(line);
        this.lines.push(line);
      },
      onChar: (c, _origin, _font, _size, quad) => {
        const xs = [quad[0], quad[2], quad[4], quad[6]],
          ys = [quad[1], quad[3], quad[5], quad[7]];
        line.chars.push({
          text: c,
          rect: [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          ],
        });
        line.text += c;
      },
      endLine: () => {
        block.text += line.text + "\n";
        let word: Word | null = null;
        for (const char of line.chars) {
          if (/\s/u.test(char.text)) word = null;
          else if (word) {
            word.text += char.text;
            word.rect = union(word.rect, char.rect);
          } else {
            word = { text: char.text, rect: [...char.rect] };
            this.words.push(word);
          }
        }
      },
    });
    text.destroy();
  }
  get width() {
    return this.bounds[2] - this.bounds[0];
  }
  get twoColumns() {
    if (this.columns === undefined) {
      const middle = this.bounds[0] + this.width / 2;
      const prose = this.lines.filter(
        (l) =>
          l.text.trim().split(/\s+/).length >= 5 &&
          l.rect[2] - l.rect[0] > this.width * 0.25,
      );
      const left = prose.filter((l) => l.rect[2] < middle),
        right = prose.filter((l) => l.rect[0] > middle);
      this.columns =
        left.filter((a) =>
          right.some(
            (b) =>
              Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]) >
              3,
          ),
        ).length >= 3;
    }
    return this.columns;
  }
  column(rect: Rect) {
    if (!this.twoColumns) return -1;
    const middle = this.bounds[0] + this.width / 2;
    return rect[2] <= middle ? 0 : rect[0] >= middle ? 1 : -1;
  }
  columnBounds(column: number): [number, number] {
    const middle = this.bounds[0] + this.width / 2;
    return column === 0
      ? [this.bounds[0], middle]
      : column === 1
        ? [middle, this.bounds[2]]
        : [this.bounds[0], this.bounds[2]];
  }
  get height() {
    return this.bounds[3] - this.bounds[1];
  }
  search(needle: string): Rect[] {
    return this.raw
      .search(needle, {})
      .flat()
      .map((q) => [
        Math.min(q[0], q[2], q[4], q[6]),
        Math.min(q[1], q[3], q[5], q[7]),
        Math.max(q[0], q[2], q[4], q[6]),
        Math.max(q[1], q[3], q[5], q[7]),
      ]);
  }
  text(clip: Rect = this.bounds) {
    return this.lines
      .map((l) =>
        l.chars
          .filter((c) => containsCenter(clip, c.rect))
          .map((c) => c.text)
          .join(""),
      )
      .filter(Boolean)
      .join("\n");
  }
  raster(clip: Rect, scale = 2, gray = false): Raster {
    const matrix: mupdf.Matrix = [scale, 0, 0, scale, 0, 0],
      rect: Rect = [
        Math.floor(clip[0] * scale),
        Math.floor(clip[1] * scale),
        Math.ceil(clip[2] * scale),
        Math.ceil(clip[3] * scale),
      ],
      pixmap = new mupdf.Pixmap(
        gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB,
        rect,
        false,
      );
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    this.raw.run(device, matrix);
    device.close();
    device.destroy();
    const result = {
      width: pixmap.getWidth(),
      height: pixmap.getHeight(),
      channels: pixmap.getNumberOfComponents(),
      stride: pixmap.getStride(),
      pixels: new Uint8Array(pixmap.getPixels()),
    };
    pixmap.destroy();
    return result;
  }
  svg(top: number, bottom: number) {
    const buffer = new mupdf.Buffer(),
      writer = new mupdf.DocumentWriter(buffer, "svg", "text=path"),
      device = writer.beginPage([0, 0, this.width, bottom - top]);
    this.raw.run(device, [1, 0, 0, 1, 0, -top]);
    writer.endPage();
    writer.close();
    const svg = buffer.asString();
    device.destroy();
    writer.destroy();
    buffer.destroy();
    return svg;
  }
  close() {
    this.raw.destroy();
  }
}
export class PdfDocument {
  raw: mupdf.Document;
  private pages = new Map<number, PdfPage>();
  outline: OutlineEntry[] = [];
  constructor(input: string | Uint8Array) {
    this.raw = mupdf.Document.openDocument(
      typeof input === "string" ? fs.readFileSync(input) : input,
      "application/pdf",
    );
    const walk = (
      items: NonNullable<ReturnType<mupdf.Document["loadOutline"]>>,
      level: number,
    ) => {
      for (const item of items) {
        const uri = item.uri ?? "",
          dest = this.destination(uri);
        this.outline.push({
          level,
          title: item.title ?? "",
          uri,
          name:
            new URLSearchParams(uri.replace(/^#/, "")).get("nameddest") ?? "",
          page: dest?.page ?? item.page ?? -1,
          y: dest?.y ?? 0,
        });
        if (item.down) walk(item.down, level + 1);
      }
    };
    walk(this.raw.loadOutline() ?? [], 1);
  }
  get length() {
    return this.raw.countPages();
  }
  page(number: number) {
    if (!this.pages.has(number))
      this.pages.set(number, new PdfPage(this.raw, number));
    return this.pages.get(number)!;
  }
  destination(uri: string) {
    if (!uri) return null;
    try {
      const dest = this.raw.resolveLinkDestination(uri);
      return dest.page >= 0
        ? {
            page: dest.page,
            y: Number.isFinite(dest.y) ? dest.y : 0,
            x: Number.isFinite(dest.x) ? dest.x : 0,
          }
        : null;
    } catch {
      return null;
    }
  }
  close() {
    for (const page of this.pages.values()) page.close();
    this.raw.destroy();
  }
}
