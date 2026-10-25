import { diffArrays } from "diff";
import type { Op } from "../types.ts";
/** Stable line/token opcodes shared by source and PDF comparisons. */
export function opcodes<T>(a: T[], b: T[]): Op[] {
  const result: Op[] = [];
  let i = 0,
    j = 0;
  for (const part of diffArrays(a, b)) {
    const n = part.value.length;
    if (!part.added && !part.removed) {
      result.push(["equal", i, i + n, j, j + n]);
      i += n;
      j += n;
    } else {
      const previous = result.at(-1);
      const tag = part.added ? "insert" : "delete";
      const endI = i + (part.removed ? n : 0),
        endJ = j + (part.added ? n : 0);
      if (previous && previous[0] !== "equal") {
        previous[0] =
          previous[1] < endI && previous[3] < endJ ? "replace" : tag;
        previous[2] = endI;
        previous[4] = endJ;
      } else result.push([tag, i, endI, j, endJ]);
      i = endI;
      j = endJ;
    }
  }
  return result;
}
export function groups(ops: Op[], context = 3) {
  const result: Op[][] = [];
  let group: Op[] = [];
  for (const op of ops) {
    if (op[0] === "equal") {
      if (op[2] - op[1] > 2 * context) {
        if (group.length) result.push(group);
        group = [];
      }
    } else group.push(op);
  }
  if (group.length) result.push(group);
  return result;
}
export function similarity(a: string[], b: string[]) {
  return (
    (2 *
      opcodes(a, b).reduce(
        (n, o) => n + (o[0] === "equal" ? o[2] - o[1] : 0),
        0,
      )) /
    Math.max(a.length + b.length, 1)
  );
}
