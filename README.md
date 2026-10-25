# latex-review-skill

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![TypeScript / Node 22.22+](https://img.shields.io/badge/TypeScript-Node%2022.22%2B-blue)
![macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
[![Agent skill](https://img.shields.io/badge/agent%20skill-Claude%20Code%20%7C%20Codex-8a63d2)](SKILL.md)

Review your AI agent's LaTeX edits as typeset PDF, one change at a time.

![Ask your agent, review LaTeX edits in the PDF, then accept or leave a comment](docs/demo.gif)

The agent edits in its own Git worktree. You see every change in place in the PDF, including text, formulas and figures, and accept, reject or comment on it. Accepted changes go into your working tree. Comments go back to the agent, which revises and sends the next round.

## Install

```sh
npx skills add cu1ch3n/latex-review-skill -g
```

The [skills](https://skills.sh) installer asks which agents to set it up for (Claude Code, Codex, Cursor and others) and needs Node.js 22 or later. You can also clone the repository into your agent's skills folder, e.g. `git clone https://github.com/cu1ch3n/latex-review-skill ~/.claude/skills/latex-review-skill`.

The skill runs on Node.js 22.22+ and needs Git, TeX Live or MacTeX (with `latexmk` and `synctex`). In the installed skill folder, run `npm ci && npm run build`; your agent checks the tools with `node scripts/review.mjs doctor`.

The implementation is TypeScript: React + Vite for the review page, Fastify for the local API, and MuPDF WebAssembly for PDF extraction and vector rendering.

## Use

In your LaTeX project (a Git repository), ask your agent:

> Use latex-review-skill to tighten Section 3, and let me review the changes.

It sends you a link. Press `A` to accept, `R` to reject, `C` to comment, `J`/`K` or `→`/`←` for the next or previous change, `N` for the next undecided one, and `⌘Z` to undo.

PDF text is selectable: drag across the preview and use your normal copy shortcut. **Copy reference** copies the selection together with the source file, line numbers, PDF page and review round. This also works for the before/after previews.

Use **Accept all** to accept the current round’s pending changes together. You can also tell your agent “accept all”: it calls `accept --all` through the CLI, without opening a browser. One undo reverses the batch. The PDF view keeps more surrounding context visible around changes.

The agent stays waiting while you review. Once you decide the last change, it automatically picks up your comments and continues, or reports completion if no revisions are needed. You do not need to send an extra "I'm done" message. **Message the agent** also interrupts the wait, so you can ask it to pause or change direction before deciding every change. Keep the agent session running while you review.

After completion, the review stays open for inspection and undo. Ask the agent to close or clean up the review when you no longer need it.

Working on several tasks? Click **All reviews** at the top of any review page, or open the same server address without `?task=…`. The overview lists open tasks in that repository with their status, latest round and decision counts. Search by title or task name, or filter to tasks awaiting your review. It updates automatically as agents publish and you review changes.

To see it first, ask your agent to "run the latex-review-skill demo".

The agent's instructions are in [SKILL.md](SKILL.md); configuration and internals are in [docs/reference.md](docs/reference.md).

## Development and regression corpus

```sh
npm ci
npm run check         # TypeScript, Vitest, production build
npx playwright install chromium
npm run test:browser  # real browser selection, clipboard and decisions
npm run test:corpus   # full Raft dissertation, two review rounds
```

The corpus is Diego Ongaro’s [Raft dissertation](https://github.com/ongardie/dissertation), pinned to a fixed revision under CC-BY-4.0. It exercises long documents, equations, citations, floats, deletions and reflow. Preparation uses `rsvg-convert` for the original SVG figures; install `librsvg` on macOS or `librsvg2-bin` on Linux. Details and provenance are in [docs/corpus.md](docs/corpus.md).

## License

[MIT](LICENSE)
