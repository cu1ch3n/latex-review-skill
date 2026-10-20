import {buildStops, nextPending, pendingUnits, progress, resolvedSide, stopState, visibleStop, wordDiff} from './model.js';

const params = new URLSearchParams(location.search);
const TASK = params.get('task');
const PINNED = Number(params.get('round')) || null;
const $ = selector => document.querySelector(selector);
const KIND = {text: 'Text', layout: 'Layout', position: 'Moved', identical: 'No visible change', unmapped: 'Source only'};
const PHASE = {snapshot: 'Taking a snapshot', build: 'Compiling LaTeX', render: 'Rendering the diff'};
const VERB = {accept: 'acceptance', reject: 'rejection', comment: 'comment'};

const view = {
  state: null, detail: null, stops: [], units: {}, current: -1, round: null,
  busy: null, composer: null, online: true, timer: null, lastError: '',
};

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
}

const storage = {
  key: () => `latex-review:${TASK}`,
  read() { try { return JSON.parse(localStorage.getItem(this.key())) || {}; } catch { return {}; } },
  write(value) { try { localStorage.setItem(this.key(), JSON.stringify({...this.read(), ...value})); } catch { /* optional */ } },
};

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', 'X-Review-Token': view.state?.csrf || ''},
  };
  const response = await fetch(`/api/tasks/${encodeURIComponent(TASK)}${path}`, options);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `The server answered ${response.status}.`);
  return value;
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

let toastTimer;
function toast(message, kind = 'info') {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast ${kind}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 9000 : 2600);
}

// Document

const images = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const img = entry.target;
    img.src = img.dataset.want;
    images.unobserve(img);
  }
}, {rootMargin: '800px 0px'});

function strip(image, label) {
  if (!image) return null;
  const base = view.detail.files;
  const img = el('img', {
    alt: label, width: image.width, height: image.height, decoding: 'async',
    style: `aspect-ratio:${image.width}/${image.height}`,
    'data-marked': base + image.src, 'data-clean': base + (image.clean || image.src),
  });
  img.dataset.want = img.dataset.marked;
  images.observe(img);
  return img;
}

function describeLocation(units) {
  const known = units.map(id => view.units[id]).filter(Boolean);
  const files = new Map();
  for (const unit of known) {
    const where = unit.status === 'added' ? 'new file' : unit.status === 'deleted' ? 'deleted'
      : unit.new_start === unit.new_end ? `${unit.new_start}` : `${unit.new_start}–${unit.new_end}`;
    files.set(unit.file, [...(files.get(unit.file) || []), where]);
  }
  const pages = [...new Set(known.flatMap(unit => unit.pages || []))];
  return [...files].map(([file, places]) => `${file}:${places.join(', ')}`).join('; ')
    + (pages.length ? ` · p. ${pages.join(', ')}` : '');
}

function sourceView(units) {
  return units.map(id => {
    const unit = view.units[id];
    const title = el('div', {class: 'source-title'}, `${unit.file}`,
      el('span', {class: 'muted'}, unit.status === 'added' ? ' · new file' : unit.status === 'deleted' ? ' · deleted file'
        : ` · lines ${unit.new_start}–${unit.new_end}`));
    if (unit.kind === 'binary') return el('div', {class: 'source-unit'}, title, el('p', {class: 'muted'}, 'Binary file changed.'));
    const code = el('pre', {class: 'source-code'},
      wordDiff(unit.old_text, unit.new_text).map(part => part.type === 'equal' ? part.text : el(part.type, {}, part.text)));
    return el('div', {class: 'source-unit'}, title, code,
      unit.truncated ? el('p', {class: 'muted'}, 'Long change: the source is shortened.') : null);
  });
}

