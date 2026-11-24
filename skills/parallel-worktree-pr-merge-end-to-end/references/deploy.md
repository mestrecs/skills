# After the merge

A change is not done until it is live and checked. `deliver.cjs` runs this after a successful merge; exit code 1 means the merge happened but a later step (cleanup, deploy or health check) failed.

## Modes (`deploy.mode`)

**`none`** - libraries, docs, anything that ships by tagging. Skip deploy and health check.

**`platform`** - a hosting platform that deploys on its own when the base branch changes (for example Vercel, Netlify, Railway or Fly.io). Some projects are not linked to git and need an explicit deploy command; if so, use `command` mode. `deliver.cjs` starts nothing in this mode: it only calls `healthUrl` after the merge.

**`vps-actions`** - your own server, updated by a GitHub Actions workflow on push to base. After the merge, `deliver.cjs` polls `gh run list --commit <merged sha>` until every run has completed (up to 20 minutes); any run that did not succeed is a post-merge failure. Then it calls `healthUrl`. Docs: [GitHub Actions](https://docs.github.com/actions).

**`vps-ssh`** - `deploy.ssh` holds `host`, `user`, `path` and `update` (the command that pulls and restarts, such as a pull plus a service restart). Authentication uses the person's existing SSH key setup. Never ask for or store a password. Test the connection once during setup with a harmless read-only command.

**`command`** - `deploy.command` runs from the repo root after the merge. Use it for explicit deploy scripts.

## Health check

- `healthUrl` must answer with a 2xx status. If the service also reports an "ok" field in the body, check it yourself once.
- `deliver.cjs` tries up to 10 times, 3 seconds apart, with a 10-second timeout per call, because services take a moment to come up. Anything other than a 2xx answer counts as a failure.
- For a new record or screen, also check the real data path once: a read that proves the change is visible, not only that the server answers.

## Restart window

`deploy.restartWindow` (for example `03:00-05:30`, read in `timezone`, may cross midnight) applies only to the modes that restart something: `command` and `vps-ssh`. Inside the window, or when no window is set, the deploy runs. Outside it, `deliver.cjs` prints `DEPLOY-DEFERRED`, does not deploy, and **still exits 0**, because the merge is done and nothing failed. Run the deploy command yourself inside the window, or after the service has been idle for a few minutes. An emergency fix may override this, by an explicit decision of the person. The `platform` and `vps-actions` modes ignore the window, since the platform decides when to restart.

## When it fails

- Do not revert blindly. Read the deploy log first.
- Roll forward with a small fix PR, or roll back with a revert PR through the same loop.
- Report honestly: merged yes, live no, and what you are doing about it.
