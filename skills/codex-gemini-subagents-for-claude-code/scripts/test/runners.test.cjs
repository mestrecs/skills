'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const codexRunner = require('../run-codex.cjs');
const geminiRunner = require('../run-gemini.cjs');

const CODEX_SCRIPT = path.resolve(__dirname, '..', 'run-codex.cjs');
const GEMINI_SCRIPT = path.resolve(__dirname, '..', 'run-gemini.cjs');

test('buildCodexArgs: write mode, delivery mode, non-repo check, and linked worktree directory', () => {
  const writeRepo = codexRunner.buildCodexArgs({
    dir: '/tmp/wt',
    answerFile: '/tmp/ans.txt',
    deliver: false,
    model: 'gpt-6.2-sol',
    effort: 'medium',
    isRepo: true,
    gitCommonDir: '/tmp/repo/.git',
  });
  assert.ok(!writeRepo.includes('--skip-git-repo-check'));
  assert.ok(writeRepo.includes('workspace-write'));
  assert.ok(writeRepo.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(writeRepo[writeRepo.indexOf('--add-dir') + 1], '/tmp/repo/.git');
  assert.strictEqual(writeRepo[writeRepo.length - 1], '-');

  const writeNonRepo = codexRunner.buildCodexArgs({
    dir: '/tmp/plain',
    answerFile: '/tmp/ans.txt',
    deliver: false,
    model: 'gpt-6.2-sol',
    effort: 'medium',
    isRepo: false,
    gitCommonDir: '',
  });
  assert.ok(writeNonRepo.includes('--skip-git-repo-check'));

  const deliver = codexRunner.buildCodexArgs({
    dir: '/tmp/wt',
    answerFile: '/tmp/ans.txt',
    deliver: true,
    model: 'gpt-6.2-sol',
    effort: 'high',
    isRepo: true,
    gitCommonDir: '/tmp/repo/.git',
  });
  assert.ok(deliver.includes('danger-full-access'));
  assert.ok(!deliver.includes('workspace-write'));
});

test('Gemini and agy use documented flags and reject partial JSON answers', () => {
  const agyWrite = geminiRunner.buildGeminiArgs({
    cli: 'agy',
    model: 'gemini-4-hydrogen-high',
    deliver: false,
    timeoutSec: 900,
    dirPosix: '/tmp/work',
    tempDirPosix: '/tmp/es-1',
    requestPosix: '/tmp/es-1/request.md',
    permissionsPosix: '/tmp/es-1/permissions.json',
  });
  assert.equal(agyWrite[agyWrite.indexOf('--settings') + 1], '/tmp/es-1/permissions.json');
  assert.ok(agyWrite.includes('/tmp/work'));
  assert.deepEqual(geminiRunner.buildPermissionsObject('/tmp/work').permissions.allow, ['command(*)', 'read_file(*)', 'write_file(/tmp/work/**)']);
  assert.equal(agyWrite[agyWrite.indexOf('--add-dir') + 1], '/tmp/es-1');
  assert.ok(agyWrite.includes('--sandbox'));
  assert.ok(agyWrite.includes('900s'));

  const agyDeliver = geminiRunner.buildGeminiArgs({
    cli: 'agy',
    model: 'gemini-4-hydrogen-high',
    deliver: true,
    timeoutSec: 900,
    dirPosix: '/tmp/work',
    tempDirPosix: '/tmp/es-1',
    requestPosix: '/tmp/es-1/request.md',
    permissionsPosix: '/tmp/es-1/permissions.json',
  });
  assert.ok(!agyDeliver.includes('--sandbox'));

  const gemWrite = geminiRunner.buildGeminiArgs({
    cli: 'gemini',
    model: 'gemini-4-hydrogen-high',
    deliver: false,
    dirPosix: '/tmp/work',
    requestPosix: '/tmp/es-1/request.md',
  });
  assert.ok(gemWrite.includes('--sandbox'));
  assert.ok(!gemWrite.includes('--settings'));
  assert.ok(gemWrite.includes('auto_edit'));
  assert.deepEqual(geminiRunner.readJsonResult('{"response":"partial","finished_reason":"print_timeout"}'), { text: '', error: '' });
});

test('run-codex: --quota-only, fake binary success, quota error, and mid-run watchdog kill', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-runcodex-'));
  const home = path.join(tmp, 'home');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const req = path.join(tmp, 'req.md');
  const ans = path.join(tmp, 'ans.txt');
  fs.writeFileSync(req, 'Fix bug in a.js');

  const fakeBin = path.join(tmp, 'fake-codex.cjs');
  fs.writeFileSync(fakeBin, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
const outIdx = a.indexOf('-o');
const out = outIdx >= 0 ? a[outIdx + 1] : null;
const mode = process.env.FAKE_MODE || 'ok';
const prompt = fs.readFileSync(0, 'utf8');
if (mode === 'quota') {
  console.error('Error 429 rate limit exceeded');
  process.exit(1);
}
if (mode === 'sleep') {
  fs.writeFileSync(require('path').join(process.env.ENGINE_SWITCH_HOME, 'quota-codex.json'),
    JSON.stringify({ windowPct: 95, weekPct: 20, at: Date.now() }));
  setTimeout(() => {}, 30000);
} else {
  if (!prompt.includes('never print, log or commit secrets')
    || !prompt.includes('Keep temporary files outside the worktree')
    || !prompt.includes('Before returning code changes')
    || !prompt.trimEnd().endsWith('Report all failures together.')) process.exit(9);
  if (out) fs.writeFileSync(out, 'Done: ' + a.join(' '));
  process.exit(0);
}
`);

  const env = (extra) => Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_CODEX: fakeBin,
  }, extra || {});

  try {
    // 1. Quota under ceiling -> --quota-only exits 0
    fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 50, weekPct: 30, at: Date.now() }));
    assert.strictEqual(cp.spawnSync(process.execPath, [CODEX_SCRIPT, '--quota-only'], { env: env() }).status, 0);

    // 2. Happy run -> exit 0, answer written, rules appended to stdin
    const okRun = cp.spawnSync(process.execPath, [CODEX_SCRIPT, work, req, ans], { env: env(), encoding: 'utf8' });
    assert.strictEqual(okRun.status, 0, okRun.stdout);
    assert.match(fs.readFileSync(ans, 'utf8'), /workspace-write/);

    // 3. Quota error in output -> exit 3 + ceiling marker
    const qErr = cp.spawnSync(process.execPath, [CODEX_SCRIPT, work, req, ans], {
      env: env({ FAKE_MODE: 'quota' }),
      encoding: 'utf8',
    });
    assert.strictEqual(qErr.status, 3);
    assert.strictEqual(fs.existsSync(path.join(home, 'ceilings', 'codex.json')), true);
    fs.rmSync(path.join(home, 'ceilings', 'codex.json'), { force: true });

    // 4. --quota-only over ceiling -> exit 3 + ceiling marker
    fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 92, weekPct: 30, at: Date.now() }));
    assert.strictEqual(cp.spawnSync(process.execPath, [CODEX_SCRIPT, '--quota-only'], { env: env() }).status, 3);
    assert.strictEqual(fs.existsSync(path.join(home, 'ceilings', 'codex.json')), true);
    fs.rmSync(path.join(home, 'ceilings', 'codex.json'), { force: true });

    // 5. Watchdog mid-run stop -> kills sleeping child and exits 3
    fs.writeFileSync(path.join(home, 'quota-codex.json'), JSON.stringify({ windowPct: 40, weekPct: 20, at: Date.now() }));
    const child = cp.spawn(process.execPath, [CODEX_SCRIPT, work, req, ans], {
      env: env({ FAKE_MODE: 'sleep', ENGINE_SWITCH_WATCHDOG_MS: '150' }),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.strictEqual(code, 3);
    assert.match(out, /MID-RUN CEILING/);
    assert.strictEqual(fs.existsSync(path.join(home, 'ceilings', 'codex.json')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('run-gemini: agy request file, sandbox vs --deliver, and ceiling exit 3', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rungemini-'));
  const home = path.join(tmp, 'home');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  const req = path.join(tmp, 'req.md');
  const ans = path.join(tmp, 'ans.txt');
  fs.writeFileSync(req, 'Check module b.js');

  const fakeBin = path.join(tmp, 'fake-gemini.cjs');
  fs.writeFileSync(fakeBin, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
if (process.env.FAKE_MODE === 'quota') {
  console.error('Quota exceeded for quota metric');
  process.exit(1);
}
if (!a.includes('--settings')) process.exit(9);
const perms = JSON.parse(fs.readFileSync(a[a.indexOf('--settings') + 1], 'utf8')).permissions.allow;
if (!perms.some((p) => /^write_file\\(.+\\/\\*\\*\\)$/.test(p)) || perms.some((p) => p === 'write_file(*)')) process.exit(8);
const request = fs.readFileSync(require('path').join(a[a.indexOf('--add-dir') + 1], 'request.md'), 'utf8');
const hasSandbox = a.includes('--sandbox');
console.log(JSON.stringify({ response: JSON.stringify({ hasSandbox, request }) }));
`);

  const env = (extra) => Object.assign({}, process.env, {
    ENGINE_SWITCH_HOME: home,
    ENGINE_SWITCH_BIN_GEMINI: fakeBin,
  }, extra || {});

  try {
    // Configure agy CLI
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ gemini: { cli: 'agy' } }));

    // 1. Write mode passes --sandbox and per-run permissions.json
    const writeRun = cp.spawnSync(process.execPath, [GEMINI_SCRIPT, work, req, ans], { env: env(), encoding: 'utf8' });
    assert.strictEqual(writeRun.status, 0, writeRun.stdout);
    const meta1 = JSON.parse(fs.readFileSync(ans, 'utf8'));
    assert.strictEqual(meta1.hasSandbox, true);
    assert.match(meta1.request, /Check module b.js/);
    assert.match(meta1.request, /Keep temporary files outside the worktree/);
    assert.match(meta1.request, /Follow this checklist when the task writes or changes code/);
    assert.match(meta1.request, /Duplicate effects[\s\S]+Interruption[\s\S]+Concurrency[\s\S]+Tenant and group isolation[\s\S]+Optional behavior/);
    assert.match(meta1.request.trimEnd(), /Report all failures together\.$/);

    // 2. Delivery mode omits --sandbox
    const delivRun = cp.spawnSync(process.execPath, [GEMINI_SCRIPT, work, req, ans, '--deliver'], { env: env(), encoding: 'utf8' });
    assert.strictEqual(delivRun.status, 0, delivRun.stdout);
    const meta2 = JSON.parse(fs.readFileSync(ans, 'utf8'));
    assert.strictEqual(meta2.hasSandbox, false);

    // 3. Quota error -> exit 3 + gemini ceiling marker
    const qErr = cp.spawnSync(process.execPath, [GEMINI_SCRIPT, work, req, ans], {
      env: env({ FAKE_MODE: 'quota' }),
      encoding: 'utf8',
    });
    assert.strictEqual(qErr.status, 3);
    assert.strictEqual(fs.existsSync(path.join(home, 'ceilings', 'gemini.json')), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
