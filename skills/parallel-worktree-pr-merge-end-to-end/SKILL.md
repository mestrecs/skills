---
name: parallel-worktree-pr-merge-end-to-end
description: Takes each of several AI coding chats from first edit to merged, deployed and cleaned up on one shared git repository without them overwriting each other, using a worktree per chat, a test queue, pull requests, review by a different model and a one-at-a-time merge. Use when several chats, agents or people edit the same repo at once, when changes collide or one chat overwrites another's work, when asked to open a PR and merge it safely, when a change needs cross-model review (Claude Code, Codex, Gemini CLI), or when worktrees and branches pile up after merges.
license: MIT
compatibility: Needs git, the GitHub CLI (gh) logged in, and Node.js 18 or newer. Scripts have no npm dependencies and run on Windows, macOS and Linux. Reviewers are optional CLIs (claude, codex, gemini). Network access to GitHub is required for the pull request steps.
---

# Parallel worktree to merge, end to end

Several AI coding chats work on the same repo at the same time. This skill keeps them from breaking each other and takes each one all the way from first edit to merged, deployed and cleaned up.

- Every chat gets **its own git worktree and branch**, outside the main checkout. Nobody edits the shared folder.
- A **machine-wide queue** limits how many full test suites run at once.
- **Merges go one at a time per repo**, and only when the branch already contains the latest base branch.
- Changes to critical paths are **reviewed by a different model** than the one that wrote them. The reviewer also fixes what it finds.
- The chat that wrote the change **finishes it itself**: pull request, merge, deploy check, cleanup.

## When to use

Use it when two or more chats (or a chat and a human) may touch the same repo at once, or when one change should go from edit to merged without hand-holding. Skip it for a one-person repo with no tests, a read-only question, or a throwaway script.

`scripts/` below means this skill's folder (for example `~/.claude/skills/parallel-worktree-pr-merge-end-to-end/scripts/`). Run `detect`, `worktree` and `cleanup` with the repo as the current directory. Always call scripts as `node scripts/<name>.cjs`, with the full path in front.

## Quick reference

| You want to | Run | Exit codes |
| --- | --- | --- |
| Check the environment (read-only) | `node scripts/detect.cjs` | 0 |
| Start a task in its own worktree | `node scripts/worktree.cjs new <task-slug>` | 0 path printed, 2 error |
| List or remove worktrees | `node scripts/worktree.cjs list` / `remove <slug> [--delete-branch]` | 0, 2 |
| Run any heavy command through the queue | `node scripts/test-queue.cjs [--timeout <s>] -- <command...>` | the command's own, 124 gave up waiting |
| Ask another model to review a PR | `node scripts/review.cjs --pr <n> [--dir <wt>] [--engine <name>] [--max-wait <s>] [--separated "..."]` | 0 written, 2 usage, 3 no engine or usable verdict, 6 separation required |
| Deliver the task | `node scripts/deliver.cjs --dir <wt> --body <file> [--title "..."] [--max-wait <s>] [--separated "..."]` | see the table below |
| Clear merged worktrees and branches | `node scripts/cleanup.cjs [--dry-run]` | 0 |

## First run: setup before any work

If `.parallel-pr.json` is missing at the repo root, set up first. Question wording and the config schema are in `references/setup.md`.

1. Run `node scripts/detect.cjs`. It prints JSON: repo, base branch, test command, OS, whether `gh` is installed and logged in, which engines (claude, codex, gemini) are installed and logged in, and deploy hints. Show the findings in plain words and ask the person to confirm or correct.
2. **Round 1** (five or six questions): which engines review (Claude itself is one option); which engines help (suggest the same); when review is required (always, critical paths only, never); where the change goes live; whether to protect the base branch (give `https://github.com/<repo>/settings/branches`); how many chats at once on this machine; language and defect log.
3. **Round 2**, only what the answers need.
   - Claude: inform only. Reviewer is Sonnet at medium effort. Helpers use Sonnet for judgment, Haiku for search, Opus on the third try. Do not ask about quota.
   - Codex or Gemini: model, effort, quota caps (`maxWindowPct`, `maxWeekPct`) and whether the account is shared. If the CLI is missing, give the install link. Codex has no separate login command: run `codex` and pick a sign-in method.
   - Platform deploy: the health URL. VPS: host, user, path, GitHub Actions or SSH, health URL, restart window; test the connection once, read-only. Command deploy: the command and the health URL.
   - Never ask for a password, key or token in the chat.
4. Write `.parallel-pr.json` (example: `examples/parallel-pr.config.json`), show a one-screen summary, and let the person commit it. Make sure `.gitignore` lists `node_modules` **without a trailing slash**, because inside a worktree it is a link, and `node_modules/` does not match a link.

How to ask, per tool:

- **Claude Code:** `AskUserQuestion`, at most 4 questions per call, 2 to 4 options each, recommended option first.
- **Gemini CLI:** the `ask_user` tool, 1 to 4 questions per call, choice or multi-select.
- **Codex CLI:** a numbered list in plain text (its `request_user_input` tool is off in default mode).
- **Anything else:** a numbered list. The person answers like `1 2, 2 1`.

