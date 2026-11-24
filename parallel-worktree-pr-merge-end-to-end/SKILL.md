---
name: parallel-worktree-pr-merge-end-to-end
description: "Run many AI coding chats in parallel on the same repo without one breaking another: each gets its own worktree, then pull request, tests, cross-model review and merge, end to end."
---

# Parallel worktree to merge, end to end

Many AI coding chats work on the same repo at the same time. This skill keeps them from breaking each other, and takes each one all the way from first edit to merged and deployed.

## The idea (parallel first)

- Every chat gets **its own git worktree and branch**, outside the main checkout. Nobody edits the shared folder.
- A **machine-wide queue** limits how many full test suites run at once, so chats do not starve each other.
- **Merges go one at a time per repo**, and only when the branch contains the latest base branch.
- Changes to critical paths are **reviewed by a different model** than the one that wrote them. The reviewer also fixes what it finds; it does not only approve.
- The chat that wrote the change **finishes it itself**: pull request, merge, deploy check, cleanup. Nobody else merges for it.

## When to use

Use it when two or more chats (or a chat and a human) may touch the same repo at once, or when you want a change to go from edit to merged without hand-holding. Do not use it for a repo with a single contributor and no tests, or for a quick read-only question.

## First run: setup before any work

If `.parallel-pr.json` is missing at the repo root, set up first. Full question list, wording and config schema: `references/setup.md`.

1. Run `node scripts/detect.cjs` (read-only). It prints JSON: repo, base branch, test command, OS, whether `gh` is installed and logged in, which engines (claude, codex, gemini) are installed and logged in, and deploy hints. Show the findings and ask the person to confirm or correct.
2. **Round 1** (five or six questions): which engines review (Claude itself is one option); which engines act as helpers (suggest the same as reviewers); when review is required (always, critical paths only, never); where the change goes live; whether to protect the base branch (generate `https://github.com/<repo>/settings/branches`); how many chats at once on this machine; language and defect log.
3. **Round 2**: only what the answers need.
   - Claude: inform only. Reviewer is Sonnet with medium effort. Helpers use Sonnet for judgment, Haiku for search, Opus on the third try. Do not ask about quota.
   - Codex or Gemini: ask model and effort (mark the recommended one), quota caps, and whether the account is shared with others. If the CLI is missing, give the install link and the login command.
   - Platform deploy: ask the health URL. VPS: host, user, path, GitHub Actions or SSH, health URL, restart window; test the connection once, read-only. Command deploy: which command, and the health URL.
   - Never ask for a password, key or token in the chat.
4. Write `.parallel-pr.json` (example: `examples/parallel-pr.config.json`), show a one-screen summary, and let the person commit it.

### How to ask, per tool

- **Claude Code:** `AskUserQuestion`, at most 4 questions per call, 2 to 4 options each, recommended option first.
- **Gemini CLI:** the `ask_user` tool, 1 to 4 questions per call, choice or multi-select.
- **Codex CLI:** a numbered list in plain text (its `request_user_input` tool is off in default mode).
- **Anything else:** a numbered list. The person answers like `1 2, 2 1`.

## The loop, for every task

1. `node scripts/worktree.cjs new <task-slug>` creates the worktree on branch `pr/<slug>` from the latest base, links dependencies, prints the path. Work only there.
2. Do the work. Commit **only the files you touched, by name**.
3. Write the PR body to a file: what the person asked (their words), what is left out and why, what changed, which test proves it.
4. `node scripts/deliver.cjs --dir <worktree> --body <file> [--title "..."]`. It syncs with base, runs the quick check, pushes (tests go through the queue), opens or updates the PR, runs review when the paths are critical, takes the merge lock, gates, merges, deploys, health-checks and cleans up.
5. Read the exit code and act:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Done | Report: merged, live, checked. |
| 1 | Merged, but deploy or health check failed | Do not revert blindly. Read `references/deploy.md`, then fix forward or roll back with a new PR. |
| 3 | Review missing or blocked | Read `reviews/REVIEW-PR<n>.md`, fix, run again. |
| 4 | Gate refused | Read the printed reason; usually branch behind base, or no approval for this head. |
| 5 | Merge conflict | Resolve in the worktree, commit, run again. |
| 6 | Tests red | Find the cause. Never retry until green. |
| 7 | Merge queue busy | Run again later; start the next task meanwhile. |

6. `node scripts/cleanup.cjs` removes merged worktrees and branches (only when nothing unmerged is left on them).

Other commands: `node scripts/worktree.cjs list`, `node scripts/worktree.cjs remove <slug>`, `node scripts/test-queue.cjs -- <command...>` (run any heavy command through the slot queue), `node scripts/review.cjs --pr <n>` (exit 0 review written, 3 no engine available, 2 usage error).

## Non-negotiable rules

- Never `--no-verify`. Never merge by hand; the gate is the only way in.
- Never `git add -A` or `git add .`. Name each file you touched.
- One worktree per chat, outside the repo. Never edit the shared checkout.
- The full suite runs only through `test-queue.cjs`.
- A flaky test is a bug: find the cause, or delete the test with a written reason. No retry loops, no skips.
- The reviewer is never the author, and never the same model session.
- Never print, log or commit a secret. Never dump environment variables.
- A step that waits (queue, review, deploy window) does not stop the line: start the next task.

## Where to read more

- `references/method.md` - the full method, each rule with the reason it exists.
- `references/setup.md` - setup questions, config schema, links.
- `references/reviewers.md` - Claude, Codex and Gemini as reviewer and helper.
- `references/deploy.md` - what happens after merge.

Tools and docs: [GitHub CLI](https://cli.github.com/), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://geminicli.com/docs/), [Agent Skills format](https://agentskills.io).
