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
  `codex exec [--skip-git-repo-check] -s workspace-write -c sandbox_workspace_write.network_access=false [-c "sandbox_workspace_write.writable_roots=['<git-common-dir>']"] -m <model> -c model_reasoning_effort="<effort>" -C <dir> -o <answer-file> -`
- **Delivery mode (`--deliver`)**:
  `codex exec --skip-git-repo-check -s danger-full-access -m <model> -c model_reasoning_effort="<effort>" -C <dir> -o <answer-file> -`
- The prompt (request file + safety rules) is piped via `stdin`.
- `--skip-git-repo-check` is passed automatically whenever `<dir>` is not inside a git repository (or in `--deliver` mode).

### Windows notes for Codex
1. **Worktree git index**: In a linked git worktree, `.git` inside `<dir>` is a pointer file, and the shared git index/objects directory lives in `<main-repo>/.git/worktrees/...`, which is outside `<dir>`. `run-codex.cjs` runs `git -C <dir> rev-parse --path-format=absolute --git-common-dir` and passes `-c "sandbox_workspace_write.writable_roots=['<git-common-dir>']"` with **single quotes** inside the TOML array because `cmd.exe` strips double quotes.
2. **CLI shims**: On Windows, globally installed CLIs are `.cmd` shims, so real binary spawns pass `{ shell: process.platform === 'win32', windowsHide: true }`.
3. **Process tree kill**: When the watchdog or 60-minute timer fires on Windows, `run-codex.cjs` terminates the entire process tree with `taskkill /PID <pid> /T /F`.

## Gemini CLI and Antigravity CLI (`scripts/run-gemini.cjs`)

Interface:

```bash
node scripts/run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>] [--cli gemini|agy]
node scripts/run-gemini.cjs --quota-only
```

Two Google CLIs exist:
- `gemini` ([Gemini CLI](https://geminicli.com/docs/)): API-key and enterprise accounts (since 18 June 2026). Accepts `-p <prompt> --model <m> [--sandbox]`.
- `agy` (Antigravity CLI): consumer Google sign-in accounts. Accepts:
  `agy -p <prompt> --model <m> --mode accept-edits --output-format json --print-timeout <n>s --settings <permissions.json> --add-dir <tempDir> --add-dir <dir> [--sandbox]`

Select which CLI `run-gemini.cjs` uses via `gemini.cli` in `~/.engine-switch/config.json` (`"gemini"` or `"agy"`), or `--cli`.

### Per-run permissions and the `agy` global-allow pitfall
- In write mode, `run-gemini.cjs` passes `--sandbox` and creates an isolated temporary directory holding a copy of the request and a per-run `permissions.json`:
  ```json
  {
    "permissions": {
      "allow": ["command(*)", "read_file(*)", "write_file(<dir>/**)"],
      "deny": []
    }
  }
  ```
- **Known pitfall**: Never put a broad `write_file(*)` or global allow-all rule in the user's global `agy` settings file. Global `agy` allow rules leak into every helper run and permit writes outside `<dir>`. Always keep permissive rules scoped to the per-run temporary `--settings` file, which is deleted as soon as the run finishes.
- In `--deliver` mode, `--sandbox` is omitted so network/push delivery scripts can run.

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
3. **Output error detection**: If the CLI exits non-zero (or produces an empty answer) with output matching `/rate.?limit|quota|429|usage limit/i`, the runner writes the ceiling marker and exits **3**.
4. **Hard limit**: Runs have a 60-minute hard timeout.
