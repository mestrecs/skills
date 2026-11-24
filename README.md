# Skills

Open skills for AI coding agents. They follow the [Agent Skills](https://agentskills.io) format (a folder with a `SKILL.md`), so they work in Claude Code, Codex CLI, Gemini CLI and other tools that read skills.

## Skills

| Skill | What it does |
| --- | --- |
| [`parallel-worktree-pr-merge-end-to-end`](parallel-worktree-pr-merge-end-to-end/) | Run many AI coding chats in parallel on the same repo without one breaking another: each gets its own worktree, then pull request, tests, cross-model review and merge, end to end. *(in progress)* |

## Install

Copy the skill folder into your tool's skills folder:

- Claude Code: `~/.claude/skills/` (all projects) or `.claude/skills/` (one project)
- Codex CLI: `~/.agents/skills/` or `~/.codex/skills/` (depends on the version)
- Gemini CLI: `~/.gemini/skills/` (all projects) or `.gemini/skills/` (one project)

## License

MIT, see [LICENSE](LICENSE).
