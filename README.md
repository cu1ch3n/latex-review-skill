# latex-review-skill

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
![macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
[![Agent skill](https://img.shields.io/badge/agent%20skill-Claude%20Code%20%7C%20Codex-8a63d2)](SKILL.md)

Review your AI agent's LaTeX edits as typeset PDF, one change at a time.

The agent edits in its own Git worktree. You see each change in place in the PDF and accept, reject or comment on it. Accepted changes go straight into your working tree; comments go back to the agent for the next round.

![The review page: a changed equation shown before and after, inside its section](docs/review-page.png)

## Features

- Changes shown inside their section of the real PDF, with text, formulas and figures marked word by word
- Accept, reject or comment per change, with undo
- Accepting is a three-way merge into your working tree; nothing is committed for you
- The agent works in an isolated worktree, limited to the sections you name
- Quick rounds: only the affected `\include` chapters are recompiled
- Works with [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex), or any agent that can run shell commands and read a `SKILL.md`

## Quick start

```sh
# Install (pick your agent)
git clone https://github.com/cu1ch3n/latex-review-skill ~/.claude/skills/latex-review-skill   # Claude Code
git clone https://github.com/cu1ch3n/latex-review-skill ~/.codex/skills/latex-review-skill    # Codex

# Check your setup; downloads the PDF renderer once
python3 ~/.claude/skills/latex-review-skill/scripts/review.py doctor

# Try it on the example paper, no agent needed
python3 ~/.claude/skills/latex-review-skill/examples/demo.py
```

Then, in your own LaTeX project (a Git repository), ask your agent:

> Use latex-review-skill to tighten Section 3, and let me review the changes.

It starts a task, edits, publishes, and sends you the review link.

### Requirements

| | macOS | Linux |
| --- | --- | --- |
| Python 3.10+, Git | preinstalled, or `brew install python git` | your package manager |
| TeX with `latexmk` and `synctex` | `brew install --cask mactex-no-gui`, or BasicTeX and `sudo tlmgr install latexmk` | `sudo apt install latexmk texlive-latex-recommended` |
| [uv](https://docs.astral.sh/uv/), which installs the renderer (PyMuPDF) | `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

No Node.js needed. On Windows, use WSL.

## The example

`examples/demo.py` plays the agent. It copies `examples/paper`, a four-page note on ropes (a string data structure), into a temporary Git repository. It then starts a task on the *Design* section, applies `examples/agent-edits.json` and publishes seven changes:

- a definition rewritten as a `cases` equation
- edits inside inline math and in one line of an `align` block
- a shorter sentence that reflows its paragraph
- a longer figure caption
- a deleted sentence
- a re-wrapped source line, with no visible effect, shown as a LaTeX diff

It also prints the `feedback` command, which shows what an agent receives once you have reviewed, and the commands to clean up.

## Reviewing

| Key | Action |
| --- | --- |
| `A` / `R` / `C` | Accept, reject, or comment on the current change |
| `J` / `K` | Next / previous change |
| `S` | Show the LaTeX source diff |
| `⌘Z` or `U` | Undo the last decision (within the current round) |
| `M` | Send the agent a message |
| `?` | All shortcuts |

- **Accept** merges the change into your working tree and keeps your own edits.
- **Reject** reverts the change in the agent's worktree.
- **Comment** asks the agent to revise the change in the next round.

After each decision the page jumps to the next undecided change. Undecided changes carry over to the next round, and a revised change shows the comment it answers.

## How it works

```
agent:  start ─▶ edit worktree ─▶ publish ────────────▶ feedback --wait ─▶ revise ─▶ publish … ─▶ finish
                                     │                        ▲
                                     ▼                        │
you:                        review page: Accept · Reject · Comment, per change
```

`publish` snapshots the worktree and compiles both versions with `latexmk`. It locates each change in both PDFs with SyncTeX and renders the comparison as vector SVG. Each command prints one JSON object whose `next` field tells the agent what to do. [SKILL.md](SKILL.md) is the agent's manual.

```sh
review=~/.claude/skills/latex-review-skill/scripts/review.py
python3 $review start NAME [--section 3.2]... [--file path]... [--title TEXT]   # in the repository
python3 $review publish            # in the worktree: compile, render, wait for the build
python3 $review feedback [--wait SECONDS] [--all]
python3 $review status | list | finish [--force] | doctor
python3 $review server status | stop
```

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

## Good to know

- The in-context view needs PDF bookmarks, which `hyperref` provides. Without them, changes appear as standalone crops.
- Section scopes understand `\part` … `\subsubsection`, literal `\input`/`\include`/`\subfile`, and `\label`s.
- A task's first publish compiles the whole document once; later rounds reuse it.
- Your branch, `HEAD` and staging area are never touched. Writes are journaled, so an interrupted accept or undo completes when the server restarts.
- State lives in `.git/latex-review/` and `refs/latex-review/`; `finish` removes a task's files and refs.
- The server listens on 127.0.0.1 only, rejects cross-origin requests and exits after 12 idle hours.

## Contributing

Issues and pull requests are welcome. Run `make check` before sending a change; `make demo` runs the example.

```
latex_review/        cli · client · server              agent CLI, server discovery, HTTP API
                     tasks · review · publish             worktrees, decisions and undo, building rounds
                     build · changes · outline · git · config · store
latex_review/render/ PDF locating, glyph diffs and SVG strips (runs under uv with PyMuPDF)
web/                 the review page: plain ES modules, no build step
examples/            the example paper and the demo script
tests/               Python and JavaScript tests (make check)
```

## License

[MIT](LICENSE)
