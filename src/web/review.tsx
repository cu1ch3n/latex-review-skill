import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ActionKind,
  ChangeBlock,
  PageState,
  RoundDetail,
  Strip,
  Unit,
  VisualUnit,
} from "../types.ts";
import { PdfStrip } from "./PdfStrip.tsx";
import { ChangeMap } from "./ChangeMap.tsx";
import { STATUS } from "./overview.tsx";
import {
  buildStops,
  copyReference,
  describeLocation,
  nextPending,
  pendingUnits,
  progress,
  resolvedSide,
  stopState,
  visibleStop,
  wordDiff,
} from "./model.ts";
const KIND = {
  text: "Text",
  layout: "Layout",
  position: "Moved",
  identical: "No visible change",
  unmapped: "Source only",
};
const PHASE: Record<string, string> = {
  snapshot: "Taking a snapshot",
  build: "Compiling LaTeX",
  render: "Rendering the diff",
};
type Composer = {
  changes: string[];
  stop: number;
  key: string;
};
function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage is optional. */
  }
}
function jobText(job: PageState["job"]) {
  return job?.status === "queued"
    ? job.ahead
      ? `Queued behind ${job.ahead} other rounds…`
      : "Queued…"
    : `${PHASE[job?.phase ?? ""] || "Starting"}…`;
}
export function ReviewApp({
  task,
  pinned,
}: {
  task: string;
  pinned: number | null;
}) {
  const [state, setState] = useState<PageState | null>(null),
    [detail, setDetail] = useState<RoundDetail | null>(null),
    [current, setCurrent] = useState(-1),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [openSource, setOpenSource] = useState<Set<number>>(new Set()),
    [composer, setComposer] = useState<Composer | null>(null),
    [draft, setDraft] = useState(""),
    [help, setHelp] = useState(false);
  const paper = useRef<HTMLElement>(null),
    epoch = useRef(0),
    scrollUntil = useRef(0),
    snapshot = useRef({ state, detail, busy, composer, current });
  snapshot.current = { state, detail, busy, composer, current };
  const units = useMemo(
      () => new Map(detail?.units.map((u) => [u.id, u]) ?? []),
      [detail],
    ),
    stops = useMemo(() => (detail ? buildStops(detail) : []), [detail]),
    locations = useMemo(
      () =>
        stops.map((stop) =>
          describeLocation(
            stop.units.map((id) => units.get(id)!).filter(Boolean),
          ),
        ),
      [stops, units],
    ),
    decisions = state?.decisions ?? {},
    count = progress(decisions),
    latest = Boolean(
      detail && state && detail.round === state.latest && !state.closed,
    );
  async function api<T>(route: string, body?: unknown): Promise<T> {
    const response = await fetch(
      `/api/tasks/${encodeURIComponent(task)}${route}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Review-Token": snapshot.current.state?.csrf ?? "",
            },
            body: JSON.stringify(body),
          },
    );
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value as T;
  }
  function select(index: number, scroll = true) {
    if (index < 0 || index >= stops.length) return;
    setCurrent(index);
    store(`latex-review:${task}`, {
      round: detail?.round,
      stop: stops[index].key,
    });
    if (scroll) {
      scrollUntil.current = Date.now() + 800;
      requestAnimationFrame(() => {
        const article = paper.current?.querySelector<HTMLElement>(
          `[data-stop="${index}"]`,
        );
        article?.scrollIntoView({ block: "start", behavior: "smooth" });
        article?.focus({ preventScroll: true });
      });
    }
  }
  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const requestedEpoch = epoch.current;
      try {
        const previous = snapshot.current,
          number = pinned || previous.detail?.round,
          next = await api<PageState>(
            `/state${number ? `?round=${number}` : ""}`,
          );
        if (
          cancelled ||
          epoch.current !== requestedEpoch ||
          snapshot.current.busy
        )
          return;
        setOnline(true);
        setError("");
        const target = pinned || next.latest;
        if (
          target &&
          (target !== previous.detail?.round ||
            (next.revision && next.revision !== previous.detail?.after)) &&
          !snapshot.current.composer
        ) {
          const [loadedState, loaded] = await Promise.all([
            api<PageState>(`/state?round=${target}`),
            api<RoundDetail>(`/rounds/${target}`),
          ]);
          if (
            cancelled ||
            epoch.current !== requestedEpoch ||
            snapshot.current.busy
          )
            return;
          const nextStops = buildStops(loaded),
            saved = readStorage<{ round?: number; stop?: string }>(
              `latex-review:${task}`,
              {},
            );
          let index =
            saved.round === target
              ? nextStops.findIndex((s) => s.key === saved.stop)
              : -1;
          if (
            index < 0 ||
            !pendingUnits(nextStops[index], loadedState.decisions).length
          )
            index = nextPending(nextStops, loadedState.decisions, index);
          if (index < 0) index = nextStops.length ? 0 : -1;
          setState(loadedState);
          setDetail(loaded);
          setCurrent(index);
          setOpenSource(new Set());
          if (previous.detail) setToast(`Round ${target} is ready`);
        } else setState(next);
      } catch (e) {
        if (!cancelled) {
          setOnline(false);
          setError((e as Error).message);
        }
      } finally {
        if (!cancelled)
          timer = setTimeout(poll, document.hidden ? 10000 : 1500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [task, pinned]);
  useEffect(() => {
    if (detail && current >= 0)
      requestAnimationFrame(() =>
        paper.current
          ?.querySelector<HTMLElement>(`[data-stop="${current}"]`)
          ?.scrollIntoView({ block: "start" }),
      );
  }, [detail?.round]);
  useEffect(() => {
    if (state) document.title = `${state.title} · LaTeX Review`;
  }, [state?.title]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  function beginComposer(changes = pendingUnits(stops[current], decisions)) {
    if (!latest || !changes.length || busy || state?.closed) return;
    const key = `latex-review:${task}:draft:${detail?.round}:${changes.join(",")}`;
    setDraft(readStorage(key, ""));
    setComposer({ changes, stop: current, key });
  }
  function closeComposer(sent = false) {
    if (composer) store(composer.key, sent ? "" : draft);
    setComposer(null);
  }
  async function decide(
    kind: ActionKind,
    changes = pendingUnits(stops[current], decisions),
    body = "",
  ) {
    if (!changes.length || busy || !latest || !detail) return;
    epoch.current++;
    setBusy(true);
    snapshot.current.busy = true;
    try {
      const next = await api<PageState>("/decide", {
        id: crypto.randomUUID(),
        action: kind,
        round: detail.round,
        changes,
        body,
      });
      setState(next);
      if (kind === "comment") closeComposer(true);
      const target = pendingUnits(stops[current], next.decisions).length
        ? current
        : nextPending(stops, next.decisions, current);
      if (target >= 0 && target !== current) select(target);
      if (target < 0)
        setToast("This round is reviewed. Your decisions are saved.");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      epoch.current++;
      setBusy(false);
      snapshot.current.busy = false;
    }
  }
  async function undo() {
    if (!state?.undo || busy) return;
    epoch.current++;
    setBusy(true);
    snapshot.current.busy = true;
    try {
      const next = await api<PageState & { restored: string[] }>("/undo", {
        id: state.undo.id,
      });
      setState(next);
      const target = stops.findIndex((s) =>
        s.units.some((id) => next.restored.includes(id)),
      );
      if (target >= 0) select(target);
      setToast("Decision undone.");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      epoch.current++;
      setBusy(false);
      snapshot.current.busy = false;
    }
  }
  async function submitComposer() {
    if (!composer || !draft.trim() || busy) return;
    await decide("comment", composer.changes, draft.trim());
  }
  function toggleSource(index: number) {
    setOpenSource((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }
  async function copy(index: number) {
    if (!detail || !state) return;
    const selected = window.getSelection()?.toString().trim() ?? "",
      known = stops[index].units.map((id) => units.get(id)!).filter(Boolean);
    try {
      await navigator.clipboard.writeText(
        copyReference(
          state.title,
          detail.round,
          index + 1,
          describeLocation(known),
          selected,
        ),
      );
      setToast(
        selected
          ? "Copied selected text with file, lines and PDF page."
          : "Copied the change location.",
      );
    } catch (e) {
      setToast(
        "Clipboard unavailable. Select the PDF text and use your browser’s Copy command.",
      );
    }
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement,
        typing =
          target.matches("input,textarea,select") || target.isContentEditable;
      if (event.key === "Escape") {
        if (help) setHelp(false);
        else if (composer) closeComposer();
        return;
      }
      if (
        composer &&
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        void submitComposer();
        return;
      }
      if (typing || help) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
        return;
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        composer ||
        window.getSelection()?.toString()
      )
        return;
      const key = event.key.toLowerCase();
      if (
        [
          "a",
          "r",
          "c",
          "j",
          "k",
          "arrowright",
          "arrowleft",
          "n",
          "s",
          "u",
          "?",
        ].includes(key)
      )
        event.preventDefault();
      if (key === "a") void decide("accept");
      else if (key === "r") void decide("reject");
      else if (key === "c") beginComposer();
      else if (key === "j" || key === "arrowright") select(current + 1);
      else if (key === "k" || key === "arrowleft") select(current - 1);
      else if (key === "n") select(nextPending(stops, decisions, current));
      else if (key === "s") toggleSource(current);
      else if (key === "u") void undo();
      else if (key === "?") setHelp(true);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [state, detail, current, busy, composer, draft, help]);
  function onScroll() {
    if (
      !paper.current ||
      composer ||
      Date.now() < scrollUntil.current ||
      window.getSelection()?.toString()
    )
      return;
    const box = paper.current.getBoundingClientRect(),
      regions = [
        ...paper.current.querySelectorAll<HTMLElement>("[data-stop]"),
      ].map((article) => {
        const b = article.getBoundingClientRect();
        return {
          index: Number(article.dataset.stop),
          top: b.top,
          bottom: b.bottom,
        };
      });
    const index = visibleStop(regions, current, box.top + 60, box.bottom - 100);
    if (index !== current) select(index, false);
  }
  const actionBar = (index: number) => {
    if (index !== current || !state) return null;
    const pending = pendingUnits(stops[index], decisions),
      remaining = nextPending(stops, decisions);
    return (
      <div className="dock">
        <nav className="actions" aria-label="Review the current change">
          <button
            className="nav"
            aria-label="Previous change"
            aria-keyshortcuts="k ArrowLeft"
            title="Previous change (K or ←)"
            disabled={index === 0}
            onClick={() => select(index - 1)}
          >
            ‹
          </button>
          <span className="position">
            {index + 1} / {stops.length}
          </span>
          {pending.length ? (
            <>
              {(["accept", "reject", "comment"] as const).map((kind) => (
                <button
                  className={kind}
                  key={kind}
                  aria-keyshortcuts={kind[0]}
                  title={`${kind[0].toUpperCase() + kind.slice(1)} (${kind[0].toUpperCase()})`}
                  disabled={busy || !latest}
                  onClick={() =>
                    kind === "comment" ? beginComposer() : void decide(kind)
                  }
                >
                  {kind[0].toUpperCase() + kind.slice(1)}
                  {pending.length > 1 && kind !== "comment"
                    ? ` (${pending.length})`
                    : ""}
                </button>
              ))}
            </>
          ) : remaining >= 0 ? (
            <button
              className="skip"
              aria-keyshortcuts="n"
              onClick={() => select(nextPending(stops, decisions, current))}
            >
              Next undecided
            </button>
          ) : (
            <span className="complete">
              {latest ? "Review complete" : "Earlier round"}
            </span>
          )}
          <button
            className="nav"
            aria-label="Next change"
            aria-keyshortcuts="j ArrowRight"
            title="Next change (J or →)"
            disabled={index === stops.length - 1}
            onClick={() => select(index + 1)}
          >
            ›
          </button>
          <button
            className="undo"
            disabled={!state.undo || busy}
            onClick={() => void undo()}
          >
            Undo
          </button>
        </nav>
      </div>
    );
  };
  function change(
    block: ChangeBlock,
    index: number,
    inline: boolean,
  ): ReactNode {
    const known = block.units.map((id) => units.get(id)!).filter(Boolean),
      resolved = resolvedSide(block.units, decisions),
      status = stopState(block.units, decisions),
      source =
        openSource.has(index) ||
        block.identical ||
        (!block.before.length && !block.after.length),
      remarks = [
        ...new Set(
          block.units.map((id) => state?.comments[id]).filter(Boolean),
        ),
      ],
      location = describeLocation(known),
      kindLabel = block.reflow
        ? "Reflow"
        : [...new Set(known.map((u) => u.visual ?? "unmapped"))]
            .filter((kind) => kind !== "text")
            .map((kind) => KIND[kind])
            .join(", ");
    const images = (items: Strip[], side: "before" | "after") => (
      <div
        className={`side ${side}${block.identical ? " identical" : ""}`}
        aria-label={side === "before" ? "Before" : "After"}
      >
        {items.map((image) => (
          <PdfStrip
            key={image.src}
            image={image}
            base={detail!.files}
            label={side === "before" ? "Before" : "After"}
            clean={Boolean(resolved)}
          />
        ))}
      </div>
    );
    return (
      <article
        key={index}
        className={`change ${inline ? "inline" : "standalone"}${current === index ? " current" : ""}`}
        data-stop={index}
        data-state={status}
        data-resolved={resolved}
        tabIndex={-1}
        onClick={() => {
          if (index !== current && !composer) select(index, false);
        }}
      >
        <header className="change-head">
          <span className="change-number">Change {index + 1}</span>
          <span className="change-where" title={location}>
            {location}
          </span>
          {actionBar(index)}
          {kindLabel && <span className="change-kind">{kindLabel}</span>}
          {status !== "pending" && (
            <span className="badge">
              {status[0].toUpperCase() + status.slice(1)}
            </span>
          )}
          <button
            className="link copy-reference"
            title="Copy selected text with this change’s file, line numbers and PDF page"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => void copy(index)}
          >
            Copy reference
          </button>
          <button
            className={`link ${source ? "active" : ""}`}
            title="Show the LaTeX source (S)"
            onClick={() => toggleSource(index)}
          >
            {block.units.length > 1
              ? `${block.units.length} edits · LaTeX`
              : "LaTeX"}
          </button>
        </header>
        {known.some((u) => u.history?.length) && (
          <div className="histories">
            {known
              .flatMap((u) => u.history ?? [])
              .map((h, i) => (
                <p key={i}>
                  <strong>
                    Revised after your comment in round {h.round}:{" "}
                  </strong>
                  “{h.comment}”
                </p>
              ))}
          </div>
        )}
        {!block.identical &&
          !block.reflow &&
          block.before.length > 0 &&
          images(block.before, "before")}
        {block.after.length > 0 && images(block.after, "after")}
        {block.identical && (
          <p className="caption">
            No visible change in the PDF; see the LaTeX source.
          </p>
        )}
        {block.reflow && (
          <p className="caption">Continued: only line breaks moved here.</p>
        )}
        {remarks.length > 0 && (
          <div className="remark">
            {remarks.map((r, i) => (
              <p key={i}>
                <strong>Your comment: </strong>
                {r}
              </p>
            ))}
          </div>
        )}
        {source && (
          <div className="source">
            {known.map((unit) => (
              <div
                className="source-unit"
                data-state={decisions[unit.id]}
                key={unit.id}
              >
                <div className="source-title">
                  <span>
                    {unit.file} · lines {unit.new_start}–{unit.new_end}
                  </span>
                  {known.length > 1 && (
                    <span className="unit-actions">
                      <span className="unit-state">
                        {decisions[unit.id] !== "pending"
                          ? decisions[unit.id]
                          : ""}
                      </span>
                      {decisions[unit.id] === "pending" &&
                        (["accept", "reject", "comment"] as const).map(
                          (kind) => (
                            <button
                              className={kind}
                              key={kind}
                              disabled={busy || !latest}
                              onClick={() =>
                                kind === "comment"
                                  ? beginComposer([unit.id])
                                  : void decide(kind, [unit.id])
                              }
                            >
                              {kind[0].toUpperCase() + kind.slice(1)}
                            </button>
                          ),
                        )}
                    </span>
                  )}
                </div>
                {unit.kind === "binary" ? (
                  <p>Binary file changed.</p>
                ) : (
                  <pre className="source-code">
                    {wordDiff(unit.old_text, unit.new_text).map((part, i) =>
                      part.type === "del" ? (
                        <del key={i}>{part.text}</del>
                      ) : part.type === "ins" ? (
                        <ins key={i}>{part.text}</ins>
                      ) : (
                        <Fragment key={i}>{part.text}</Fragment>
                      ),
                    )}
                  </pre>
                )}
                {unit.truncated && (
                  <p className="muted">Long change: the source is shortened.</p>
                )}
              </div>
            ))}
          </div>
        )}
      </article>
    );
  }
  let index = 0;
  return (
    <>
      <header className="bar">
        <a className="ghost overview-link" href="/">
          ← All reviews
        </a>
        <div className="identity">
          <h1>{state?.title ?? "LaTeX Review"}</h1>
          <span className="muted">
            {detail
              ? `Round ${detail.round}${detail.round !== state?.latest ? " (earlier round)" : ""}`
              : ""}
          </span>
        </div>
        {count.total > 0 && (
          <div className="meter">
            <span>
              {count.decided} of {count.total} decided
            </span>
          </div>
        )}
        <div className="bar-end">
          {count.pending > 0 && (
            <button
              className="ghost accept accept-all"
              disabled={busy || !latest || Boolean(composer)}
              title="Accept all pending changes in this round. Undo reverses the whole batch."
              onClick={() =>
                void decide(
                  "accept",
                  Object.keys(decisions).filter(
                    (id) => decisions[id] === "pending",
                  ),
                )
              }
            >
              Accept all ({count.pending})
            </button>
          )}
          {(!online || state?.closed || state?.state !== "reviewing") && (
            <span
              className="status"
              role="status"
              data-state={!online ? "offline" : state?.state}
            >
              {!online
                ? "Reconnecting…"
                : state?.closed
                  ? "Finished"
                  : state?.state === "building"
                    ? jobText(state.job)
                    : STATUS[state?.state ?? ""]}
            </span>
          )}
          <button
            className="ghost round"
            aria-label="Keyboard shortcuts"
            onClick={() => setHelp(true)}
          >
            ?
          </button>
        </div>
      </header>
      <div className="review-body">
        <main id="paper" ref={paper} tabIndex={-1} onScroll={onScroll}>
          {state?.closed && (
            <div className="banner">
              This review is finished. Accepted changes are in your manuscript.
            </div>
          )}
          {state?.state === "build_failed" && (
            <div className="banner">
              <strong>The latest publish failed: </strong>
              {state.job?.error}
              {state.job?.details && (
                <pre className="details">{state.job.details.join("\n")}</pre>
              )}
            </div>
          )}
          {state?.state === "building" && detail && (
            <div className="banner">
              The agent is publishing a new round. You can keep reviewing; the
              new round will include your decisions.
            </div>
          )}
          {detail && state?.latest && detail.round !== state.latest && (
            <div className="banner">
              You are viewing round {detail.round}.{" "}
              <a href={`?task=${encodeURIComponent(task)}`}>
                Go to round {state.latest} →
              </a>
            </div>
          )}
          {detail?.warnings.length ? (
            <div className="banner">
              <details>
                <summary>{detail.warnings.length} new LaTeX warnings</summary>
                <pre className="details">{detail.warnings.join("\n")}</pre>
              </details>
            </div>
          ) : null}
          {detail &&
            count.total > 0 &&
            !count.pending &&
            state?.state !== "building" && (
              <div className="banner">
                Round {detail.round} is reviewed:{" "}
                {(["accepted", "rejected", "commented"] as const)
                  .filter((k) => count[k])
                  .map((k) => `${count[k]} ${k}`)
                  .join(", ")}
                .{" "}
                {count.commented
                  ? "The agent will revise your comments."
                  : "The review remains available for inspection and undo."}
              </div>
            )}
          <div className="document">
            {detail ? (
              <>
                {detail.sections.map((section) => (
                  <section className="part" key={section.node}>
                    <h2 className="part-title">
                      <span className="number">{section.number}</span>
                      {section.title}
                    </h2>
                    <div className="sheet">
                      {section.blocks.map((block, b) =>
                        block.kind === "context" ? (
                          <div className="context" key={`context-${b}`}>
                            <PdfStrip
                              image={block.image}
                              base={detail.files}
                              label="Unchanged text"
                            />
                          </div>
                        ) : block.kind === "gap" ? (
                          <div
                            className="fold"
                            key={`gap-${b}`}
                            title="Unchanged text is folded"
                          >
                            ⋯
                          </div>
                        ) : (
                          change(block, index++, true)
                        ),
                      )}
                    </div>
                  </section>
                ))}
                {detail.loose.length > 0 && (
                  <section className="part">
                    <h2 className="part-title">
                      {detail.sections.length ? "Other changes" : "Changes"}
                    </h2>
                    {detail.loose.map((block) => change(block, index++, false))}
                  </section>
                )}
                {!stops.length && (
                  <p className="empty">This round has no changes.</p>
                )}
              </>
            ) : error ? (
              <p className="empty" role="alert">
                {error}
              </p>
            ) : (
              <div className="waiting">
                <div className="pulse" />
                <p>
                  {state?.state === "building"
                    ? jobText(state.job)
                    : "Waiting for the agent to publish its changes."}
                </p>
                <p className="muted">This page updates by itself.</p>
              </div>
            )}
          </div>
        </main>
        <ChangeMap
          scrollRoot={paper}
          stops={stops}
          locations={locations}
          decisions={decisions}
          current={current}
          disabled={Boolean(composer)}
          onSelect={select}
        />
      </div>
      {composer && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submitComposer();
          }}
        >
          <label htmlFor="composer-text">
            Comment on change {composer.stop + 1}
          </label>
          <textarea
            id="composer-text"
            autoFocus
            rows={4}
            maxLength={20000}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              store(composer.key, e.target.value);
            }}
            placeholder="What should the agent change here?"
          />
          <div className="composer-row">
            <span className="muted">⌘↵ send · Esc cancel</span>
            <button type="button" onClick={() => closeComposer()}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !draft.trim()}>
              Send
            </button>
          </div>
        </form>
      )}
      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
      {help && (
        <div className="help-backdrop" onClick={() => setHelp(false)}>
          <dialog
            open
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="help-title">Keyboard shortcuts</h2>
            <dl>
              {[
                ["A", "Accept"],
                ["R", "Reject"],
                ["C", "Comment"],
                ["J / K or → / ←", "Next / previous change"],
                ["N", "Next undecided"],
                ["S", "Show LaTeX source"],
                ["⌘Z / U", "Undo"],
                ["⌘C / Ctrl+C", "Copy selected PDF text"],
              ].map(([key, label]) => (
                <Fragment key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{label}</dd>
                </Fragment>
              ))}
            </dl>
            <p className="muted">
              Select text directly in the PDF preview. Copy reference includes
              the selection and its file, line numbers and page. Review
              shortcuts pause while text is selected.
            </p>
            <button onClick={() => setHelp(false)}>Close</button>
          </dialog>
        </div>
      )}
    </>
  );
}
