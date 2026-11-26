# Verdict Format, Head Validity, and Safe Fixes

Every review produces a machine-checkable markdown verdict file that stays compatible with `parallel-worktree-pr-merge-end-to-end`.

## File path

- **PR mode (`--pr <n>`):** `reviews/REVIEW-PR<n>.md`
- **Local branch mode (`--base <ref>`):** `reviews/REVIEW-<branch-slug>.md` (for example `reviews/REVIEW-feat-auth.md`, or `reviews/REVIEW-HEAD.md` if detached)

## Exact header contract

Line 1 and Line 2 must match this format:

```markdown
VERDICT: APPROVE
REVIEWED-HEAD: 0123456789abcdef0123456789abcdef01234567

## Findings
- None blocking.

## Checked
- Verified callers in src/billing.js and ran tests/billing.test.cjs (12/12 passed).
```

- Line 1: `VERDICT: APPROVE` or `VERDICT: BLOCK`. If the reviewer outputs multiple `VERDICT:` lines and any of them is `BLOCK`, `BLOCK` wins.
- Line 2: `REVIEWED-HEAD: <sha>` — the commit SHA **after** any fixes committed by the reviewer during the review.
- Followed by findings (severity `P1`/`P2`/`P3`, `file:line`, reason), fixes applied, and what could not be proved (such as checks blocked by sandbox restrictions).

## One-head validity rule

A verdict applies **only** to `REVIEWED-HEAD` (plus files under `reviews/` or changes merged in from the base branch). Any subsequent author commit on code or tests invalidates the approval and requires a fresh review.

## Fix commits and safety checks

The reviewer runs inside the target worktree and may fix clear defects before writing the verdict:

1. **Uncommitted edits:** After the reviewer exits with a usable verdict, `review.cjs` inspects `git status --porcelain -z`.
2. **Forbidden paths:** Any edit or addition under `.git/`, `.github/`, `.githooks/`, `.claude/`, or `.codex/` is rejected (exit `1`), because hooks and CI belong to the author. Deleted or renamed files are also rejected.
3. **Secret scan:** `review.cjs` scans the diff and untracked files for secret patterns (JWTs, `sk-...`, `ghp_...`, private key headers, `AKIA...`, Slack tokens) and environment secret values. If a match is found, nothing is committed and `review.cjs` exits `1`.
4. **Commit:** Safe fixes are staged by explicit file path (`git add -- <files>`) and committed (`git commit -m "review: fixes by the reviewer"` without `--no-verify`).
5. **Verdict commit:** `REVIEWED-HEAD` is read via `git rev-parse HEAD` **after** the fix commit, then the verdict file is written and committed (`git commit -m "review: PR <n> <VERDICT>"` or branch equivalent) unless `--no-commit` is passed.
6. **Never pushes:** `review.cjs` leaves pushing to the caller or delivery pipeline.
