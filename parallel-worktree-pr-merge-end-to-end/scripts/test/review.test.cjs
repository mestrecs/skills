'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('../review.cjs');

test('globToRegExp: ** crosses folders, * does not', () => {
  assert.ok(r.globToRegExp('src/auth/**').test('src/auth/login.js'));
  assert.ok(r.globToRegExp('src/auth/**').test('src/auth/deep/er/x.js'));
  assert.ok(!r.globToRegExp('src/auth/**').test('src/author/x.js'));
  assert.ok(r.globToRegExp('migrations/*.sql').test('migrations/001.sql'));
  assert.ok(!r.globToRegExp('migrations/*.sql').test('migrations/old/001.sql'));
  assert.ok(r.globToRegExp('**/secrets.json').test('a/b/secrets.json'));
  assert.ok(r.globToRegExp('**/secrets.json').test('secrets.json'));
  assert.ok(!r.globToRegExp('a.b').test('axb'));
});

test('needsReview: never / always / critical', () => {
  const crit = { requiredFor: 'critical', criticalPaths: ['migrations/**', 'src/auth/**'] };
  assert.strictEqual(r.needsReview(crit, ['src/ui/button.js']), false);
  assert.strictEqual(r.needsReview(crit, ['src/ui/button.js', 'migrations/002.sql']), true);
  assert.strictEqual(r.needsReview(crit, ['src\\auth\\login.js']), true, 'Windows separators');
  assert.strictEqual(r.needsReview({ requiredFor: 'always', criticalPaths: [] }, ['x.js']), true);
  assert.strictEqual(r.needsReview({ requiredFor: 'never', criticalPaths: ['**'] }, ['x.js']), false);
  assert.strictEqual(r.needsReview({ requiredFor: 'always', criticalPaths: [] }, []), false);
  assert.strictEqual(r.needsReview({ requiredFor: 'critical', criticalPaths: [] }, ['x.js']), false);
});

test('pickEngine: order, availability, quota, unreadable quota means one at a time', () => {
  const cfg = {
    engines: ['codex', 'gemini', 'claude'],
    codex: { maxWindowPct: 90, maxWeekPct: 80 }, gemini: { maxWindowPct: 90, maxWeekPct: 80, sharedAccount: true }, claude: {},
  };
  const all = { codex: true, gemini: true, claude: true };
  assert.deepStrictEqual(r.pickEngine(cfg, all, { codex: { windowPct: 10, weekPct: 10 } }), { engine: 'codex', solo: false });
  assert.deepStrictEqual(r.pickEngine(cfg, all, {}), { engine: 'codex', solo: true });
  assert.deepStrictEqual(r.pickEngine(cfg, all, { codex: { windowPct: 95, weekPct: 10 }, gemini: { windowPct: 1, weekPct: 1 } }), { engine: 'gemini', solo: true });
  assert.deepStrictEqual(r.pickEngine(cfg, all, { codex: { windowPct: 10, weekPct: 85 }, gemini: { windowPct: 99, weekPct: 1 } }), { engine: 'claude', solo: false });
  assert.deepStrictEqual(r.pickEngine(cfg, { codex: false, gemini: false, claude: true }, {}), { engine: 'claude', solo: false });
  assert.strictEqual(r.pickEngine(cfg, { codex: false, gemini: false, claude: false }, {}), null);
  assert.strictEqual(r.pickEngine(cfg, all, {}, ['codex', 'gemini', 'claude']), null);
});

test('parseVerdict: last word wins unless a BLOCK is present', () => {
  assert.strictEqual(r.parseVerdict('ok\nVERDICT: APPROVE\n'), 'APPROVE');
  assert.strictEqual(r.parseVerdict('VERDICT: BLOCK\n'), 'BLOCK');
  assert.strictEqual(r.parseVerdict('VERDICT: APPROVE\nbut wait\nVERDICT: BLOCK'), 'BLOCK');
  assert.strictEqual(r.parseVerdict('**VERDICT: APPROVE**'), 'APPROVE');
  assert.strictEqual(r.parseVerdict('I approve this'), null);
  assert.strictEqual(r.parseVerdict('the verdict: approve is mid-sentence VERDICT: APPROVE yes'), null);
});

test('review file round trip', () => {
  const t = r.formatReviewFile('APPROVE', 'abcdef1234567', 'text\nVERDICT: APPROVE\nmore');
  assert.strictEqual(t.split('\n')[0], 'VERDICT: APPROVE');
  assert.strictEqual(t.split('\n')[1], 'REVIEWED-HEAD: abcdef1234567');
  assert.deepStrictEqual(r.parseReviewFile(t), { verdict: 'APPROVE', head: 'abcdef1234567' });
  assert.strictEqual(r.parseReviewFile('hello'), null);
  assert.strictEqual(r.parseReviewFile('VERDICT: MAYBE\nREVIEWED-HEAD: abcdef1'), null);
});

test('gateReviewOk: approved review only opens the gate for the code it saw', () => {
  const file = 'VERDICT: APPROVE\nREVIEWED-HEAD: abcdef1\n\nfine\n';
  const ok = { headIsDescendant: true, filesSinceReview: [], baseMovedFiles: [] };
  assert.strictEqual(r.gateReviewOk(file, ok).ok, true);
  assert.strictEqual(r.gateReviewOk(file, Object.assign({}, ok, { filesSinceReview: ['reviews/REVIEW-PR3.md'] })).ok, true, 'the review file itself does not count');
  assert.strictEqual(r.gateReviewOk(file, Object.assign({}, ok, { filesSinceReview: ['src/a.js'] })).ok, false, 'code changed after review');
  assert.strictEqual(r.gateReviewOk(file, Object.assign({}, ok, { filesSinceReview: ['src/a.js'], baseMovedFiles: ['src/a.js'] })).ok, true, 'came from the base branch, not from us');
  assert.strictEqual(r.gateReviewOk(file, Object.assign({}, ok, { headIsDescendant: false })).ok, false);
  assert.strictEqual(r.gateReviewOk('VERDICT: BLOCK\nREVIEWED-HEAD: abcdef1\n', ok).ok, false);
  assert.strictEqual(r.gateReviewOk('garbage', ok).ok, false);
});

test('extractSymbols and buildPrompt', () => {
  const diff = '+function chargeCard(x) {\n+const refund = async (y) => {}\n+  def apply_discount(self):\n-function removed() {}\n+let a = 1\n';
  assert.deepStrictEqual(r.extractSymbols(diff).sort(), ['apply_discount', 'chargeCard', 'refund']);
  const p = r.buildPrompt({ number: 7, title: 'T', body: 'B', diff: 'D'.repeat(300000), callers: '' });
  assert.match(p, /VERDICT: APPROVE/);
  assert.match(p, /diff truncated/);
  assert.match(p, /did not write/);
});

test('engineCommand: prompt goes through stdin, no shell-sensitive values', () => {
  assert.deepStrictEqual(r.engineCommand('claude', { model: 'sonnet' }).args, ['-p', '--model', 'sonnet']);
  assert.deepStrictEqual(r.engineCommand('claude', { model: '<latest>' }).args, ['-p']);
  const cx = r.engineCommand('codex', { model: 'm1', effort: 'medium' }).args;
  assert.strictEqual(cx[0], 'exec');
  assert.strictEqual(cx[cx.length - 1], '-');
  assert.ok(cx.includes('workspace-write'));
  assert.ok(r.engineCommand('gemini', { model: 'g1' }).args.includes('-p'));
  assert.throws(() => r.engineCommand('skynet', {}));
});
