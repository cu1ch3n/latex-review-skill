# latex-review-skill

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)
![macOS | Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
[![Agent skill](https://img.shields.io/badge/agent%20skill-Claude%20Code%20%7C%20Codex-8a63d2)](SKILL.md)

Review your AI agent's LaTeX edits as typeset PDF, one change at a time.

![The review page: a changed equation shown before and after, inside its section](docs/review-page.png)

The agent edits in its own Git worktree. You see every change in place in the PDF, including text, formulas and figures, and accept, reject or comment on it. Accepted changes go into your working tree. Comments go back to the agent, which revises and sends the next round.

## Install

```sh
git clone https://github.com/cu1ch3n/latex-review-skill ~/.claude/skills/latex-review-skill   # Claude Code
git clone https://github.com/cu1ch3n/latex-review-skill ~/.codex/skills/latex-review-skill    # Codex
```

You need Python 3.10+, Git, TeX Live or MacTeX, and [uv](https://docs.astral.sh/uv/). `python3 ~/.claude/skills/latex-review-skill/scripts/review.py doctor` checks them.

## Use

In your LaTeX project (a Git repository), ask your agent:

> Use latex-review-skill to tighten Section 3, and let me review the changes.

It sends you a link. Press `A` to accept, `R` to reject, `C` to comment, `J`/`K` for the next or previous change, and `⌘Z` to undo.

To try it without an agent:

```sh
python3 ~/.claude/skills/latex-review-skill/examples/demo.py
```

The agent's instructions are in [SKILL.md](SKILL.md); configuration and internals are in [docs/reference.md](docs/reference.md).

## License

[MIT](LICENSE)