function changeBlock(block, index, inline) {
  const kinds = [...new Set(block.units.map(id => view.units[id]?.visual || 'unmapped'))];
  const before = (block.identical || block.reflow ? [] : block.before || []).filter(Boolean);
  const after = (Array.isArray(block.after) ? block.after : [block.after]).filter(Boolean);
  const article = el('article', {class: `change${inline ? ' inline' : ' standalone'}`, 'data-stop': index, tabindex: -1},
    el('header', {class: 'change-head'},
      el('span', {class: 'change-number'}, `Change ${index + 1}`),
      el('span', {class: 'change-where', title: describeLocation(block.units)}, describeLocation(block.units)),
      el('span', {class: 'change-kind'}, block.reflow ? 'Reflow' : kinds.map(k => KIND[k] || k).join(', ')),
      el('span', {class: 'badge'}),
      el('button', {type: 'button', class: 'link', 'data-command': 'source', title: 'Show the LaTeX source (S)'}, 'LaTeX')),
    history(block.units),
    before.length ? el('div', {class: 'side before', 'aria-label': 'Before'}, before.map(image => strip(image, 'Before'))) : null,
    after.length ? el('div', {class: `side after${block.identical ? ' identical' : ''}`, 'aria-label': 'After'},
      after.map(image => strip(image, 'After'))) : null,
    block.identical ? el('p', {class: 'caption'}, 'No visible change in the PDF; see the LaTeX source.') : null,
    block.reflow ? el('p', {class: 'caption'}, 'Continued: only line breaks moved here.') : null,
    el('div', {class: 'remark', hidden: true}),
    el('div', {class: 'source', hidden: true}));
  if (block.identical || (!before.length && !after.length)) openSource(article, block.units, false);
  return article;
}

function history(units) {
  const notes = units.flatMap(id => (view.units[id]?.history || []).map(item =>
    el('p', {class: 'history'}, el('strong', {}, `Revised after your comment in round ${item.round}: `), `“${item.comment}”`)));
  return notes.length ? el('div', {class: 'histories'}, notes) : null;
}

function openSource(article, units, toggle = true) {
  const box = article.querySelector('.source');
  if (!box.childElementCount) box.append(...sourceView(units));
  box.hidden = toggle ? !box.hidden : false;
  article.querySelector('[data-command=source]').classList.toggle('active', !box.hidden);
}

function renderDocument() {
  const root = $('#document');
  park();
  root.replaceChildren();
  const {sections, loose} = view.detail;
  let index = 0;
  for (const section of sections) {
    const sheet = el('div', {class: 'sheet'});
    for (const block of section.blocks) {
      if (block.kind === 'context') sheet.append(el('div', {class: 'context'}, strip(block.image, 'Unchanged text')));
      else if (block.kind === 'gap') sheet.append(el('div', {class: 'fold', title: 'Unchanged text is folded'}, '⋯'));
      else sheet.append(changeBlock(block, index++, true));
    }
    root.append(el('section', {class: 'part'},
      el('h2', {class: 'part-title'}, section.number ? el('span', {class: 'number'}, section.number) : null, section.title),
      sheet));
  }
  if (loose.length) {
    root.append(el('section', {class: 'part'},
      el('h2', {class: 'part-title'}, sections.length ? 'Other changes' : 'Changes'),
      loose.map(block => changeBlock(block, index++, false))));
  }
  if (!view.stops.length) root.append(el('p', {class: 'empty'}, 'This round has no changes.'));
}

// State

function articles() {
  return [...document.querySelectorAll('article.change')];
}

