'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfgMod = require('../config.cjs');
const detectMod = require('../detect.cjs');

test('defaults and example config are valid', () => {
  assert.deepStrictEqual(cfgMod.validateConfig(cfgMod.DEFAULTS), []);
  const example = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'examples', 'engine-switch.config.json'), 'utf8')
  );
  assert.deepStrictEqual(cfgMod.validateConfig(example), []);
  assert.strictEqual(example.review.maxConcurrent, 3);
  assert.deepStrictEqual(example.review.order, ['codex', 'gemini', 'claude']);
});

test('validateConfig rejects out-of-range percents, unknown engines, empty fallback, and bad review fields', () => {
  const bad = (patch) => cfgMod.validateConfig(cfgMod.mergeDeep(cfgMod.DEFAULTS, patch));
  assert.ok(bad({ version: 2 }).length);
  assert.ok(bad({ engines: [] }).length);
  assert.ok(bad({ engines: ['skynet'] }).length);
  assert.ok(bad({ defaults: { helper: 'skynet' } }).length);
  assert.ok(bad({ defaults: { reviewer: 'unknown' } }).length);
  assert.ok(bad({ newChatsMode: 'sometimes' }).length);
  assert.ok(bad({ fallback: [] }).length);
  assert.ok(bad({ fallback: ['bad-engine'] }).length);
  assert.ok(bad({ switchOn: { mode: 'magic' } }).length);
  assert.ok(bad({ switchOn: { maxWindowPct: -1 } }).length);
  assert.ok(bad({ switchOn: { maxWindowPct: 101 } }).length);
  assert.ok(bad({ switchOn: { maxWeekPct: 150 } }).length);
  assert.ok(bad({ switchOn: { ceilingValidMinutes: 0 } }).length);
  assert.ok(bad({ codex: { effort: 'extreme' } }).length);
  assert.ok(bad({ codex: { sharePct: 0 } }).length);
  assert.ok(bad({ codex: { sharePct: 105 } }).length);
  assert.ok(bad({ gemini: { cli: 'other' } }).length);
  assert.ok(bad({ gemini: { model: 'bad;cmd' } }).length);
  assert.ok(bad({ review: { order: [] } }).length);
  assert.ok(bad({ review: { order: ['skynet'] } }).length);
  assert.ok(bad({ review: { maxConcurrent: 0 } }).length);
  assert.ok(bad({ review: { timeoutMinutes: 0 } }).length);
  assert.ok(bad({ review: { claude: { effort: 'turbo' } } }).length);
});

test('writeConfig writes valid config and rejects invalid config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-cfg-'));
  try {
    const dest = path.join(tmp, 'config.json');
    cfgMod.writeConfig({ defaults: { reviewer: 'gemini' }, review: { maxConcurrent: 2 } }, dest);
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.strictEqual(loaded.defaults.reviewer, 'gemini');
    assert.strictEqual(loaded.review.maxConcurrent, 2);

    assert.throws(() => cfgMod.writeConfig({ fallback: [] }, dest), (e) => e.code === 'BADCONFIG');
    assert.throws(() => cfgMod.writeConfig({ switchOn: { maxWindowPct: 120 } }, dest), (e) => e.code === 'BADCONFIG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect pure helpers: parseVersion, loginFolderCandidates, detectEngineInfo, formatSummary', () => {
  assert.strictEqual(detectMod.parseVersion('codex-cli 0.42.1'), '0.42.1');
  assert.strictEqual(detectMod.parseVersion('2.1.0-beta.3'), '2.1.0-beta.3');
  assert.strictEqual(detectMod.parseVersion('unknown'), null);

  assert.deepStrictEqual(detectMod.loginFolderCandidates('codex'), ['.codex']);
  assert.ok(detectMod.loginFolderCandidates('agy').includes('.antigravity'));

  const ok = detectMod.detectEngineInfo('codex', { ok: true, output: 'codex 1.2.3' }, '/tmp', (rel) => rel === '.codex');
  assert.deepStrictEqual(ok, { installed: true, version: '1.2.3', authed: true });

  const notAuthed = detectMod.detectEngineInfo('gemini', { ok: true, output: '0.5.0' }, '/tmp', () => false);
  assert.deepStrictEqual(notAuthed, { installed: true, version: '0.5.0', authed: false });

  const missing = detectMod.detectEngineInfo('agy', { ok: false, output: '' }, '/tmp', () => true);
  assert.deepStrictEqual(missing, { installed: false, version: null, authed: false });

  const summary = detectMod.formatSummary({
    configExists: false,
    hookConfigured: false,
    gh: { installed: true, version: '2.60.0', authed: true },
    engines: {
      claude: ok,
      codex: ok,
      gemini: notAuthed,
      agy: missing,
    },
  });
  assert.match(summary, /codex: installed \(1\.2\.3\), signed-in folder found/);
  assert.match(summary, /gemini: installed \(0\.5\.0\), not signed in/);
  assert.match(summary, /gh: installed \(2\.60\.0\), signed in/);
});

test('detect runs with stubbed binaries via ENGINE_SWITCH_BIN_* and ENGINE_SWITCH_GH', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-detect-'));
  const home = path.join(tmp, 'userhome');
  const esHome = path.join(tmp, 'eshome');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const stubCodex = path.join(tmp, 'bin-codex.cjs');
  const stubGh = path.join(tmp, 'bin-gh.cjs');
  const missing = path.join(tmp, 'missing.cjs');
  fs.writeFileSync(stubCodex, 'console.log("codex 3.4.5");');
  fs.writeFileSync(stubGh, 'console.log("gh version 2.65.0");');

  const prev = {
    ENGINE_SWITCH_BIN_CLAUDE: process.env.ENGINE_SWITCH_BIN_CLAUDE,
    ENGINE_SWITCH_BIN_CODEX: process.env.ENGINE_SWITCH_BIN_CODEX,
    ENGINE_SWITCH_BIN_GEMINI: process.env.ENGINE_SWITCH_BIN_GEMINI,
    ENGINE_SWITCH_BIN_AGY: process.env.ENGINE_SWITCH_BIN_AGY,
    ENGINE_SWITCH_GH: process.env.ENGINE_SWITCH_GH,
  };
  process.env.ENGINE_SWITCH_BIN_CLAUDE = missing;
  process.env.ENGINE_SWITCH_BIN_CODEX = stubCodex;
  process.env.ENGINE_SWITCH_BIN_GEMINI = missing;
  process.env.ENGINE_SWITCH_BIN_AGY = missing;
  process.env.ENGINE_SWITCH_GH = stubGh;

  try {
    const res = detectMod.detect(home, esHome);
    assert.deepStrictEqual(res.engines.codex, { installed: true, version: '3.4.5', authed: true });
    assert.strictEqual(res.engines.claude.installed, false);
    assert.strictEqual(res.gh.installed, true);
    assert.strictEqual(res.gh.version, '2.65.0');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
