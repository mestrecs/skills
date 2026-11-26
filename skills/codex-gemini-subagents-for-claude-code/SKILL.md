---
name: codex-gemini-subagents-for-claude-code
description: Routes Claude Code subagent work to Codex CLI, Gemini CLI, or Antigravity CLI per chat instead of spending Claude quota, enforced by a PreToolUse guard hook that blocks unintended Claude subagents. Claude subagents run only when the active engine (and configured fallback) has a verified quota-ceiling marker or when a task requires a Claude-only tool such as an MCP server or browser. Use when the user wants to use Codex or Gemini for Claude Code helpers or subagents, switch helper engines per chat, save Claude quota, enforce subagent routing with a hook, or configure automatic fallback at quota limits.
license: MIT
compatibility: Needs Node.js 20 or newer and Claude Code (for the PreToolUse guard hook). Scripts have zero npm dependencies and run on Windows, macOS and Linux. Helper runners require at least one configured CLI (codex, gemini, or agy).
---

# Codex and Gemini Subagents for Claude Code

Run helper (subagent) tasks from Claude Code on Codex CLI, Gemini CLI, or Antigravity CLI (`agy`) instead of spending Claude quota. The choice is stored **per chat** and enforced by a `PreToolUse` guard hook so a chat configured for Codex or Gemini cannot silently spawn Claude subagents.

- The main Claude chat only **writes the request file and verifies the result**.
- The helper executes the bounded task in its own worktree and writes a short answer file.
- Claude subagents run only with a verified quota-ceiling fallback (`CLAUDE-ONLY: ceiling`) or an exclusive Claude tool (`CLAUDE-ONLY: tool <name>`), and every exception is logged for audit.

## When to use

Use this skill when:
- You want subagents in a Claude Code session to run on Codex or Gemini instead of Claude.
- You say `"use codex helpers"`, `"use gemini helpers"`, `"use claude helpers"`, or `"reconfigure"`.
- You want a hard guard hook preventing accidental Claude subagent, `fork`, named agent, or `Workflow` launches, with an audit trail for exceptions.

`scripts/` below refers to this skill's directory (for example `~/.claude/skills/codex-gemini-subagents-for-claude-code/scripts/`). Always invoke scripts with `node <skill-dir>/scripts/<name>.cjs`.

## First-run setup

If `~/.engine-switch/config.json` does not exist (or the user says `"reconfigure"`), run the setup interview before delegating work. Full questions, defaults, and config schema are in `references/setup.md`.

1. Run `node scripts/detect.cjs` (read-only). Show the detected CLIs (`claude`, `codex`, `gemini`, `agy`), versions, and login state in plain words for the user to confirm or correct. Give official install/sign-in instructions for any missing tool; never ask for keys or tokens.
2. Ask Round 1 and Round 2 questions (engines, default per role, opt-in vs all-chats default, fallback chain, quota ceilings and watchdog behavior, ceiling marker validity, models/effort, concurrency, shared-account share %, allowed pass-through agents, tool exceptions, audit log path).
3. Write `~/.engine-switch/config.json` (verified against `scripts/config.cjs`), show a one-screen summary, print the `settings.json` hook snippet (`matcher: "Agent|Task|Workflow"`), and verify `scripts/hooks/engine-guard.cjs` runs cleanly against a sample input.

## Per-chat engine switch

When the user says:
- `"use codex helpers"` -> `node scripts/engine-switch.cjs --chat <session-id> helper codex "user request"`
- `"use gemini helpers"` -> `node scripts/engine-switch.cjs --chat <session-id> helper gemini "user request"`
- `"use claude helpers"` -> `node scripts/engine-switch.cjs --chat <session-id> helper claude "user request"`

Reply in one line with what the script printed. To inspect the current chat's key without changing it:

```bash
node scripts/engine-switch.cjs --chat <session-id>
```

How to find `<session-id>`: check the `session_id` passed to hooks, the current conversation/transcript folder UUID, or `~/.engine-switch/chats/`. Without a chat file, `engine-switch.cjs` falls back to `defaults.helper` in `~/.engine-switch/config.json` (which defaults to `claude` so new chats are opt-in unless changed during setup).

