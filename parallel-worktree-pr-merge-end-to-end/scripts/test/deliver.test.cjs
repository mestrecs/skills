'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const h = require('./_helpers.cjs');
const d = require('../deliver.cjs');
const cl = require('../cleanup.cjs');

const DEAD_PID = 2147483646;

// ---------- pure decisions ----------

test('needRetest: base moved or code changed since the tests; review files do not count', () => {
  const same = { testedHead: 'h1', testedBase: 'b1', head: 'h1', baseNow: 'b1', filesSinceTested: [] };
  assert.strictEqual(d.needRetest(same), false);
  assert.strictEqual(d.needRetest(Object.assign({}, same, { testedHead: null })), true, 'never tested');
  assert.strictEqual(d.needRetest(Object.assign({}, same, { baseNow: 'b2' })), true, 'base moved');
  assert.strictEqual(d.needRetest(Object.assign({}, same, { head: 'h2', filesSinceTested: ['src/x.js'] })), true, 'code changed');
  assert.strictEqual(d.needRetest(Object.assign({}, same, { head: 'h2', filesSinceTested: ['reviews/REVIEW-PR1.md'] })), false, 'only the review file');
});

test('decideGate: every rule can refuse', () => {
  const good = { pushed: true, upToDate: true, testsGreen: true, reviewRequired: true, review: { ok: true } };
  assert.strictEqual(d.decideGate(good).ok, true);
  assert.strictEqual(d.decideGate(Object.assign({}, good, { pushed: false })).ok, false);
  assert.strictEqual(d.decideGate(Object.assign({}, good, { upToDate: false })).ok, false);
  assert.strictEqual(d.decideGate(Object.assign({}, good, { testsGreen: false })).ok, false);
  assert.strictEqual(d.decideGate(Object.assign({}, good, { review: { ok: false, reason: 'blocked' } })).ok, false);
  assert.strictEqual(d.decideGate(Object.assign({}, good, { review: null })).ok, false, 'review required but absent');
  assert.strictEqual(d.decideGate(Object.assign({}, good, { reviewRequired: false, review: null })).ok, true, 'review not required');
});

test('isDocsOnly, dirtyFiles, shellQuote', () => {
  assert.strictEqual(d.isDocsOnly(['README.md', 'docs/a.png']), true);
  assert.strictEqual(d.isDocsOnly(['README.md', 'src/a.js']), false);
  assert.strictEqual(d.isDocsOnly([]), false);
  assert.deepStrictEqual(d.dirtyFiles('?? node_modules\n M src/a.js\n', ['node_modules']), ['src/a.js']);
  assert.strictEqual(d.shellQuote("a'b"), "'a'\\''b'");
});

test('inWindow: inside, outside, crossing midnight, time zone', () => {
  const t = (iso) => new Date(iso);
  assert.strictEqual(d.inWindow(t('2030-01-01T04:00:00Z'), '03:00-05:30', 'UTC'), true);
  assert.strictEqual(d.inWindow(t('2030-01-01T06:00:00Z'), '03:00-05:30', 'UTC'), false);
  assert.strictEqual(d.inWindow(t('2030-01-01T23:30:00Z'), '22:00-02:00', 'UTC'), true);
  assert.strictEqual(d.inWindow(t('2030-01-01T12:00:00Z'), '22:00-02:00', 'UTC'), false);
  assert.strictEqual(d.inWindow(t('2030-01-01T06:00:00Z'), '03:00-05:30', 'America/Sao_Paulo'), true, '06:00 UTC is 03:00 there');
  assert.strictEqual(d.inWindow(t('2030-01-01T06:00:00Z'), null, 'UTC'), true);
});

test('checkHealth against a local server', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.statusCode = hits < 2 ? 503 : 200; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/health';
  try {
    const ok = await d.checkHealth(url, { attempts: 3, delayMs: 20 });
    assert.strictEqual(ok.ok, true);
    const bad = await d.checkHealth('http://127.0.0.1:1/none', { attempts: 2, delayMs: 10 });
    assert.strictEqual(bad.ok, false);
  } finally {
    srv.close();
  }
});

