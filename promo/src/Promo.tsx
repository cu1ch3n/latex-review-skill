import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useDelayRender,
} from "remotion";
import {
  Paper,
  OpeningPdf,
  StaticSemantics,
  StaticSemanticsAfter,
  Preservation,
  PreservationAfter,
  ProofText,
  TYPE_APPLICATION,
  MathText,
} from "./PLPaper";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "katex/dist/katex.min.css";
import "./style.css";

export const TIMING = {
  fps: 30,
  review: 90,
  accept: 165,
  navigate: 188,
  arrived: 230,
  comment: 266,
  send: 354,
  batch: 396,
  revised: 446,
  finalAccept: 494,
  loop: 538,
  duration: 564,
};
const ease = Easing.bezier(0.22, 0.8, 0.25, 1);
const tween = (f: number, a: number, b: number, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], {
    easing: ease,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
const enter = (frame: number, start: number, duration = 16): CSSProperties => ({
  opacity: tween(frame, start, start + duration),
  transform: `translateY(${tween(frame, start, start + duration, 6, 0)}px)`,
});
const type = (text: string, frame: number, start: number, duration: number) =>
  text.slice(
    0,
    Math.floor(
      interpolate(frame, [start, start + duration], [0, text.length], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      }),
    ),
  );
const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="m5 12 4.5 4.5L19 7"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Anchor cursor paths to the rendered controls, including the composition scale.
// All motion is frame-derived, so stills and exports have identical timing.
function Cursor({
  frame,
  start,
  arrive,
  click,
  end,
  target,
  from,
}: {
  frame: number;
  start: number;
  arrive: number;
  click: number;
  end: number;
  target: string;
  from: [number, number];
}) {
  const [point, setPoint] = useState({ x: from[0], y: from[1] });
  const { delayRender, continueRender } = useDelayRender();
  useLayoutEffect(() => {
    if (frame < start || frame >= end) return;
    const handle = delayRender(`Measure cursor target: ${target}`);
    let request = 0,
      disposed = false,
      released = false;
    const release = () => {
      if (!released) {
        released = true;
        continueRender(handle);
      }
    };
    const measure = () => {
      if (disposed) return;
      const anchor = document.querySelector(`[data-cursor="${target}"]`),
        stage = document.querySelector(".demo");
      const rect = anchor?.getBoundingClientRect(),
        origin = stage?.getBoundingClientRect();
      // Remotion's initial layout can be zero-sized, especially for stills.
      if (!rect || !origin || origin.width <= 0) {
        request = requestAnimationFrame(measure);
        return;
      }
      const scale = origin.width / 1200;
      setPoint({
        x: (rect.left + rect.width / 2 - origin.left) / scale,
        y: (rect.top + rect.height / 2 - origin.top) / scale,
      });
      release();
    };
    void document.fonts.ready.then(() => {
      if (!disposed) request = requestAnimationFrame(measure);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(request);
      release();
    };
  }, [frame, target, start, end, delayRender, continueRender]);
  const opacity =
      tween(frame, start, start + 6) * (1 - tween(frame, end - 6, end)),
    press =
      frame >= click
        ? tween(frame, click, click + 3, 1, 0.9) +
          tween(frame, click + 3, click + 9, 0, 0.1)
        : 1;
  return (
    <div
      className="cursor"
      style={{
        left: tween(frame, start, arrive, from[0], point.x),
        top: tween(frame, start, arrive, from[1], point.y),
        opacity,
      }}
    >
      {frame >= click && frame < click + 16 && (
        <span
          className="click-ring"
          style={{
            opacity: 0.35 * (1 - tween(frame, click, click + 16)),
            transform: `translate(-50%, -50%) scale(${tween(frame, click, click + 16, 0.45, 1.2)})`,
          }}
        />
      )}
      <svg
        width="24"
        height="29"
        viewBox="0 0 33 39"
        style={{ transform: `scale(${press})`, transformOrigin: "0 0" }}
      >
        <path
          d="M3 2v29l8-7 6 12 6-3-6-12h11L3 2Z"
          fill="#25282b"
          stroke="#fff"
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Ask({ frame }: { frame: number }) {
  return (
    <div className="app-window pdf-window">
      <div className="app-bar">
        <span className="file-name">paper.pdf</span>
        <span className="file-detail">Type safety</span>
        <span className="page-number">5 / 12</span>
      </div>
      <OpeningPdf />
      <div className="pdf-agent">
        <div className="agent-context">
          LaTeX Review <span>paper.pdf · Theorem 4.2</span>
        </div>
        <div className="prompt">
          <span className="prompt-chevron">›</span>
          {type("Review the type-safety proof.", frame, 8, 34)}
          {frame < 48 && (
            <span
              className="typing-caret"
              style={{ opacity: Math.floor(frame / 10) % 2 ? 0.25 : 1 }}
            />
          )}
          <span
            className="enter-key"
            style={{
              background: frame >= 47 && frame < 54 ? "#edf1f5" : "#fff",
            }}
          >
            ↵
          </span>
        </div>
        <div className="agent-reply" style={enter(frame, 55)}>
          <Check />
          <span>Seven changes ready for review.</span>
          <span className="review-link" data-cursor="open">
            Open review <span>↗</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Toolbar({
  frame,
  proof = false,
  accepted = false,
}: {
  frame: number;
  proof?: boolean;
  accepted?: boolean;
}) {
  const revised = proof && frame >= TIMING.revised,
    commented = proof && frame >= TIMING.send && !revised;
  return (
    <div className="toolbar">
      <span className="nav-arrow">‹</span>
      <span className="position">
        {proof && !revised ? "2" : "1"} / {revised ? "1" : "7"}
      </span>
      <span
        className="toolbar-controls"
        style={{ opacity: accepted || commented ? 0 : 1 }}
      >
        <span
          className="tool accept"
          data-cursor={proof ? "proof-accept" : "rule-accept"}
        >
          Accept
        </span>
        <span className="tool reject">Reject</span>
        <span
          className="tool comment"
          data-cursor={proof ? "comment" : undefined}
          style={{
            background:
              proof &&
              frame >= TIMING.comment - 5 &&
              frame < TIMING.comment + 10
                ? "#edf2f8"
                : undefined,
          }}
        >
          Comment
        </span>
      </span>
      {(accepted || commented) && (
        <span className="toolbar-result">
          {accepted ? "Accepted" : "Commented"}
        </span>
      )}
      <span className="nav-arrow">›</span>
      <span className="undo">Undo</span>
    </div>
  );
}

function Minimap({ frame }: { frame: number }) {
  const travel = tween(frame, TIMING.navigate, TIMING.arrived),
    nextRound = tween(frame, TIMING.revised, TIMING.revised + 18),
    accepted = frame >= TIMING.accept,
    sent = frame >= TIMING.send,
    batch = frame >= TIMING.batch,
    finished = frame >= TIMING.finalAccept;
  return (
    <div className="minimap">
      <div
        className="minimap-viewport"
        style={{
          top:
            20 +
            tween(frame, TIMING.review + 8, TIMING.review + 32, 0, 25) +
            travel * 142,
          height: 124 + nextRound * 120,
        }}
      />
      {[0.12, 0.39, 0.53, 0.64, 0.75, 0.84, 0.93].map((position, index) => {
        const current = frame < TIMING.navigate ? index === 0 : index === 1,
          status =
            index === 0
              ? accepted
                ? "accepted"
                : "pending"
              : index === 1
                ? finished
                  ? "accepted"
                  : nextRound > 0
                    ? "pending"
                    : sent
                      ? "commented"
                      : "pending"
                : batch
                  ? "accepted"
                  : "pending";
        return (
          <span
            key={index}
            className={`map-mark ${status} ${current ? "current" : ""}`}
            style={{
              top: `${position * 100}%`,
              height: index === 1 ? 31 : index === 0 ? 21 : 12,
              opacity: index === 1 ? 1 : 1 - nextRound,
            }}
          />
        );
      })}
    </div>
  );
}

function RuleChange({ frame }: { frame: number }) {
  const accepted = frame >= TIMING.accept,
    fold = tween(frame, TIMING.accept, TIMING.accept + 20),
    active = frame < TIMING.navigate;
  return (
    <div className={`change-block rule-change ${active ? "current" : ""}`}>
      <div className="change-meta">
        <span>Change 1</span>
        <span className="source-location">typing.tex:42–46 · p. 4</span>
        {active && <Toolbar frame={frame} accepted={accepted} />}
        {accepted && !active && (
          <span className="accepted-label">
            <Check /> Accepted
          </span>
        )}
        <span className="meta-link">LaTeX</span>
      </div>
      <div
        className="diff before"
        style={{ height: 82 * (1 - fold), opacity: 1 - fold }}
      >
        <span className="diff-label">Before</span>
        <MathText tex={TYPE_APPLICATION.before} />
      </div>
      <div
        className="diff after"
        style={{
          background: `rgba(238, 248, 241, ${1 - fold})`,
          borderLeftColor: `rgba(104, 171, 130, ${1 - fold})`,
        }}
      >
        <span className="diff-label" style={{ opacity: 1 - fold }}>
          After
        </span>
        <MathText
          tex={accepted ? TYPE_APPLICATION.afterClean : TYPE_APPLICATION.after}
        />
      </div>
    </div>
  );
}

function ProofChange({ frame }: { frame: number }) {
  const revised = frame >= TIMING.revised,
    finished = frame >= TIMING.finalAccept,
    fold = tween(frame, TIMING.finalAccept, TIMING.finalAccept + 20),
    commented = frame >= TIMING.send && !revised,
    active = frame >= TIMING.navigate;
  return (
    <div className={`change-block text-change ${active ? "current" : ""}`}>
      <div className="change-meta">
        <span>Change {revised ? "1" : "2"}</span>
        <span className="source-location">type-safety.tex:83–87 · p. 5</span>
        {active && <Toolbar frame={frame} proof accepted={finished} />}
        <span className="meta-link">LaTeX</span>
      </div>
      {revised && (
        <div className="comment-history" style={enter(frame, TIMING.revised)}>
          Revised after your comment: <span>“Keep the substitution step.”</span>
        </div>
      )}
      <div
        className="diff before prose"
        style={{
          height: (revised ? 74 : 110) * (1 - fold),
          paddingBlock: 14 * (1 - fold),
          opacity: 1 - fold,
        }}
      >
        <span className="diff-label">Before</span>
        <div className="proof-content">
          <span className="deleted">
            <ProofText version={revised ? "after" : "before"} />
          </span>
        </div>
      </div>
      <div
        className="diff after prose"
        style={{
          height: revised ? 110 : 74,
          background: `rgba(238, 248, 241, ${1 - fold})`,
          borderLeftColor: `rgba(104, 171, 130, ${1 - fold})`,
        }}
      >
        <span className="diff-label" style={{ opacity: 1 - fold }}>
          After
        </span>
        <div className="proof-content">
          <span className={finished ? "" : "inserted"}>
            <ProofText version={revised ? "revised" : "after"} />
          </span>
        </div>
      </div>
      {commented && (
        <div className="comment-history" style={enter(frame, TIMING.send)}>
          Your comment: <span>Keep the substitution step.</span>
        </div>
      )}
    </div>
  );
}

function Review({ frame }: { frame: number }) {
  const revised = frame >= TIMING.revised,
    finished = frame >= TIMING.finalAccept,
    total = revised ? 1 : 7,
    count = revised
      ? finished
        ? 1
        : 0
      : frame >= TIMING.batch
        ? 7
        : frame >= TIMING.send
          ? 2
          : frame >= TIMING.accept
            ? 1
            : 0,
    publishing = frame >= TIMING.batch + 12 && !revised,
    travel =
      tween(frame, TIMING.review + 8, TIMING.review + 32, 0, 200) +
      tween(frame, TIMING.navigate, TIMING.arrived, 0, 980);
  return (
    <div className="app-window review-window">
      <div className="app-bar">
        <span className="all-reviews">← All reviews</span>
        <span className="review-title">Type safety</span>
        <span className="round">Round {revised ? "2" : "1"}</span>
        <span className="review-count">
          {count} of {total} decided
        </span>
        <span
          className="accept-all"
          data-cursor="accept-all"
          style={{ opacity: count === total ? 0 : 1 }}
        >
          Accept all ({total - count})
        </span>
        <span className="help">?</span>
      </div>
      <div className="review-content">
        <div className="paper-viewport">
          <div
            className="paper-stack"
            style={{ transform: `translateY(${-travel}px)` }}
          >
            <Paper page={4}>
              <StaticSemantics />
              <RuleChange frame={frame} />
              <StaticSemanticsAfter />
            </Paper>
            <Paper page={5}>
              <Preservation />
              <ProofChange frame={frame} />
              <PreservationAfter />
            </Paper>
          </div>
        </div>
        <Minimap frame={frame} />
        <div
          className="comment-composer"
          style={{
            ...enter(frame, TIMING.comment),
            opacity:
              tween(frame, TIMING.comment, TIMING.comment + 16) *
              (1 - tween(frame, TIMING.send, TIMING.send + 10)),
          }}
        >
          <div className="composer-title">Comment on change 2</div>
          <div className="composer-input">
            {type(
              "Keep the substitution step.",
              frame,
              TIMING.comment + 14,
              42,
            )}
            {frame < TIMING.send - 18 && <span className="typing-caret" />}
          </div>
          <div className="composer-footer">
            <span>⌘↵ send · Esc cancel</span>
            <span className="cancel">Cancel</span>
            <span className="send" data-cursor="send">
              Send
            </span>
          </div>
        </div>
        {publishing && (
          <div className="notice" style={enter(frame, TIMING.batch + 12)}>
            <span
              className="working-dot"
              style={{ opacity: 0.55 + Math.sin(frame / 8) * 0.25 }}
            />{" "}
            Publishing a new round…
          </div>
        )}
        {finished && (
          <div
            className="notice complete-notice"
            style={enter(frame, TIMING.finalAccept + 14)}
          >
            <Check /> This round is reviewed. Your decisions are saved.
          </div>
        )}
      </div>
    </div>
  );
}

export function Promo() {
  const frame = useCurrentFrame(),
    { delayRender, continueRender } = useDelayRender(),
    [handle] = useState(() => delayRender("Load the local paper and UI fonts"));
  useEffect(() => {
    void document.fonts.ready.then(() => continueRender(handle));
  }, [continueRender, handle]);
  const reviewOpacity = tween(frame, TIMING.review, TIMING.review + 16),
    closing = tween(frame, TIMING.loop, TIMING.duration - 1),
    openingFrame = frame >= TIMING.loop ? 0 : frame;
  return (
    <AbsoluteFill className="demo">
      <AbsoluteFill
        style={{ opacity: frame >= TIMING.loop ? closing : 1 - reviewOpacity }}
      >
        <Ask frame={openingFrame} />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity: reviewOpacity * (1 - closing),
          transform: `translateY(${(1 - reviewOpacity) * 5}px)`,
        }}
      >
        <Review frame={frame} />
      </AbsoluteFill>
      <Cursor
        frame={frame}
        start={64}
        arrive={79}
        click={83}
        end={96}
        target="open"
        from={[1030, 610]}
      />
      <Cursor
        frame={frame}
        start={129}
        arrive={157}
        click={TIMING.accept}
        end={183}
        target="rule-accept"
        from={[1030, 476]}
      />
      <Cursor
        frame={frame}
        start={238}
        arrive={259}
        click={TIMING.comment}
        end={280}
        target="comment"
        from={[1020, 436]}
      />
      <Cursor
        frame={frame}
        start={330}
        arrive={347}
        click={TIMING.send}
        end={368}
        target="send"
        from={[975, 563]}
      />
      <Cursor
        frame={frame}
        start={371}
        arrive={390}
        click={TIMING.batch}
        end={412}
        target="accept-all"
        from={[995, 370]}
      />
      <Cursor
        frame={frame}
        start={467}
        arrive={486}
        click={TIMING.finalAccept}
        end={511}
        target="accept-all"
        from={[1000, 351]}
      />
    </AbsoluteFill>
  );
}
