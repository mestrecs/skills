'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const r = require('../review.cjs');
const sw = require('../engine-switch.cjs');
const cfgMod = require('../config.cjs');

const REVIEW_SCRIPT = path.resolve(__dirname, '..', 'review.cjs');
const SID = '11111111-2222-3333-4444-555555555555';

function git(cwd, args) {
  const res = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + res.stderr);
  return res.stdout.trim();
}

function makeTempRepoWithBranch(tmp) {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'user.email', 'tester@users.noreply.github.com']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'function greet(name) { return "hi " + name; }\nmodule.exports = { greet };\n');
  git(repo, ['add', 'app.js']);
  git(repo, ['commit', '-m', 'init']);
  git(repo, ['checkout', '-b', 'feat/billing']);
  fs.writeFileSync(path.join(repo, 'billing.js'), 'function chargeTotal(a, b) { return a + b; }\nmodule.exports = { chargeTotal };\n');
  git(repo, ['add', 'billing.js']);
  git(repo, ['commit', '-m', 'add billing']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  return { repo, head };
}

test('parseArgs validates flags and rejects missing target or bad values', () => {
  assert.deepStrictEqual(r.parseArgs(['--pr', '42', '--dir', '/tmp/wt']).pr, '42');
  assert.strictEqual(r.parseArgs(['--base', 'origin/main', '--no-commit']).noCommit, true);
  assert.throws(() => r.parseArgs([]), /--pr <n> or --base <ref>/);
  assert.throws(() => r.parseArgs(['--pr', 'abc']), /positive integer/);
  assert.throws(() => r.parseArgs(['--base', 'main', '--engine', 'skynet']), /--engine/);
  assert.throws(() => r.parseArgs(['--base', 'main', '--cli', 'other']), /--cli/);
  assert.throws(() => r.parseArgs(['--base', 'main', '--max-wait', '-1']), /--max-wait/);
  assert.throws(() => r.parseArgs(['--base', 'main', '--unknown']), /unknown argument/);
  assert.throws(() => r.parseArgs(['--pr', '42', '--separated', '  ']), /--separated requires/);
  assert.throws(() => r.parseArgs(['--pr', '42', '--separated', '--no-commit']), /--separated requires/);
  assert.equal(r.parseArgs(['--pr', '42', '--separated', ' removed\n  scheduler ']).separated, 'removed scheduler');
});

test('review covers all failure cases, then uses the fix diff and counts distinct BLOCKs in history', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-review-rounds-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const { repo, head } = makeTempRepoWithBranch(tmp);
  const home = path.join(tmp, 'home');
  const capture = path.join(tmp, 'prompt.txt');
  const engine = path.join(tmp, 'reviewer.cjs');
  fs.writeFileSync(engine, `
const fs = require('fs');
if (process.argv.includes('--version')) process.exit(0);
fs.writeFileSync(process.env.FAKE_PROMPT, fs.readFileSync(0));
console.log(JSON.stringify({result: 'F1 P1 billing.js:1 duplicate charge on retry\\nVERDICT: ' + process.env.FAKE_VERDICT}));
`);
  const run = (verdict, extra = []) => cp.spawnSync(process.execPath,
    [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--engine', 'claude', ...extra], {
      encoding: 'utf8', env: { ...process.env, ENGINE_SWITCH_HOME: home, ENGINE_SWITCH_BIN_CLAUDE: engine,
        FAKE_PROMPT: capture, FAKE_VERDICT: verdict },
    });
  const first = run('BLOCK');
  assert.equal(first.status, 0, first.stderr);
  const firstPrompt = fs.readFileSync(capture, 'utf8');
  assert.match(firstPrompt, /Duplicate effects[\s\S]+Interruption[\s\S]+concurrently[\s\S]+another tenant[\s\S]+Optional or scheduled/);
  assert.match(firstPrompt, /all findings together with stable IDs/);

  const report = path.join(repo, r.reviewFilePath({ branch: 'feat/billing' }));
  fs.appendFileSync(report, '\nClarification for the same reviewed head.\n');
  git(repo, ['commit', '-am', 'clarify first report']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'const fixed = true;\n');
  git(repo, ['commit', '-am', 'repair']);
  const second = run('BLOCK');
  assert.equal(second.status, 0, second.stderr);
  const secondPrompt = fs.readFileSync(capture, 'utf8');
  assert.match(secondPrompt, new RegExp(head + '\\.\\.[0-9a-f]+'));
  assert.match(secondPrompt, /RESOLVED, PARTIAL, or OPEN/);
  assert.match(secondPrompt, /P0\/P1 and reproduced/);
  assert.match(secondPrompt, /P2-NEW/);
  assert.match(secondPrompt, /F1 P1 billing.js:1 duplicate charge on retry/);
  assert.match(secondPrompt, /\+const fixed = true/);
  assert.doesNotMatch(secondPrompt, /diff --git a\/(?:billing.js|reviews\/)/);

  fs.writeFileSync(path.join(repo, 'app.js'), 'const optional = false;\n');
  git(repo, ['commit', '-am', 'disable optional path']);
  const third = run('APPROVE');
  assert.equal(third.status, 6, third.stderr);
  assert.match(third.stderr, /--separated/);
  assert.equal(fs.readFileSync(capture, 'utf8'), secondPrompt);
  const separated = run('APPROVE', ['--separated', 'disabled optional path']);
  assert.equal(separated.status, 0, separated.stderr);
  assert.match(fs.readFileSync(capture, 'utf8'), /Verify in the diff[\s\S]+disabled optional path/);
});

