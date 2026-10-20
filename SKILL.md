---
name: latex-review-skill
description: Use when editing a LaTeX document whose edits the user should approve. You edit in an isolated Git worktree; a local page shows each change as a PDF diff in context, where the user accepts, rejects or comments on it. Accepted changes are merged into their manuscript. Not needed for discussion-only work.
---

# LaTeX review

The user reviews every edit before it reaches the manuscript. You edit in a private worktree. `publish` renders a PDF diff. The user decides per change in the browser, and `feedback` tells you what to do next.

`REVIEW` below means `python3 <this skill's folder>/scripts/review.py`. Every command prints one JSON object, and its `next` field says what to do. Failures print `error` (plus `details` and `next`) and exit with status 1.

## First use and demo

- Before the first task, run `REVIEW doctor`. If a check fails, give the user its `hint` and stop.
- If the user wants to try the skill or see a demo, run `python3 <this skill's folder>/examples/demo.py` and give them the URL it prints. It needs no document of theirs.

## The loop

1. **Start**, from the document repository:
   ```sh
   REVIEW start tighten-related-work --section 2.3 --title "Tighten the related work"
   ```
   - Scope the task to the request: `--section` takes a number, an exact title or a `\label` and can be repeated. `--file path` scopes to files or folders. Give neither only for whole-document work.
   - Edit **only** inside the returned `worktree`. Give the user the `url`.
   - `start` is idempotent. Run it again with the same arguments, or with none inside the worktree, to reattach.
2. **Edit** the LaTeX in the worktree, staying inside the scope. Do not compile or commit; publishing compiles a frozen snapshot.
3. **Publish**, from the worktree: `REVIEW publish`. It waits for the build (up to 15 minutes).
   - Success gives `round`, `changes` and `warnings`. The warnings are LaTeX warnings your edits introduced; fix them unless they are intended.
   - A compile error or an edit outside the scope returns `error` and `details`. Fix it and publish again.
4. **Wait for the review**: `REVIEW feedback --wait 300`. It returns once the user has decided every change, or after 300 s with `state: "reviewing"`. Set your command timeout above the wait. If the user is not reviewing right now, finish your turn with the URL and run `feedback` when they return.
5. **Act on `state`**:
   - `revise`: handle every `comment` item. Each has `changes[]` with `file`, `lines` and `old`/`new` text, plus the user's `text`. Edit the worktree, then publish again. Rejected changes are already reverted in your worktree, so do not re-propose them unless a comment asks. An item with `not_reverted` lists files you must revert by hand. Also follow any `note` items.
   - `reviewing`: the user is still deciding. Wait again.
   - `done`: every change is decided. Ask whether anything else is needed; otherwise run `REVIEW finish`.
   - `build_failed`: fix the reported error and publish again.
6. **Finish**: `REVIEW finish` removes the worktree. Accepted changes are already in the user's working tree, uncommitted.

## What the user's decisions mean

- **Accept** merges the change into the manuscript immediately. It is a three-way merge, so the user's own edits are kept.
- **Reject** reverts the change in your worktree.
- **Comment** asks you to revise it. The next round shows the revision next to the comment.

Undecided changes carry over to the next round. The user can undo decisions within the current round.

## Rules

- Never edit the main working tree, and never commit, push, stash, or create worktrees or branches yourself.
- One task per piece of work. Do not start another task from inside a worktree.
- Keep reports short: the URL, what changed, and concrete errors.
- For troubleshooting use `REVIEW doctor` (checks the required tools), `REVIEW status`, `REVIEW list` and `REVIEW server status`. Do not read the skill's code or state files otherwise.
- If `start` cannot find the root document, it says so. Create `.latex-review.json` in the repository with `{"main": "path/to/main.tex"}`. [docs/reference.md](docs/reference.md) lists all settings and limits; read it only when you need them.
