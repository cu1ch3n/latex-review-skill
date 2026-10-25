import fs from "node:fs";
import path from "node:path";
import { within } from "../core/git.ts";
import { deepestNode } from "../core/outline.ts";
import { Build } from "./locate.ts";
import { renderSection, snap, Strips } from "./inline.ts";
import { pixelDifference, textChanges } from "./pdfdiff.ts";
import type {
  Card,
  ChangeBlock,
  Pair,
  RenderedRound,
  RenderRequest,
  Strip,
  Unit,
} from "../types.ts";
export function typesetWords(text: string) {
  // TeX comments consume the end-of-line too. Keeping that newline would
  // turn a standalone comment into a paragraph break, or split foo%\nbar.
  const uncommented = (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    .map((line) => {
      line = line.replace(/^[ \t]+/, "");
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\") {
          i++;
          continue;
        }
        if (line[i] === "%") return line.slice(0, i);
      }
      return line;
    })
    .join("");
  return uncommented
    .split(/\n[ \t]*\n/)
    .filter((p) => p.trim())
    .map((p) => p.trim().replace(/\s+/g, " "));
}
export function classify(
  old: Build,
  next: Build,
  unit: Unit,
  body: Set<string>,
  figureFiles: (file: string) => boolean,
): Pick<Card, "pairs" | "comparison" | "own"> {
  const name = unit.file;
  // A changed line may be inside a whitespace-sensitive environment without
  // including its \begin in the hunk. Inspect the owning file before using
  // the source-only no-op shortcut; the PDF is the authority for these files.
  const whitespaceSensitive =
    /\\(?:verb\b|lstinline\b|mintinline\b|begin\{(?:verbatim\*?|Verbatim|lstlisting|minted)\})/.test(
      (old.read(name) ?? "") + (next.read(name) ?? ""),
    );
  if (
    unit.kind !== "binary" &&
    !whitespaceSensitive &&
    !unit.truncated &&
    unit.status === "modified" &&
    JSON.stringify(typesetWords(unit.old_text)) ===
      JSON.stringify(typesetWords(unit.new_text))
  )
    return { pairs: [], comparison: "identical" };
  const located =
      name.endsWith(".tex") && unit.kind !== "binary" && body.has(name),
    whole = unit.whole_file || figureFiles(name),
    left =
      located && unit.status !== "added"
        ? old.locator.locate(name, unit.old_start, unit.old_end, whole)
        : [],
    right =
      located && unit.status !== "deleted"
        ? next.locator.locate(name, unit.new_start, unit.new_end, whole)
        : [],
    analysis = textChanges(old.document, next.document, left, right),
    pairs: Pair[] = [];
  let pixels = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] ?? null,
      b = right[i] ?? null;
    pairs.push({
      old: a,
      new: b,
      before_marks: analysis.old_marks[i] ?? [],
      after_marks: analysis.new_marks[i] ?? [],
    });
    if (!analysis.text_changed)
      pixels += pixelDifference(
        a ? old.document.page(a.page).raster(a.clip) : null,
        b ? next.document.page(b.page).raster(b.clip) : null,
      );
  }
  const own = {
      old:
        left.length && !whole
          ? old.locator.boxes(name, unit.old_start, unit.old_end)
          : [],
      new:
        right.length && !whole
          ? next.locator.boxes(name, unit.new_start, unit.new_end)
          : [],
    },
    moved = left.some(
      (a, i) =>
        right[i] &&
        (a.page !== right[i].page ||
          a.label !== right[i].label ||
          a.clip.some((v, j) => Math.abs(v - right[i].clip[j]) > 1)),
    );
  return {
    pairs,
    comparison: !pairs.length
      ? "unmapped"
      : analysis.text_changed
        ? "text"
        : pixels
          ? "layout"
          : moved
            ? "position"
            : "identical",
    own,
  };
}
function looseBlock(
  card: Card,
  strips: Strips,
  old: Build,
  next: Build,
): ChangeBlock {
  const before: Strip[] = [],
    after: Strip[] = [];
  for (const pair of card.pairs)
    for (const [side, build, images, marks] of [
      ["old", old, before, pair.before_marks],
      ["new", next, after, pair.after_marks],
    ] as const) {
      const position = pair[side];
      if (position) {
        const image = strips.write(
          build.document,
          position.page,
          ...snap(
            build.document,
            position.page,
            position.clip[1],
            position.clip[3],
          ),
          marks,
          side,
        );
        if (image) images.push(image);
      }
    }
  return {
    kind: "change",
    units: [card.id],
    identical: card.comparison === "identical",
    before,
    after,
  };
}
export function renderRound(
  request: RenderRequest,
  out: string,
): RenderedRound {
  fs.mkdirSync(out, { recursive: true });
  const figureFiles = (name: string) => within(name, request.figures),
    old = new Build(request.old, request.main, request.source_dir),
    next = new Build(request.new, request.main, request.source_dir);
  try {
    const body = new Set(
        [old, next].flatMap((b) => b.outline.flatMap((n) => n.files)),
      ),
      cards: Card[] = [],
      result: RenderedRound = { units: {}, sections: [], loose: [] };
    for (const unit of request.units) {
      const card: Card = {
          id: unit.id,
          file: unit.file,
          ...classify(old, next, unit, body, figureFiles),
        },
        node = card.pairs.length
          ? unit.status === "deleted"
            ? deepestNode(old.outline, unit.file, unit.old_start, unit.old_end)
            : deepestNode(next.outline, unit.file, unit.new_start, unit.new_end)
          : null;
      card.context_node = node?.id ?? null;
      cards.push(card);
      result.units[unit.id] = {
        visual: card.comparison,
        pages: [
          ...new Set(card.pairs.map((p) => (p.new ?? p.old)!.label)),
        ].sort(),
        section: node ? `${node.number} ${node.title}`.trim() : null,
      };
    }
    const strips = new Strips(out),
      placed = new Set<number>();
    for (const node of next.outline.filter((n) =>
      cards.some((c) => c.context_node === n.id),
    )) {
      const members = cards.flatMap((c, i): [number, Card][] =>
        c.context_node === node.id ? [[i, c]] : [],
      );
      let rendered: ReturnType<typeof renderSection>;
      try {
        rendered = renderSection(old, next, node, members, strips, figureFiles);
      } catch (error) {
        if (
          !(error as Error).message.includes("PDF outline") &&
          !(error as Error).message.includes("outside this PDF")
        )
          throw error;
        continue;
      }
      const [blocks, unlocated] = rendered;
      if (!blocks.some((b) => b.kind === "change")) continue;
      result.sections.push({
        node: node.id,
        number: node.number,
        title: node.title,
        blocks,
      });
      members.forEach(([i]) => {
        if (!unlocated.includes(i)) placed.add(i);
      });
    }
    cards.forEach((card, index) => {
      if (!placed.has(index))
        result.loose.push(looseBlock(card, strips, old, next));
    });
    fs.writeFileSync(path.join(out, "round.json"), JSON.stringify(result));
    return result;
  } finally {
    old.close();
    next.close();
  }
}
