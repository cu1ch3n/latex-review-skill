# Reference

Details for agents and contributors. Users only need the [README](../README.md); agents follow [SKILL.md](../SKILL.md) and read this page when they need more.

## How it works

```
agent:  start ─▶ edit worktree ─▶ publish ────────────▶ feedback --wait ─▶ revise ─▶ publish … ─▶ report completion
                                     │                        ▲
                                     ▼                        │
user:                       review page: Accept · Reject · Comment, per change
```

- `start` snapshots the repository and creates a worktree, outside the repository at `../<repository>-tasks/<task>`, limited to the requested sections or files.
- `publish` snapshots the worktree and compiles the accepted text and the agent's version with `latexmk`. If the document uses `\include`, only the affected chapters are compiled. It locates each change in both PDFs with SyncTeX and renders the comparison as vector SVG with an aligned HTML text layer for native selection and copy. Edits that only touch comments or line breaks are shown as LaTeX diffs.
- **Accept** merges the change into the user's working tree with a three-way merge and records it as accepted. **Reject** reverts it in the worktree. **Comment** marks it for revision. The user can undo decisions within the current round.
- Edits whose typeset output overlaps, such as a table file and the line that inputs it, appear as one change marked "2 edits". The buttons act on all of them; the change's LaTeX view decides on each one.
- Each round shows what is still proposed and not accepted. Undecided changes carry over, and revised changes show the comment they answer.
- The user can keep deciding while the next round is queued or compiling. A build that a decision makes outdated starts over, so the new round includes it; builds are cached, so mostly only the accepted text compiles again.

## Commands

Each command prints one JSON object. Its `next` field says what to do. Failures exit with status 1 and include `error`, `details` and `next`.

Agents use the CLI throughout manuscript review: `publish` reports publication, `status` reports progress, `feedback` returns decisions and comments, and `list` lists tasks. Share the returned URL with the user; opening or inspecting the review UI is not a routine verification step. `--open` is an optional convenience when the user asks to open a page.

```sh
review="/path/to/skill/scripts/review.mjs"
node "$review" start NAME [--section 3.2]... [--file path]... [--title TEXT] [--open]   # in the repository
node "$review" publish [--no-wait] [--timeout S] [--open]   # in the worktree
node "$review" feedback [--wait [SECONDS]] [--all]
node "$review" accept --all [--round NUMBER]   # when the user explicitly delegates acceptance
node "$review" accept c001 c003              # selected pending changes
node "$review" undo                         # undo one decision or the entire last batch
node "$review" status | list | finish [--force] | doctor
node "$review" server status | stop [--force]
```

`--repo PATH` runs a command for another repository or worktree. `--task NAME` names the task outside its worktree.

`feedback` reads immediately. There is no 200-message cap: every undelivered opinion is returned, including its complete comment body and source location. `feedback --all` replays all active decisions, comments and messages across rounds without advancing the delivery cursor. Undone opinions are omitted from a replay; agents that already received them get an explicit `undo` event. Build failures include `build_error` with diagnostics and a log path; the response also includes current-round compiler warnings. An agent can obtain all this through the CLI, with no browser access.

 `feedback --wait` waits without a time limit until
the round is fully decided, a message to the agent arrives, or a build fails;
`feedback --wait 60` bounds the wait to 60 seconds. A new `note` ends the wait even
in `reviewing` or `building`: the agent handles that message before following the
task state. Each response consumes the feedback it returns, so the agent keeps
any comments already received for the next revision. Ordinary partial decisions
alone do not end the wait. The agent shares the review URL and keeps its turn open
waiting on the command, then acts on the returned feedback automatically. If a
bounded wait expires, it waits again. This works while the agent session is
running; it does not wake an ended session.

`done` means every change is decided. The agent reports completion and leaves the
task open, keeping the PDF review and undo available. `finish` is a separate
cleanup command used when the user asks to close the review; it removes the
worktree, rounds and refs and ends undo.

`accept --all` accepts every pending unit of the current round with one atomic decision. Previously rejected or commented units retain their decisions. If any proposed write conflicts with a user edit, the entire batch fails without writing. `undo` reverses the whole batch. A waiting `feedback --wait` process receives the acceptance once the round completes; no browser is needed.

## Configuration

