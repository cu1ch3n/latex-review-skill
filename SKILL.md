---
name: latex-review-skill
description: Use when editing a LaTeX document whose edits the user should approve. You edit in an isolated Git worktree and use the CLI to publish changes and receive feedback; the user reviews PDF diffs in a local page. Accepted changes are merged into their manuscript. Not needed for discussion-only work.
---

# LaTeX review

The user reviews every edit before it reaches the manuscript. You edit in a private worktree. `publish` renders a PDF diff. The user decides per change in the browser, and `feedback` tells you what to do next.

`REVIEW` below means `node <this skill's folder>/scripts/review.mjs`. Every command prints one JSON object, and its `next` field says what to do. Failures print `error` (plus `details` and `next`) and exit with status 1.

## Agent interface

Use the CLI for the manuscript review workflow. The returned `url`, review page and task overview are for the user. Do not use computer use or browser automation (including Playwright, screenshots or DOM inspection) to verify publication, monitor progress or read feedback. A successful `publish` response confirms publication; use `status` for task state, `feedback` for decisions and comments, and `list` for the task overview. Share the URL and continue through the CLI.

Browser interaction is appropriate when the user explicitly requests it or the task is to develop or debug the review web interface itself. If the user only asks to open a review page, use `start --open` or `publish --open`; no UI automation is needed. Leave review decisions to the user unless they explicitly delegate them. When the user says “accept all” / “全部接受”, run `REVIEW accept --all` directly; do not open the browser or click through changes. This accepts the current round’s pending changes as one batch. Use `REVIEW undo` if the user asks to undo that batch.

## First use and demo

- Setup requires Node.js 22.22 or newer. In the skill folder, run `npm ci` and `npm run build` once after installation or an update.
- Before the first task, run `REVIEW doctor`. If a check fails, give the user its `hint` and stop.
- If the user wants to try the skill or see a demo, run `npm --prefix <this skill's folder> run demo -- --no-open` and give them the URL it prints. Omit `--no-open` if they ask to open it. It needs no document of theirs.

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
4. **Wait for the review**: share the URL in a progress message, then run `REVIEW feedback --wait`. It waits without a time limit and returns once the user has decided every change or a build fails. Notes delivered through the API also interrupt the wait. Keep the agent turn open so you can act on the result automatically; the user does not need to send a separate "I'm done" message.
   - If the command tool returns a running session, wait on that session. Use a long-lived command session when available. If the tool requires a bounded command, use `REVIEW feedback --wait 60` and handle each response as below before waiting again.
   - A timeout or `viewing: false` does not mean the user is done or wants to pause. Stop waiting if the user asks to pause, or report an actual tool/session limit if it prevents waiting. This workflow relies on the active agent turn; a detached command cannot wake an ended conversation.
5. **Read any `note` items first**, regardless of `state`: they are direct messages from the user and may ask you to pause or change direction. Then act on `state`:
   - `revise`: handle every `comment` item, including comments received in earlier feedback responses for this round. Each has `changes[]` with `file`, `lines` and `old`/`new` text, plus the user's full `text`. If context or earlier responses are missing, run `REVIEW feedback --all` to replay all feedback without advancing the cursor. This includes previous rounds; ignore opinions explicitly undone by the user. Edit the worktree, then publish again. Rejected changes are already reverted in your worktree, so do not re-propose them unless a comment asks. An item with `not_reverted` lists files you must revert by hand.
   - `reviewing` or `building`: keep waiting with `REVIEW feedback --wait`.
   - `done`: report completion with the review URL. Leave the task open so the user can inspect the result and undo decisions.
   - `build_failed`: read `build_error.error`, `build_error.details` and `build_error.log` in the feedback response, fix the error, and publish again.
6. **Clean up when requested**: run `REVIEW finish` when the user asks to close or clean up the review. It removes the worktree and PDF review artifacts and ends undo. Accepted changes remain in the user's working tree, uncommitted.

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