## The loop, for every task

1. `node scripts/worktree.cjs new <task-slug>` cuts branch `pr/<slug>` from the latest remote base into `worktreeDir`, links `linkDependencies`, and prints the path. Work only there.
2. Do the work. Commit **only the files you touched, by name**.
3. Write the PR body to a file: what the person asked (their words), a `Left out:` line, what changed, which test proves it.
4. `node scripts/deliver.cjs --dir <worktree> --body <file>`. It merges the latest base into the branch, runs the quick check, runs the suite through the queue, pushes, opens or updates the PR, runs review when the changed paths are critical, then takes the merge lock. Under the lock it re-syncs, re-tests only if the base moved or code changed, checks the gate, merges with `gh pr merge --merge --match-head-commit`, removes the worktree and branch, deploys and checks health.
5. Read the exit code and act:

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Done (or merged with `DEPLOY-DEFERRED` outside the restart window) | Report merged, live, checked. If deferred, run the deploy inside the window. |
| 1 | Merged, but cleanup, deploy or health check failed | Do not revert blindly. Read `references/deploy.md`; fix forward or revert with a new PR. |
| 2 | Usage or config error, dirty worktree, nothing to deliver | Read the message; commit the files you touched, fix the flag or config. |
| 3 | Review missing or blocked | Read `reviews/REVIEW-PR<n>.md`, fix, and run again. After two BLOCKs, use the separation step below. |
| 4 | Gate refused, push refused or `gh` failed | Read the printed reason (behind base, no approval for this head, remote moved). |
| 5 | Merge conflict with base | Merge base in the worktree, resolve, commit, run again. |
| 6 | Tests red | Find the cause. Never retry until green. |
| 7 | Merge lock busy past `--max-wait` (default 900 s) | Run again later; start the next task meanwhile. |

Docs-only changes go straight to the base branch when `docsDirectToBase` is true (and skip review).

Set `testCommand` to a command string or a list of commands. The queue runs all commands in one slot even if one fails, then lists failures together and prints the path to the full redacted log. The delivery record in `~/.parallel-pr/queue.jsonl` includes stage timings, reviewer engine and fix commit time when available, and counts of BLOCKs and distinct reviewed heads.

After two BLOCKs, move the blocking part into a separate PR or put it behind a flag that defaults to off. Commit the separation and run delivery with `--separated "<what left the change>"`. The reviewer checks the separation in the follow-up diff.

Use `--body -` to read the PR description from stdin. Use `--squash` to request a squash merge and `--wait-for-checks` to wait for GitHub checks to pass before merging. Pass `--author-email` to set the merge commit author's address explicitly, such as your GitHub noreply address.

## Non-negotiable rules

- Never `--no-verify`. Never merge by hand; the gate is the only way in.
- Never `git add -A` or `git add .`. Name each file you touched.
- One worktree per chat, outside the repo. Never edit, clean or reset the shared checkout.
- The full suite runs only through `test-queue.cjs`.
- A flaky test is a bug: find the cause, or delete the test with a written reason. No retry loops, no skips.
- The reviewer is never the author, and never the same session.
- A review verdict is valid for one head. After approval, only files under `reviews/` or files that came in from the base may change; anything else needs a new review.
- Never print, log or commit a secret. Never dump environment variables. Put this rule in every helper prompt.
- A step that waits (queue, review, merge lock, deploy window) does not stop the line: start the next task.

## Common mistakes

- **Running `deliver.cjs` from the main checkout.** It refuses to run on the base branch; run it with `--dir` set to the task worktree.
- **Editing in the shared folder "just this once".** The next chat then commits your half-done files. Make the worktree first.
- **`git add -A` in a worktree.** It sweeps in linked dependencies and other chats' edits to shared files. Add by name.
- **Calling a red suite "flaky" and running it again.** The second green hides a real race. Find the cause.
- **Pushing a small fix after the review approved.** The verdict belonged to the old head and the gate refuses. Ask for a new review.
- **Treating "merged" as "done".** Exit 0 means live and health-checked; exit 1 means merged but not verified; `DEPLOY-DEFERRED` means the deploy is still yours to run.
- **Using `node_modules/` in `.gitignore`.** The link in a worktree is not a directory to git; use `node_modules`.
- **Waiting in a loop for the queue or the merge lock.** Start the next task; the scripts already poll.
- **Resolving a conflict in the host's web editor.** Nobody tested that merge. Merge base into the branch in the worktree and let `deliver.cjs` re-run the tests.

## Where to read more

- `references/method.md`: the full method, each rule with the reason it exists.
- `references/setup.md`: setup questions, config schema, links.
- `references/reviewers.md`: Claude, Codex and Gemini as reviewer and helper, quota file, environment hooks.
- `references/deploy.md`: what happens after the merge, health check, restart window.

Tools and docs: [GitHub CLI](https://cli.github.com/), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://geminicli.com/docs/), [Agent Skills format](https://agentskills.io).