Usually none. The root document comes from `@default_files` in a `latexmkrc`, or is the only `.tex` file with `\documentclass`. The engine comes from a `% !TEX program` line, `$pdf_mode` in the latexmkrc, or the packages used (`fontspec` means XeLaTeX). To override, add `.latex-review.json` at the repository root:

| Setting | Meaning |
| --- | --- |
| `main` | Root document, e.g. `"paper/main.tex"` |
| `engine` | `"pdflatex"`, `"xelatex"` or `"lualatex"` |
| `latexmkrc` | latexmkrc to use (default: next to the root document) |
| `source_dir` | Folder copied for each build (default: the root document's folder; use `"."` if the document inputs files outside it) |
| `partial_builds` | `false` to always compile the whole document |
| `preload` | For partial builds: `\include` target → file to `\input` when that chapter is left out (e.g. macros it defines) |
| `dependencies` | For partial builds: `\include` target → targets that must be compiled with it |
| `figures` | Folders whose files are reviewed as whole figures (default: `figures/` or `figs/` beside the root document) |
| `worktrees` | Where task worktrees go (default: `../<repository>-tasks/`) |
| `build_workers` | Number of independent tasks compiled and rendered concurrently, from 1 to 8 (default: 1). Restart the review server after changing it. |

For example, add `"build_workers": 2` to let a small edit run while another task
is building or rendering. Rounds of the same task still run in order, and repeated
requests for a waiting round coalesce. Shared build snapshots retain their cache
locks. Cache cleanup runs only when all publishing workers are idle.
Stop an idle server with `REVIEW server stop`; the next command starts it with
the new setting. Let active builds finish before restarting.

## Limits and guarantees

- The in-context view needs PDF bookmarks, which `hyperref` provides. Without them, changes appear as standalone crops.
- Section scopes understand `\part` … `\subsubsection`, literal `\input`/`\include`/`\subfile`, and `\label`s.
- A task's first publish compiles the whole document once; later rounds reuse it.
- The user's branch, `HEAD` and staging area are never touched; snapshots use a private index. Writes are journaled, so an interrupted accept or undo completes when the server restarts.
- State lives in `.git/latex-review/` and `refs/latex-review/`. `finish` removes a task's worktree, rounds and refs.
- One local server per repository. It listens on 127.0.0.1 only, rejects cross-origin requests, restarts itself when the skill is updated, and exits after 12 idle hours.

## The example

`examples/demo.ts` copies `examples/paper` into a temporary repository, starts a task on its *Design* section, applies `examples/agent-edits.json` and publishes seven changes. They cover an equation rewritten with `cases`, inline and `align` math, a reflowing sentence, a figure caption, a deletion, and a re-wrapped line with no visible effect.

## Development

`npm run check` runs TypeScript checks, Vitest and the Vite production build.
`npm run test:browser` tests the rendered UI with Playwright (run `npx playwright install chromium` first).
`npm run test:corpus` compiles and reviews the pinned Raft dissertation; see [corpus.md](corpus.md).

`npm run dev` serves the React UI on localhost. Point `REVIEW_API` to a running review server, for example `REVIEW_API=http://127.0.0.1:8765 npm run dev`. Start a development API with `node scripts/review.mjs serve --root /path/to/document-repo --port 8765`.

```
src/cli.ts, client.ts       Commander CLI, discovery and feedback wait
src/server.ts              Fastify localhost API
src/core/                  Git snapshots, SQLite journal, decisions, build queue
src/render/                MuPDF WASM, SyncTeX, word diffs and SVG/text strips
src/web/                   React review page, Vite build
examples/                  demo paper and TypeScript demo runner
tests/ts/                  core, rendering and TeX integration tests
tests/browser/             native selection, clipboard and review interaction
scripts/                   CLI bootstrap and pinned corpus validation
```

The server retains the existing SQLite schema, task refs, worktrees and API routes. Updating the skill rebuilds the UI; the client waits for an idle old server before restarting it, normally on the same port. Old rendered rounds remain readable, but need rerendering to gain a selectable text layer.

The preview uses paths for exact PDF appearance and transparent positioned Unicode glyphs for selection. Copying equations follows the PDF’s text extraction order; it does not reconstruct LaTeX. Source view remains available for exact TeX.