function refresh() {
  const state = view.state;
  if (!state) return;
  const decisions = state.decisions || {};
  document.title = `${state.title} · LaTeX Review`;
  $('#title').textContent = state.title;
  $('#round-label').textContent = view.round ? `Round ${view.round}${view.round !== state.latest ? ' (earlier round)' : ''}` : '';
  const count = progress(decisions);
  $('#meter').hidden = !count.total;
  $('#progress-text').textContent = `${count.decided} of ${count.total} decided`;
  $('#progress-fill').style.width = `${count.total ? 100 * count.decided / count.total : 0}%`;
  $('#note-button').hidden = state.closed;
  renderStatus();
  for (const article of articles()) {
    const stop = view.stops[Number(article.dataset.stop)];
    const kind = stopState(stop.units, decisions);
    article.dataset.state = kind;
    const side = resolvedSide(stop.units, decisions);
    if (side) article.dataset.resolved = side; else delete article.dataset.resolved;
    article.classList.toggle('current', Number(article.dataset.stop) === view.current);
    const decided = [...new Set(stop.units.map(id => decisions[id]).filter(value => value && value !== 'pending'))];
    article.querySelector('.badge').textContent = kind === 'pending' && !decided.length ? ''
      : decided.map(value => value[0].toUpperCase() + value.slice(1)).join(' + ') + (kind === 'pending' ? ' (partly)' : '');
    for (const img of article.querySelectorAll('img')) {
      const want = article.dataset.resolved ? img.dataset.clean : img.dataset.marked;
      if (img.dataset.want !== want) {
        img.dataset.want = want;
        if (img.getAttribute('src')) img.src = want;
      }
    }
    const remarks = stop.units.map(id => state.comments?.[id]).filter(Boolean);
    const remark = article.querySelector('.remark');
    remark.hidden = !remarks.length;
    remark.replaceChildren(...[...new Set(remarks)].map(text => el('p', {}, el('strong', {}, 'Your comment: '), text)));
  }
  renderActions();
  renderBanner();
  dock();
}

// The action bar and comment box sit in the current change's header, like an inline editor widget.
const DOCK = document.getElementById('dock');

function dock() {
  const article = articles()[view.current];
  if (!article) return park();
  const head = article.querySelector('.change-head');
  DOCK.hidden = false;
  if (DOCK.parentElement !== head) head.insertBefore(DOCK, head.querySelector('.change-kind'));
}

function park() {
  DOCK.hidden = true;
  if (DOCK.parentElement !== document.body) document.body.append(DOCK);
}

function jobText(job) {
  if (job?.status !== 'queued') return `${PHASE[job?.phase] || 'Starting'}…`;
  return job.ahead ? `Queued behind ${job.ahead} other round${job.ahead > 1 ? 's' : ''}…` : 'Queued…';
}

function renderStatus() {
  const {state, job} = view.state;
  const status = $('#status');
  let text = {editing: 'Waiting for the agent', reviewing: 'Your turn', revise: 'The agent will revise',
    done: 'All decided', build_failed: 'Last publish failed'}[state] || '';
  if (state === 'building') text = jobText(job);
  if (view.state.closed) text = 'Finished';
  if (!view.online) text = 'Reconnecting…';
  status.textContent = text;
  status.dataset.state = view.online ? (view.state.closed ? 'done' : state || '') : 'offline';
}

function renderActions() {
  const bar = $('#actions');
  const state = view.state;
  const latest = view.round && view.round === state.latest && !state.closed;
  bar.hidden = !view.stops.length;
  const stop = view.stops[view.current];
  const pending = pendingUnits(stop, state.decisions || {});
  const remaining = nextPending(view.stops, state.decisions || {});
  const locked = !!view.busy || !latest;
  // A decided change offers the way on instead of buttons that do nothing.
  const decided = !pending.length && remaining >= 0;
  for (const kind of ['accept', 'reject', 'comment']) {
    const button = bar.querySelector(`[data-command=${kind}]`);
    button.hidden = remaining < 0 || decided;
    button.disabled = locked || !pending.length;
    button.classList.toggle('working', view.busy === kind);
  }
  bar.querySelector('[data-command=pending]').hidden = !decided;
  bar.querySelector('[data-command=previous]').disabled = view.current <= 0;
  bar.querySelector('[data-command=next]').disabled = view.current >= view.stops.length - 1;
  bar.querySelector('[data-command=undo]').disabled = !state.undo || !!view.busy;
  $('#position').textContent = view.stops.length ? `${view.current + 1} / ${view.stops.length}` : '';
  const complete = $('#complete');
  complete.hidden = remaining >= 0;
  complete.textContent = !latest ? 'Earlier round (read-only)' : 'Review complete';
}

