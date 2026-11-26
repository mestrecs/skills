---
name: claude-code-subagent-model-routing
description: Routes Claude Code subagents to the cheapest model and effort level that fit the job, enforced by a PreToolUse hook on Agent and Task calls. Requires a JOB declaration on general subagents (Haiku for search, asked model at medium effort for judgment), rejects reading-verb excuses, defaults Explore to Haiku, gates Opus on ATTEMPT 3 and stops after 3 failed attempts, keeps named agents' models while setting default effort, and supports an optional lean helper agent. Use when Claude Code subagents run on Claude and you want hook-enforced Haiku/Sonnet/Opus cost routing, retry escalation, or lean helper swapping.
license: MIT
compatibility: Needs Node.js 20 or newer and Claude Code (for the PreToolUse hook). Scripts have zero npm dependencies and run on Windows, macOS, and Linux.
---

# Claude Code Subagent Model Routing

When Claude Code spawns Claude subagents (`Agent` or `Task`), text instructions in a prompt file are easily skipped under context pressure. This skill enforces model and effort routing with a `PreToolUse` hook (`scripts/hooks/model-router.cjs`) so every helper uses the cheapest model that fits the work.

In one real setup, moving search subagents from Sonnet to Haiku cut search cost by roughly 9x with the same answer, and swapping `general-purpose` to a lean helper agent (`agents/helper.md`) reduced startup context from ~50k tokens to ~30k tokens.

## When to use

Use this skill when:
- Your subagents run on Claude (either natively or via an allowed exception from `codex-gemini-subagents-for-claude-code`).
- You want a `PreToolUse` hook to enforce Haiku for search, Sonnet at medium effort for judgment, and Opus only on the third attempt.
- You want to prevent reading-only tasks from claiming to need Sonnet/Opus judgment, and stop retry loops after 3 failed attempts.
- You say `"configure model routing"` or `"reconfigure"`.

`scripts/` below refers to this skill's directory (for example `~/.claude/skills/claude-code-subagent-model-routing/scripts/`). Always run scripts with `node <skill-dir>/scripts/<name>.cjs`.

## First-run setup

If `~/.engine-switch/config.json` does not exist (or the user says `"reconfigure"`), run the setup interview before installing or enabling optional features. Full questions, defaults, and config keys are in `references/setup.md`.

1. Run `node scripts/detect.cjs` (read-only). Show installed CLIs (`claude`, `codex`, `gemini`, `agy`), config status, hook presence, and whether the lean agent file is installed.
2. Ask Round 1 and Round 2 questions (model-routing policy, lean helper toggle — off by default — plus shared engine-switch defaults).
3. Write `~/.engine-switch/config.json`, validate with `node scripts/config.cjs --validate ~/.engine-switch/config.json`, print the `settings.json` hook snippet (`matcher: "Agent|Task"`), and verify `scripts/hooks/model-router.cjs` runs cleanly against sample JSON stdin.

## Routing rules at a glance

| Subagent type | Without `JOB:` | `JOB: search` | `JOB: judgment - <reason>` | Reading verb in reason |
| --- | --- | --- | --- | --- |
| `Explore` | Haiku | Haiku | Asked model (`opus` -> `sonnet` unless `ATTEMPT: 3`), `medium` effort | Stays on Haiku |
| General (`general-purpose`, `claude`, empty, `helper`) | **Denied** | Haiku | Asked model (`opus` -> `sonnet` unless `ATTEMPT: 3`), `medium` effort | **Denied** |
| Named agent (e.g. `Plan`, custom reviewer) | Keeps own `model`, adds `effort` when missing (unless Haiku) | Keeps own `model` | Keeps own `model`, adds `effort` when missing | Keeps own `model` |
| `fork` | Untouched (except `ATTEMPT: 4+` denied) | — | — | — |

## Prompt declaration contract

Every `general-purpose`, `claude`, empty-type, or `helper` subagent prompt must contain one line starting at column 0 (leading spaces allowed):

- `JOB: search` — find, read, list, count, or extract; closed answer verifiable from outside. Forced to `haiku`.
- `JOB: judgment - <what it must conclude>` — diagnose, review, write or edit code, decide across sources. Runs on the asked model (Sonnet by default) at `medium` effort.

**Reading is not judgment:** If the reason after `JOB: judgment -` starts with a reading verb (`read`, `find`, `locate`, `list`, `count`, `extract`, `search`, `inventory`, including `-ing` forms or fillers like `just read`), the hook **denies** general subagents and keeps `Explore` on Haiku. Start the reason with what the helper must *conclude* (for example, `JOB: judgment - diagnose the flaky test by reading the log`).

**Search findings are leads, not proof:** Always open the cited file and line yourself before acting on a small model's search result.

## Retry escalation and stopping after 3 attempts

Add `ATTEMPT: N` on its own line when retrying a failed fix or review loop:

- `ATTEMPT: 1` (or omitted): `medium` effort; `opus` is downgraded to `sonnet` (for general/`Explore` subagents).
- `ATTEMPT: 2`: raises `effort` to `high`; `opus` is still downgraded to `sonnet`.
- `ATTEMPT: 3`: raises `effort` to `high` and **unlocks `opus`**.
- `ATTEMPT: 4` or higher: **denied** across all subagent types. Stop retrying that item, report to the user in one line what broke, what was tried, and what is needed, record the blocker, and move on to the next task.

If `effort` is already set explicitly on `tool_input`, the hook leaves it alone. Agents listed in `modelRouting.highEffortAgents` always default to `high` effort.

## Optional lean helper agent (`agents/helper.md`)

`agents/helper.md` defines a minimal `helper` subagent with `Bash, Read, Write, Edit, Grep, Glob, Skill, WebFetch, WebSearch` (`model: sonnet`, `effort: medium`) that starts with far fewer tokens than `general-purpose`.

- **Off by default:** controlled by `modelRouting.leanHelper.enabled` (`false` by default).
- **Transcript safety check:** even when enabled, the hook only swaps `general-purpose`/`claude`/empty to `helper` if the current chat's `transcript_path` lists `helper` in an `agent_listing_delta` record (chats opened before `helper.md` existed do not know the type and would fail with `Agent type not found`).
- **Escape hatches:** include `TOOLS: all` on its own line in the prompt, or reference an `mcp__...` tool, to keep `general-purpose`.

## Composing with `codex-gemini-subagents-for-claude-code`

If you also use `codex-gemini-subagents-for-claude-code`:

1. Register `engine-guard.cjs` **before** `model-router.cjs` in `PreToolUse`.
2. When a chat is set to `codex` or `gemini`, `engine-guard.cjs` checks for an authorized ceiling or tool declaration. Its denial takes precedence over the router update.
3. `model-router.cjs` only shapes the Claude subagents that `engine-guard.cjs` allows through (for example when the chat runs on `claude`, or on an allowed `CLAUDE-ONLY:` exception).

See `references/rules.md` for full edge-case rules and `references/setup.md` for configuration and `settings.json` examples.
