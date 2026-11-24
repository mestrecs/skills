# The method, with the reason behind each rule

Each rule is followed by **Why**: a short, anonymous case of what went wrong without it.

## A. Parallel work (the main point)

**A1. One task = one worktree = one branch = one PR.** The worktree lives outside the main checkout (default `../<repo>-wt/<slug>`), on branch `pr/<slug>`, cut from the latest remote base.
**Why:** two chats shared one folder; one switched branches and the other committed its half-done edits onto the wrong branch.

**A2. A dirty shared checkout is normal, not an error.** Never clean, reset or stash it to "tidy up".
**Why:** a chat discarded "stray" changes that were another chat's unsaved work.

**A3. Link dependencies instead of reinstalling.** `node_modules` (or the equivalent) is linked into the worktree: a junction on Windows, a symlink elsewhere. Removal must unlink first, without following the link.
**Why:** a recursive delete followed a link and emptied the shared dependency folder for every chat.

**A4. Commit only the files you touched, named one by one.** Never `git add -A` or `git add .`. For files several chats edit (changelogs, defect logs), look at that file's diff before committing.
**Why:** a blanket add swept another chat's half-written file into an unrelated PR.

**A5. Full test suites go through a machine-wide queue.** A fixed number of slots (default 2), lock files with PID and start time, a stale lock being a dead PID or one older than the stuck limit, and a free-memory check before starting. While waiting, do other work.
**Why:** five suites at once froze the machine, tests timed out, and every chat saw red for reasons unrelated to its change.

**A6. Merges are serialized per repo, and only with the branch up to date.** One merge lock per repo. After taking it, re-sync with base; re-run tests only if base moved. Merge with `--match-head-commit` so a late push cannot slip in unreviewed.
**Why:** two green PRs merged back to back broke the base, because each was green only against an older base.

**A7. A waiting step never stops the line.** Queue, review and deploy windows are waited out in the background while the next task starts. Do not poll in a tight loop.
**Why:** chats sat idle for half an hour on a queue, when they could have started the next task.

**A8. Cap parallel work by what the machine can take, not by ambition.** Slots for suites, a cap on parallel reviewers, a cap on helpers. Lower the caps when disk or memory is under pressure.
**Why:** the throughput gained from more chats vanished once the disk began throwing errors.

## B. The pull request

**B1. Open with the request in the person's own words**, then a line `Left out:` (what was asked and not done, and why, or `nothing`). Then what changed, which test proves it, and the suite result.
**Why:** reviewers kept approving PRs that solved a slightly different problem than the one asked.

**B2. Docs and notes go straight to base** (when `docsDirectToBase` is on); only code goes through a PR. A hook on push enforces it.
**Why:** PRs for typo fixes clogged the merge lock.

**B3. Tests run on push, and green means you saw the result.** Not "it should pass". Heavy suites write output to a file; read the tally and the failures only.
**Why:** a chat reported "done" from a partial run that had silently skipped the failing file.

**B4. A flaky test is a bug.** No retry-until-green, no skip. Find the cause, or delete the test and write down why.
**Why:** a test retried until green hid a real race, which later caused a double write in production.

**B5. Logic that handles money, dates or rounding gets property tests.** Generated inputs, checked invariants (totals match, no negative balance, re-running changes nothing).
**Why:** example-based tests passed while a rounding rule drifted by a cent per thousand rows.

## C. Review by a different model

**C1. Require review only where it finds defects.** Typical critical paths: schema and migrations, authorization, anything that moves money, entry points that take outside input, and the review tooling itself. Everything else passes with a green suite.
**Why:** measured over a few months, independent review found real defects in most PRs touching schema and auth, and almost none in UI tweaks and docs; author self-reviews cost time and added no second pair of eyes.

**C2. The reviewer is a different model from the author.** Engine order is configured; the next one is used when the previous is missing or at quota. If nothing else is reachable, a fresh Claude session is the last resort.
**Why:** a model tends to approve its own blind spots.

