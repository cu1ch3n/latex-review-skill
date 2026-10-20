// Pure review logic, shared by the page and its tests.

export const DECISIONS = ['accepted', 'rejected', 'commented', 'pending'];

// Navigation stops in reading order: every change block of every section, then the loose ones.
export function buildStops(detail) {
  const stops = [];
  (detail.sections || []).forEach((section, s) => section.blocks.forEach((block, b) => {
    if (block.kind === 'change') stops.push({key: `s${s}b${b}`, units: block.units, section: s});
  }));
  (detail.loose || []).forEach((block, l) => stops.push({key: `l${l}`, units: block.units, section: null}));
  return stops;
}

export const pendingUnits = (stop, decisions) => (stop?.units || []).filter(id => decisions[id] === 'pending');

// The next stop that still has an undecided change, searching forward and wrapping around.
export function nextPending(stops, decisions, current = -1) {
  for (let step = 1; step <= stops.length; step++) {
    const index = ((current < 0 ? -1 : current) + step) % stops.length;
    if (pendingUnits(stops[index], decisions).length) return index;
  }
  return -1;
}

export function stopState(units, decisions) {
  const values = new Set(units.map(id => decisions[id] || 'pending'));
  return values.size === 1 ? [...values][0] : values.has('pending') ? 'pending' : 'mixed';
}

// Which version a decided block shows: the new text once accepted, the old once rejected.
export function resolvedSide(units, decisions) {
  if (units.length && units.every(id => decisions[id] === 'accepted')) return 'after';
  if (units.length && units.every(id => decisions[id] === 'rejected')) return 'before';
  return null;
}

export function progress(decisions) {
  const values = Object.values(decisions);
  const count = Object.fromEntries(DECISIONS.map(kind => [kind, values.filter(v => v === kind).length]));
  return {...count, total: values.length, decided: values.length - count.pending};
}

// Keep the selected stop while it is visible; otherwise pick the first visible one.
export function visibleStop(regions, current, top, bottom) {
  const visible = regions.filter(region => region.bottom > top && region.top < bottom);
  if (visible.some(region => region.index === current)) return current;
  return visible.length ? visible[0].index : current;
}

const TOKEN = /\\[A-Za-z@]+\*?|[\p{L}\p{N}_]+|\s+|[^\s]/gu;
const LIMIT = 400_000;

function lcs(a, b) {
  const n = a.length, m = b.length, width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const parts = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { parts.push(['equal', a[i]]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) parts.push(['del', a[i++]]);
    else parts.push(['ins', b[j++]]);
  }
  while (i < n) parts.push(['del', a[i++]]);
  while (j < m) parts.push(['ins', b[j++]]);
  return parts;
}

function merge(parts) {
  const result = [];
  for (const [type, text] of parts) {
    if (!text) continue;
    const last = result.at(-1);
    if (last && last.type === type) last.text += text;
    else result.push({type, text});
  }
  return result;
}

// A word-level diff of LaTeX source: [{type: 'equal' | 'del' | 'ins', text}].
export function wordDiff(before, after) {
  if (before === after) return before ? [{type: 'equal', text: before}] : [];
  let a = before.match(TOKEN) || [], b = after.match(TOKEN) || [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = a.slice(0, start).join(''), tail = end ? a.slice(a.length - end).join('') : '';
  a = a.slice(start, a.length - end);
  b = b.slice(start, b.length - end);
  let middle;
  if ((a.length + 1) * (b.length + 1) <= LIMIT) middle = lcs(a, b);
  else middle = [['del', a.join('')], ['ins', b.join('')]];
  // Fold single spaces between edits into the edits, so phrases read as one replacement.
  const parts = merge([['equal', head], ...middle, ['equal', tail]]);
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part.type === 'equal' && /^\s+$/.test(part.text) && parts[i - 1].type !== 'equal' && parts[i + 1].type !== 'equal') {
      parts.splice(i, 1, {type: 'del', text: part.text}, {type: 'ins', text: part.text});
    }
  }
  const ordered = [];
  for (let i = 0; i < parts.length;) {
    if (parts[i].type === 'equal') { ordered.push(parts[i++]); continue; }
    let removed = '', added = '';
    while (i < parts.length && parts[i].type !== 'equal') {
      if (parts[i].type === 'del') removed += parts[i].text; else added += parts[i].text;
      i++;
    }
    if (removed) ordered.push({type: 'del', text: removed});
    if (added) ordered.push({type: 'ins', text: added});
  }
  return ordered;
}
