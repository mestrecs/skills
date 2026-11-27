# Reviewers and helpers

A reviewer reads a PR that someone else wrote, hunts for defects, may commit fixes, and writes a verdict file. A helper is a side agent the author starts for search, reading or a bounded fix.

## Rules for every engine

- The reviewer is a different model, or at least a fresh session, from the author. Never review in the conversation that wrote the change.
- Output: `reviews/REVIEW-PR<n>.md` on the PR branch. Line 1 `VERDICT: APPROVE` or `VERDICT: BLOCK`. Line 2 `REVIEWED-HEAD: <sha>`. Then findings, each with file and line, and what was fixed.
- Input: PR body, diff, and the callers of changed functions. Tell it to read the code, not trust the description.
- A verdict is valid for one head. Any later push needs a new one.
- In the first round, check for duplicate effects, interrupted writes or sends, concurrent runs, cross-tenant data access, and optional or scheduled features that should default to off. Report all findings with stable IDs, severity and evidence.
- In follow-ups, reconcile every prior finding as `RESOLVED`, `PARTIAL`, or `OPEN` and review the diff from the last reviewed head. New issues outside that diff need reproduced P0/P1 evidence to block. Mark the others `P2-NEW`.
- After two distinct BLOCK verdicts, remove the blocking part into another PR or isolate it behind a flag that defaults to off. Pass `--separated "<what left the change>"` to delivery or review, and verify the separation in the follow-up diff.
- Put the secrets rule in every prompt: never print or write a key, token or password; never dump environment variables.
- Engine order is `review.engines`. When one is missing, logged out or at quota, take the next. When none is available, `review.cjs` exits 3.

## Claude

- `review.cjs` runs `claude -p [--model <model>]` in the worktree, with the prompt on stdin.
- Reviewer: Sonnet, medium effort. Raise effort for a second look at something the first pass missed.
- Helpers: Haiku for search, reading, counting and listing (closed answers you can check from outside). Sonnet for judgment: diagnosing a failing suite, writing or changing code, anything near money or production data. Opus only on the third attempt, after Sonnet failed twice; after that, stop and report what broke, what was tried and what you need.
- No quota fields: Claude Code manages its own limits, and setup never asks about them.
- A search result from a small model is a lead, not proof: open the source before acting on it.

## Codex

- `review.cjs` runs `codex exec --sandbox workspace-write -m <model> -c model_reasoning_effort=<effort> -`, with the prompt on stdin, inside the PR worktree. The sandbox is writable because the reviewer may commit fixes.
- Model and effort come from config; medium is a good default. See the [Codex CLI page](https://developers.openai.com/codex/cli).
- Quota: respect `maxWindowPct` (short window) and `maxWeekPct`. If the account is shared (`sharedAccount: true`), keep your own share lower and run fewer reviews at once, since other users spend the same quota.
- Quota is read from an optional file `~/.parallel-pr/quota-<engine>.json` holding `{"windowPct": 40, "weekPct": 25}` (percent used; write it from whatever tool you trust to measure usage). If the file is missing or unreadable, the engine is allowed but only one review at a time runs on it. Claude has no quota file.

## Gemini

- `review.cjs` runs `gemini [-m <model>] -p ...` in the worktree, with the prompt on stdin. See the [Gemini CLI docs](https://geminicli.com/docs/).
- Same caps and shared-account behavior as Codex.
- Since 18 June 2026 Google serves Gemini CLI to API-key and enterprise users; accounts that signed in with a consumer Google login moved to the Antigravity CLI. If `detect.cjs` reports Gemini installed but not logged in, ask the person how they authenticate rather than guessing, and drop `gemini` from `review.engines` if they cannot use it.

## Picking an order

Put first the engine least likely to share blind spots with your main author. Keep Claude last as the always-available fallback, unless Claude is also the author; then prefer Codex or Gemini, and use a fresh Claude session only when nothing else is reachable.

## Helper hygiene

- A helper prompt declares its job (search or judgment) so the cheapest fitting model is chosen.
- Reading a lot is not judgment. Use the small model for it.
- Cap helpers per chat (three is plenty) and keep one slot free for an urgent task.
- Environment hooks for tests and wrappers: `PARALLEL_PR_BIN_CLAUDE`, `PARALLEL_PR_BIN_CODEX` and `PARALLEL_PR_BIN_GEMINI` replace the engine binary; `PARALLEL_PR_GH` replaces `gh`; `PARALLEL_PR_HOME` moves `~/.parallel-pr`.
- Repeat the rules in the prompt: no secrets, no `git add -A`, work only in the given worktree.
