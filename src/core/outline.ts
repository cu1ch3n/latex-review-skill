import path from "node:path";
import { createHash } from "node:crypto";
import type { Heading, Ranges, SectionRef, Span } from "../types.ts";
const LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
};
const COMMAND =
  /^\s*\\(part|chapter|section|subsection|subsubsection|input|include|subfile|appendix|mainmatter|frontmatter|backmatter)\b(\*)?/;
export const stripComments = (text: string) =>
  text.replace(/(?<!\\)%[^\n]*/g, "");
export function sourceLines(text: string) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
export function argument(
  text: string,
  position: number,
): [string | null, number] {
  while (/\s/.test(text[position] ?? "") && position < text.length) position++;
  if (text[position] === "[") {
    const end = text.indexOf("]", position);
    return end < 0 ? [null, position] : argument(text, end + 1);
  }
  if (text[position] !== "{") return [null, position];
  let depth = 1;
  const begin = ++position;
  for (; position < text.length; position++) {
    if (text[position] === "\\") {
      position++;
      continue;
    }
    if (text[position] === "{") depth++;
    else if (text[position] === "}" && --depth === 0)
      return [text.slice(begin, position), position + 1];
  }
  return [null, position];
}
export function plainTitle(value: string) {
  return value
    .replace(/\\(?:linebreak|newline)\b(?:\[[^\]]*\])?/g, " ")
    .replace(/\\texorpdfstring\{([^{}]*)\}\{([^{}]*)\}/g, "$2")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replaceAll("~", " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function compactRanges(points: Record<string, Set<number>>): Ranges {
  return Object.fromEntries(
    Object.entries(points).map(([file, lines]) => {
      const spans: Span[] = [];
      for (const line of [...lines].sort((a, b) => a - b)) {
        const last = spans.at(-1);
        if (last && line <= last[1] + 1) last[1] = line;
        else spans.push([line, line]);
      }
      return [file, spans];
    }),
  );
}
export function buildOutline(
  read: (file: string) => string | null | undefined,
  main: string,
) {
  type Draft = Omit<Heading, "number" | "ranges" | "files"> & {
    points: Record<string, Set<number>>;
    counters: number[] | null;
    appendix: boolean;
  };
  const base = path.posix.dirname(main),
    nodes: Draft[] = [],
    stack: Draft[] = [],
    warnings: string[] = [],
    used = new Set<string>();
  const counters = [0, 0, 0, 0, 0];
  let appendix = false,
    numbered = true;
  const resolve = (value: string) => {
    value = value.trim();
    if (!value || /[\\#]/.test(value)) return null;
    const file = path.posix.normalize(path.posix.join(base, value));
    return file === ".." ||
      file.startsWith("../") ||
      path.posix.isAbsolute(value)
      ? null
      : path.posix.extname(file)
        ? file
        : file + ".tex";
  };
  const record = (file: string, line: number, root: boolean) => {
    if (root && (!stack.length || stack.at(-1)!.file !== file)) return;
    for (const node of stack) (node.points[file] ??= new Set()).add(line);
  };
  const walk = (file: string, active: string[] = []) => {
    if (active.includes(file)) {
      warnings.push("Circular input: " + file);
      return;
    }
    const text = read(file);
    if (text == null) {
      warnings.push("Input not found: " + file);
      return;
    }
    const root = file === main,
      lines = sourceLines(stripComments(text)),
      first = lines.findIndex((line) => line.trim()),
      opening = first >= 0 ? lines[first].match(COMMAND) : null;
    const prefix = opening && opening[1] in LEVELS ? first : 0;
    if (prefix)
      while (stack.length && stack.at(-1)!.level >= LEVELS[opening![1]])
        stack.pop();
    let inDocument = !root,
      verbatim: string | null = null,
      i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!inDocument) {
        inDocument = line.includes("\\begin{document}");
        i++;
        continue;
      }
      if (root && line.includes("\\end{document}")) break;
      const environment = line.match(
        /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment)\}/,
      );
      if (environment) verbatim = environment[1];
      if (verbatim) {
        record(file, i + 1, root);
        if (line.includes("\\end{" + verbatim + "}")) verbatim = null;
        i++;
        continue;
      }
      const match = line.match(COMMAND);
      if (!match) {
        if (i >= prefix) record(file, i + 1, root);
        i++;
        continue;
      }
      const command = match[1];
      if (
        ["mainmatter", "frontmatter", "backmatter", "appendix"].includes(
          command,
        )
      ) {
        if (command === "appendix") {
          appendix = true;
          counters.fill(0, 1);
        } else numbered = command === "mainmatter";
        i++;
        continue;
      }
      const joined = lines.slice(i).join("\n"),
        [value, end] = argument(joined, match[0].length);
      if (value === null) {
        warnings.push(`Could not parse ${file}:${i + 1}`);
        i++;
        continue;
      }
      const consumed = joined.slice(0, end).split("\n").length;
      if (["input", "include", "subfile"].includes(command)) {
        if (!root) record(file, i + 1, root);
        const child = resolve(value);
        if (child) walk(child, [...active, file]);
        else
          warnings.push(`Dynamic input needs manual review: ${file}:${i + 1}`);
        i += consumed;
        continue;
      }
      const level = LEVELS[command];
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      const rest = joined.slice(end).split("\n")[0],
        labels = [...rest.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
      for (const following of lines.slice(i + consumed, i + consumed + 8)) {
        if (!following.trim()) continue;
        const found = following.match(/^\s*\\label\{([^}]+)\}\s*$/);
        if (!found) break;
        labels.push(found[1]);
      }
      const label = labels.find((l) => !/^sec:\d/.test(l)) ?? labels[0];
      let id = label
        ? "label:" + label
        : `${file}#${command}:${plainTitle(value)}`;
      if (used.has(id))
        id +=
          ":" +
          createHash("sha256").update(`${file}:${i}`).digest("hex").slice(0, 8);
      used.add(id);
      const isNumbered = !match[2] && (numbered || level === 0);
      if (isNumbered) {
        counters[level]++;
        if (level) counters.fill(0, level + 1);
      }
      const node: Draft = {
        id,
        title: plainTitle(value),
        kind: command,
        level,
        file,
        line: i + 1,
        parent: stack.at(-1)?.id ?? null,
        labels,
        points: {},
        counters: isNumbered ? [...counters] : null,
        appendix,
      };
      nodes.push(node);
      stack.push(node);
      if (i === prefix)
        for (let k = 0; k < prefix; k++) record(file, k + 1, root);
      for (let k = 0; k < consumed; k++) record(file, i + k + 1, root);
      i += consumed;
    }
  };
  walk(main);
  const top = nodes.some((n) => n.kind === "chapter") ? 1 : 2;
  const headings: Heading[] = nodes.map(
    ({ counters: counts, appendix, points, ...node }) => {
      let number = "";
      if (counts && !(node.level > 0 && node.level < top)) {
        const first =
          appendix && counts[top] >= 1 && counts[top] <= 26
            ? String.fromCharCode(64 + counts[top])
            : String(counts[top]);
        number =
          node.level === 0
            ? String(counts[0])
            : [first, ...counts.slice(top + 1, node.level + 1)].join(".");
      }
      const ranges = compactRanges(points);
      return { ...node, number, ranges, files: Object.keys(ranges).sort() };
    },
  );
  return {
    nodes: headings,
    warnings,
    signature: createHash("sha256")
      .update(JSON.stringify(headings))
      .digest("hex")
      .slice(0, 20),
  };
}
export function overlaps(a: Ranges, b: Ranges) {
  return Object.keys(a).some(
    (file) =>
      b[file] &&
      a[file].some(([x, y]) =>
        b[file].some(([u, v]) => Math.max(x, u) <= Math.min(y, v)),
      ),
  );
}
export function selectedRanges(
  nodes: Heading[],
  ids: string[],
): [Ranges, SectionRef[]] {
  const selected = nodes.filter((n) => ids.includes(n.id));
  if (selected.length !== new Set(ids).size)
    throw new Error("The outline changed; select the sections again.");
  const points: Record<string, Set<number>> = {};
  for (const node of selected)
    for (const [file, spans] of Object.entries(node.ranges))
      for (const [a, b] of spans)
        for (let i = a; i <= b; i++) (points[file] ??= new Set()).add(i);
  return [
    compactRanges(points),
    selected.map(({ id, number, title }) => ({ id, number, title })),
  ];
}
export function resolveSections(nodes: Heading[], selectors: string[]) {
  return [
    ...new Set(
      selectors.map((selector) => {
        const key = selector.trim(),
          label = key.startsWith("label:") ? key : "label:" + key;
        let matches = nodes.filter(
          (n) => n.id === key || n.number === key || n.id === label,
        );
        if (!matches.length)
          matches = nodes.filter(
            (n) => n.title.toLocaleLowerCase() === key.toLocaleLowerCase(),
          );
        if (matches.length !== 1)
          throw new Error(
            `Section ${JSON.stringify(selector)} matches ${matches.length} headings. Use a section number, exact title, or label.`,
          );
        return matches[0].id;
      }),
    ),
  ];
}
export function covers(spans: Span[], start: number, end: number) {
  let reached = start - 1;
  for (const [a, b] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (a > reached + 1) break;
    reached = Math.max(reached, b);
  }
  return reached >= end;
}
export function deepestNode(
  nodes: Heading[],
  file: string,
  start: number,
  end: number,
) {
  return (
    nodes
      .filter((n) => covers(n.ranges[file] ?? [], start, end))
      .sort((a, b) => b.level - a.level)[0] ?? null
  );
}
