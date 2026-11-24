'use strict';
// Removes worktrees and branches of tasks that are already merged.
//   node cleanup.cjs [--dry-run]
// A branch goes only when `git log origin/<base>..<branch>` is empty AND the PR is confirmed
// merged (a brand-new branch also has an empty log, so the log alone is not enough).
const common = require('./common.cjs');
const { loadConfig, mainRoot } = require('./config.cjs');
const { parseWorktreeList, removeWorktree } = require('./worktree.cjs');
const { dirtyFiles } = require('./deliver.cjs');

// PURE. prMerged: true | false | null (unknown, e.g. gh missing)
function decideCleanup(i) {
  if (i.dirty) return { remove: false, reason: 'has uncommitted changes' };
  if (!i.logEmpty) return { remove: false, reason: 'has commits not in the base' };
  if (i.prMerged === null) return { remove: false, reason: 'cannot confirm the PR is merged (gh unavailable)' };
  if (i.prMerged === false) return { remove: false, reason: 'no merged PR for this branch' };
  return { remove: true, reason: 'merged' };
}

function prMerged(cfg, branch) {
  const r = common.gh(['pr', 'list', '--repo', cfg.repo, '--head', branch, '--state', 'merged', '--json', 'number']);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).length > 0; } catch (_) { return null; }
}

function main(argv) {
  const { flags } = common.parseFlags(argv, { 'dry-run': 'bool' });
  let root;
  let cfg;
  try {
    root = mainRoot(process.cwd());
    cfg = loadConfig(root);
  } catch (e) {
    console.error('[cleanup] ' + e.message);
    return 2;
  }
  const f = common.git(root, ['fetch', '--prune', 'origin']);
  if (f.status !== 0) { console.error('[cleanup] fetch failed: ' + f.stderr.trim()); return 2; }
  const items = parseWorktreeList(common.gitOut(root, ['worktree', 'list', '--porcelain']));
  const byBranch = new Map(items.filter((w) => w.branch).map((w) => [w.branch, w]));
  const branches = common.gitOut(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pr/']).split(/\r?\n/).filter(Boolean);
  let removed = 0;
  for (const b of branches) {
    const wt = byBranch.get(b);
    const log = common.git(root, ['log', '--oneline', 'origin/' + cfg.baseBranch + '..' + b]).stdout.trim();
    const dirty = wt ? dirtyFiles(common.git(wt.path, ['status', '--porcelain']).stdout, cfg.linkDependencies).length > 0 : false;
    const d = decideCleanup({ dirty, logEmpty: log === '', prMerged: log === '' ? prMerged(cfg, b) : false });
    console.log((d.remove ? (flags['dry-run'] ? 'would remove ' : 'removing ') : 'keeping ') + b + ' (' + d.reason + ')');
    if (d.remove && !flags['dry-run']) {
      removeWorktree(root, b.slice(3), true);
      removed++;
    }
  }
  console.log('removed ' + removed);
  return 0;
}

module.exports = { decideCleanup };

if (require.main === module) process.exit(main(process.argv.slice(2)));
