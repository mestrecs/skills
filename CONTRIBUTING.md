# Contributing

Thanks for helping. This repo holds Agent Skills: a folder with a `SKILL.md`, plus scripts and references the skill uses.

## Ground rules

- A skill lives in `skills/<name>/` and everything it uses stays inside that folder. `npx skills` copies only that folder.
- `name` in the frontmatter equals the folder name. The `description` is third person, says what the skill does and when to use it, and is at most 1024 characters.
- `SKILL.md` stays under 500 lines; put detail in `references/`.
- Scripts are Node 18+ CommonJS with no npm dependencies, and must work on Windows, macOS and Linux.
- The text must match the code: if you change a flag or an exit code, change `SKILL.md` and the references in the same pull request.
- No secrets, no private paths, no names of real people or companies in code, tests or docs.

## Before you open a pull request

```bash
cd skills/parallel-worktree-pr-merge-end-to-end
node --test scripts/test/
```

Tests use temporary git repositories and stubs; they never touch the network. Add a test with every fix. If you change when the skill should fire, update `evals/` too.

If you have the Claude Code CLI, also run `claude plugin validate . --strict` from the repo root.

## Proposing a new skill

Open a "Skill request" issue first and describe a real problem you hit, what the agent got wrong, and what a good result looks like. Skills that come from a real, corrected task are accepted; generic advice is not.
