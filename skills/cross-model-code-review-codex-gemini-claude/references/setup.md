# First-Run Setup

Run this interview on first use of this skill or when the user asks to reconfigure. If a shared config already exists, reuse the answers it contains and ask for the settings introduced by this skill. Never ask for a password, API key, or token in chat, and never open `.env`.

## Step 0: Detect installed tools

Run:

```bash
node scripts/detect.cjs
```

It prints JSON with `os`, `node`, `configExists`, `hookConfigured`, `gh` (`installed`, `authed`), and `engines` (`claude`, `codex`, `gemini`, `agy` — each with `installed`, `version`, `authed`). Show the findings and ask the user to confirm. For engine CLIs, a settings folder suggests prior setup and does not prove current authentication.

If a selected CLI is missing or not signed in, show its official link and command:
- **Codex CLI**: [Codex CLI docs](https://developers.openai.com/codex/cli) (run `codex` and pick a sign-in method)
- **Gemini CLI**: [Gemini CLI docs](https://geminicli.com/docs/), install with `npm install -g @google/gemini-cli` (API-key and enterprise accounts since 18 June 2026; consumer Google sign-ins use the Antigravity CLI `agy`)
- **Claude Code**: [Claude Code docs](https://docs.claude.com/en/docs/claude-code)
- **GitHub CLI (`gh`)**: [GitHub CLI](https://cli.github.com/), sign in with `gh auth login` (only needed for `--pr <n>`)

## How to ask

| Environment | Method |
| --- | --- |
| Claude Code | `AskUserQuestion`: max 4 questions per call, 2–4 options each, recommended option first with `(Recommended)`. Split Round 1 across two calls. |
| Gemini CLI | `ask_user`: 1–4 questions per call. |
| Codex CLI / other | A numbered list with lettered options and `(Recommended)` marked, e.g. user replies `1a 2b 3 other: 70`. |

Always show the default value that will be used if the user skips a question, and explain briefly why it is recommended.

## Round 1 (engines, order, thresholds, concurrency)

1. **Which engines are available and signed in (`engines`)?** Multi-select from `codex`, `gemini` (or `agy`), `claude`. Recommend enabling every engine you have signed in so cross-model review and fallback work. Default: `["codex", "gemini", "claude"]`.
2. **Default reviewer and new-chat mode (`defaults.reviewer`, `defaults.helper`, `newChatsMode`)?**
   - Default reviewer: `codex` (Recommended when you author in Claude so reviews use a different vendor), `gemini`, or `claude`.
   - New chats mode: `opt-in` (Recommended — keeps existing/new chats on Claude helpers unless switched per chat; `defaults.helper: "claude"`) or `all-chats` (sets `defaults.helper` to `codex` or `gemini`).
3. **Ordered fallback chain (`review.order` and `fallback`)?**
   - Default: `["codex", "gemini", "claude"]` (Recommended: Codex first, Gemini second, Claude Sonnet last). Must not be empty.
   - `fallback` (helper fallback chain): default `["codex", "claude"]`.
4. **When to switch (`switchOn.mode`, `maxWindowPct`, `maxWeekPct`)?**
   - `percent-or-error` (Recommended): switch when `quota-<engine>.json` meets or exceeds `maxWindowPct` (default `90`) or `maxWeekPct` (default `80`), OR on a CLI quota/rate-limit error. Ask for both percentages separately (0 to 100).
   - `error-only`: switch only when the CLI returns a real quota/rate-limit error.
5. **Watchdog & ceiling proof lifetime (`stopMidRun`, `ceilingValidMinutes`)?**
   - `stopMidRun`: `true` (Recommended — stops a running review mid-way if the quota file crosses the ceiling so it can fall back) or `false`.
   - `ceilingValidMinutes`: `30` (Recommended) or custom positive number.
6. **Max concurrent reviews per engine (`review.maxConcurrent`)?**
   - `3` (Recommended — caps simultaneous reviews per engine so a shared account is not drained), `2`, or `1`.
7. **Review timeout and audit location (`review.timeoutMinutes` and `review.auditLog`)?**
   - Timeout: `60` minutes by default, or choose a positive duration up to 35,791 minutes.
   - Audit log: `~/.engine-switch/review-history.jsonl` or a custom path.
   - Optionally set `review.<engine>.maxConcurrent` for individual engines.
8. **Guard hook exceptions & audit log (`guard.allowAgents`, `guard.toolExceptions`, `guard.auditLog`)?** (Only needed if using the `PreToolUse` guard hook in Claude Code)
   - `allowAgents`: default `[]`.
   - `toolExceptions`: default `[]`.
   - `auditLog`: default `"~/.engine-switch/claude-exceptions.jsonl"`.

## Round 2 (per-engine details, only for selected engines)

- **Codex (`codex`)**:
  - Model: `<latest>` (CLI default, recommended), or custom model string.
  - Effort: `medium` (Recommended — balances depth and quota cost), `low`, or `high`.
  - Max concurrent helpers (`codex.maxConcurrent`): `2` (Recommended) or `1`.
  - Shared account (`sharedAccount`): `false` (Recommended) or `true`. If `true`, ask their own `sharePct` (`1–100`, e.g., `50`).
- **Gemini (`gemini`)**:
  - CLI binary (`cli`): `gemini` (Recommended for API-key/enterprise) or `agy` (consumer Google sign-in via Antigravity CLI).
  - Model: `<latest>` (CLI default, recommended), or a model name supported by the selected CLI.
  - Effort for `agy` only: CLI default or a supported level.
  - Max concurrent helpers (`gemini.maxConcurrent`): `1` (Recommended).
  - Shared account (`sharedAccount`): `false` (Recommended) or `true` (with `sharePct` `1–100`).
- **Claude (`claude`)**:
  - Model: `sonnet` (Recommended for fresh `claude -p` reviews), `opus`, or custom model string.
  - Effort: `medium` (Recommended), `low`, or `high`.
  - No quota percentages asked: Claude Code manages its own limits.

## Finish: write config, validate, and verify hook

1. Merge these answers into `~/.engine-switch/config.json`, retaining other skills' settings. Write it (comment-free JSON; example: `examples/engine-switch.config.json`) and validate it:
   ```bash
   node scripts/config.cjs --validate ~/.engine-switch/config.json
   ```
2. Show a one-screen summary of enabled engines, default reviewer, fallback chain, quota thresholds, and max concurrent reviews.
3. If the user also uses the `PreToolUse` guard hook in Claude Code (`codex-gemini-subagents-for-claude-code`), print the `settings.json` snippet (`matcher: "Agent|Task|Workflow|Bash|PowerShell|Monitor"`, command `node "<subagents-skill-dir>/scripts/hooks/engine-guard.cjs"`) and verify it exits `0` on sample JSON stdin.

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
| `review.order` | Non-empty ordered list of engines | `["codex", "gemini", "claude"]` |
| `review.maxConcurrent` | Integer `>= 1` | `3` |
| `review.timeoutMinutes` | Positive number up to 35,791 | `60` |
| `review.<engine>.maxConcurrent` | Optional integer `>= 1` | `review.maxConcurrent` |
| `review.auditLog` | JSONL path | `~/.engine-switch/review-history.jsonl` |
| `review.claude.model` | Model string | `"sonnet"` |
| `review.claude.effort` | `"low"`, `"medium"`, or `"high"` | `"medium"` |
| `guard.allowAgents` | Array of lowercase agent names | `[]` |
| `guard.toolExceptions` | Array of exact tool names | `[]` |
| `guard.auditLog` | Path to JSONL audit log | `"~/.engine-switch/claude-exceptions.jsonl"` |

Skill format reference: [Agent Skills](https://agentskills.io).