function renderBanner() {
  const banner = $('#banner');
  const {state, job, latest, closed} = view.state;
  const count = progress(view.state.decisions || {});
  const parts = [];
  if (closed) {
    parts.push(el('p', {}, el('strong', {}, 'This review is finished. '), 'Accepted changes are in your manuscript.'));
  } else if (state === 'build_failed' && job) {
    parts.push(el('p', {}, el('strong', {}, 'The agent’s latest publish failed: '), job.error || 'unknown error'));
    if (job.details?.length) parts.push(el('pre', {class: 'details'}, job.details.join('\n')));
  } else if (state === 'building') {
    parts.push(el('p', {}, el('strong', {}, 'The agent is publishing a new round. '),
      'Keep reviewing: the new round includes your decisions, and undecided changes carry over.'));
  }
  if (view.round && latest && view.round !== latest) {
    parts.push(el('p', {}, `You are viewing round ${view.round}. `, el('a', {href: `?task=${encodeURIComponent(TASK)}`}, `Go to round ${latest} →`)));
  } else if (view.round && count.total && !count.pending && !closed && state !== 'building') {
    const summary = ['accepted', 'rejected', 'commented'].filter(k => count[k]).map(k => `${count[k]} ${k}`).join(', ');
    parts.push(el('p', {}, el('strong', {}, `Round ${view.round} is reviewed: ${summary}. `), outcome(count)));
  }
  const warnings = view.detail?.warnings || [];
  if (warnings.length && view.round === latest) {
    parts.push(el('details', {class: 'warnings'}, el('summary', {}, `${warnings.length} new LaTeX warning${warnings.length > 1 ? 's' : ''}`),
      el('pre', {class: 'details'}, warnings.join('\n'))));
  }
  banner.replaceChildren(...parts);
  banner.hidden = !parts.length;
}

function outcome(count) {
  const applied = count.accepted ? 'Accepted changes are in your manuscript (not committed).' : 'Your manuscript is unchanged.';
  return count.commented ? `${applied} The agent will revise the commented changes and publish a new round.` : applied;
}

// Navigation

function select(index, {scroll = true, smooth = true} = {}) {
  if (index < 0 || index >= view.stops.length) return;
  view.current = index;
  storage.write({round: view.round, stop: view.stops[index].key});
  refresh();
  if (!scroll) return;
  const article = articles()[index];
  const paper = $('#paper');
  const box = article.getBoundingClientRect(), frame = paper.getBoundingClientRect();
  const space = frame.height - 40;
  const offset = box.height < space ? (space - box.height) / 2 : 12;
  settle();
  paper.scrollTo({top: paper.scrollTop + box.top - frame.top - offset, behavior: smooth ? 'smooth' : 'auto'});
  article.focus({preventScroll: true});
}

// While the page scrolls itself to the selected change, the selection stays put until the
// scrolling has stopped, however long a smooth scroll takes.
let scrollFrame = 0, settling = 0;
function settle() {
  clearTimeout(settling);
  settling = setTimeout(() => { settling = 0; followScroll(); }, 200);
}

function followScroll() {
  if (settling) return settle();
  if (scrollFrame || view.composer) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const frame = $('#paper').getBoundingClientRect();
    const regions = articles().map(article => {
      const box = article.getBoundingClientRect();
      return {index: Number(article.dataset.stop), top: box.top, bottom: box.bottom};
    });
    const index = visibleStop(regions, view.current, frame.top + 60, frame.bottom - 110);
    if (index !== view.current) select(index, {scroll: false});
  });
}

function move(direction) {
  select(view.current + direction);
}

// Decisions

