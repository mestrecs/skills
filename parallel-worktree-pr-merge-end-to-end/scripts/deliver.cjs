'use strict';
// The whole delivery of one task, from the task's own worktree:
//   node deliver.cjs --dir <worktree> --body <file> [--title "..."] [--max-wait <seconds>]
// Exit codes: 0 done | 1 merged, but a post-merge step failed | 2 usage/config error
//             3 review missing or blocked | 4 gate refused | 5 conflict with base
//             6 tests red | 7 another delivery holds the merge lock
const fs = require('fs');
const path = require('path');
const common = require('./common.cjs');
const { loadConfig, repoRoot, mainRoot } = require('./config.cjs');
const review = require('./review.cjs');

const DOC_RE = /\.(md|mdx|rst|txt)$/i;

// ---------- pure decisions ----------

// PURE. Must the suite run again before merging?
//   - never tested, base moved since the tests, or code (not review files) changed since the tests
function needRetest(s) {
  if (!s.testedHead) return true;
  if (s.testedBase !== s.baseNow) return true;
  if (s.head !== s.testedHead && s.filesSinceTested.some((f) => !review.normPath(f).startsWith('reviews/'))) return true;
  return false;
}

// PURE. The last check before `gh pr merge`. First failing rule wins.
function decideGate(i) {
  if (!i.pushed) return { ok: false, reason: 'the remote branch is not at the local head' };
  if (!i.upToDate) return { ok: false, reason: 'the branch does not contain the latest base' };
  if (!i.testsGreen) return { ok: false, reason: 'tests are not green for this exact code' };
  if (i.reviewRequired && !(i.review && i.review.ok)) return { ok: false, reason: 'review: ' + ((i.review && i.review.reason) || 'missing') };
  return { ok: true, reason: 'all checks passed' };
}

// PURE. Only documentation changed?
function isDocsOnly(files) {
  return files.length > 0 && files.every((f) => {
    const p = review.normPath(f);
    return DOC_RE.test(p) || p.startsWith('docs/');
  });
}

// PURE. Paths that matter in `git status --porcelain` (linked dependencies are not changes).
function dirtyFiles(porcelain, ignore) {
  const out = [];
  for (const line of String(porcelain).split(/\r?\n/).filter(Boolean)) {
    const f = review.normPath(line.slice(3).replace(/^"|"$/g, '').replace(/\/$/, ''));
    if (!ignore.some((i) => f === i || f.startsWith(i + '/'))) out.push(f);
  }
  return out;
}

// PURE. "03:00-05:30" in a time zone; the window may cross midnight.
function inWindow(date, window, timeZone) {
  if (!window) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  const now = h * 60 + m;
  const [a, b] = window.split('-').map((x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5)));
  return a <= b ? now >= a && now <= b : now >= a || now <= b;
}

