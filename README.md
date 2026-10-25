# LaTeX Review Skill

**English** · [简体中文](README.zh-CN.md)

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![Node.js 22.22+](https://img.shields.io/badge/Node.js-22.22%2B-339933)
![macOS and Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

Review an AI agent's LaTeX edits in the typeset document, with the corresponding source diff alongside each change.

LaTeX Review Skill connects a coding agent's editing workflow to a local PDF review page. The agent works in an isolated Git worktree; you accept, reject, or comment on proposed changes. Accepted edits are merged into your manuscript, and feedback returns to the agent through a structured CLI.

![Demo: an agent proposes LaTeX edits, and the user reviews the PDF and accepts or comments on each change](docs/demo.gif)

[Getting started](#getting-started) · [Review workflow](#review-workflow) · [Agent interface](#agent-interface) · [Development](#development)

## Features

- **Review in context.** Inspect text, equations, and figures in vector PDF previews with surrounding content, before/after views, and the associated LaTeX diff.
- **Select and copy.** Copy text directly from the preview. **Copy reference** includes the selected text, source file, line numbers, PDF page, and review round.
- **Control what reaches the manuscript.** Accept individual changes or all pending changes in one action. Undo reverses a decision or an entire batch.
- **Keep the agent informed.** Decisions, complete comments, messages, source locations, and build errors are available through the CLI. The agent does not need browser access to follow the review.
- **Preserve your Git workflow.** Accepted changes remain uncommitted in your working tree. The review workflow leaves your branch, `HEAD`, and staging area unchanged.

## Getting started

### Requirements

| Dependency       | Requirement                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Operating system | macOS or Linux                                                                                            |
| Node.js          | 22.22 or newer, with npm                                                                                  |
| Git              | Installed and available on `PATH`; the manuscript must be in a Git repository                             |
| LaTeX            | TeX Live or MacTeX, including `latexmk`, `synctex`, and the engine and packages required by your document |
| Agent            | An agent that supports skills, such as Codex or Claude Code                                               |

### Install

Install with the [skills CLI](https://skills.sh) and select your agent:

```sh
npx skills add cu1ch3n/latex-review-skill -g
```

For manual installation, clone this repository into your agent's skills directory, for example `~/.agents/skills/latex-review-skill` for Codex.

From the installed skill directory, install dependencies, build the review page, and check the environment:

```sh
npm ci
npm run build
node scripts/review.mjs doctor
```

### Start a review

Open your LaTeX repository in the agent and ask:

> Use latex-review-skill to tighten Section 3 while preserving its technical meaning. Let me review the changes before they reach the manuscript.

The agent creates a task, edits its worktree, and publishes a local review URL. Open that URL to review the changes.

To try the workflow with the bundled example paper, run this from the skill directory:

```sh
npm run demo
```

The demo uses a temporary repository. If the root `.tex` file in your own project cannot be detected, add `.latex-review.json` at the repository root:

```json
{ "main": "paper/main.tex" }
```

See the [configuration reference](docs/reference.md#configuration) for engine selection, multi-file documents, and partial builds.

## Review workflow

1. **Inspect the proposal.** Read the PDF preview and switch to the LaTeX source diff when needed. Select text to copy it, or use **Copy reference** to include its location.
2. **Make decisions.** Accept a change to merge it into your manuscript, reject it to revert it in the agent's worktree, or comment to request a revision. **Accept all** applies every pending change in the current round as one batch; existing comments and rejections are preserved. One undo reverses the batch.
3. **Continue with the agent.** While the agent is waiting with `feedback --wait`, completing the round or using **Message the agent** returns feedback automatically. Keep the agent session running: this mechanism cannot wake an ended session.
4. **Review the next round.** Revisions appear with the comments they address. Undecided changes carry forward. The review remains available after completion; ask the agent to close it when you no longer need the previews or undo.

You can also tell the agent to **“accept all”**. It uses the CLI to apply the batch directly, without opening a browser or clicking through changes.

**All reviews** opens the task overview for the current repository. Search by title or task name, filter tasks awaiting review, and see each task's latest round and decision counts.

### Keyboard shortcuts

| Action                    | Shortcut               |
| ------------------------- | ---------------------- |
| Accept / reject / comment | `A` / `R` / `C`        |
| Next / previous change    | `J` / `K` or `→` / `←` |
| Next pending change       | `N`                    |
| Toggle LaTeX source       | `S`                    |
| Message the agent         | `M`                    |
| Undo                      | `U`, `⌘Z`, or `Ctrl+Z` |
| Show shortcuts            | `?`                    |

## Agent interface

The browser is the user's review surface. The agent uses JSON responses from the CLI to publish changes, track progress, and retrieve feedback. [SKILL.md](SKILL.md) defines the full workflow.

The following commands run inside a task worktree; replace the path with the installed skill location:

```sh
review="/path/to/latex-review-skill/scripts/review.mjs"
node "$review" publish
node "$review" feedback --wait
node "$review" feedback --all
node "$review" status
node "$review" accept --all  # When the user delegates acceptance
node "$review" undo
```

`feedback --all` replays active feedback across rounds, including complete comment bodies and source locations, without advancing the delivery cursor. `feedback --wait` also returns on build failure, with diagnostics available to the agent. Batch acceptance is atomic: if a proposed write conflicts with a user edit, the entire batch fails without writing.

See the [command reference](docs/reference.md#commands) for starting tasks, scoping edits, and managing the local server.

## Development

The implementation is TypeScript, with React and Vite for the review page, Fastify for the local API, SQLite for review state, and MuPDF WebAssembly for PDF extraction and vector rendering. SyncTeX maps source changes to their PDF locations. The server listens on `127.0.0.1`.

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run test:corpus
```

| Check                  | Coverage                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`        | Type checking, unit and integration tests, and the production build                                                       |
| `npm run test:browser` | Native text selection, clipboard copying, contextual references, review decisions, and batch undo                         |
| `npm run test:corpus`  | Two review rounds of the full Raft dissertation, with checks for source/PDF consistency and manuscript state preservation |

The regression corpus uses Diego Ongaro's [_Consensus: Bridging Theory and Practice_](https://github.com/ongardie/dissertation), pinned to a fixed revision and used under CC-BY-4.0. It requires a full TeX installation and `rsvg-convert` (`librsvg` on macOS, `librsvg2-bin` on Linux).

Additional rendering tests cover two-column layouts, footnotes, ligatures, aligned equations, deletions, repeated text, floats, page relocation, captions, verbatim spacing, and multi-page tables. CLI tests exercise long comments, feedback history across rounds, undo, and build failures. See [corpus documentation](docs/corpus.md) for provenance, setup, and failure artifacts.

When contributing, include a regression case for fixes to source/PDF alignment or feedback delivery. Development server instructions and the code layout are in the [developer reference](docs/reference.md#development).

## Documentation

- [Agent instructions](SKILL.md) — task lifecycle and review protocol.
- [Technical reference](docs/reference.md) — CLI, configuration, architecture, and limitations.
- [Regression corpus](docs/corpus.md) — upstream source, test scenarios, and reproducible validation.

PDF text copying follows the document's extraction order; it does not reconstruct LaTeX equations. Use the source view when you need exact TeX. See [limits and guarantees](docs/reference.md#limits-and-guarantees) for further details.

## License

The project source is available under the [MIT License](LICENSE). The external regression corpus is covered by its [upstream license and attribution](docs/corpus.md).
