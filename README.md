# latex-review-skill

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
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

The skill itself needs Python 3.10+, Git, TeX Live or MacTeX, and [uv](https://docs.astral.sh/uv/). Your agent checks for them the first time it uses it.

## Use

In your LaTeX project (a Git repository), ask your agent:

> Use latex-review-skill to tighten Section 3, and let me review the changes.

It sends you a link. Press `A` to accept, `R` to reject, `C` to comment, `J`/`K` or `→`/`←` for the next or previous change, `N` for the next undecided one, and `⌘Z` to undo.

The agent stays waiting while you review. Once you decide the last change, it automatically picks up your comments and continues, or reports completion if no revisions are needed. You do not need to send an extra "I'm done" message. **Message the agent** also interrupts the wait, so you can ask it to pause or change direction before deciding every change. Keep the agent session running while you review.

After completion, the review stays open for inspection and undo. Ask the agent to close or clean up the review when you no longer need it.

Working on several tasks? Click **All reviews** at the top of any review page, or open the same server address without `?task=…`. The overview lists open tasks in that repository with their status, latest round and decision counts. Search by title or task name, or filter to tasks awaiting your review. It updates automatically as agents publish and you review changes.

To see it first, ask your agent to "run the latex-review-skill demo".

The agent's instructions are in [SKILL.md](SKILL.md); configuration and internals are in [docs/reference.md](docs/reference.md).

## License

[MIT](LICENSE)