## How to delegate a helper task

1. **Give the helper its own git worktree**:
   ```bash
   git worktree add -b helper/<slug> ../<repo>-wt/<slug> origin/main
   ```
2. **Write a complete request file** (e.g., `request.md` in a temp or scratch path). The helper cannot see your chat history, so include:
   - Goal and exact scope
   - Files allowed to read/modify, and what **not** to touch
   - How to prove the change (exact test file or check command)
   - Answer format: at most 10 lines
   - Hard rules: only edit inside the assigned directory, never push directly, never `--no-verify`, never run broad test suites, never print or commit secrets or environment variables (the runners also append these rules automatically)
3. **Run the helper in the background** and wait for completion:
   ```bash
   # Codex (write mode: sandboxed, no network)
   node scripts/run-codex.cjs <dir> <request.md> <answer.txt>

   # Codex (delivery mode: network + git push enabled)
   node scripts/run-codex.cjs <dir> <request.md> <answer.txt> --deliver

   # Gemini / Antigravity CLI (write mode: sandboxed)
   node scripts/run-gemini.cjs <dir> <request.md> <answer.txt>

   # Gemini / Antigravity CLI (delivery mode: no --sandbox)
   node scripts/run-gemini.cjs <dir> <request.md> <answer.txt> --deliver
   ```
   Run **at most one Gemini helper at a time per chat** (default `gemini.maxConcurrent: 1`) so shared reviewer or parallel quota is not exhausted.
4. **Verify the result yourself**: read `answer.txt`, run `git -C <dir> diff`, and run the touched test file yourself. Treat a helper's answer as a lead, not proof.

## Write mode vs delivery mode

- **Write mode (default)**: Codex runs with `-s workspace-write` and `network_access=false` (plus `writable_roots` for Windows worktree `.git` common dir); Gemini/agy runs with `--sandbox` and a per-run temporary `permissions.json` scoped to `<dir>/**`.
- **Delivery mode (`--deliver`)**: disables the network/write sandbox (`danger-full-access` for Codex, omits `--sandbox` for Gemini/agy) so a bounded delivery or PR script can push. Keep direct `git push` prohibited in the prompt; delegate delivery through a dedicated delivery script.

## Quota ceilings, fallback chain, and valid Claude exceptions

"At ceiling" means **either**:
1. `~/.engine-switch/quota-<engine>.json` (`{"windowPct", "weekPct", "at"}`, ignored if older than 15 minutes) meets or exceeds `maxWindowPct` or `maxWeekPct` (checked before start and every 60 seconds mid-run by the watchdog when `stopMidRun` is true), **or**
2. The CLI fails with a rate-limit/quota error matching `/rate.?limit|quota|429|usage limit/i`.

When that happens, the runner writes `~/.engine-switch/ceilings/<engine>.json` (valid for 30 minutes by default) and exits with **code 3**. Check quota beforehand with `--quota-only`.

**Fallback chain:**
- Chat on `codex` (default fallback `["codex", "claude"]`): Codex exit 3 -> Claude helper is allowed with `CLAUDE-ONLY: ceiling`.
- Chat on `gemini` (default fallback `["codex", "claude"]`): Gemini exit 3 -> run Codex next; only if Codex also exits 3 (so **both** recent ceiling markers exist) does the hook allow Claude with `CLAUDE-ONLY: ceiling`.

**The only two valid exceptions** when the chat key is `codex` or `gemini` (searched across the entire serialized `tool_input`):
1. `CLAUDE-ONLY: ceiling` — exact line, valid only when the required recent ceiling marker(s) exist on disk.
2. `CLAUDE-ONLY: tool <name>` — where `<name>` matches a configured exclusive Claude tool (`mcp|browser|chrome|supabase|database` by default).

Allowed exceptions are appended to `~/.engine-switch/claude-exceptions.jsonl`. Any other `Agent`, `Task`, `fork`, named agent not in `guard.allowAgents`, or `Workflow` call is denied by the hook. See `references/guard-hook.md` and `references/engines.md` for details.
