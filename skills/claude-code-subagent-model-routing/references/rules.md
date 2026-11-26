# Routing Rules and Edge Cases

This document details every decision made by `scripts/hooks/model-router.cjs`.

## 1. Handled tools and fail-safe behavior

- Matches `tool_name === "Agent"` and `tool_name === "Task"` (older Claude Code alias).
- Any other tool name, missing `tool_input`, malformed JSON on stdin, or internal read error prints nothing and exits `0` so the chat is never deadlocked.
- When modifying inputs, the hook returns Claude Code's `PreToolUse` JSON with `"permissionDecision": "allow"` and `"updatedInput"` merging all original `tool_input` fields with the updated fields.
- When blocking a call, the hook returns `"permissionDecision": "deny"` with a clear explanation so the chat can retry immediately with the right `JOB:` line or stop at attempt 4.

## 2. Subagent classification

| Category | Matched `subagent_type` values | Behavior |
| --- | --- | --- |
| `Explore` | Exact string `"Explore"` | Defaults to `modelRouting.searchModel` (`"haiku"`) without needing `JOB:`. Switches to judgment mode only with a valid `JOB: judgment - <reason>` that does not start with a reading verb. |
| General | `undefined`, `""`, `"general-purpose"`, `"claude"`, or `modelRouting.leanHelper.agentName` (`"helper"`) | Requires `JOB: search` or valid `JOB: judgment - <reason>`. Denies missing `JOB:` or reading-verb judgment reasons. Eligible for optional lean helper swap. |
| Named agent | Any other non-empty string (`"Plan"`, `"claude-code-guide"`, custom `.claude/agents/*.md` agents, case-variant `"explore"`, etc.) | Keeps its own `model` (defined in its agent file or `tool_input.model`). Hook only sets `effort` when missing and final model is not Haiku (unless `capNamedAgentOpus: true` is configured). |
| `fork` | Exact string `"fork"` | Untouched unless `ATTEMPT: 4+` is present (which denies it). `fork` inherits parent conversation and ignores model/effort overrides. |

## 3. `JOB:` line rules

Both directives must start at the beginning of a line (optional leading spaces or tabs). Mentioning `JOB: search` or `JOB: judgment` in the middle of a sentence does not count.

- `JOB: search` — forces `model: "haiku"` (or configured `searchModel`). Effort is left untouched when running on Haiku.
- `JOB: judgment - <what it must conclude>` (colon `:` or parentheses `(...)` after `judgment` are also accepted, as long as alphanumeric text follows on the same line):
  - Rejects empty reasons (`JOB: judgment` or `JOB: judgment -   `).
  - Rejects reasons starting with any configured reading verb (default: `read`, `reading`, `find`, `finding`, `locate`, `locating`, `list`, `listing`, `count`, `counting`, `extract`, `extracting`, `search`, `searching`, `inventory`, `inventorying`, optionally preceded by `just`, `only`, `simply`, `need to`, or `to`).
  - If both `JOB: search` and a valid `JOB: judgment - <reason>` appear on separate lines, `JOB: judgment` wins ("when in doubt, judgment").

Good vs. rejected judgment lines:

- Rejected: `JOB: judgment - read 14 log files and list errors` (starts with `read`)
- Rejected: `JOB: judgment - locate where invoices are rounded` (starts with `locate`)
- Accepted: `JOB: judgment - diagnose why invoice rounding fails by reading the log` (starts with `diagnose`)
- Accepted: `JOB: judgment - compare the two migration files for schema drift` (starts with `compare`)

## 4. `ATTEMPT:` escalation and 3-round stop rule

The hook scans all lines matching `^[ \t]*ATTEMPT:[ \t]*(\d+)\b` and uses the highest number (`1` when absent):

| Attempt | Effort (when `tool_input.effort` is omitted and model != Haiku) | Opus (`general-purpose` / `Explore`) |
| --- | --- | --- |
| `1` (default) | `medium` (`high` for agents in `modelRouting.highEffortAgents`) | Downgraded to `sonnet` |
| `2` | `high` | Downgraded to `sonnet` |
| `3` | `high` | Allowed (`opus` stays `opus`) |
| `4+` | **Denied** (all subagent types) | **Denied** — stop and tell the user in one line what broke, what was tried, and what is needed, then move on |

## 5. Optional lean helper (`agents/helper.md`)

`general-purpose` loads every built-in and MCP tool schema, costing ~50k tokens at startup in real sessions, whereas `agents/helper.md` (`Bash, Read, Write, Edit, Grep, Glob, Skill, WebFetch, WebSearch`) started with ~30k tokens in the same environment.

Because `helper` is a custom agent file:
1. Copy `agents/helper.md` into `~/.claude/agents/helper.md` (or `<repo>/.claude/agents/helper.md`) **before** starting the chat.
2. Enable it in `~/.engine-switch/config.json` (`modelRouting.leanHelper.enabled: true`).
3. Leave `requireTranscriptListing: true` (default). The hook reads `transcript_path` and checks `agent_listing_delta` attachments (`isInitial`, `addedTypes`, `removedTypes`) to confirm Claude Code announced `helper` in that session; otherwise swapping would trigger `Agent type not found`.
4. Add `TOOLS: all` on its own line in the prompt whenever a helper needs nested `Agent` calls or extra integrations, or reference `mcp__<server>__<tool>` directly — either keeps `general-purpose`.

## 6. Treating search results as leads

Smaller models occasionally miss secondary callers or stop after the first match. Treat any finding from a `JOB: search` / `Explore` / Haiku subagent as a lead: open the cited file and line range yourself before making edits or drawing conclusions.

## 7. Composing with `codex-gemini-subagents-for-claude-code`

When both hooks are installed in `PreToolUse`:
1. `engine-guard.cjs` runs **first** (`matcher: "Agent|Task|Workflow"`). If the chat key is `codex` or `gemini`, it blocks Claude subagents unless `CLAUDE-ONLY: ceiling` or `CLAUDE-ONLY: tool <name>` is in the prompt (or `subagent_type` is allow-listed).
2. `model-router.cjs` runs **second** (`matcher: "Agent|Task"`). It never sees blocked calls and only shapes the Claude helpers that are allowed through.
3. Combine directives freely in one prompt, for example:
   ```text
   JOB: judgment - inspect Stripe webhook signature failure via MCP logs
   CLAUDE-ONLY: tool mcp
   TOOLS: all
   ```