test('buildEngineChain orders preferred first, claude goes straight to claude, respects override', () => {
  const enabled = ['codex', 'gemini', 'claude'];
  const order = ['codex', 'gemini', 'claude'];
  assert.deepStrictEqual(r.buildEngineChain('codex', order, enabled, null), ['codex', 'gemini', 'claude']);
  assert.deepStrictEqual(r.buildEngineChain('gemini', order, enabled, null), ['gemini', 'codex', 'claude']);
  assert.deepStrictEqual(r.buildEngineChain('claude', order, enabled, null), ['claude']);
  assert.deepStrictEqual(r.buildEngineChain('codex', order, ['codex', 'claude'], null), ['codex', 'claude']);
  assert.deepStrictEqual(r.buildEngineChain('codex', order, enabled, 'gemini'), ['gemini']);
});

test('shouldFallbackReason: only missing, logged-out, ceiling; never timeout or non-quota error', () => {
  assert.strictEqual(r.shouldFallbackReason('missing'), true);
  assert.strictEqual(r.shouldFallbackReason('logged-out'), true);
  assert.strictEqual(r.shouldFallbackReason('ceiling'), true);
  assert.strictEqual(r.shouldFallbackReason('timeout'), false);
  assert.strictEqual(r.shouldFallbackReason('error'), false);
  assert.strictEqual(r.shouldFallbackReason('bad-verdict'), false);
});

test('parseVerdict, formatReviewFile, parseReviewFile, reviewFilePath', () => {
  assert.strictEqual(r.parseVerdict('findings\nVERDICT: APPROVE\n'), 'APPROVE');
  assert.strictEqual(r.parseVerdict('VERDICT: APPROVE\nwait\nVERDICT: BLOCK\n'), 'BLOCK');
  assert.strictEqual(r.parseVerdict('**VERDICT: BLOCK**'), 'BLOCK');
  assert.strictEqual(r.parseVerdict('no verdict'), null);

  const formatted = r.formatReviewFile('APPROVE', '0123456789abcdef0123456789abcdef01234567', 'All good\nVERDICT: APPROVE\n');
  assert.strictEqual(formatted.split('\n')[0], 'VERDICT: APPROVE');
  assert.strictEqual(formatted.split('\n')[1], 'REVIEWED-HEAD: 0123456789abcdef0123456789abcdef01234567');
  assert.deepStrictEqual(r.parseReviewFile(formatted), {
    verdict: 'APPROVE',
    head: '0123456789abcdef0123456789abcdef01234567',
  });

  assert.strictEqual(r.reviewFilePath({ pr: '42' }), 'reviews/REVIEW-PR42.md');
  assert.strictEqual(r.reviewFilePath({ branch: 'feat/auth' }), 'reviews/REVIEW-feat-auth.md');
});

