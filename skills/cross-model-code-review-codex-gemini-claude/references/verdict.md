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
- Followed by findings with stable IDs (such as `F1`), severity (`P0` through `P3`), `file:line`, and evidence. Include checks, fixes applied, and what could not be proved.

## Findings across rounds

- **First round.** Check each new or changed path for duplicate effects, interruption before and after writes or sends, concurrent execution, cross-tenant or cross-group access, and optional or scheduled behavior behind a flag that defaults to off. List every finding in the same report.
- **Later rounds.** Keep the original IDs. Carry forward each finding with `RESOLVED`, `PARTIAL`, or `OPEN` and evidence. Use the diff from the prior `REVIEWED-HEAD` to the current head. Fix regressions and new P0/P1 defects introduced by the diff can block. A newly discovered issue outside the diff needs P0/P1 severity and a reproducing test or concrete steps with observed results to block. Record the other newly discovered issues outside the diff as `P2-NEW`.
- **Two BLOCKs.** The runner counts distinct blocked heads in the committed history of this report path. Overwriting a report preserves the earlier round in Git. Rewording a report for the same head does not add a block. To run another review, separate the blocking behavior into another PR or put it behind a flag that defaults to off. Pass `--separated "<what left the change>"` so the reviewer can verify the change in the diff. Uncommitted reports, including `--no-commit` output, do not count.

## One-head validity rule

A verdict applies **only** to `REVIEWED-HEAD` (plus files under `reviews/` or changes merged in from the base branch). Any subsequent author commit on code or tests invalidates the approval and requires a fresh review.

## Fix commits and safety checks

The reviewer runs inside the target worktree and may fix clear defects before writing the verdict:

1. **Uncommitted edits:** After the reviewer exits with a usable verdict, `review.cjs` inspects `git status --porcelain -z`.
2. **Forbidden paths:** Any edit or addition under `.git/`, `.github/`, `.githooks/`, `.claude/`, or `.codex/` is rejected (exit `1`), because hooks and CI belong to the author. Deleted or renamed files are also rejected.
3. **Secret scan:** `review.cjs` scans the diff and untracked files for secret patterns (JWTs, `sk-...`, `ghp_...`, private key headers, `AKIA...`, Slack tokens) and environment secret values. If a match is found, nothing is committed and `review.cjs` exits `1`.
4. **Commit:** Safe fixes are staged by explicit file path (`git add -- <files>`) and committed (`git commit -m "review: fixes by the reviewer"` without `--no-verify`).
5. **Verdict commit:** `REVIEWED-HEAD` is read via `git rev-parse HEAD` **after** the fix commit, then the verdict file is written and committed (`git commit -m "review: PR <n> <VERDICT>"` or branch equivalent) unless `--no-commit` is passed. With that flag, fixes remain uncommitted and the verdict is BLOCK if fixes are required.
6. **Never pushes:** `review.cjs` leaves pushing to the caller or delivery pipeline.
