import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame} from 'remotion';
import {Paper, OpeningPdf, StaticSemantics, StaticSemanticsAfter, Preservation, PreservationAfter, ProofText, TYPE_APPLICATION, MathText} from './PLPaper';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import 'katex/dist/katex.min.css';
import './style.css';

// A ten-second loop, showing only the operations: ask → accept → comment.
export const TIMING = {review: 60, comment: 144, loop: 230, duration: 240};
const ease = Easing.bezier(0.22, 1, 0.36, 1);
const tween = (f: number, a: number, b: number, x = 0, y = 1) =>
  interpolate(f, [a, b], [x, y], {
    easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
const enter = (frame: number, delay = 0): CSSProperties => ({
  opacity: tween(frame, delay, delay + 8),
  transform: `translateY(${(1 - spring({frame: frame - delay, fps: 24,
    config: {damping: 24, stiffness: 200}})) * 12}px)`,
});
const type = (text: string, frame: number, start: number, duration: number) =>
  text.slice(0, Math.floor(interpolate(frame, [start, start + duration], [0, text.length], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  })));

const Check = ({size = 22}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const Arrow = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
    <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);
const Key = ({children}: {children: ReactNode}) => <kbd>{children}</kbd>;

type CursorPoint = [frame: number, x: number, y: number];
const Cursor = ({frame, points, click, hideAt}: {
  frame: number; points: CursorPoint[]; click: number; hideAt: number;
}) => {
  const frames = points.map((p) => p[0]);
  const options = {easing: ease, extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
  const x = interpolate(frame, frames, points.map((p) => p[1]), options);
  const y = interpolate(frame, frames, points.map((p) => p[2]), options);
  const opacity = tween(frame, frames[0], frames[0] + 4) * (1 - tween(frame, hideAt, hideAt + 4));
  const pulse = interpolate(frame, [click, click + 3, click + 7], [1, .84, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  return <div className="cursor" style={{left: x, top: y, opacity}}>
    {frame >= click && frame < click + 13 && <div className="click-ring" style={{
      opacity: 1 - tween(frame, click, click + 13),
      transform: `translate(-50%, -50%) scale(${tween(frame, click, click + 13, .3, 1.4)})`,
    }}/>}
    <svg width="35" height="41" viewBox="0 0 33 39" style={{transform: `scale(${pulse})`, transformOrigin: '0 0'}}>
      <path d="M3 2v29l8-7 6 12 6-3-6-12h11L3 2Z" fill="#202d2a" stroke="white" strokeWidth="2.5" strokeLinejoin="round"/>
    </svg>
  </div>;
};

const Ask = ({frame}: {frame: number}) => (
  <div className="app-window pdf-window">
    <div className="app-bar"><span className="tiny-dots"><i/><i/><i/></span><span className="pdf-file">paper.pdf</span><span className="file-badge">Page 5</span></div>
    <OpeningPdf/>
    <div className="pdf-agent">
      <div className="agent-context"><span>Ask agent</span><span className="context-chip">paper.pdf · Theorem 4.2</span></div>
      <div className="prompt">
        <span className="prompt-chevron">›</span>
        {type('Review the type-safety proof.', frame, 3, 19)}
        {frame < 25 && <span className="typing-caret"/>}
        <span className={`enter-key ${frame >= 23 && frame < 27 ? 'pressed' : ''}`}>↵</span>
      </div>
      <div className="agent-reply" style={enter(frame, 27)}>
        <span className="agent-icon"><Check size={25}/></span>
        <strong>Ready to review.</strong>
        <div className="review-link" style={{background: frame >= 50 ? '#205745' : undefined}}>Open review <Arrow/></div>
      </div>
    </div>
    <Cursor frame={frame} points={[[36, 1060, 577], [48, 1000, 520], [59, 1000, 520]]} click={50} hideAt={56}/>
  </div>
);

const Toolbar = ({accepted = false, second = false, commentActive = false}: {
  accepted?: boolean; second?: boolean; commentActive?: boolean;
}) => (
  <div className="toolbar">
    <span className="position">{second ? '2' : '1'} / 7</span>
    <div className={`tool accept ${accepted ? 'selected' : ''}`}>{accepted && <Check size={20}/>} {accepted ? 'Accepted' : 'Accept'}<Key>A</Key></div>
    <div className="tool reject">Reject<Key>R</Key></div>
    <div className={`tool comment ${commentActive ? 'selected' : ''}`}>Comment<Key>C</Key></div>
    <span className="next">›</span>
  </div>
);

const ReviewWindow = ({children, count = '0', round = '1', state = 'Your turn'}: {
  children: ReactNode; count?: string; round?: string; state?: string;
}) => <div className="app-window review-window">
  <div className="app-bar">
    <div className="review-title">Type safety <span>Round {round}</span></div>
    <div className="review-count">{count} / 7 <span className="progress-track"><i style={{width: `${Number(count) / 7 * 100}%`}}/></span></div>
    <div className="state-pill">{state}</div>
  </div>
  <div className="review-content">{children}</div>
</div>;

const Review = ({frame}: {frame: number}) => {
  const accepted = frame >= 53;
  const fold = tween(frame, 53, 65);
  return <ReviewWindow count={accepted ? '1' : '0'}>
    <div className="paper-viewport"><div style={{transform: `translateY(${-tween(frame, 4, 22, 0, 90)}px)`}}><Paper page={4}>
    <StaticSemantics/>
    <div className={`change-block rule-change ${accepted ? 'resolved' : ''}`}>
      <div className="change-meta"><strong>Change 1</strong><span>typing.tex:42–46</span><span className="accepted-label" style={{opacity: fold}}><Check size={17}/> Applied</span><span className="view-mode">PDF</span></div>
      <div className="diff before" style={{height: 82 * (1 - fold), opacity: 1 - fold}}>
        <div className="diff-label">BEFORE</div>
        <MathText tex={TYPE_APPLICATION.before}/>
      </div>
      <div className="diff after">
        <div className="diff-label">{accepted ? 'ACCEPTED' : 'AFTER'}</div>
        <MathText tex={TYPE_APPLICATION.after}/>
      </div>
    </div>
    <StaticSemanticsAfter/>
    </Paper></div></div>
    <Toolbar accepted={accepted}/>
    <Cursor frame={frame} points={[[26, 928, 448], [49, 414, 502], [78, 414, 502]]} click={53} hideAt={73}/>
  </ReviewWindow>;
};

const Comment = ({frame}: {frame: number}) => {
  const opened = frame >= 18;
  const sent = frame >= 58;
  const revised = frame >= 74;
  return <ReviewWindow count="1" round={revised ? '2' : '1'} state={sent && !revised ? 'Agent’s turn' : 'Your turn'}>
    <div className="paper-viewport proof-viewport"><div style={{transform: `translateY(${-tween(frame, 3, 18, 0, 190)}px)`}}><Paper page={5}>
    <Preservation/>
    <div className="change-block text-change">
      <div className="change-meta"><strong>Change 2</strong><span>type-safety.tex:83–87</span><span className="view-mode">PDF</span></div>
      <div className="diff before prose"><span className="diff-label">BEFORE</span><div><ProofText version="before"/></div></div>
      <div className="diff after prose"><span className="diff-label">AFTER</span><div><ProofText version={revised ? 'revised' : 'after'}/></div></div>
    </div>
    <PreservationAfter/>
    </Paper></div></div>
    {!opened && <Toolbar second commentActive={frame >= 15}/>}
    {opened && !sent && <div className="comment-composer" style={enter(frame, 18)}>
      <div className="composer-title">Comment</div>
      <div className="composer-input">{type('Keep the substitution step.', frame, 24, 16)}{frame < 43 && <span className="typing-caret"/>}</div>
      <div className="send">Send <Arrow/></div>
    </div>}
    {sent && <div className={`feedback-result ${revised ? 'revised' : ''}`} style={enter(frame, 58)}>
      <Check size={26}/><strong>{revised ? 'Revised. Your turn.' : 'Sent to agent.'}</strong>
    </div>}
    <Cursor frame={frame} points={[[1, 930, 430], [15, 712, 502], [22, 712, 502]]} click={17} hideAt={20}/>
    <Cursor frame={frame} points={[[46, 847, 489], [56, 990, 502], [64, 990, 502]]} click={58} hideAt={64}/>
  </ReviewWindow>;
};

const Scene = ({frame, start, end, children}: {frame: number; start: number; end: number; children: ReactNode}) => {
  if (frame < start || frame >= end + 8) return null;
  const alpha = (start === 0 ? 1 : tween(frame, start, start + 8)) * (1 - tween(frame, end, end + 8));
  return <AbsoluteFill style={{opacity: alpha}}>{children}</AbsoluteFill>;
};

export const Promo = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill className="demo">
    <Scene frame={frame} start={0} end={TIMING.review}><Ask frame={frame}/></Scene>
    <Scene frame={frame} start={TIMING.review} end={TIMING.comment}><Review frame={frame - TIMING.review}/></Scene>
    <Scene frame={frame} start={TIMING.comment} end={TIMING.loop}><Comment frame={frame - TIMING.comment}/></Scene>
    {frame >= TIMING.loop && <AbsoluteFill style={{opacity: tween(frame, TIMING.loop, TIMING.duration - 1)}}><Ask frame={0}/></AbsoluteFill>}
  </AbsoluteFill>;
};