test('decideCleanup: a new empty branch is not "merged"', () => {
  assert.strictEqual(cl.decideCleanup({ dirty: false, logEmpty: true, prMerged: true }).remove, true);
  assert.strictEqual(cl.decideCleanup({ dirty: false, logEmpty: true, prMerged: false }).remove, false);
  assert.strictEqual(cl.decideCleanup({ dirty: false, logEmpty: true, prMerged: null }).remove, false);
  assert.strictEqual(cl.decideCleanup({ dirty: false, logEmpty: false, prMerged: true }).remove, false);
  assert.strictEqual(cl.decideCleanup({ dirty: true, logEmpty: true, prMerged: true }).remove, false);
});

// ---------- end to end, with a local bare origin and a fake gh ----------

const mainSha = (w) => h.git(w.origin, ['rev-parse', 'refs/heads/main']);
const runs = (w) => {
  const f = path.join(w.home, 'queue.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'ran').length : 0;
};

test('e2e: ordinary change is tested, merged with match-head-commit, worktree cleaned', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'happy');
  const head = h.git(dir, ['rev-parse', 'HEAD']);
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.originFiles(w).includes('feature.txt'), 'change reached the base branch');
  assert.strictEqual(mainSha(w), head);
  const st = h.ghState(w);
  assert.ok(st.calls.some((c) => c === 'MATCH ' + head + ' HAVE ' + head), 'merge used --match-head-commit with the tested head');
  assert.ok(!fs.existsSync(dir), 'worktree removed');
  assert.strictEqual(h.git(w.repo, ['branch', '--list', 'pr/happy']), '', 'local branch deleted');
  assert.strictEqual(runs(w), 1, 'suite ran once');
  assert.ok(fs.existsSync(path.join(w.repo, 'node_modules', 'dep.txt')), 'main checkout dependencies intact');
});

test('e2e: red tests stop everything (exit 6), nothing merged', () => {
  const w = h.makeWorld();
  const before = mainSha(w);
  const dir = h.newTask(w, 'red', { FAIL: 'x\n', 'feature.txt': 'y\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 6, r.stderr);
  assert.strictEqual(mainSha(w), before);
  assert.strictEqual(h.ghState(w).prs.length, 0, 'no PR for red code');
});

test('e2e: conflict with base (exit 5)', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'conf', { 'a.txt': 'mine\n' });
  // someone else changes the same line on base
  const other = path.join(w.tmp, 'other');
  h.git(w.tmp, ['clone', w.origin, other]);
  fs.writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
  h.git(other, ['commit', '-am', 'other change']);
  h.git(other, ['push', 'origin', 'HEAD:main']);
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 5, r.stderr);
  assert.strictEqual(h.git(dir, ['status', '--porcelain']).replace(/\?\? node_modules/, '').trim(), '', 'merge aborted, worktree left clean');
});

