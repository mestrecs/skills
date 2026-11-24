# First-run setup

Run only when `.parallel-pr.json` does not exist at the repo root. Goal: write that file with as few questions as possible. Never ask for a password, key or token in the chat, and never open `.env`.

## Step 0: detect

`node scripts/detect.cjs` prints JSON:

```
{ repo, baseBranch, testCommand, os,
  gh: { installed, authed },
  engines: { claude, codex, gemini: { installed, authed } },
  deployHints: [ ... ] }
```

Show it in plain words ("repo owner/name, base main, tests with `npm test`, GitHub CLI logged in, Codex not installed") and ask for corrections. If `gh` is missing or not logged in, stop and give the install link ([GitHub CLI](https://cli.github.com/)) and the command `gh auth login`.

## Round 1 (ask together)

1. **Who reviews** critical changes? Options: Codex, Gemini, Claude (a fresh session). Multi-select, in order of preference. Recommend an engine different from the one that usually writes the code.
2. **Who helps** (side agents for search and bounded fixes)? Suggest the same list as the reviewers.
3. **When is review required?** `critical` (recommended: only the paths you list), `always`, or `never`.
4. **Where does it go live?** A hosting platform that deploys itself, your own server (GitHub Actions or SSH), a local command, or nowhere (library, docs).
5. **Protect the base branch?** Recommended yes. Give the link `https://github.com/<repo>/settings/branches`; background: [about protected branches](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). Changing branch protection is the person's decision.
6. **How many chats at once on this machine?** Sets `parallel.suiteSlots` (suggest 2 for a laptop, 3 or 4 for a workstation with 32 GB or more).
7. **Language and defect log.** Language of PR text and reviews; path of the defect log (default `docs/DEFECTS.md`).

If review is required for critical paths, also ask for the glob list (migrations, auth, payments, public entry points, build and CI config).

## Round 2 (only what the answers need)

- **Claude as reviewer or helper:** inform, do not ask. Reviewer: Sonnet, medium effort. Helpers: Haiku for search and reading, Sonnet for judgment, Opus only on the third attempt. No quota question: Claude Code manages its own limits.
- **Codex:** model (mark the latest as recommended), effort (low, medium or high; recommend medium), `maxWindowPct` (default 90) and `maxWeekPct` (default 80) of quota this skill may use, and whether the account is shared with other people or systems (`sharedAccount`). If the CLI is missing, point to the [Codex CLI page](https://developers.openai.com/codex/cli); sign-in happens by running `codex` and choosing a sign-in method.
- **Gemini:** model (recommend the latest), the same two caps, and shared account yes or no. If missing, see the [Gemini CLI docs](https://geminicli.com/docs/); install is `npm install -g @google/gemini-cli`, and sign-in is explained on its authentication page.
- **Platform deploy:** the health URL.
- **VPS:** host, user, path; then Actions or SSH; health URL; restart window (for example `03:00-05:30`) and timezone. Test the connection once, read-only (a command like `echo ok`), using the person's existing key setup. Never ask for a password in the chat.
- **Command deploy:** which command, and the health URL.

Finish by writing the file, showing a one-screen summary (engines, review rule, deploy, slots), and asking the person to commit `.parallel-pr.json`.

## How to ask, per tool

| Tool | Method |
| --- | --- |
| Claude Code | `AskUserQuestion`: at most 4 questions per call, 2 to 4 options each, recommended option first. Split Round 1 into two calls. |
| Gemini CLI | [`ask_user`](https://geminicli.com/docs/tools/ask-user/): 1 to 4 questions per call; choice, multi-select or free text. |
| Codex CLI | A numbered list in plain text. Its `request_user_input` tool is off in default mode. |
| Other | A numbered list; the person answers like `1 2, 2 1` (question 1 option 2, question 2 option 1). |

## Config schema (`.parallel-pr.json`)

| Field | Meaning |
| --- | --- |
| `version` | Always 1. |
| `repo` | `owner/name`. |
| `baseBranch` | Branch that PRs merge into. |
| `docsDirectToBase` | Docs and notes skip the PR. |
| `worktreeDir` | Where worktrees live; `<repo>` expands to the repo name. |
| `linkDependencies` | Folders linked into each worktree (junction or symlink). |
| `testCommand` | The full suite. `quickCheckCommand`: a fast check before push, or null. |
| `parallel.suiteSlots` | Suites at once on this machine. `stuckSuiteMinutes`: a slot older than this is stale. `minFreeMemoryGB`: do not start below this. |
| `review.requiredFor` | `always`, `critical` or `never`. |
| `review.criticalPaths` | Globs that trigger review. |
| `review.engines` | Order; the next is used when the previous is unavailable or at quota. |
| `review.claude / codex / gemini` | Model and effort; quota caps and `sharedAccount` for Codex and Gemini only. |
| `review.maxParallel` | Reviews at once. |
| `helpers` | Engines and models for side agents. |
| `deploy.mode` | `none`, `platform`, `vps-actions`, `vps-ssh` or `command`. Other deploy fields are described in `deploy.md`. |
| `timezone`, `language`, `defectLog` | As named. |

The file is plain JSON with no comments; see `examples/parallel-pr.config.json`.

Skill format background: [Agent Skills](https://agentskills.io).
