# Reviewers and helpers

A reviewer reads a PR that someone else wrote, hunts for defects, may commit fixes, and writes a verdict file. A helper is a side agent the author starts for search, reading or a bounded fix.

## Rules for every engine

- The reviewer is a different model, or at least a fresh session, from the author. Never review in the conversation that wrote the change.
- Output: `reviews/REVIEW-PR<n>.md` on the PR branch. Line 1 `VERDICT: APPROVE` or `VERDICT: BLOCK`. Line 2 `REVIEWED-HEAD: <sha>`. Then findings, each with file and line, and what was fixed.
- Input: PR body, diff, and the callers of changed functions. Tell it to read the code, not trust the description.
- A verdict is valid for one head. Any later push needs a new one.
- Put the secrets rule in every prompt: never print or write a key, token or password; never dump environment variables.
- Engine order is `review.engines`. When one is missing, logged out or at quota, take the next. When none is available, `review.cjs` exits 3.

## Claude

- Run as `claude -p` in the worktree.
- Reviewer: Sonnet, medium effort. Raise effort for a second look at something the first pass missed.
- Helpers: Haiku for search, reading, counting and listing (closed answers you can check from outside). Sonnet for judgment: diagnosing a failing suite, writing or changing code, anything near money or production data. Opus only on the third attempt, after Sonnet failed twice; after that, stop and report what broke, what was tried and what you need.
- No quota fields: Claude Code manages its own limits, and setup never asks about them.
- A search result from a small model is a lead, not proof: open the source before acting on it.

## Codex

- Run with `codex exec` in a sandbox (read-only, unless the reviewer may commit fixes; then workspace-write).
- Model and effort come from config; medium is a good default. See the [Codex CLI page](https://developers.openai.com/codex/cli).
- Quota: respect `maxWindowPct` (short window) and `maxWeekPct`. If the account is shared (`sharedAccount: true`), keep your own share lower and run fewer reviews at once, since other users spend the same quota.
- If the quota cannot be read, allow the run but only one at a time.

## Gemini

- Run with `gemini -p` in the worktree. See the [Gemini CLI docs](https://geminicli.com/docs/).
- Same caps and shared-account behavior as Codex.
- Some account tiers have moved to another Google CLI. If `detect.cjs` reports Gemini installed but not logged in, ask the person to log in rather than guessing.

## Picking an order

Put first the engine least likely to share blind spots with your main author. Keep Claude last as the always-available fallback, unless Claude is also the author; then prefer Codex or Gemini, and use a fresh Claude session only when nothing else is reachable.

## Helper hygiene

- A helper prompt declares its job (search or judgment) so the cheapest fitting model is chosen.
- Reading a lot is not judgment. Use the small model for it.
- Cap helpers per chat (three is plenty) and keep one slot free for an urgent task.
- Repeat the rules in the prompt: no secrets, no `git add -A`, work only in the given worktree.
