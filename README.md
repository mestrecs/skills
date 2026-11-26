# skills

**Run many AI coding chats in parallel on the same repo without one breaking another: each gets its own worktree, then pull request, tests, cross-model review and merge, end to end.**

[![GitHub stars](https://img.shields.io/github/stars/mestrecs/skills?style=social)](https://github.com/mestrecs/skills/stargazers)
[![skills.sh](https://skills.sh/b/mestrecs/skills)](https://skills.sh/mestrecs/skills)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Works with Claude Code, Codex and Gemini CLI](https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Gemini%20CLI-555555)

![Two chats deliver to the same repo at the same moment: one waits for the merge lock, re-tests on the new base, merges; both end on main and the worktrees are cleaned](assets/demo.svg)

*Real run, shortened: two chats, one repo, same moment. The late chat waits for the lock, re-tests on the new base, then merges.*

## Quick start

```bash
npx skills add mestrecs/skills        # installer needs Node 22.20+; on Node 20, use the plugin or copy route below
# open your agent (Claude Code, Codex, Gemini CLI) in your repo
# ask it to work; on first use the skill sets itself up (writes .parallel-pr.json)
```

```mermaid
flowchart LR
    A[Chat A] --> WA[worktree A]
    B[Chat B] --> WB[worktree B]
    C[Chat C] --> WC[worktree C]
    WA --> Q[test queue<br/>N suites at a time]
    WB --> Q
    WC --> Q
    Q --> PR[pull request]
    PR --> R{critical paths?}
    R -- yes --> X[review by a<br/>different model<br/>fixes + verdict]
    R -- no --> M
    X --> M[merge queue<br/>one at a time<br/>branch up to date]
    M --> D[deploy +<br/>health check]
    D --> CL[cleanup]
```

## Install

Pick one route. Installing the same skill twice (for example plugin and copied files) makes your agent see it twice.

<details>
<summary><b>npx skills</b> (any agent; the installer needs Node 22.20 or newer, the skill itself runs on Node 20+)</summary>

```bash
npx skills add mestrecs/skills
```

One skill only, or one agent only:

```bash
npx skills add mestrecs/skills --skill parallel-worktree-pr-merge-end-to-end
npx skills add mestrecs/skills -a claude-code
```

List what is inside with `--list`, install for every project with `-g`, update later with `npx skills update`. This copies files; it does not update by itself.
</details>

<details>
<summary><b>Claude Code, plugin marketplace</b> (updates itself)</summary>

```bash
claude plugin marketplace add mestrecs/skills
claude plugin install parallel-worktree-pr-merge-end-to-end@mestrecs-agent-skills
```

On Claude Code 2.1.292 or newer, one step also works:

```bash
claude plugin install parallel-worktree-pr-merge-end-to-end --marketplace mestrecs/skills
```

Inside a session, the same thing is `/plugin marketplace add mestrecs/skills` and `/plugin install parallel-worktree-pr-merge-end-to-end@mestrecs-agent-skills`. If the add step fails with `Permission denied (publickey)`, tell git to use HTTPS: `git config --global url."https://github.com/".insteadOf git@github.com:`.
</details>

<details>
<summary><b>Claude Code, manual copy</b></summary>

Copy `skills/parallel-worktree-pr-merge-end-to-end/` into `~/.claude/skills/` (all projects) or `<your-repo>/.claude/skills/` (one project).
</details>

<details>
<summary><b>Codex CLI</b></summary>

Copy `skills/parallel-worktree-pr-merge-end-to-end/` into `~/.agents/skills/` (all projects) or `<your-repo>/.agents/skills/` (one project). Or let `npx skills` do it:

```bash
npx skills add mestrecs/skills -a codex
```

Older Codex versions read `~/.codex/skills/` instead; copy there if the skill does not show up. A Codex plugin package is not published yet.
</details>

<details>
<summary><b>Gemini CLI</b></summary>

```bash
gemini skills install https://github.com/mestrecs/skills.git --path skills/parallel-worktree-pr-merge-end-to-end
```

Add `--scope workspace` to keep it to one project, `--consent` to skip the confirmation. Manual route: copy the folder to `~/.gemini/skills/` or `<your-repo>/.gemini/skills/`.

Since 18 June 2026 Google serves Gemini CLI only to API-key and enterprise accounts; consumer sign-ins moved to the Antigravity CLI. If you use that one, the skill works the same through `npx skills add mestrecs/skills`; Gemini is then just one of the optional reviewers you leave out.
</details>

<details>
<summary><b>Cursor</b></summary>

```bash
npx skills add mestrecs/skills -a cursor
```

Or copy the folder to `<your-repo>/.cursor/skills/` or `~/.cursor/skills/`. Cursor also reads `.claude/skills/` and `.agents/skills/`. Invoke it with `/parallel-worktree-pr-merge-end-to-end`.
</details>

On first use the skill finds no `.parallel-pr.json`, inspects your setup, asks a few questions (who reviews, where it goes live, how many chats at once) and writes the file for you to commit.

## Skills

| Skill | Use when | What you get |
| --- | --- | --- |
| [`parallel-worktree-pr-merge-end-to-end`](skills/parallel-worktree-pr-merge-end-to-end/SKILL.md) | Several chats or agents edit one repo at once; changes collide or overwrite each other; you want a PR merged safely with a second model reviewing it | One worktree per chat, a machine-wide test queue, a PR, review by a different model on critical paths, a one-at-a-time merge gate, deploy plus health check, cleanup. Seven small Node scripts with 51 tests, no dependencies. |
| [`codex-gemini-subagents-for-claude-code`](skills/codex-gemini-subagents-for-claude-code/SKILL.md) | You want Claude Code to send subagent work to Codex CLI or Gemini / Antigravity CLI per chat instead of spending Claude quota | Per-chat engine switch, sandboxed Codex and Gemini/agy runners with mid-run quota watchdogs, a PreToolUse guard hook that blocks unintended Claude subagents, verified ceiling fallback, and a JSONL audit log for Claude exceptions. |

## Why this exists

- **Two chats, one folder.** One switched branches while the other was mid-edit and committed its half-written files onto the wrong branch. Now every chat has its own worktree and nobody touches the shared checkout.
- **Green against an old base.** Two PRs, each green, merged back to back and broke the base, because each had only been tested against the code from before the other. Now merges go one at a time and the branch must contain the latest base before it merges.
- **Review that was never read.** A reviewer approved its own model's blind spots, and a "small fix" after approval brought the bug back. Now critical changes get a verdict from a different model, written to a file that is valid for exactly one commit.

The rules and the reason behind each one are in [`method.md`](skills/parallel-worktree-pr-merge-end-to-end/references/method.md).

## How it compares

- **superpowers `using-git-worktrees`** gives one agent an isolated worktree. It stops there. This skill starts at the worktree and goes on to tests, PR, review, merge, deploy and cleanup, and it coordinates several chats at once.
- **Claude Code `/ship` and Claude Ship** open a PR from your branch and follow it, for one change at a time, and Claude Ship needs a team plan. Neither merges for you. This skill merges, behind a gate, and works with Codex and Gemini CLI as well.

## Requirements

- git, with a remote called `origin`
- [GitHub CLI](https://cli.github.com/) (`gh`), logged in with `gh auth login`
- [Node.js](https://nodejs.org/) 20 or newer for the scripts (no npm install; CI runs Node 20 and 22)
- Optional reviewers: Claude Code (`claude`), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://geminicli.com/docs/)

## FAQ

**Does it work without GitHub?** No. The pull request, the merge and the gate go through `gh`. A GitLab or Gitea port would be a welcome contribution.

**Which model reviews?** You choose the order in `.parallel-pr.json`; the next one is used when the first is missing, logged out or over its quota cap. Codex and Gemini are the usual first picks because they differ from the model that wrote the code.

**Does it run on Windows?** Yes. Scripts are plain Node, dependencies are linked with a junction instead of a symlink, and CI runs the tests on Windows, macOS and Linux.

**What if two chats finish at the same moment?** They queue on a per-repo merge lock. The first merges; the second then merges the new base into its branch, re-runs the tests only because the base moved, and merges. If it conflicts, it stops with exit code 5 and tells the chat to resolve it in its worktree.

**What if I only use Claude?** Set `review.engines` to `["claude"]`. The reviewer is then a fresh Claude session (Sonnet, medium effort), never the chat that wrote the change. Weaker than a second vendor, but still a second pair of eyes, and nothing else changes.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md); the scripts are tested with `node --test` and CI must stay green.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=mestrecs/skills&type=Date)](https://star-history.com/#mestrecs/skills&Date)

## License

MIT, see [LICENSE](LICENSE).
