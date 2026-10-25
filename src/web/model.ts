import { opcodes } from "../core/diff.ts";
import type { Decision, RoundDetail, Unit, VisualUnit } from "../types.ts";
export interface Stop {
  key: string;
  units: string[];
  section: number | null;
}
export function buildStops(
  detail: Pick<RoundDetail, "sections" | "loose">,
): Stop[] {
  return [
    ...detail.sections.flatMap((section, s) =>
      section.blocks.flatMap((b, i) =>
        b.kind === "change"
          ? [{ key: `s${s}b${i}`, units: b.units, section: s }]
          : [],
      ),
    ),
    ...detail.loose.map((b, l) => ({
      key: `l${l}`,
      units: b.units,
      section: null,
    })),
  ];
}
export const pendingUnits = (
  stop: Stop | undefined,
  decisions: Record<string, Decision>,
) => (stop?.units ?? []).filter((id) => decisions[id] === "pending");
export function nextPending(
  stops: Stop[],
  decisions: Record<string, Decision>,
  current = -1,
) {
  for (let step = 1; step <= stops.length; step++) {
    const index = ((current < 0 ? -1 : current) + step) % stops.length;
    if (pendingUnits(stops[index], decisions).length) return index;
  }
  return -1;
}
export function stopState(
  units: string[],
  decisions: Record<string, Decision>,
) {
  const values = new Set(units.map((id) => decisions[id] || "pending"));
  return values.size === 1
    ? [...values][0]
    : values.has("pending")
      ? "pending"
      : "mixed";
}
export function resolvedSide(
  units: string[],
  decisions: Record<string, Decision>,
) {
  if (units.length && units.every((id) => decisions[id] === "accepted"))
    return "after";
  if (units.length && units.every((id) => decisions[id] === "rejected"))
    return "before";
  return undefined;
}
export function progress(decisions: Record<string, Decision>) {
  const values = Object.values(decisions),
    counts = { accepted: 0, rejected: 0, commented: 0, pending: 0 };
  for (const value of values) counts[value]++;
  return {
    ...counts,
    total: values.length,
    decided: values.length - counts.pending,
  };
}
export function visibleStop(
  regions: { index: number; top: number; bottom: number }[],
  current: number,
  top: number,
  bottom: number,
) {
  const visible = regions.filter((r) => r.bottom > top && r.top < bottom);
  return visible.some((r) => r.index === current)
    ? current
    : (visible[0]?.index ?? current);
}
export function wordDiff(before: string, after: string) {
  const token = /\\[A-Za-z@]+\*?|[\p{L}\p{N}_]+|\s+|[^\s]/gu,
    a = before.match(token) ?? [],
    b = after.match(token) ?? [],
    parts: { type: "equal" | "del" | "ins"; text: string }[] = [];
  for (const [tag, i, j, x, y] of opcodes(a, b)) {
    if (tag === "equal")
      parts.push({ type: "equal", text: a.slice(i, j).join("") });
    else {
      if (i < j) parts.push({ type: "del", text: a.slice(i, j).join("") });
      if (x < y) parts.push({ type: "ins", text: b.slice(x, y).join("") });
    }
  }
  for (let i = 1; i < parts.length - 1; i++)
    if (
      parts[i].type === "equal" &&
      /^\s+$/.test(parts[i].text) &&
      parts[i - 1].type !== "equal" &&
      parts[i + 1].type !== "equal"
    ) {
      const text = parts[i].text;
      parts.splice(i, 1, { type: "del", text }, { type: "ins", text });
      i++;
    }
  const result: typeof parts = [];
  for (let i = 0; i < parts.length;) {
    if (parts[i].type === "equal") {
      result.push(parts[i++]);
      continue;
    }
    let removed = "",
      added = "";
    while (i < parts.length && parts[i].type !== "equal") {
      if (parts[i].type === "del") removed += parts[i].text;
      else added += parts[i].text;
      i++;
    }
    if (removed) result.push({ type: "del", text: removed });
    if (added) result.push({ type: "ins", text: added });
  }
  return result;
}
export function describeLocation(units: (Unit & Partial<VisualUnit>)[]) {
  const files = new Map<string, string[]>();
  for (const unit of units) {
    const where =
      unit.status === "added"
        ? "new file"
        : unit.status === "deleted"
          ? "deleted"
          : unit.new_start === unit.new_end
            ? String(unit.new_start)
            : `${unit.new_start}–${unit.new_end}`;
    files.set(unit.file, [...(files.get(unit.file) ?? []), where]);
  }
  const pages = [...new Set(units.flatMap((u) => u.pages ?? []))];
  return (
    [...files]
      .map(([file, places]) => `${file}:${places.join(", ")}`)
      .join("; ") + (pages.length ? ` · p. ${pages.join(", ")}` : "")
  );
}
export function copyReference(
  title: string,
  round: number,
  change: number,
  location: string,
  selected: string,
) {
  return `${title} · Round ${round} · Change ${change}\n${location}${selected ? "\n\n" + selected : ""}`;
}
