# Guard Hook (`scripts/hooks/engine-guard.cjs`)

`engine-guard.cjs` is a Claude Code `PreToolUse` hook with matcher `Agent|Task|Workflow`. It makes the per-chat engine choice binding so a chat set to `codex` or `gemini` cannot quietly launch Claude subagents.

## How the decision works

For every `Agent`, `Task`, or `Workflow` tool call:

1. **Allow-list check (`Agent` and `Task` only)**:
   - `subagent_type` is normalized to lowercase.
   - If `subagent_type` is in `guard.allowAgents` (default `["web-fetch", "claude-code-guide", "statusline-setup"]`, plus any reviewer agent name you add in config), the call passes immediately.
   - `Workflow` is **never** on the allow-list.
2. **Chat key lookup**:
   - Reads `~/.engine-switch/chats/<session_id>.json` (falling back to `defaults.helper` in `~/.engine-switch/config.json`, which defaults to `claude` for opt-in behavior).
   - If the helper engine is `claude`, **everything passes**.
3. **Denied by default when engine is `codex` or `gemini`**:
   - Empty `subagent_type` (which launches `general-purpose`)
   - `general-purpose`, `Explore`, `Plan`
   - `fork`
   - **Any** named agent not listed in `guard.allowAgents` (for example custom executors, deployers, or validators)
   - The `Workflow` tool
4. **Exceptions searched across serialized `tool_input`**:
   The hook walks every string field inside `tool_input` (prompt, script, nested args) looking for lines starting with `CLAUDE-ONLY:` (or `# CLAUDE-ONLY:`):
   - **Tool exception**: `CLAUDE-ONLY: tool <name>` passes only when `<name>` matches a keyword in `guard.toolExceptions` (default `mcp|browser|chrome|supabase|database`).
     - Keyword stuffing without the exact `CLAUDE-ONLY: tool <name>` prefix (e.g. `CLAUDE-ONLY: needs supabase mcp` or `CLAUDE-ONLY: open chrome`) is **denied**.
     - Unlisted tools (e.g. `CLAUDE-ONLY: tool bash`) are **denied**.
   - **Ceiling exception**: the exact line `CLAUDE-ONLY: ceiling` (no arbitrary trailing explanation on that line) passes only if valid recent ceiling marker(s) exist in `~/.engine-switch/ceilings/`:
     - When the chat engine is `codex`: requires a recent `codex` ceiling marker.
     - When the chat engine is `gemini`: requires a recent `gemini` ceiling marker **and**, whenever `fallback` includes `"codex"`, a recent `codex` ceiling marker too (proving Gemini fell back to Codex before reaching Claude).
   - **Arbitrary `CLAUDE-ONLY: ...` lines** (e.g. `CLAUDE-ONLY: Codex is at 90%`) are **denied**.

## Ceiling marker expiry

- Runners write `~/.engine-switch/ceilings/<engine>.json` containing `{ "engine": "<name>", "at": <ms>, "reason": "..." }` whenever they exit with code `3`.
- A marker is valid for `switchOn.ceilingValidMinutes` (default **30 minutes**). Once expired, Claude subagents are blocked again until a fresh `--quota-only` or runner exit `3` refreshes the marker.

## Audit log

Every allowed `CLAUDE-ONLY: ceiling` or `CLAUDE-ONLY: tool <name>` invocation appends one JSON line to `guard.auditLog` (default `~/.engine-switch/claude-exceptions.jsonl`):

```json
{"at":1795651200000,"sessionId":"...","engine":"codex","tool":"Agent","subagentType":"general-purpose","exception":"ceiling","detail":"ceiling"}
```

## Fail-safe behavior

- Denial responses print Claude Code's standard `PreToolUse` JSON with `permissionDecision: "deny"`, stating the chat's active engine, why the call was blocked, and the two valid exception lines.
- Any internal exception (malformed stdin JSON, unreadable disk, audit log write failure) prints nothing and exits `0` so the chat is never deadlocked.
