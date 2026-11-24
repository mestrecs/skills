# After the merge

A change is not done until it is live and checked. `deliver.cjs` runs this after a successful merge; exit code 1 means the merge happened but a later step failed.

## Modes (`deploy.mode`)

**`none`** - libraries, docs, anything that ships by tagging. Skip deploy and health check.

**`platform`** - a hosting platform that deploys on its own when the base branch changes (for example Vercel, Netlify, Railway or Fly.io). Some projects are not linked to git and need an explicit deploy command; if so, use `command` mode. After the merge, wait for the platform, then call `healthUrl`.

**`vps-actions`** - your own server, updated by a GitHub Actions workflow on push to base. After the merge, watch the run with `gh run watch` or `gh run list`, then call `healthUrl`. Docs: [GitHub Actions](https://docs.github.com/actions).

**`vps-ssh`** - `deploy.ssh` holds `host`, `user`, `path` and `update` (the command that pulls and restarts, such as a pull plus a service restart). Authentication uses the person's existing SSH key setup. Never ask for or store a password. Test the connection once during setup with a harmless read-only command.

**`command`** - `deploy.command` runs from the repo root after the merge. Use it for explicit deploy scripts.

## Health check

- `healthUrl` must return HTTP 200 (and, if the service reports one, an "ok" status in the body).
- Retry for a short, bounded time (for example 2 minutes), because services take a moment to come up.
- For a new record or screen, also check the real data path once: a read that proves the change is visible, not only that the server answers.

## Restart window

If `restartWindow` is set (for example `03:00-05:30` in `timezone`), a service that holds live sessions should restart only inside it, or after it has been idle for a few minutes. Outside the window, `deliver.cjs` reports "merged, deploy waiting for window" and exits 1 with that reason; run it again later. An emergency fix may override this, by an explicit decision of the person.

## When it fails

- Do not revert blindly. Read the deploy log first.
- Roll forward with a small fix PR, or roll back with a revert PR through the same loop.
- Report honestly: merged yes, live no, and what you are doing about it.
