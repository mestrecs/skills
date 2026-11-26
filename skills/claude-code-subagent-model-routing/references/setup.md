# First-Run Setup

Run this interview on first use of this skill or when the user asks to reconfigure. If a shared config already exists, reuse the answers it contains and ask for the settings introduced by this skill. Never ask for a password, API key, or token in chat, and never open `.env`.

## Step 0: Detect installed tools

Run:

```bash
node scripts/detect.cjs
```

It prints JSON with `os`, `node`, `configExists`, `configPath`, `hookConfigured`, `engineGuardConfigured`, `leanAgentInstalled`, and `engines` (`claude`, `codex`, `gemini`, `agy` — each with `installed`, `version`, `authed`). Show the findings and ask the user to confirm. For engine CLIs, a settings folder suggests prior setup and does not prove current authentication.

If a chosen CLI is missing or not signed in, show its official setup command and link:
- **Claude Code**: [Claude Code docs](https://docs.claude.com/en/docs/claude-code)
- **Codex CLI**: [Codex CLI docs](https://developers.openai.com/codex/cli) (run `codex` and pick a sign-in method)
- **Gemini CLI**: [Gemini CLI docs](https://geminicli.com/docs/), install with `npm install -g @google/gemini-cli` (API-key and enterprise accounts since 18 June 2026; consumer Google sign-ins use the Antigravity CLI `agy`)

## How to ask

| Environment | Method |
| --- | --- |
| Claude Code | `AskUserQuestion`: max 4 questions per call, 2–4 options each, put the recommended option first with `(Recommended)`. Split Round 1 across two calls. |
| Gemini CLI | `ask_user`: 1–4 questions per call. |
| Codex CLI / other | A numbered list with lettered options and `(Recommended)` marked, e.g. user replies `1a 2b 3 other: 70`. |

Always show the default value that will be used if the user skips a question, and briefly explain why it is recommended.

## Round 1 (model routing & core engine-switch policy)

1. **Default effort & retry/Opus gating (`modelRouting.defaultEffort`, `retryEffort`, `opusMinAttempt`, `maxAttempts`)**:
   - `medium` default, `high` on `ATTEMPT: 2`, `opus` unlocked on `ATTEMPT: 3`, stop after `3` attempts (Recommended — cuts Sonnet token usage on bounded tasks and avoids infinite retry loops).
   - Ask for the search model alias (`haiku` by default), default and retry effort, minimum Opus attempt, and maximum attempts.
2. **Optional lean helper agent (`modelRouting.leanHelper.enabled`)**:
   - `false` (Recommended to start — avoids `Agent type not found` until `agents/helper.md` is installed in `~/.claude/agents/helper.md` and announced in new chats).
   - `true` — swaps `general-purpose` to `helper` whenever the chat transcript lists it and the prompt has neither `TOOLS: all` nor an external `mcp__` reference.
3. **High-effort named agents & reading-verb guard (`modelRouting.highEffortAgents`, `readingVerbs`, `capNamedAgentOpus`)**:
   - `highEffortAgents`: default `[]` (ask if any named delivery/deploy agent should always run at `high` effort).
   - `capNamedAgentOpus`: `false` (Recommended — named agents keep their own `model`; hook only sets missing `effort`).
   - `readingVerbs`: default list (`read`, `find`, `locate`, `list`, `count`, `extract`, `search`, `inventory` + `-ing` forms).
4. **Shared engine-switch routing (`engines`, `defaults.helper`, `defaults.reviewer`, `newChatsMode`, `fallback`)** (if `~/.engine-switch/config.json` is being created for the first time):
   - `engines`: multi-select from `claude`, `codex`, `gemini` (recommend all signed-in CLIs; default `["codex", "gemini", "claude"]`).
   - `newChatsMode`: `opt-in` (`defaults.helper: "claude"`, Recommended) or `all-chats` (`defaults.helper: "codex"` or `"gemini"`).
   - `defaults.reviewer`: `codex` (Recommended) or `gemini` / `claude`.
   - `fallback`: non-empty ordered list, default `["codex", "claude"]`.
5. **Quota switch thresholds & guard exceptions (`switchOn.*`, `guard.*`)**:
   - `switchOn.mode`: `percent-or-error` (Recommended — switches at `maxWindowPct: 90`, `maxWeekPct: 80`, or CLI rate-limit error) or `error-only`.
   - Ask for the short-window and weekly percentages separately, each within 0 to 100.
   - `switchOn.stopMidRun`: `true` (Recommended) or `false`.
   - `switchOn.ceilingValidMinutes`: `30` (Recommended) or positive integer.
   - `guard.allowAgents`: default `[]`.
   - `guard.toolExceptions`: default `[]` — a connector that exists only in Claude Code on this machine, found by setup (e.g., `my-db`, `browser`).
   - `guard.auditLog`: default `"~/.engine-switch/claude-exceptions.jsonl"`.

## Round 2 (per-engine details, only if `codex` or `gemini` are enabled)

- **Codex (`codex`)**:
  - Model: `<latest>` (CLI default, recommended) or custom model string.
  - Effort: `medium` (Recommended), `low`, or `high`.
  - Max concurrent runs (`maxConcurrent`): `2` (Recommended) or `1`.
  - Shared account (`sharedAccount`): `false` (Recommended) or `true` (with `sharePct` `1–100`).
- **Gemini (`gemini`)**:
  - CLI binary (`cli`): `gemini` (Recommended for API-key/enterprise) or `agy` (consumer sign-in via Antigravity CLI).
  - Model: `<latest>` (CLI default, recommended), or a model name supported by the selected CLI.
  - Effort for `agy` only: CLI default, `low`, `medium`, or `high` if supported by the chosen model.
  - Max concurrent runs (`maxConcurrent`): `1` (Recommended).
  - Shared account (`sharedAccount`): `false` (Recommended) or `true` (with `sharePct` `1–100`).

## Finish: write config, optional lean agent, install hook, and verify

1. Merge these answers into `~/.engine-switch/config.json`, retaining other skills' settings. Write it (comment-free JSON; example: `examples/engine-switch.config.json`) and validate it:
   ```bash
   node scripts/config.cjs --validate ~/.engine-switch/config.json
   ```
2. If the user opted into `leanHelper.enabled: true`, copy `agents/helper.md` to `~/.claude/agents/helper.md` (or `<repo>/.claude/agents/helper.md`) and remind them that only new chats (or after `/clear`) will see `helper`.
3. Show a one-screen summary of the model-routing rules and engine-switch defaults.
4. Ask the user to add the `PreToolUse` hook to `~/.claude/settings.json` (or `.claude/settings.json` in the repo), replacing `<skill-dir>` with the absolute path to this skill.

Standalone snippet (`matcher: "Agent|Task"`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent|Task",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<skill-dir>/scripts/hooks/model-router.cjs\""
          }
        ]
      }
    ]
  }
}
```

Composed with `codex-gemini-subagents-for-claude-code` (both hooks run independently and guard denial takes precedence. See `examples/settings.hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent|Task|Workflow|Bash|PowerShell|Monitor",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<subagents-skill-dir>/scripts/hooks/engine-guard.cjs\""
          }
        ]
      },
      {
        "matcher": "Agent|Task",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<skill-dir>/scripts/hooks/model-router.cjs\""
          }
        ]
      }
    ]
  }
}
```

5. Verify the hook runs cleanly against sample stdin (both deny and rewrite):

```bash
echo '{"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","prompt":"Find auth.ts"}}' | node <skill-dir>/scripts/hooks/model-router.cjs
echo '{"tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","model":"sonnet","prompt":"JOB: search\nFind auth.ts"}}' | node <skill-dir>/scripts/hooks/model-router.cjs
```

## Config schema (`~/.engine-switch/config.json`)

| Key | Type / Values | Default |
| --- | --- | --- |
| `version` | `1` | `1` |
| `engines` | Array of `codex`, `gemini`, `claude` | `["codex", "gemini", "claude"]` |
| `defaults.helper` | `codex`, `gemini`, or `claude` | `"claude"` |
| `defaults.reviewer` | `codex`, `gemini`, or `claude` | `"codex"` |
| `newChatsMode` | `"opt-in"` or `"all-chats"` | `"opt-in"` |
| `fallback` | Non-empty ordered list of engines | `["codex", "claude"]` |
| `switchOn.mode` | `"percent-or-error"` or `"error-only"` | `"percent-or-error"` |
| `switchOn.maxWindowPct` | Number `0..100` | `90` |
| `switchOn.maxWeekPct` | Number `0..100` | `80` |
| `switchOn.stopMidRun` | Boolean | `true` |
| `switchOn.ceilingValidMinutes` | Positive number | `30` |
| `codex.model` | Model string | `"<latest>"` |
| `codex.effort` | `"low"`, `"medium"`, or `"high"` | `"medium"` |
| `codex.maxConcurrent` | Integer `>= 1` | `2` |
| `codex.sharedAccount` | Boolean | `false` |
| `codex.sharePct` | Number `1..100` | `100` |
| `gemini.cli` | `"gemini"` or `"agy"` | `"gemini"` |
| `gemini.model` | Model string | `"<latest>"` |
| `gemini.effort` | Optional `low`, `medium` or `high`, for `agy` | CLI default |
| `gemini.maxConcurrent` | Integer `>= 1` | `1` |
| `gemini.sharedAccount` | Boolean | `false` |
| `gemini.sharePct` | Number `1..100` | `100` |
| `guard.allowAgents` | Array of lowercase agent names | `[]` |
| `guard.toolExceptions` | Array of Claude-only connector names (found by setup) | `[]` |
| `guard.auditLog` | Path to JSONL audit log | `"~/.engine-switch/claude-exceptions.jsonl"` |
| `modelRouting.searchModel` | Agent model alias | `"haiku"` |
| `modelRouting.defaultEffort` | `"low"`, `"medium"`, or `"high"` | `"medium"` |
| `modelRouting.retryEffort` | `"low"`, `"medium"`, or `"high"` | `"high"` |
| `modelRouting.opusMinAttempt` | Integer `>= 1` | `3` |
| `modelRouting.maxAttempts` | Integer `>= 1` | `3` |
| `modelRouting.capNamedAgentOpus` | Boolean | `false` |
| `modelRouting.highEffortAgents` | Array of agent names | `[]` |
| `modelRouting.readingVerbs` | Non-empty array of verbs | `["read", "reading", "find", ...]` |
| `modelRouting.leanHelper.enabled` | Boolean | `false` |
| `modelRouting.leanHelper.agentName` | Safe agent name | `"helper"` |
| `modelRouting.leanHelper.requireTranscriptListing` | Boolean | `true` |
| `modelRouting.leanHelper.includedMcps` | Array of MCP server prefixes | `[]` |

Skill format reference: [Agent Skills](https://agentskills.io).