// Health check with an injectable fetch (tests use a local server or a stub).
async function checkHealth(url, opts) {
  const o = Object.assign({ attempts: 10, delayMs: 3000, fetchFn: globalThis.fetch }, opts || {});
  let last = 'no answer';
  for (let i = 0; i < o.attempts; i++) {
    try {
      const res = await o.fetchFn(url, { signal: AbortSignal.timeout(10000) });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      last = 'HTTP ' + res.status;
    } catch (e) {
      last = e.message;
    }
    if (i < o.attempts - 1) await new Promise((r) => setTimeout(r, o.delayMs));
  }
  return { ok: false, status: last };
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// ---------- I/O ----------

class Stop extends Error {
  constructor(code, message) { super(message); this.exitCode = code; }
}

function say(msg) { console.error('[deliver] ' + msg); }

function sha(dir, ref) { return common.gitOut(dir, ['rev-parse', ref]); }

function isAncestor(dir, a, b) { return common.git(dir, ['merge-base', '--is-ancestor', a, b]).status === 0; }

function changedFiles(dir, from, to) {
  const r = common.git(dir, ['diff', '--name-only', from, to]);
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function remoteHead(dir, branch) {
  const r = common.git(dir, ['ls-remote', 'origin', 'refs/heads/' + branch]);
  return r.status === 0 ? (r.stdout.split(/\s+/)[0] || null) : null;
}

// Merge origin/<base> into the branch. Returns true when it merged cleanly (or was already in).
function syncWithBase(dir, base) {
  const f = common.git(dir, ['fetch', 'origin', base]);
  if (f.status !== 0) throw new Stop(2, 'cannot fetch origin/' + base + ': ' + f.stderr.trim());
  if (isAncestor(dir, 'origin/' + base, 'HEAD')) return true;
  const m = common.git(dir, ['merge', '--no-edit', 'origin/' + base]);
  if (m.status !== 0) {
    common.git(dir, ['merge', '--abort']);
    return false;
  }
  return true;
}

function runTests(dir, cfg) {
  if (!cfg.testCommand) { say('no testCommand configured: skipping the suite'); return true; }
  const r = common.run(process.execPath, [path.join(__dirname, 'test-queue.cjs'), '--', cfg.testCommand], { cwd: dir });
  if (r.status !== 0) {
    say('tests are red (exit ' + r.status + '). Last lines:');
    console.error(common.tail(r.stdout + '\n' + r.stderr, 60));
    return false;
  }
  return true;
}

function pushBranch(dir, branch) {
  const p = common.git(dir, ['push', '-u', 'origin', branch]);
  if (p.status !== 0) throw new Stop(4, 'push refused: ' + common.tail(p.stderr, 15));
}

function ghJson(args) {
  const r = common.gh(args);
  if (r.status !== 0) throw new Stop(4, 'gh ' + args.slice(0, 2).join(' ') + ' failed: ' + common.tail(r.stderr, 10));
  return JSON.parse(r.stdout || 'null');
}

function ensurePr(cfg, branch, title, bodyFile) {
  const find = () => ghJson(['pr', 'list', '--repo', cfg.repo, '--head', branch, '--state', 'open', '--json', 'number,url']);
  let prs = find();
  if (prs.length) {
    const e = common.gh(['pr', 'edit', String(prs[0].number), '--repo', cfg.repo, '--title', title, '--body-file', bodyFile]);
    if (e.status !== 0) say('could not update the PR text: ' + common.tail(e.stderr, 5));
    return prs[0].number;
  }
  const c = common.gh(['pr', 'create', '--repo', cfg.repo, '--base', cfg.baseBranch, '--head', branch, '--title', title, '--body-file', bodyFile]);
  if (c.status !== 0) throw new Stop(4, 'gh pr create failed: ' + common.tail(c.stderr, 10));
  prs = find();
  if (!prs.length) throw new Stop(4, 'PR was created but cannot be found');
  return prs[0].number;
}

function reviewGate(dir, cfg, n) {
  const file = path.join(dir, 'reviews', 'REVIEW-PR' + n + '.md');
  if (!fs.existsSync(file)) return { ok: false, reason: 'no review file yet', missing: true };
  const text = fs.readFileSync(file, 'utf8');
  const rv = review.parseReviewFile(text);
  if (!rv) return { ok: false, reason: 'review file malformed' };
  const head = sha(dir, 'HEAD');
  const desc = isAncestor(dir, rv.head, 'HEAD');
  const since = desc ? changedFiles(dir, rv.head, head) : [];
  let moved = [];
  const mb = common.git(dir, ['merge-base', rv.head, 'origin/' + cfg.baseBranch]);
  if (mb.status === 0) moved = changedFiles(dir, mb.stdout.trim(), 'origin/' + cfg.baseBranch);
  const g = review.gateReviewOk(text, { headIsDescendant: desc, filesSinceReview: since, baseMovedFiles: moved });
  return Object.assign(g, { verdict: rv.verdict, stale: !g.ok && rv.verdict === 'APPROVE' });
}

function acquireMergeLock(cfg, maxWaitMs) {
  const file = path.join(common.parallelHome(), 'merge-' + cfg.repo.replace('/', '__') + '.lock');
  const started = Date.now();
  const poll = Number(process.env.PARALLEL_PR_POLL_MS) || 3000;
  let told = false;
  while (!common.tryCreateLock(file, { repo: cfg.repo }, 30 * 60 * 1000)) {
    if (Date.now() - started > maxWaitMs) throw new Stop(7, 'another delivery holds the merge lock for ' + cfg.repo);
    if (!told) { say('waiting for the merge lock...'); told = true; }
    common.sleepSync(poll);
  }
  return file;
}

async function deploy(cfg, mergedSha) {
  const d = cfg.deploy;
  if (d.mode === 'none') return;
  const needsWindow = d.mode === 'command' || d.mode === 'vps-ssh';
  if (needsWindow && !inWindow(new Date(), d.restartWindow, cfg.timezone)) {
    say('DEPLOY-DEFERRED: outside the restart window ' + d.restartWindow + ' (' + cfg.timezone + '). Run the deploy later.');
    return;
  }
  if (d.mode === 'command') {
    const r = common.run(d.command, [], { shell: true });
    if (r.status !== 0) throw new Error('deploy command failed: ' + common.tail(r.stderr || r.stdout, 15));
  } else if (d.mode === 'vps-ssh') {
    const remote = 'cd ' + shellQuote(d.ssh.path) + ' && ' + d.ssh.update;
    const r = common.run('ssh', ['-o', 'BatchMode=yes', d.ssh.user + '@' + d.ssh.host, remote]);
    if (r.status !== 0) throw new Error('ssh deploy failed: ' + common.tail(r.stderr || r.stdout, 15));
  } else if (d.mode === 'vps-actions') {
    const deadline = Date.now() + 20 * 60 * 1000;
    for (;;) {
      const runs = ghJson(['run', 'list', '--repo', cfg.repo, '--commit', mergedSha, '--json', 'databaseId,status,conclusion', '--limit', '10']);
      if (runs.length && runs.every((x) => x.status === 'completed')) {
        if (runs.some((x) => x.conclusion !== 'success')) throw new Error('a workflow run did not succeed');
        break;
      }
      if (Date.now() > deadline) throw new Error('workflow runs did not finish in 20 minutes');
      common.sleepSync(Number(process.env.PARALLEL_PR_POLL_MS) || 10000);
    }
  }
  // mode "platform": the platform deploys on merge by itself; we only check health below.
  if (d.healthUrl) {
    const h = await checkHealth(d.healthUrl);
    if (!h.ok) throw new Error('health check failed: ' + h.status);
    say('health check ok (' + h.status + ')');
  }
}

async function deliver(argv) {
  let flags;
  try {
    flags = common.parseFlags(argv, { dir: 'string', body: 'string', title: 'string', 'max-wait': 'string' }).flags;
  } catch (e) { throw new Stop(2, e.message); }
  if (!flags.dir || !flags.body) throw new Stop(2, 'usage: deliver.cjs --dir <worktree> --body <file> [--title "..."] [--max-wait <s>]');
  const dir = path.resolve(flags.dir);
  const bodyFile = path.resolve(flags.body);
  if (!fs.existsSync(bodyFile)) throw new Stop(2, 'body file not found: ' + bodyFile);
  let cfg;
  try { cfg = loadConfig(repoRoot(dir)); } catch (e) { throw new Stop(2, e.message); }
  const base = cfg.baseBranch;
  const branch = common.gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD' || branch === base) throw new Stop(2, 'run this from a task branch, not from ' + branch);
  const dirty = dirtyFiles(common.git(dir, ['status', '--porcelain']).stdout, cfg.linkDependencies);
  if (dirty.length) throw new Stop(2, 'uncommitted changes (commit the files you touched, by name): ' + dirty.slice(0, 5).join(', '));

  // 1. up to date with base
  if (!syncWithBase(dir, base)) throw new Stop(5, 'conflict with ' + base + ': resolve it in the worktree and run again');
  let files = changedFiles(dir, 'origin/' + base, 'HEAD');
  if (!files.length) throw new Stop(2, 'nothing to deliver: no difference from ' + base);

  // docs only, straight to base when the owner allows it
  if (cfg.docsDirectToBase && isDocsOnly(files)) {
    const p = common.git(dir, ['push', 'origin', 'HEAD:refs/heads/' + base]);
    if (p.status !== 0) throw new Stop(4, 'direct push to ' + base + ' refused: ' + common.tail(p.stderr, 10));
    say('docs only: pushed straight to ' + base);
    return 0;
  }

  // 2. quick check, tests, push
  if (cfg.quickCheckCommand) {
    const q = common.run(cfg.quickCheckCommand, [], { cwd: dir, shell: true });
    if (q.status !== 0) { console.error(common.tail(q.stdout + q.stderr, 40)); throw new Stop(6, 'quick check failed'); }
  }
  if (!runTests(dir, cfg)) throw new Stop(6, 'tests are red');
  const tested = { head: sha(dir, 'HEAD'), base: sha(dir, 'origin/' + base) };
  pushBranch(dir, branch);

  // 3. pull request
  const title = flags.title || common.gitOut(dir, ['log', '-1', '--format=%s']);
  const n = ensurePr(cfg, branch, title, bodyFile);
  say('PR ' + n);

  // 4. review (outside the merge lock: it is slow)
  const reviewRequired = review.needsReview(cfg.review, files);
  if (reviewRequired) {
    let g = reviewGate(dir, cfg, n);
    if (!g.ok && g.verdict === 'BLOCK' && !g.stale) {
      // a BLOCK on this very code: do not ask again, the author must change something
      throw new Stop(3, 'review blocked this change (see reviews/REVIEW-PR' + n + '.md): ' + g.reason);
    }
    if (!g.ok) {
      say('review required: asking another model');
      const r = common.run(process.execPath, [path.join(__dirname, 'review.cjs'), '--pr', String(n), '--dir', dir]);
      if (r.status !== 0) throw new Stop(3, 'review did not finish (exit ' + r.status + '): ' + common.tail(r.stderr, 8));
      g = reviewGate(dir, cfg, n);
      if (!g.ok) throw new Stop(3, 'review blocked this change: ' + g.reason);
    }
  }

  // 5. merge lock, then re-check everything that may have changed meanwhile
  const lockFile = acquireMergeLock(cfg, Number(flags['max-wait'] || 900) * 1000);
  let merged = null;
  try {
    if (!syncWithBase(dir, base)) throw new Stop(5, 'conflict with ' + base + ' while waiting for the merge lock');
    const state = {
      testedHead: tested.head, testedBase: tested.base, head: sha(dir, 'HEAD'), baseNow: sha(dir, 'origin/' + base),
      filesSinceTested: changedFiles(dir, tested.head, 'HEAD'),
    };
    if (needRetest(state)) {
      say('base or code moved since the tests: running the suite again');
      if (!runTests(dir, cfg)) throw new Stop(6, 'tests are red after syncing');
      tested.head = sha(dir, 'HEAD');
      tested.base = sha(dir, 'origin/' + base);
      pushBranch(dir, branch);
    }
    const head = sha(dir, 'HEAD');
    files = changedFiles(dir, 'origin/' + base, 'HEAD');
    const gate = decideGate({
      pushed: remoteHead(dir, branch) === head,
      upToDate: isAncestor(dir, 'origin/' + base, 'HEAD'),
      testsGreen: !needRetest({ testedHead: tested.head, testedBase: tested.base, head, baseNow: sha(dir, 'origin/' + base), filesSinceTested: changedFiles(dir, tested.head, head) }),
      reviewRequired: review.needsReview(cfg.review, files),
      review: reviewRequired ? reviewGate(dir, cfg, n) : { ok: true },
    });
    if (!gate.ok) throw new Stop(4, 'gate refused: ' + gate.reason);
    const m = common.gh(['pr', 'merge', String(n), '--repo', cfg.repo, '--merge', '--match-head-commit', head]);
    if (m.status !== 0) throw new Stop(4, 'merge refused: ' + common.tail(m.stderr || m.stdout, 10));
    merged = head;
    say('merged PR ' + n + ' at ' + head.slice(0, 8));
  } finally {
    common.releaseLock(lockFile);
  }

  // 6. after the merge: cleanup, deploy, health. The code is already in; failures here exit 1.
  const problems = [];
  try {
    if (branch.startsWith('pr/')) {
      const r = common.run(process.execPath, [path.join(__dirname, 'worktree.cjs'), 'remove', branch.slice(3), '--delete-branch'], { cwd: mainRoot(dir) });
      if (r.status !== 0) problems.push('cleanup: ' + common.tail(r.stderr, 5));
    }
  } catch (e) { problems.push('cleanup: ' + e.message); }
  try { await deploy(cfg, merged); } catch (e) { problems.push(e.message); }
  if (problems.length) {
    for (const p of problems) say('POST-MERGE PROBLEM: ' + p);
    return 1;
  }
  say('done');
  return 0;
}

module.exports = { needRetest, decideGate, isDocsOnly, dirtyFiles, inWindow, checkHealth, shellQuote };

if (require.main === module) {
  deliver(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error('[deliver] ' + e.message);
    process.exit(e.exitCode || 2);
  });
}
