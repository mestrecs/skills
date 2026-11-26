---
name: cross-model-code-review-codex-gemini-claude
description: Reviews pull requests or local branch diffs using a model different from the author (Codex CLI, Gemini CLI / Antigravity CLI, or a fresh Claude session) chosen per chat, with strict quota-ceiling fallback, concurrency limits, safe fix commits, and single-commit verdicts. Use when asked to review a PR or branch with another model, switch reviewer engine per chat ("use codex reviewer", "use gemini reviewer", "use claude reviewer"), enforce cross-model code review, or configure review fallback and quota caps.
license: MIT
compatibility: Needs Node.js 20 or newer, git, and at least one review CLI (codex, gemini, agy, or claude). GitHub CLI (gh) is required only for --pr. Scripts have zero npm dependencies and run on Windows, macOS, and Linux.
---

# Cross-Model Code Review (Codex, Gemini, Claude)

Review a pull request (`--pr <n>`) or a local branch diff (`--base <ref>`) with a model different from the one that wrote the change. The reviewer reads the code and callers directly (not trusting the PR description), may fix clear defects on the branch, and writes a verdict valid for one head commit.

- **Per-chat reviewer choice:** stored in `~/.engine-switch/chats/<session-id>.json` under role `reviewer`.
- **Strict ordered fallback:** moves to the next engine **only** when the current one is missing, logged out, or proven at its quota ceiling — **never** because it is slow.
- **Concurrency cap:** limits concurrent reviews per engine (default `3`) via machine-wide slot locks so a shared account is not drained.
- **Compatible verdict format:** writes `reviews/REVIEW-PR<n>.md` with `VERDICT: APPROVE|BLOCK` on line 1 and `REVIEWED-HEAD: <sha>` on line 2, matching `parallel-worktree-pr-merge-end-to-end`.

## When to use

Use this skill when:
- You want an independent code review from Codex, Gemini / Antigravity (`agy`), or a fresh Claude session (`claude -p`).
- You say `"use codex reviewer"`, `"use gemini reviewer"`, `"use claude reviewer"`, or `"reconfigure"`.
- You want automatic fallback when an engine hits its quota ceiling, without falling back merely for slow runs.

`scripts/` below refers to this skill's directory (for example `~/.claude/skills/cross-model-code-review-codex-gemini-claude/scripts/`). Always invoke scripts as `node <skill-dir>/scripts/<name>.cjs`.

## First-run setup

If `~/.engine-switch/config.json` does not exist (or the user says `"reconfigure"`), run the setup interview before running a review. Full questions, defaults, and schema are in `references/setup.md`.

1. Run `node scripts/detect.cjs` (read-only). Show detected CLIs (`claude`, `codex`, `gemini`, `agy`, and optional `gh`), versions, and sign-in state in plain words for confirmation. Give official install/sign-in links for missing tools; never ask for keys or tokens.
2. Ask Round 1 and Round 2 questions: available engines, default reviewer (`codex` recommended) and new-chat mode, ordered chain (recommend Codex `gpt-6.2-sol` medium first, Gemini `gemini-4-hydrogen-high` second, Claude Sonnet last), ceiling thresholds and mid-run watchdog, max concurrent reviews per engine (default `3`), shared-account share %, and guard-hook settings if used.
3. Write `~/.engine-switch/config.json`, validate with `node scripts/config.cjs --validate ~/.engine-switch/config.json`, print a one-screen summary, and check the guard hook if Claude Code subagent enforcement is enabled.

## Per-chat reviewer switch

When the user says:
- `"use codex reviewer"` -> `node scripts/engine-switch.cjs --chat <session-id> reviewer codex "user request"`
- `"use gemini reviewer"` -> `node scripts/engine-switch.cjs --chat <session-id> reviewer gemini "user request"`
- `"use claude reviewer"` -> `node scripts/engine-switch.cjs --chat <session-id> reviewer claude "user request"`

Reply in one line with what the script printed. Inspect the current key with:

```bash
node scripts/engine-switch.cjs --chat <session-id>
```

Without a chat key file, `review.cjs` uses `defaults.reviewer` from `~/.engine-switch/config.json` (default `codex`).

## Running a review

```bash
# Review a GitHub PR in its worktree (reads chat key, runs fallback chain)
node scripts/review.cjs --pr 42 --dir ../my-app-wt/feat --chat <session-id>

# Review a local branch diff against origin/main
node scripts/review.cjs --base origin/main --dir ../my-app-wt/feat --chat <session-id>

# Force a single engine (skips fallback chain)
node scripts/review.cjs --pr 42 --dir ../my-app-wt/feat --engine gemini
```

Exit codes:
- `0`: Verdict file written (and fixes/verdict committed unless `--no-commit`). Read line 1 (`VERDICT: APPROVE` or `VERDICT: BLOCK`).
- `3`: No engine available — every engine in the chain is missing, logged out, or proven at its quota ceiling.
- `1`: Error — invalid arguments, git/`gh` failure, timeout, engine error unrelated to quota/auth, secret detected in diff, or malformed verdict.

## Fallback and Claude reviewer rules

- **Engine order:** Starts with the chat's `reviewer` preference (or `defaults.reviewer`), then continues through `review.order` (`["codex", "gemini", "claude"]` by default). Choosing `claude` goes straight to Claude.
- **When fallback triggers:** Only on `missing` binary, `logged-out` state, or proven `ceiling` (`quota-<engine>.json` over threshold, watchdog mid-run stop, or CLI rate-limit/quota error matching `/rate.?limit|quota|429|usage limit/i`). **Never** fall back on timeout or non-quota failure.
- **Claude reviewer:** Runs a fresh `claude -p --model sonnet --effort medium` session — never the chat that wrote the change.
- **Guard hook compatibility:** When the `engine-guard.cjs` `PreToolUse` hook from `codex-gemini-subagents-for-claude-code` is installed, `review.cjs` leaves verified ceiling markers in `~/.engine-switch/ceilings/<engine>.json` whenever an engine hits ceiling. A Claude reviewer subagent spawned via the `Agent` tool only passes with `CLAUDE-ONLY: ceiling` after the preceding engines in the chain are proven at ceiling.

## Non-negotiable rules

- Never review in the conversation that authored the code.
- Read the actual code, diff, and callers — never trust the PR description alone.
- Reviewer fixes must be committed safely (never `--no-verify`, never `git add -A`, never `git push`, never touch `.git`, `.github`, `.githooks`, `.claude`, or `.codex`).
- Never print, log, or commit secrets, tokens, passwords, or `.env` contents.
- A verdict is valid for one head commit (`REVIEWED-HEAD`). Any later code commit invalidates it.

## References

- `references/engines.md`: Engine CLI invocations, sandboxes, Windows worktrees, quota contract, and concurrency slots.
- `references/verdict.md`: Verdict file format, head-commit validity, fix commits, and secret checks.
- `references/setup.md`: First-run setup interview, detection, config schema, and hook check.