async function decide(kind, body = '') {
  const stop = view.stops[view.current];
  const changes = pendingUnits(stop, view.state.decisions);
  if (!changes.length || view.busy) return;
  view.busy = kind;
  renderActions();
  try {
    view.state = await api('/decide', {id: newId(), action: kind, round: view.round, changes, body});
    if (kind === 'comment') closeComposer(true);
    const next = nextPending(view.stops, view.state.decisions, view.current);
    view.busy = null;
    if (next >= 0) select(next);
    else {
      refresh();
      toast(`Review complete. ${outcome(progress(view.state.decisions))}`);
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    view.busy = null;
    refresh();
  }
}

async function undo() {
  const entry = view.state?.undo;
  if (!entry || view.busy) return;
  view.busy = 'undo';
  renderActions();
  try {
    const value = await api('/undo', {id: entry.id});
    view.state = value;
    view.busy = null;
    const target = view.stops.findIndex(stop => stop.units.some(id => value.restored.includes(id)));
    if (target >= 0) select(target);
    toast(`Undid the ${VERB[entry.kind]} of ${value.restored.join(', ')}`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    view.busy = null;
    refresh();
  }
}

function draftKey() {
  return view.composer?.mode === 'note' ? 'note' : `${view.round}:${view.stops[view.current]?.key}`;
}

function openComposer(mode) {
  if (mode === 'comment' && !pendingUnits(view.stops[view.current], view.state.decisions).length) return;
  view.composer = {mode, stop: view.current};
  const form = $('#composer'), text = $('#composer-text');
  $('#composer-label').textContent = mode === 'note' ? 'Message the agent'
    : `Comment on change ${view.current + 1} — the agent will revise it`;
  text.placeholder = mode === 'note' ? 'Anything the agent should know or do next…' : 'What should the agent change here?';
  text.value = storage.read().drafts?.[draftKey()] || '';
  form.hidden = false;
  text.focus();
}

function closeComposer(sent = false) {
  if (!view.composer) return;
  const drafts = storage.read().drafts || {};
  if (sent) delete drafts[draftKey()];
  else if ($('#composer-text').value.trim()) drafts[draftKey()] = $('#composer-text').value;
  storage.write({drafts});
  view.composer = null;
  $('#composer').hidden = true;
}

async function submitComposer() {
  const text = $('#composer-text').value.trim();
  if (!text || !view.composer) return;
  if (view.composer.mode === 'note') {
    try {
      view.state = await api('/note', {body: text});
      closeComposer(true);
      toast('Message sent to the agent');
      refresh();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (view.composer.stop !== view.current) select(view.composer.stop);
  await decide('comment', text);
}

// Loading and polling

async function loadRound(number) {
  const state = await api(`/state${PINNED ? `?round=${number}` : ''}`);
  const detail = await api(`/rounds/${number}`);
  view.detail = detail;
  view.units = Object.fromEntries(detail.units.map(unit => [unit.id, unit]));
  view.stops = buildStops(detail);
  view.round = number;
  view.state = state;
  renderDocument();
  const saved = storage.read();
  // Back where the reader was, unless that change is decided by now: then on to the next undecided one.
  let index = saved.round === number ? view.stops.findIndex(stop => stop.key === saved.stop) : -1;
  const next = nextPending(view.stops, state.decisions, index);
  if (next >= 0 && (index < 0 || !pendingUnits(view.stops[index], state.decisions).length)) index = next;
  if (index < 0) index = view.stops.length ? 0 : -1;
  view.current = index;
  refresh();
  if (index >= 0) requestAnimationFrame(() => select(index, {smooth: false}));
}

async function poll() {
  clearTimeout(view.timer);
  try {
    const state = await api(`/state${PINNED ? `?round=${PINNED}` : view.round ? `?round=${view.round}` : ''}`);
    const was = view.online;
    view.online = true;
    if (!was) toast('Reconnected');
    const target = PINNED || state.latest;
    const replaced = view.detail && state.revision && state.revision !== view.detail.after;
    if (target && (target !== view.round || replaced) && !view.composer && !view.busy) {
      const first = view.round == null;
      await loadRound(target);
      if (!first) toast(`Round ${target} is ready`);
    } else if (!view.busy) {
      view.state = state;
      if (!view.round) renderWaiting();
      refresh();
    }
  } catch (error) {
    view.online = false;
    if (view.state) renderStatus();
    else $('#document').replaceChildren(el('p', {class: 'empty'}, error.message));
  } finally {
    view.timer = setTimeout(poll, document.hidden ? 10000 : 1500);
  }
}

function renderWaiting() {
  const job = view.state.job;
  const message = view.state.state === 'building' ? jobText(job)
    : 'Waiting for the agent to publish its changes.';
  $('#document').replaceChildren(el('div', {class: 'waiting'}, el('div', {class: 'pulse'}), el('p', {}, message),
    el('p', {class: 'muted'}, 'This page updates by itself.')));
}

async function showIndex() {
  document.body.classList.add('index');
  const response = await fetch('/api/tasks');
  const {tasks} = await response.json();
  $('#document').replaceChildren(el('section', {class: 'part'}, el('h2', {class: 'part-title'}, 'Open reviews'),
    tasks.length ? el('ul', {class: 'task-list'}, tasks.map(task => el('li', {},
      el('a', {href: `?task=${encodeURIComponent(task.task)}`}, task.title),
      el('span', {class: 'muted'}, ` · ${task.task} · ${task.round ? `round ${task.round}, ${task.counts.pending} pending` : 'no round yet'}`))))
      : el('p', {class: 'empty'}, 'No open reviews. Agents start one with review.py start.')));
}

// Events

function command(name) {
  if (name === 'accept' || name === 'reject') return decide(name);
  if (name === 'comment') return openComposer('comment');
  if (name === 'next') return move(1);
  if (name === 'previous') return move(-1);
  if (name === 'pending') return select(nextPending(view.stops, view.state.decisions || {}, view.current));
  if (name === 'undo') return undo();
  if (name === 'source') {
    const article = articles()[view.current];
    if (article) openSource(article, view.stops[view.current].units);
  }
}

function bind() {
  $('#actions').addEventListener('click', event => {
    const button = event.target.closest('button[data-command]');
    if (button && !button.disabled) command(button.dataset.command);
  });
  $('#document').addEventListener('click', event => {
    const article = event.target.closest('article.change');
    if (!article) return;
    const index = Number(article.dataset.stop);
    if (index !== view.current) select(index, {scroll: false});
    if (event.target.closest('[data-command=source]')) openSource(article, view.stops[index].units);
  });
  $('#paper').addEventListener('scroll', followScroll, {passive: true});
  $('#composer').addEventListener('submit', event => { event.preventDefault(); submitComposer(); });
  $('#composer-text').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitComposer(); }
    if (event.key === 'Escape') { event.preventDefault(); closeComposer(); }
  });
  $('#note-button').addEventListener('click', () => openComposer('note'));
  $('#help-button').addEventListener('click', () => $('#help').showModal());
  document.addEventListener('keydown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable=true]') || $('#help').open || event.isComposing) return;
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'z' && !event.shiftKey) { event.preventDefault(); undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    const map = {a: 'accept', r: 'reject', c: 'comment', j: 'next', arrowright: 'next', n: 'pending',
      k: 'previous', p: 'previous', arrowleft: 'previous', s: 'source', u: 'undo'};
    if (map[key]) {
      event.preventDefault();
      const button = $(`#actions [data-command=${map[key]}]`);
      if (!button || !button.disabled || map[key] === 'source') command(map[key]);
      if (button?.hidden && ['accept', 'reject', 'comment'].includes(map[key]) && !$('#actions [data-command=pending]').hidden) {
        toast('This change is already decided. Press N for the next undecided one.');
      }
    } else if (key === 'm' && !view.state?.closed) {
      event.preventDefault();
      openComposer('note');
    } else if (event.key === '?') {
      $('#help').showModal();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}

bind();
if (TASK) poll(); else showIndex();
