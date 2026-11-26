# First-Run Setup

Run this interview on first use of this skill or when the user asks to reconfigure. If a shared config already exists, reuse the answers it contains and ask for the settings introduced by this skill. Never ask for a password, API key, or token in chat, and never open `.env`.

## Step 0: Detect installed tools

Run:

```bash
node scripts/detect.cjs
```

It prints JSON with `os`, `node`, `configExists`, `hookConfigured`, `engines` (`claude`, `codex`, `gemini`, `agy` — each with `installed`, `version`, `authed`), and `connectors` (`claude`, `codex`, `gemini`, `agy` — `"not checked"` when unknown — and `claudeOnly`). Show the findings and ask the user to confirm. For engine CLIs, a settings folder suggests prior setup and does not prove current authentication. Connector detection reads MCP server names only, never values, env, args, URLs, or tokens.

If a chosen CLI is missing or not signed in, show its official setup command/link:
- **Claude Code**: [Claude Code docs](https://docs.claude.com/en/docs/claude-code)
- **Codex CLI**: [Codex CLI docs](https://developers.openai.com/codex/cli) (run `codex` and pick a sign-in method)
- **Gemini CLI**: [Gemini CLI docs](https://geminicli.com/docs/), install with `npm install -g @google/gemini-cli` (API-key and enterprise accounts since 18 June 2026; consumer Google logins use the Antigravity CLI `agy`)

## How to ask

| Environment | Method |
| --- | --- |
| Claude Code | `AskUserQuestion`: max 4 questions per call, 2–4 options each, put the recommended option first with `(Recommended)`. Split Round 1 across two calls. |
| Gemini CLI | `ask_user`: 1–4 questions per call. |
| Codex CLI / other | A numbered list with lettered options and `(Recommended)` marked, e.g. user replies `1a 2b 3 other: 70`. |

Always show the default value that will be used if the user skips a question, and briefly explain why it is recommended.

## Round 1 (core routing and guard policy)

1. **Which helper engines are available and signed in?** Multi-select from `codex`, `gemini` (or `agy`), `claude`. Recommend enabling every engine you have signed in so fallback works.
2. **Default for new chats (`newChatsMode` and `defaults.helper`)?**
   - `opt-in` (`defaults.helper: "claude"`, recommended for first trial): existing and new chats keep Claude unless you say `"use codex helpers"` or `"use gemini helpers"`.
   - `all-chats`: pick `codex` or `gemini` as `defaults.helper` so every new chat uses it automatically.
   Also ask **default reviewer** (`defaults.reviewer`, default `"codex"`).
3. **Fallback order (`fallback`)**: order of engines when the primary hits its ceiling. Default `["codex", "claude"]` (recommended when primary is `gemini`, or `["codex", "claude"]` for `codex`). Must not be empty. Include Claude only if ceiling fallback to Claude is allowed.
4. **When to switch (`switchOn.mode`, `maxWindowPct`, `maxWeekPct`)**:
   - `percent-or-error` (recommended): switch when `quota-<engine>.json` hits `maxWindowPct` (default `90`) or `maxWeekPct` (default `80`), OR on a CLI rate-limit/quota error. Ask for both percentages separately (0 to 100).
   - `error-only`: ignore percentages and switch only when the CLI returns a real quota/rate-limit error.
5. **Stop mid-run & ceiling proof lifetime (`stopMidRun`, `ceilingValidMinutes`)**:
   - Watchdog stops a running helper mid-way if the quota file crosses the ceiling: `true` (recommended) or `false`.
   - Ceiling marker validity in minutes: `30` (recommended) or custom positive integer.
6. **Guard exceptions & audit log (`guard.allowAgents`, `guard.toolExceptions`, `guard.auditLog`)**:
   - Named agents eligible for a matching Claude-only tool declaration: default `[]` — ask if they want to add any named agent.
   - Claude-only connectors (`guard.toolExceptions`, default `[]` — a connector that exists only in Claude Code on this machine, found by setup):
     - On `"reconfigure"`, re-run `node scripts/detect.cjs` so `connectors.claudeOnly` is refreshed against the selected helper engines.
     - If `connectors.claudeOnly` is **not empty**: show the list (`"Claude Code here can use these connectors that your Codex/Gemini helpers cannot: X, Y"`), and ask: *"When a helper task needs one of these, may Claude do that one task (it is logged)?"*
       - **(a) Yes, for all of them (Recommended when the list is not empty)** — saves every name in `claudeOnly` to `guard.toolExceptions`.
       - **(b) Only some — pick** — lets the user pick a subset from `claudeOnly`.
       - **(c) No, never — the task waits or is done in the main chat** — keeps `[]`.
     - If `connectors.claudeOnly` **is empty**: do not ask; say `"no Claude-only connectors found; the tool exception stays off"` and keep `[]`.
   - Audit log path: default `"~/.engine-switch/claude-exceptions.jsonl"`.

## Round 2 (per-engine details, only for selected engines)

- **Codex (`codex`)**:
  - Model: `<latest>` (CLI default, recommended), or custom model string.
  - Effort: `medium` (Recommended), `low`, or `high`.
  - Max concurrent runs (`maxConcurrent`): `2` (Recommended) or `1`.
  - Shared account (`sharedAccount`): `false` (Recommended) or `true`. If `true`, ask their own `sharePct` (1–100, e.g., `50` so they stay inside their share of the account).
- **Gemini (`gemini`)**:
  - CLI binary (`cli`): `gemini` (Recommended for API-key/enterprise) or `agy` (consumer Google sign-in via Antigravity CLI).
  - Model: `<latest>` (CLI default, recommended), or a model name supported by the selected CLI.
  - Effort for `agy` only: CLI default, `low`, `medium`, or `high` if supported by the chosen model.
  - Max concurrent runs (`maxConcurrent`): `1` (Recommended — one Gemini helper per chat avoids exhausting shared quota).
  - Shared account (`sharedAccount`): `false` (Recommended) or `true` (with `sharePct` 1–100).

## Finish: write config, install hook, and verify

1. Merge these answers into `~/.engine-switch/config.json`, retaining other skills' settings. Write it (comment-free JSON; validate with `node scripts/config.cjs --validate ~/.engine-switch/config.json`). Example: `examples/engine-switch.config.json`.
2. Show a one-screen summary of engines, defaults, fallback chain, thresholds, and guard rules.
3. Ask the user to add this `PreToolUse` hook to `~/.claude/settings.json` (or `.claude/settings.json` in the repo), replacing `<skill-dir>` with the absolute path to this skill:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent|Task|Workflow|Bash|PowerShell|Monitor",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<skill-dir>/scripts/hooks/engine-guard.cjs\""
          }
        ]
      }
    ]
  }
}
```

4. Verify the hook runs cleanly on sample stdin:

```bash
echo '{"session_id":"11111111-1111-1111-1111-111111111111","tool_name":"Agent","tool_input":{"subagent_type":"general-purpose","prompt":"test"}}' | node <skill-dir>/scripts/hooks/engine-guard.cjs
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

Skill format reference: [Agent Skills](https://agentskills.io).