test('validateReviewerChanges, hasSecretPattern, and stripSecretEnv', () => {
  const safe = r.validateReviewerChanges(' M src/a.js\0?? src/b.test.js\0?? reviews/REVIEW-PR5.md\0', 'reviews/REVIEW-PR5.md');
  assert.deepStrictEqual(safe, { ok: true, files: ['src/a.js', 'src/b.test.js'] });

  assert.strictEqual(r.validateReviewerChanges(' M .github/workflows/test.yml\0', 'reviews/REVIEW-PR5.md').ok, false);
  assert.strictEqual(r.validateReviewerChanges(' M .claude/settings.json\0', 'reviews/REVIEW-PR5.md').ok, false);
  assert.strictEqual(r.validateReviewerChanges(' D src/old.js\0', 'reviews/REVIEW-PR5.md').ok, false);

  assert.strictEqual(r.hasSecretPattern('const k = "sk-1234567890abcdefghij1234";', []), true);
  assert.strictEqual(r.hasSecretPattern('val=my-super-secret-value-99', ['my-super-secret-value-99']), true);
  assert.strictEqual(r.hasSecretPattern('const x = 42;', ['my-super-secret-value-99']), false);

  const stripped = r.stripSecretEnv({ PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_xxx', GEMINI_API_KEY: 'abc', GIT_DIR: '.git' }, ['GEMINI_API_KEY']);
  assert.strictEqual(stripped.PATH, '/usr/bin');
  assert.strictEqual(stripped.GEMINI_API_KEY, 'abc');
  assert.strictEqual(stripped.GITHUB_TOKEN, undefined);
  assert.strictEqual(stripped.GIT_DIR, undefined);
});

test('buildReviewCommand builds expected CLI args for codex, gemini, agy, and claude', () => {
  const cfg = cfgMod.mergeDeep(cfgMod.DEFAULTS, {
    codex: { model: 'codex-test' }, gemini: { model: 'Gemini Test' },
  });
  const cx = r.buildReviewCommand('codex', cfg, {
    dir: '/tmp/wt',
    answerFile: '/tmp/ans.txt',
    isRepo: true,
    gitCommonDir: '/tmp/repo/.git',
  });
  assert.strictEqual(cx.bin, 'codex');
  assert.ok(cx.args.includes('workspace-write'));
  assert.ok(cx.args.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(cx.args[cx.args.indexOf('--add-dir') + 1], '/tmp/repo/.git');
  assert.ok(cx.args.includes('codex-test'));

  const gm = r.buildReviewCommand('gemini', cfg, { cli: 'gemini' });
  assert.strictEqual(gm.bin, 'gemini');
  assert.ok(gm.args.includes('--sandbox'));
  assert.ok(gm.args.includes('Gemini Test'));

  const agy = r.buildReviewCommand('gemini', cfg, {
    cli: 'agy',
    dirPosix: '/tmp/wt',
    requestPosix: '/tmp/req.md',
    permissionsPosix: '/tmp/perms.json',
    tempDirPosix: '/tmp/es',
    timeoutSec: 900,
  });
  assert.strictEqual(agy.bin, 'agy');
  assert.ok(!agy.args.includes('--settings'));
  assert.equal(agy.args[agy.args.indexOf('--add-dir') + 1], '/tmp/es');
  assert.ok(agy.args.includes('--sandbox'));

  const cl = r.buildReviewCommand('claude', cfg, {});
  assert.strictEqual(cl.bin, 'claude');
  assert.deepStrictEqual(cl.args, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--model', 'sonnet', '--effort', 'medium']);
});

test('PR review with fake codex commits reviewer fix and writes reviews/REVIEW-PR<n>.md for new head', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-pr-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { repo, head } = makeTempRepoWithBranch(tmp);

  const fakeGh = path.join(tmp, 'fake-gh.cjs');
  fs.writeFileSync(fakeGh, `'use strict';
console.log(JSON.stringify({
  headRefOid: ${JSON.stringify(head)},
  headRefName: "feat/billing",
  baseRefName: "main",
  title: "Add billing",
  body: "Author says everything works"
}));
`);

  const fakeCodex = path.join(tmp, 'fake-codex.cjs');
  fs.writeFileSync(fakeCodex, `'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('codex 1.2.0'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
if (!prompt.includes('Do NOT trust the PR title')) process.exit(9);
const dir = a[a.indexOf('-C') + 1];
const out = a[a.indexOf('-o') + 1];
fs.writeFileSync(path.join(dir, 'billing.js'), 'function chargeTotal(a, b) { return Number(a) + Number(b); }\\nmodule.exports = { chargeTotal };\\n');
fs.writeFileSync(out, 'Fixed non-numeric coercion in billing.js.\\nVERDICT: APPROVE\\n');
`);

  const env = Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_GH: fakeGh,
    ENGINE_SWITCH_BIN_CODEX: fakeCodex,
  });

  try {
    const res = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--pr', '17', '--dir', repo], { env, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr + '\n' + res.stdout);
    const reviewFile = path.join(repo, 'reviews', 'REVIEW-PR17.md');
    assert.ok(fs.existsSync(reviewFile));
    const parsed = r.parseReviewFile(fs.readFileSync(reviewFile, 'utf8'));
    assert.strictEqual(parsed.verdict, 'APPROVE');
    // Fix commit sits between original PR head and review commit
    assert.notStrictEqual(parsed.head, head);
    const parentOfReviewCommit = git(repo, ['rev-parse', 'HEAD~1']);
    assert.strictEqual(parsed.head, parentOfReviewCommit);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fallback chain: codex at quota ceiling -> gemini logged out -> claude -p sonnet medium succeeds and writes ceiling marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-fb-'));
  const home = path.join(tmp, 'home');
  const userHome = path.join(tmp, 'userhome');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  const { repo } = makeTempRepoWithBranch(tmp);

  fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 95, weekPct: 20, at: Date.now() }));

  const fakeOkVer = (name) => {
    const p = path.join(tmp, 'bin-' + name + '.cjs');
    fs.writeFileSync(p, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('${name} 2.0.0'); process.exit(0); }
const prompt = fs.readFileSync(0, 'utf8');
if ('${name}' === 'gemini') {
  console.log(JSON.stringify({ error: { message: 'Authentication required' } }));
  process.exit(1);
}
console.log(JSON.stringify({ result: 'ARGS=' + JSON.stringify(a) + '\\nVERDICT: BLOCK' }));
`);
    return p;
  };

  const fakeCodex = fakeOkVer('codex');
  const fakeGemini = fakeOkVer('gemini');
  const fakeClaude = fakeOkVer('claude');

  sw.updateChatKey(SID, 'reviewer', 'codex', 'default', home, cfgMod.DEFAULTS);

  const env = Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_USER_HOME: userHome,
    ENGINE_SWITCH_BIN_CODEX: fakeCodex,
    ENGINE_SWITCH_BIN_GEMINI: fakeGemini,
    ENGINE_SWITCH_BIN_CLAUDE: fakeClaude,
  });

  try {
    const res = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--chat', SID], { env, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr + '\n' + res.stdout);
    assert.match(res.stdout, /VERDICT: BLOCK \| ENGINE: claude/);
    assert.ok(fs.existsSync(path.join(home, 'ceilings', 'codex.json')));
    const revContent = fs.readFileSync(path.join(repo, 'reviews', 'REVIEW-feat-billing.md'), 'utf8');
    assert.match(revContent, /--model","sonnet","--effort","medium"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('never falls back when codex times out (exits 1), and exits 3 when all engines are missing/at ceiling', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-no-fb-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { repo } = makeTempRepoWithBranch(tmp);

  const slowCodex = path.join(tmp, 'slow-codex.cjs');
  fs.writeFileSync(slowCodex, `'use strict';
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
setTimeout(() => {}, 10000);
`);
  const okClaude = path.join(tmp, 'ok-claude.cjs');
  fs.writeFileSync(okClaude, `'use strict';
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
console.log(JSON.stringify({ result: 'VERDICT: APPROVE' }));
`);
  const missing = path.join(tmp, 'does-not-exist.cjs');

  const env = (extra) => Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_CODEX: slowCodex,
    ENGINE_SWITCH_BIN_GEMINI: okClaude,
    ENGINE_SWITCH_BIN_CLAUDE: okClaude,
    ENGINE_SWITCH_TIMEOUT_MS: '250',
  }, extra || {});

  try {
    // 1. Timeout on codex -> must exit 1 and NOT fall back to gemini/claude
    const slowRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo], { env: env(), encoding: 'utf8' });
    assert.strictEqual(slowRes.status, 1);
    assert.match(slowRes.stderr, /timeout/i);

    // 2. All engines missing/at ceiling -> exit 3
    fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 99, weekPct: 10, at: Date.now() }));
    const noneRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo], {
      env: env({
        ENGINE_SWITCH_BIN_GEMINI: missing,
        ENGINE_SWITCH_BIN_CLAUDE: missing,
      }),
      encoding: 'utf8',
    });
    assert.strictEqual(noneRes.status, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('watchdog mid-run ceiling kill triggers fallback to gemini, and concurrency limit of 3 blocks 4th review', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-wd-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { repo } = makeTempRepoWithBranch(tmp);

  const sleepCodex = path.join(tmp, 'sleep-codex.cjs');
  fs.writeFileSync(sleepCodex, `'use strict';
if (process.argv.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
require('fs').writeFileSync(require('path').join(process.env.ENGINE_SWITCH_HOME, 'quota-codex.json'),
  JSON.stringify({ windowPct: 95, weekPct: 20, at: Date.now() }));
setTimeout(() => {}, 20000);
`);
  const okGemini = path.join(tmp, 'ok-gemini.cjs');
  fs.writeFileSync(okGemini, `'use strict';
if (process.argv.includes('--version')) { console.log('gemini 1.0.0'); process.exit(0); }
console.log(JSON.stringify({ response: 'Gemini checked the diff.\\nVERDICT: APPROVE' }));
`);

  fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 30, weekPct: 20, at: Date.now() }));
  const env = Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_CODEX: sleepCodex,
    ENGINE_SWITCH_BIN_GEMINI: okGemini,
    ENGINE_SWITCH_WATCHDOG_MS: '150',
  });

  try {
    // Mid-run watchdog kill -> fallback to gemini -> exit 0
    const child = cp.spawn(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.strictEqual(code, 0);
    assert.match(stdout, /ENGINE: gemini/);
    assert.match(JSON.parse(fs.readFileSync(path.join(home, 'ceilings', 'codex.json'), 'utf8')).reason, /^MID-RUN CEILING/);

    // Concurrency limit of 3 per engine: occupy all 3 slots, 4th with --max-wait 0 fails
    const slotsDir = path.join(home, 'review-slots', 'gemini');
    const acquired = [];
    for (let i = 0; i < 3; i++) {
      const s = r.tryAcquireSlot(slotsDir, 3, { pr: String(i) }, 60000);
      assert.ok(s);
      acquired.push(s);
    }
    assert.strictEqual(r.tryAcquireSlot(slotsDir, 3, { pr: '4' }, 60000), null);
    const busyRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--engine', 'gemini', '--max-wait', '0', '--no-commit'], { env, encoding: 'utf8' });
    assert.strictEqual(busyRes.status, 1);
    assert.match(busyRes.stderr, /max 3 concurrent/);
    for (const s of acquired) r.releaseLock(s);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('secret leak in reviewer fix is rejected before commit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-sec-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { repo } = makeTempRepoWithBranch(tmp);

  const leakyCodex = path.join(tmp, 'leaky-codex.cjs');
  fs.writeFileSync(leakyCodex, `'use strict';
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
const dir = a[a.indexOf('-C') + 1];
const out = a[a.indexOf('-o') + 1];
fs.writeFileSync(path.join(dir, 'billing.js'), 'const token = "sk-1234567890abcdefghijklmnop";\\n');
fs.writeFileSync(out, 'VERDICT: APPROVE\\n');
`);

  const env = Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_CODEX: leakyCodex,
  });

  try {
    const res = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--engine', 'codex'], { env, encoding: 'utf8' });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /secret pattern detected/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy CLI request file, claude chat key direct routing, and bad-verdict does not fall back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-agy-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const { repo } = makeTempRepoWithBranch(tmp);

  const fakeAgy = path.join(tmp, 'fake-agy.cjs');
  fs.writeFileSync(fakeAgy, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('agy 1.0.0'); process.exit(0); }
const request = fs.readFileSync(require('path').join(a[a.indexOf('--add-dir') + 1], 'request.md'), 'utf8');
if (!a.includes('--sandbox') || a.includes('--settings') || !request.includes('independent reviewer')) process.exit(9);
console.log(JSON.stringify({ response: 'Checked the request.\\nVERDICT: APPROVE' }));
`);

  const badCodex = path.join(tmp, 'bad-codex.cjs');
  fs.writeFileSync(badCodex, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('codex 1.0.0'); process.exit(0); }
const out = a[a.indexOf('-o') + 1];
fs.writeFileSync(out, 'Looks okay I guess, forgot verdict line.');
`);

  const okClaude = path.join(tmp, 'ok-claude.cjs');
  fs.writeFileSync(okClaude, `'use strict';
if (process.argv.includes('--version')) { console.log('claude 1.0.0'); process.exit(0); }
console.log(JSON.stringify({ result: 'Fresh claude session.\\nVERDICT: APPROVE' }));
`);

  const env = (extra) => Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_AGY: fakeAgy,
    ENGINE_SWITCH_BIN_CODEX: badCodex,
    ENGINE_SWITCH_BIN_CLAUDE: okClaude,
  }, extra || {});

  try {
    // 1. agy CLI review with --no-commit
    const agyRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--engine', 'gemini', '--cli', 'agy', '--no-commit'], {
      env: env(),
      encoding: 'utf8',
    });
    assert.strictEqual(agyRes.status, 0, agyRes.stderr + '\n' + agyRes.stdout);
    assert.match(agyRes.stdout, /VERDICT: APPROVE \| ENGINE: gemini/);
    fs.rmSync(path.join(repo, 'reviews'), { recursive: true, force: true });

    // 2. Missing verdict on codex -> exits 1, does NOT fall back to claude
    const badRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--no-commit'], {
      env: env(),
      encoding: 'utf8',
    });
    assert.strictEqual(badRes.status, 1);
    assert.match(badRes.stderr, /without a valid VERDICT/);

    // 3. Per-chat reviewer = claude -> goes straight to claude without touching codex
    sw.updateChatKey(SID, 'reviewer', 'claude', 'use claude reviewer', home, cfgMod.DEFAULTS);
    const clRes = cp.spawnSync(process.execPath, [REVIEW_SCRIPT, '--base', 'main', '--dir', repo, '--chat', SID, '--no-commit'], {
      env: env(),
      encoding: 'utf8',
    });
    assert.strictEqual(clRes.status, 0, clRes.stderr + '\n' + clRes.stdout);
    assert.match(clRes.stdout, /ENGINE: claude/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('review result keeps error evidence separate from model text and rejects partial answers', () => {
  assert.equal(r.looksLikeAuthError('review the sign in flow'), false);
  assert.equal(r.looksLikeAuthError('authentication required'), true);
  assert.deepEqual(r.readReviewResult('gemini', '{"response":"VERDICT: APPROVE","finished_reason":"print_timeout"}'), { text: '', error: '' });
  assert.deepEqual(r.readReviewResult('claude', '{"is_error":true,"result":"not logged in"}'), { text: '', error: 'not logged in' });
  assert.equal(r.validateReviewerChanges('?? example/.env.test\0', 'reviews/REVIEW.md').ok, false);
});