test('e2e: critical path and no review engine at all (exit 3)', () => {
  const w = h.makeWorld();
  process.env.PARALLEL_PR_BIN_CLAUDE = w.missing;
  const before = mainSha(w);
  const dir = h.newTask(w, 'crit-none', { 'secure/key.js': 'x\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 3, r.stderr);
  assert.strictEqual(mainSha(w), before);
});

test('e2e: critical path, reviewer approves: review file travels with the merge', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'crit-ok', { 'secure/key.js': 'x\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.originFiles(w).includes('secure/key.js'));
  assert.ok(h.originFiles(w).includes('reviews/REVIEW-PR1.md'), 'review record merged');
  const rec = h.git(w.origin, ['show', 'main:reviews/REVIEW-PR1.md']).split('\n');
  assert.strictEqual(rec[0], 'VERDICT: APPROVE');
  assert.match(rec[1], /^REVIEWED-HEAD: [0-9a-f]{40}$/);
  assert.strictEqual(runs(w), 1, 'a review file does not trigger a second suite run');
});

test('e2e: critical path, reviewer blocks (exit 3), nothing merged', () => {
  const w = h.makeWorld();
  process.env.FAKE_ENGINE_VERDICT = 'BLOCK';
  const before = mainSha(w);
  const dir = h.newTask(w, 'crit-block', { 'secure/key.js': 'x\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 3, r.stderr);
  assert.strictEqual(mainSha(w), before);
  assert.ok(fs.existsSync(dir), 'worktree kept so the author can fix');
  // delivering again without changing anything must not ask the reviewer again
  const calls = h.ghState(w).calls.length;
  const again = h.deliver(w, dir);
  assert.strictEqual(again.status, 3);
  assert.match(again.stderr, /blocked/);
  assert.ok(h.ghState(w).calls.length >= calls);
});

test('e2e: reviewer without a verdict is skipped, next engine is used', () => {
  const w = h.makeWorld({ review: { requiredFor: 'critical', criticalPaths: ['secure/**'], engines: ['codex', 'claude'], maxParallel: 2 } });
  process.env.PARALLEL_PR_BIN_CODEX = w.engine; // available, but answers without a verdict
  process.env.FAKE_ENGINE_VERDICT = 'NONE';
  const dir = h.newTask(w, 'crit-noverdict', { 'secure/key.js': 'x\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /no usable verdict/);
});

test('e2e: reviewer fix commit means the suite runs again before merge', () => {
  const w = h.makeWorld();
  process.env.FAKE_ENGINE_FIX = '1';
  const dir = h.newTask(w, 'crit-fix', { 'secure/key.js': 'x\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.originFiles(w).includes('reviewer-fix.txt'), 'the fix was merged');
  assert.strictEqual(runs(w), 2, 'tests ran again after the reviewer changed code');
});

test('e2e: merge lock held by a live delivery (exit 7); a dead owner is taken over', () => {
  const w = h.makeWorld();
  const lock = path.join(w.home, 'merge-acme__widgets.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const dir = h.newTask(w, 'locked');
  const before = mainSha(w);
  const busy = h.deliver(w, dir);
  assert.strictEqual(busy.status, 7, busy.stderr);
  assert.strictEqual(mainSha(w), before);
  fs.writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }));
  const free = h.deliver(w, dir);
  assert.strictEqual(free.status, 0, free.stderr);
  assert.ok(!fs.existsSync(lock), 'lock released after merging');
});

test('e2e: docs only goes straight to base when configured, without a PR', () => {
  const w = h.makeWorld({ docsDirectToBase: true });
  const dir = h.newTask(w, 'docs', { 'docs/guide.md': '# hi\n' });
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(h.originFiles(w).includes('docs/guide.md'));
  assert.strictEqual(h.ghState(w).prs.length, 0);
});

test('e2e: uncommitted work is refused (exit 2)', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'dirty');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  assert.strictEqual(h.deliver(w, dir).status, 2);
});

test('e2e: post-merge command failure after a real merge is exit 1', () => {
  const w = h.makeWorld({ deploy: { mode: 'command', command: 'node -e "process.exit(9)"' } });
  const dir = h.newTask(w, 'deploy-fails');
  const r = h.deliver(w, dir);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(h.originFiles(w).includes('feature.txt'), 'it was merged');
});

test('e2e: cleanup removes only merged branches', () => {
  const w = h.makeWorld();
  const merged = h.newTask(w, 'clean-merged', { 'm.txt': '1\n' });
  // simulate a merge done on the hosting side: base now contains the branch, the PR is "merged"
  h.git(merged, ['push', '-u', 'origin', 'pr/clean-merged']);
  h.git(w.origin, ['update-ref', 'refs/heads/main', h.git(merged, ['rev-parse', 'HEAD'])]);
  fs.writeFileSync(w.state, JSON.stringify({ prs: [{ number: 1, head: 'pr/clean-merged', state: 'merged' }], calls: [] }));
  const open = h.newTask(w, 'clean-open', { 'open.txt': '1\n' });
  const fresh = h.node('worktree.cjs', ['new', 'clean-fresh'], w.repo).stdout.trim();
  const r = h.node('cleanup.cjs', [], w.repo);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(merged), 'merged work removed');
  assert.ok(fs.existsSync(path.join(w.repo, 'node_modules', 'dep.txt')), 'dependencies of the main checkout intact');
  assert.ok(fs.existsSync(open), 'unmerged work kept');
  assert.ok(fs.existsSync(fresh), 'a brand-new empty branch is not mistaken for merged');
});
