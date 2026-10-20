# Reference

Details for agents and contributors. Users only need the [README](../README.md); agents follow [SKILL.md](../SKILL.md) and read this page when they need more.

## How it works

```
agent:  start ─▶ edit worktree ─▶ publish ────────────▶ feedback --wait ─▶ revise ─▶ publish … ─▶ finish
                                     │                        ▲
                                     ▼                        │
user:                       review page: Accept · Reject · Comment, per change
```

- `start` snapshots the repository and creates a worktree, outside the repository at `../<repository>-tasks/<task>`, limited to the requested sections or files.
- `publish` snapshots the worktree and compiles the accepted text and the agent's version with `latexmk`. If the document uses `\include`, only the affected chapters are compiled. It locates each change in both PDFs with SyncTeX and renders the comparison as vector SVG. Edits that only touch comments or line breaks are shown as LaTeX diffs.
- **Accept** merges the change into the user's working tree with a three-way merge and records it as accepted. **Reject** reverts it in the worktree. **Comment** marks it for revision. The user can undo decisions within the current round.
- Each round shows what is still proposed and not accepted. Undecided changes carry over, and revised changes show the comment they answer.

## Commands

Each command prints one JSON object. Its `next` field says what to do. Failures exit with status 1 and include `error`, `details` and `next`.

```sh
review=<skill folder>/scripts/review.py
python3 $review start NAME [--section 3.2]... [--file path]... [--title TEXT] [--open]   # in the repository
python3 $review publish [--no-wait] [--timeout S] [--open]   # in the worktree
python3 $review feedback [--wait S] [--all]
python3 $review status | list | finish [--force] | doctor
python3 $review server status | stop [--force]
```

`--repo PATH` runs a command for another repository or worktree. `--task NAME` names the task outside its worktree.

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
