'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfgMod = require('../config.cjs');
const detectMod = require('../detect.cjs');

test('defaults and example config are valid, and leanHelper is off by default', () => {
  assert.deepStrictEqual(cfgMod.validateConfig(cfgMod.DEFAULTS), []);
  assert.strictEqual(cfgMod.DEFAULTS.modelRouting.leanHelper.enabled, false);
  const example = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'examples', 'engine-switch.config.json'), 'utf8')
  );
  assert.deepStrictEqual(cfgMod.validateConfig(example), []);
  assert.strictEqual(example.modelRouting.leanHelper.enabled, false);
});

test('validateConfig rejects out-of-range percents, unknown engines, empty fallback, and invalid modelRouting fields', () => {
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
  assert.ok(bad({ codex: { maxConcurrent: 0 } }).length);
  assert.ok(bad({ gemini: { cli: 'other' } }).length);
  assert.ok(bad({ gemini: { model: 'bad;cmd' } }).length);
  assert.ok(bad({ guard: { allowAgents: [''] } }).length);
  assert.ok(bad({ guard: { toolExceptions: [''] } }).length);

  assert.ok(bad({ modelRouting: { searchModel: 'bad cmd' } }).length);
  assert.ok(bad({ modelRouting: { defaultEffort: 'xhigh' } }).length);
  assert.ok(bad({ modelRouting: { retryEffort: 'max' } }).length);
  assert.ok(bad({ modelRouting: { opusMinAttempt: 0 } }).length);
  assert.ok(bad({ modelRouting: { maxAttempts: 0 } }).length);
  assert.ok(bad({ modelRouting: { capNamedAgentOpus: 'yes' } }).length);
  assert.ok(bad({ modelRouting: { highEffortAgents: [''] } }).length);
  assert.ok(bad({ modelRouting: { readingVerbs: [] } }).length);
  assert.ok(bad({ modelRouting: { leanHelper: { enabled: 'true' } } }).length);
  assert.ok(bad({ modelRouting: { leanHelper: { agentName: 'bad name' } } }).length);
  assert.ok(bad({ modelRouting: { leanHelper: { requireTranscriptListing: 1 } } }).length);
  assert.ok(bad({ modelRouting: { leanHelper: { includedMcps: [''] } } }).length);
});

test('writeConfig writes valid config and rejects invalid config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cfg-'));
  try {
    const dest = path.join(tmp, 'config.json');
    cfgMod.writeConfig({ modelRouting: { leanHelper: { enabled: true } } }, dest);
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.strictEqual(loaded.modelRouting.leanHelper.enabled, true);

    assert.throws(() => cfgMod.writeConfig({ fallback: [] }, dest), (e) => e.code === 'BADCONFIG');
    assert.throws(() => cfgMod.writeConfig({ switchOn: { maxWindowPct: 120 } }, dest), (e) => e.code === 'BADCONFIG');
    assert.throws(() => cfgMod.writeConfig({ modelRouting: { maxAttempts: 0 } }, dest), (e) => e.code === 'BADCONFIG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig merges global home config and project .engine-switch.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-load-'));
  const home = path.join(tmp, 'home');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  try {
    cfgMod.writeConfig({ modelRouting: { defaultEffort: 'low' } }, path.join(home, 'config.json'));
    fs.writeFileSync(path.join(proj, '.engine-switch.json'), JSON.stringify({
      modelRouting: { leanHelper: { enabled: true } },
    }));
    const cfg = cfgMod.loadConfig(proj, home);
    assert.strictEqual(cfg.modelRouting.defaultEffort, 'low');
    assert.strictEqual(cfg.modelRouting.leanHelper.enabled, true);
    assert.strictEqual(cfg.modelRouting.leanHelper.agentName, 'helper');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detect pure helpers: parseVersion, loginFolderCandidates, detectEngineInfo, formatSummary', () => {
  assert.strictEqual(detectMod.parseVersion('claude 2.1.12'), '2.1.12');
  assert.strictEqual(detectMod.parseVersion('0.42.1-rc.1'), '0.42.1-rc.1');
  assert.strictEqual(detectMod.parseVersion('not-a-version'), null);

  assert.deepStrictEqual(detectMod.loginFolderCandidates('claude'), ['.claude']);
  assert.ok(detectMod.loginFolderCandidates('agy').includes('.antigravity'));

  const ok = detectMod.detectEngineInfo('claude', { ok: true, output: 'claude 2.1.12' }, '/tmp', (rel) => rel === '.claude');
  assert.deepStrictEqual(ok, { installed: true, version: '2.1.12', authed: true });

  const notAuthed = detectMod.detectEngineInfo('gemini', { ok: true, output: '0.5.0' }, '/tmp', () => false);
  assert.deepStrictEqual(notAuthed, { installed: true, version: '0.5.0', authed: false });

  const missing = detectMod.detectEngineInfo('agy', { ok: false, output: '' }, '/tmp', () => true);
  assert.deepStrictEqual(missing, { installed: false, version: null, authed: false });

  const summary = detectMod.formatSummary({
    configExists: false,
    hookConfigured: true,
    engineGuardConfigured: false,
    leanAgentInstalled: false,
    engines: { claude: ok, codex: missing, gemini: notAuthed, agy: missing },
  });
  assert.match(summary, /claude: installed \(2\.1\.12\), signed-in folder found/);
  assert.match(summary, /gemini: installed \(0\.5\.0\), not signed in/);
  assert.match(summary, /model-router hook: configured/);
  assert.match(summary, /lean agent: not installed/);
});

test('detect runs with stubbed binaries via MODEL_ROUTER_BIN_* and checks settings/agent files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-detect-'));
  const home = path.join(tmp, 'userhome');
  const esHome = path.join(tmp, 'eshome');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: 'node /x/model-router.cjs' }] }] },
  }));
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\n');

  const stub = path.join(tmp, 'bin-claude.cjs');
  const missing = path.join(tmp, 'missing.cjs');
  fs.writeFileSync(stub, 'console.log("claude 2.5.0");');

  const keys = ['CLAUDE', 'CODEX', 'GEMINI', 'AGY'].map((k) => 'MODEL_ROUTER_BIN_' + k);
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.MODEL_ROUTER_BIN_CLAUDE = stub;
  process.env.MODEL_ROUTER_BIN_CODEX = missing;
  process.env.MODEL_ROUTER_BIN_GEMINI = missing;
  process.env.MODEL_ROUTER_BIN_AGY = missing;

  try {
    const res = detectMod.detect(home, esHome, proj);
    assert.deepStrictEqual(res.engines.claude, { installed: true, version: '2.5.0', authed: true });
    assert.strictEqual(res.engines.codex.installed, false);
    assert.strictEqual(res.configExists, false);
    assert.strictEqual(res.hookConfigured, true);
    assert.strictEqual(res.engineGuardConfigured, false);
    assert.strictEqual(res.leanAgentInstalled, true);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
