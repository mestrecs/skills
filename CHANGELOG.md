# Changelog

## v0.2.0

- Cross-model code review checks five failure cases in the first pass and reports all findings with IDs and evidence. Follow-ups reconcile prior findings, use the diff since the reviewed head, and record new out-of-diff findings as `P2-NEW` unless a P0/P1 is reproduced. After two BLOCKs, another review requires `--separated` and verification of the separation in the diff.
- Worktree delivery enforces the same review ceiling, runs every configured test command in one queue slot, and reports failures together with a full redacted log. Delivery records include stage timings, reviewer engine and fix commit time, and counts of BLOCKs and reviewed heads. Delivery can wait for GitHub checks and request a squash merge.
- Coding helper prompts end with the five failure cases and require temporary files outside the worktree.
- Added evaluation cases for the review rounds, the delivery ceiling, aggregate test failures, delivery timing, and helper prompt rules.

The review changes came from a week of 128 reviews with 39 BLOCK verdicts. Of those, 30 identified real defects in the five failure cases. In 12 follow-ups, the reviewer returned to the same area with a new scenario. Each round took 25–29 minutes, and one optional change spent nearly two hours in four blocked rounds.