**C3. The reviewer fixes; it does not only comment.** It may commit fixes to the branch, and then the verdict is written for the new head.
**Why:** comment-only review bounced PRs back and forth for hours over one-line fixes.

**C4. The verdict is a file on the PR branch.** `reviews/REVIEW-PR<n>.md`; line 1 `VERDICT: APPROVE` or `VERDICT: BLOCK`; line 2 `REVIEWED-HEAD: <sha>`. The gate reads the verdict line itself, not the file name.
**Why:** a file named like an approval held a blocking verdict and was merged anyway.

**C5. A verdict is valid for one head.** Any later push invalidates it.
**Why:** a "small fix" after approval reintroduced the bug the reviewer had flagged.

**C6. Review runs outside the merge lock.** It is slow; holding the lock blocks every other chat.
**Why:** one slow review froze all merges for the repo.

**C7. Give the reviewer the callers, not just the diff.** The prompt carries the PR body, the diff, and the call sites of changed functions.
**Why:** a signature change looked fine in the diff and broke three callers outside it.

**C8. Aim the reviewer at what you did not test.** List the deliberate bugs (mutations) you already planted and caught.
**Why:** most review time went into repeating the author's own checks.

## D. The gate and the merge

**D1. Four questions; any "no" stops the merge.** Is review required? Is the review in the diff? Is the verdict APPROVE for this head? Is the branch up to date with base (zero commits behind)? The host's "mergeable" badge does not answer the last one.
**Why:** a PR showed mergeable while many commits behind, and its tests had never seen the newer code.

**D2. Never merge by hand and never bypass hooks.** `--no-verify` is forbidden, and so is pushing to the live branch from another checkout.
**Why:** one bypassed push reached production with a red suite.

**D3. Conflicts are resolved in the worktree**, by merging base into the branch and re-running tests.
**Why:** resolving in the host's web editor produced a merge nobody had tested.

## E. After the merge

**E1. The change is not done until it is live and checked.** Deploy per config, then a health check (see `deploy.md`).
**Why:** "merged" was reported as done twice while the deploy had silently failed.

**E2. Do not restart a service in the middle of live use.** If it has a quiet-hours window, deploy then, or wait until it is idle.
**Why:** a restart in the middle of an exchange cut the user's turn.

**E3. Clean up in the same run.** Remove the worktree and branch only when `git log origin/<base>..<branch>` is empty. Delete branches one at a time.
**Why:** hundreds of stale worktrees ate the disk and made `git branch` unreadable.

## F. Defects and secrets

**F1. Keep a defect log** (`defectLog`). Each entry has symptom, root cause, fix and the rule. Write it before the commit with the fix.
**Why:** the same defect came back repeatedly because the lesson lived in a chat that was later summarized away.

**F2. Fix a defect where the rule lives, not only where it showed up.** Search for the other paths that do the same thing.
**Why:** a fix at one entry point left two sibling entry points broken; a third of "fixed" defects returned.

**F3. A security hole you find is closed in the same delivery.** Not "in a follow-up".
**Why:** the follow-up never got scheduled and the hole stayed open for weeks.

**F4. Secrets are never printed, logged, written to a file or committed.** Ask for one variable by exact name inside a script; never dump the environment. Helpers do not inherit this rule: write it into every helper prompt.
**Why:** a helper dumped all variables to "debug", and the output landed in a saved transcript.

**F5. A failed search or measurement means "I do not know", not "none".** Confirm the instrument by searching for something known to exist.
**Why:** an empty result from a broken query was read as "no problem".

## G. Environment traps

- Report times in the configured timezone, never the server's. A shell `date` with a TZ variable can silently print UTC on some systems; use a tool that knows time zones.
- Non-ASCII text sent through shell heredocs and `curl` on Windows can turn into garbage; use a script that declares UTF-8.
- On Windows shells, a backtick inside double quotes runs a command.
- After editing a document, check the diff size: an editor may rewrite every line ending in the file.
