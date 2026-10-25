export type Span = [number, number];
export type Rect = [number, number, number, number];
export type SourceBox = [
  page: number,
  top: number,
  bottom: number,
  left?: number,
  right?: number,
];
export type Ranges = Record<string, Span[]>;
export type Op = [
  "equal" | "replace" | "insert" | "delete",
  number,
  number,
  number,
  number,
];
export interface Heading {
  id: string;
  title: string;
  number: string;
  kind: string;
  level: number;
  file: string;
  line: number;
  parent: string | null;
  labels: string[];
  ranges: Ranges;
  files: string[];
}
export interface SectionRef {
  id: string;
  number: string;
  title: string;
}
export interface Scope {
  paths: string[];
  ranges: Ranges | null;
  sections: SectionRef[];
}
export interface Task {
  name: string;
  title: string;
  worktree: string;
  base: string;
  accepted: string;
  scope: Scope;
  created: number;
  closed: number | null;
}
export interface Unit {
  id: string;
  file: string;
  status: "added" | "deleted" | "modified";
  kind: "text" | "figure" | "binary";
  whole_file: boolean;
  ops: Op[];
  old_start: number;
  old_end: number;
  new_start: number;
  new_end: number;
  old_text: string;
  new_text: string;
  truncated: boolean;
}
export interface Round {
  task: string;
  number: number;
  before: string;
  after: string;
  units: Unit[];
  summary: { warnings: string[]; targets: string[]; builds: string[] };
  created: number;
}
export type ActionKind = "accept" | "reject" | "comment";
export type Decision = "accepted" | "rejected" | "commented" | "pending";
export interface ActionDetail {
  accepted_before?: string;
  accepted_after?: string;
  not_reverted?: string[];
}
export interface Action {
  seq: number;
  id: string;
  task: string;
  round: number;
  kind: ActionKind;
  changes: string[];
  body: string;
  status: "applying" | "applied" | "undoing" | "undone" | "failed";
  detail: ActionDetail;
  created: number;
}
export interface Write {
  action: string;
  phase: "apply" | "undo";
  path: string;
  expected: Buffer | null;
  target: Buffer | null;
}
export interface MessageData {
  changes?: string[];
  not_reverted?: string[];
  undid?: string;
  message?: number;
}
export interface Message {
  id: number;
  task: string;
  round: number | null;
  kind: ActionKind | "undo" | "note";
  action: string | null;
  body: string;
  data: MessageData;
  created: number;
}
export interface JobResult {
  outcome?: "published" | "unchanged" | "empty";
  round?: number | null;
  changes?: number;
  kinds?: Record<string, number>;
  warnings?: string[];
  error?: string;
  details?: string[];
  next?: string;
  log?: string;
}
export interface Job {
  id: string;
  task: string;
  status: "queued" | "running" | "done" | "failed";
  phase: string;
  result: JobResult;
  created: number;
  finished?: number;
}
export interface BuildInfo {
  key: string;
  tree: string;
  targets: string[];
  root: string;
  cwd: string;
  pdf: string;
  seconds: number;
  warnings: string[];
}
export interface Position {
  page: number;
  clip: Rect;
  label: string;
}
export interface Mark {
  kind: "removed" | "added" | "moved";
  rect: Rect;
}
export interface Pair {
  old: Position | null;
  new: Position | null;
  before_marks: Mark[];
  after_marks: Mark[];
}
export type Visual = "unmapped" | "text" | "layout" | "position" | "identical";
export interface Card {
  id: string;
  file: string;
  pairs: Pair[];
  comparison: Visual;
  own?: { old: SourceBox[]; new: SourceBox[] };
  context_node?: string | null;
}
export interface TextGlyph {
  text: string;
  rect: Rect;
}
export interface TextLine {
  text: string;
  chars: TextGlyph[];
}
export interface Strip {
  src: string;
  clean: string;
  width: number;
  height: number;
  page: number;
  label: string;
  text?: TextLine[];
}
export interface ChangeBlock {
  kind: "change";
  units: string[];
  identical: boolean;
  reflow?: boolean;
  before: Strip[];
  after: Strip[];
}
export type Block =
  ChangeBlock | { kind: "context"; image: Strip } | { kind: "gap" };
export interface VisualUnit {
  visual: Visual;
  pages: string[];
  section: string | null;
}
export interface RenderedRound {
  units: Record<string, VisualUnit>;
  sections: { node: string; number: string; title: string; blocks: Block[] }[];
  loose: ChangeBlock[];
}
export interface RenderRequest {
  main: string;
  source_dir: string;
  figures: string[];
  old: BuildInfo;
  new: BuildInfo;
  units: Unit[];
}
export interface History {
  round: number;
  change: string;
  comment: string;
  new_text: string;
}
export interface RoundDetail extends Omit<RenderedRound, "units"> {
  task: string;
  round: number;
  before: string;
  after: string;
  units: (Unit & Partial<VisualUnit> & { history?: History[] })[];
  warnings: string[];
  files: string;
}
export type TaskState =
  "editing" | "building" | "build_failed" | "reviewing" | "revise" | "done";
export interface Summary {
  task: string;
  title: string;
  state: TaskState;
  round: number | null;
  counts: Record<Decision, number>;
  next: string;
}
export interface PageState {
  csrf: string;
  task: string;
  title: string;
  closed: boolean;
  state: TaskState | null;
  latest: number | null;
  round: number | null;
  revision: string | null;
  decisions: Record<string, Decision>;
  comments: Record<string, string>;
  undo: { id: string; kind: ActionKind; changes: string[] } | null;
  job:
    | (Pick<Job, "id" | "status" | "phase" | "created"> &
        JobResult & { ahead: number })
    | null;
}
export interface FeedbackItem {
  id: number;
  kind: Message["kind"];
  round: number | null;
  text?: string;
  changes?:
    | string[]
    | { id: string; file: string; lines: Span; old: string; new: string }[];
  not_reverted?: string[];
  undid?: string;
}
export interface Feedback extends Summary {
  feedback: FeedbackItem[];
  cursor: number;
  build_error?: JobResult;
  warnings?: string[];
}
export interface TaskInfo extends Summary {
  worktree: string;
  url: string;
  viewing: boolean;
  scope: { sections: string[]; files: string[] };
}
