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
- `publish` snapshots the worktree and compiles the accepted text and the agent's version with `latexmk`. If the document uses `\include`, only the affected chapters are compiled. It locates each change in both PDFs with SyncTeX and renders the comparison as vector SVG. Edits that only touch comments or line breaks are shown as LaTeX diffs.
- **Accept** merges the change into the user's working tree with a three-way merge and records it as accepted. **Reject** reverts it in the worktree. **Comment** marks it for revision. The user can undo decisions within the current round.
- Edits whose typeset output overlaps, such as a table file and the line that inputs it, appear as one change marked "2 edits". The buttons act on all of them; the change's LaTeX view decides on each one.
- Each round shows what is still proposed and not accepted. Undecided changes carry over, and revised changes show the comment they answer.
- The user can keep deciding while the next round is queued or compiling. A build that a decision makes outdated starts over, so the new round includes it; builds are cached, so mostly only the accepted text compiles again.

## Commands

Each command prints one JSON object. Its `next` field says what to do. Failures exit with status 1 and include `error`, `details` and `next`.

Agents use the CLI throughout manuscript review: `publish` reports publication, `status` reports progress, `feedback` returns decisions and comments, and `list` lists tasks. Share the returned URL with the user; opening or inspecting the review UI is not a routine verification step. `--open` is an optional convenience when the user asks to open a page.

```sh
review=<skill folder>/scripts/review.py
python3 $review start NAME [--section 3.2]... [--file path]... [--title TEXT] [--open]   # in the repository
python3 $review publish [--no-wait] [--timeout S] [--open]   # in the worktree
python3 $review feedback [--wait [SECONDS]] [--all]
python3 $review status | list | finish [--force] | doctor
python3 $review server status | stop [--force]
```

`--repo PATH` runs a command for another repository or worktree. `--task NAME` names the task outside its worktree.

`feedback` reads immediately. `feedback --wait` waits without a time limit until
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

`examples/demo.py` copies `examples/paper` into a temporary repository, starts a task on its *Design* section, applies `examples/agent-edits.json` and publishes seven changes. They cover an equation rewritten with `cases`, inline and `align` math, a reflowing sentence, a figure caption, a deletion, and a re-wrapped line with no visible effect.

## Development

```sh
make check   # lint, Python tests (under uv, with PyMuPDF) and JavaScript tests
make demo
```

```
latex_review/        cli · client · server              agent CLI, server discovery, HTTP API
                     tasks · review · publish             worktrees, decisions and undo, building rounds
                     build · changes · outline · git · config · store
latex_review/render/ PDF locating, glyph diffs and SVG strips (runs under uv with PyMuPDF)
web/                 the review page: plain ES modules, no build step
examples/            the example paper and the demo script
tests/               Python and JavaScript tests
```
