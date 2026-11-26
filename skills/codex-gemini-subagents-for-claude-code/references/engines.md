# Engines, Flags, Sandboxes, and Quota

Details on how `scripts/run-codex.cjs` and `scripts/run-gemini.cjs` invoke each CLI, handle Windows worktrees, avoid the `agy` global-settings pitfall, and detect quota ceilings.

## Codex CLI (`scripts/run-codex.cjs`)

Interface:

```bash
node scripts/run-codex.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--effort <e>]
node scripts/run-codex.cjs --quota-only
```

Flags passed to `codex`:
- **Write mode (default)**:
  `codex exec [--skip-git-repo-check] -s workspace-write -c sandbox_workspace_write.network_access=false [--add-dir <git-common-dir>] -m <model> -c model_reasoning_effort="<effort>" -C <dir> -o <answer-file> -`
- **Delivery mode (`--deliver`)**:
  `codex exec --skip-git-repo-check -s danger-full-access -m <model> -c model_reasoning_effort="<effort>" -C <dir> -o <answer-file> -`
- The prompt (request file + safety rules) is piped via `stdin`.
- `--skip-git-repo-check` is passed automatically whenever `<dir>` is not inside a git repository (or in `--deliver` mode).

### Windows notes for Codex
1. **Linked worktrees**: The runner grants Codex access to the shared Git directory with `--add-dir`.
2. **CLI shims**: Launches use native executables or recognized npm shims without re-parsing arguments in a shell.
3. **Process termination**: Windows uses `taskkill /T`. Unix uses a separate process group.

## Gemini CLI and Antigravity CLI (`scripts/run-gemini.cjs`)

Interface:

```bash
node scripts/run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>] [--cli gemini|agy]
node scripts/run-gemini.cjs --quota-only
```

Two Google CLIs exist:
- `gemini` ([Gemini CLI](https://geminicli.com/docs/)): API-key and enterprise accounts (since 18 June 2026). Accepts `-p <prompt> --approval-mode auto_edit --output-format json [--model <m>] [--sandbox]`.
- `agy` (Antigravity CLI): consumer Google sign-in accounts. Accepts:
  `agy -p <prompt> --model <m> --mode accept-edits --output-format json --print-timeout <n>s --add-dir <tempDir> [--sandbox]`

Select which CLI `run-gemini.cjs` uses via `gemini.cli` in `~/.engine-switch/config.json` (`"gemini"` or `"agy"`), or `--cli`.

Gemini reads the request on stdin and returns JSON. Antigravity reads its request from a temporary
directory added with `--add-dir`. Write mode requests each CLI's sandbox. Antigravity's sandbox
availability depends on the host. Delivery mode omits the sandbox flag.

## Quota contract, watchdog, and exit code 3

Different CLIs expose usage differently, so all runners share one file-based contract plus output error matching:

1. **Optional quota file**: `~/.engine-switch/quota-<engine>.json` (or `$ENGINE_SWITCH_HOME/quota-<engine>.json`):
   ```json
   { "windowPct": 42, "weekPct": 18, "at": 1795651200000 }
   ```
   - `windowPct` and `weekPct` are percentages **used** (0–100).
   - Entries older than 15 minutes (`now - at > 900000`) or in the future are ignored.
   - If `sharedAccount` is `true`, the effective cap is `min(maxPct, sharePct)`.
2. **Watchdog**: While a helper runs, `run-codex.cjs` and `run-gemini.cjs` check the quota file every 60 seconds (when `switchOn.stopMidRun` is `true` and `switchOn.mode` is `"percent-or-error"`). If the ceiling is crossed mid-run, the runner kills the child process tree, writes a ceiling marker, and exits **3**. Anything already written stays in `<dir>` so the fallback engine can inspect `git status` / `git diff` and continue.
3. **Error detection**: A terminal quota or rate-limit diagnostic yields exit 3. Model answer text does not qualify as quota evidence.
4. **Hard limit**: Runs have a 60-minute hard timeout.
