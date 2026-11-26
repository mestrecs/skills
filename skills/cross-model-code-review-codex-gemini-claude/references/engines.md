# Engines, Sandboxes, Quotas, and Concurrency

How `scripts/review.cjs` selects an engine, runs it safely inside the target worktree, enforces concurrency limits, and decides whether to fall back.

## Engine order and strict fallback

1. Read the chat key `~/.engine-switch/chats/<session-id>.json` (`reviewer` field), falling back to `defaults.reviewer` in `~/.engine-switch/config.json` (default `codex`).
2. Build the chain:
   - If `--engine <name>` is passed, run only `[<name>]`.
   - If the preferred engine is `claude`, run `["claude"]`.
   - Otherwise, place the preferred engine first, followed by the remaining enabled engines in `review.order` (default `["codex", "gemini", "claude"]`).
3. Move to the next engine **only** when the current engine is:
   - **Missing** (`--version` fails or binary is absent),
   - **Logged out** (no sign-in folder/API key found, or CLI exits with an auth/login error), or
   - **At quota ceiling** (`quota-<engine>.json` meets or exceeds threshold before start or mid-run, or CLI output matches `/rate.?limit|quota|429|usage limit/i`).
4. **Never fall back because an engine is slow** (timeout exits `1`), crashes with a non-quota/non-auth error (exits `1`), or omits a usable verdict (exits `1`).
5. When every engine in the chain is unavailable for reason (3), `review.cjs` exits `3`.

## Codex CLI (`codex`)

Default: model `gpt-6.2-sol`, reasoning effort `medium`.

`review.cjs` invokes:

```bash
codex exec [--skip-git-repo-check] -s workspace-write \
  -c sandbox_workspace_write.network_access=false \
  [-c "sandbox_workspace_write.writable_roots=['<git-common-dir>']"] \
  -m <model> -c model_reasoning_effort="<effort>" -C <dir> -o <answer-file> -
```

- The review prompt is piped via `stdin`.
- Network access is disabled (`network_access=false`) so the reviewer cannot push or leak data.
- On Windows linked worktrees, the shared git metadata directory (`git rev-parse --path-format=absolute --git-common-dir`) lives outside `<dir>`, so `writable_roots` uses single quotes inside the TOML literal because `cmd.exe` strips double quotes.
- Environment variables whose names look like secrets (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, etc.) are stripped from the child process environment.

## Gemini CLI and Antigravity CLI (`gemini` / `agy`)

Default: CLI `gemini`, model `gemini-4-hydrogen-high`.

Two Google CLIs exist:
- `gemini` ([Gemini CLI](https://geminicli.com/docs/)): API-key and enterprise accounts (since 18 June 2026). Invoked with `[-m <model>] -p <short-instruction> --sandbox` and the full prompt on `stdin`.
- `agy` (Antigravity CLI): consumer Google sign-in accounts. Invoked with:
  `agy -p <prompt> --model <model> --mode accept-edits --output-format json --print-timeout <n>s --settings <permissions.json> --add-dir <tempDir> --add-dir <dir> --sandbox`

### Per-run permissions and the `agy` global-allow pitfall

For `agy`, `review.cjs` writes the full prompt to a temporary `request.md` and creates an isolated per-run `permissions.json`:

```json
{
  "permissions": {
    "allow": ["command(*)", "read_file(*)", "write_file(<dir>/**)"],
    "deny": []
  }
}
```

- **Known pitfall:** Do not put a broad `write_file(*)` or global allow-all rule in your global `agy` settings file. Global allow rules leak into every helper and reviewer run and let it write outside `<dir>`. Always keep permissive rules scoped to the temporary per-run `--settings` file, which `review.cjs` deletes when the run ends.

## Claude Code (`claude`)

Default: model `sonnet`, effort `medium`.

`review.cjs` spawns a fresh, non-interactive session with the prompt on `stdin`:

```bash
claude -p --model sonnet --effort medium
```

- Never reuse the conversation that authored the code.
- If the `engine-guard.cjs` `PreToolUse` hook from `codex-gemini-subagents-for-claude-code` is installed and an orchestrator calls a Claude reviewer subagent through `Agent` instead of `review.cjs`, the guard only allows it when the prompt contains the exact line `CLAUDE-ONLY: ceiling` **and** recent ceiling markers exist in `~/.engine-switch/ceilings/` for the preceding engines in the chain. `review.cjs` writes those ceiling markers whenever an engine hits ceiling.

## Quota contract and watchdog

All non-Claude engines share the generic file contract in `~/.engine-switch/quota-<engine>.json` (or `$ENGINE_SWITCH_HOME/quota-<engine>.json`):

```json
{ "windowPct": 42, "weekPct": 18, "at": 1795651200000 }
```

- `windowPct` and `weekPct` are percentages **used** (`0–100`). Files older than 15 minutes or with future timestamps are ignored.
- When `sharedAccount` is `true`, the effective cap is `min(maxPct, sharePct)`.
- While a review runs, a watchdog checks the quota file every 60 seconds (when `switchOn.stopMidRun` is `true` and `switchOn.mode` is `"percent-or-error"`). If the ceiling is crossed mid-run, `review.cjs` kills the child process tree, writes `~/.engine-switch/ceilings/<engine>.json`, and moves to the next engine in the chain.

## Concurrency slots

Each engine uses machine-wide lock files under `~/.engine-switch/review-slots/<engine>/slot-<i>.lock` (`i = 0 .. maxConcurrent - 1`), defaulting to **3 concurrent reviews per engine** (`review.maxConcurrent: 3`).

- Stale locks (dead PID or older than `timeoutMinutes + 15` minutes) are reclaimed automatically.
- If all slots are busy past `--max-wait` (default `600` seconds), `review.cjs` exits `1`.

## Environment hooks for testing

- `ENGINE_SWITCH_HOME`: overrides `~/.engine-switch`.
- `ENGINE_SWITCH_BIN_CODEX`, `ENGINE_SWITCH_BIN_GEMINI`, `ENGINE_SWITCH_BIN_AGY`, `ENGINE_SWITCH_BIN_CLAUDE`: point to fake CLI scripts or binaries.
- `ENGINE_SWITCH_GH`: points to a fake `gh` script.
- `ENGINE_SWITCH_USER_HOME`: overrides home directory used for login-folder checks.
- `ENGINE_SWITCH_WATCHDOG_MS`, `ENGINE_SWITCH_TIMEOUT_MS`, `ENGINE_SWITCH_POLL_MS`: override timers in tests.
