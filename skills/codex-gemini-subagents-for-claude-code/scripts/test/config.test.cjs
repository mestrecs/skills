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
});

test('validateConfig rejects out-of-range percents, unknown engines, empty fallback, and bad fields', () => {
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
});

test('writeConfig writes valid config and rejects invalid config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-cfg-'));
  try {
    const dest = path.join(tmp, 'config.json');
    cfgMod.writeConfig({ defaults: { helper: 'codex' }, fallback: ['codex', 'claude'] }, dest);
    const loaded = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.strictEqual(loaded.defaults.helper, 'codex');

    assert.throws(() => cfgMod.writeConfig({ fallback: [] }, dest), (e) => e.code === 'BADCONFIG');
    assert.throws(() => cfgMod.writeConfig({ switchOn: { maxWindowPct: 120 } }, dest), (e) => e.code === 'BADCONFIG');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadConfig merges global home config and project .engine-switch.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-load-'));
  const home = path.join(tmp, 'home');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  try {
    cfgMod.writeConfig({ codex: { effort: 'high' } }, path.join(home, 'config.json'));
    fs.writeFileSync(path.join(proj, '.engine-switch.json'), JSON.stringify({
      guard: { allowAgents: ['web-fetch', 'code-reviewer'] },
    }));
    const cfg = cfgMod.loadConfig(proj, home);
    assert.strictEqual(cfg.codex.effort, 'high');
    assert.deepStrictEqual(cfg.guard.allowAgents, ['web-fetch', 'code-reviewer']);
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
    engines: {
      claude: ok,
      codex: ok,
      gemini: notAuthed,
      agy: missing,
    },
  });
  assert.match(summary, /codex: installed \(1\.2\.3\), signed-in folder found/);
  assert.match(summary, /gemini: installed \(0\.5\.0\), not signed in/);
  assert.match(summary, /agy: not installed/);
  assert.match(summary, /config: missing/);
});

test('detect runs with stubbed binaries via ENGINE_SWITCH_BIN_*', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-detect-'));
  const home = path.join(tmp, 'userhome');
  const esHome = path.join(tmp, 'eshome');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const stub = path.join(tmp, 'bin-codex.cjs');
  const missing = path.join(tmp, 'missing.cjs');
  fs.writeFileSync(stub, 'console.log("codex 3.4.5");');

  const prev = {
    ENGINE_SWITCH_BIN_CLAUDE: process.env.ENGINE_SWITCH_BIN_CLAUDE,
    ENGINE_SWITCH_BIN_CODEX: process.env.ENGINE_SWITCH_BIN_CODEX,
    ENGINE_SWITCH_BIN_GEMINI: process.env.ENGINE_SWITCH_BIN_GEMINI,
    ENGINE_SWITCH_BIN_AGY: process.env.ENGINE_SWITCH_BIN_AGY,
  };
  process.env.ENGINE_SWITCH_BIN_CLAUDE = missing;
  process.env.ENGINE_SWITCH_BIN_CODEX = stub;
  process.env.ENGINE_SWITCH_BIN_GEMINI = missing;
  process.env.ENGINE_SWITCH_BIN_AGY = missing;

  try {
    const res = detectMod.detect(home, esHome, tmp);
    assert.deepStrictEqual(res.engines.codex, { installed: true, version: '3.4.5', authed: true });
    assert.strictEqual(res.engines.claude.installed, false);
    assert.strictEqual(res.configExists, false);
    assert.strictEqual(res.hookConfigured, false);
    assert.deepStrictEqual(res.connectors, {
      claude: [],
      codex: [],
      gemini: [],
      agy: 'not checked',
      claudeOnly: [],
    });
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('connector parsers extract names only and never leak secrets/env/args/URLs', () => {
  const SECRET = 'SECRET_TOKEN_XYZ_987654';
  const claudeJson = JSON.stringify({
    mcpServers: {
      'my-db': {
        command: 'npx',
        args: ['-y', 'db-mcp', '--token=' + SECRET],
        env: { DB_PASSWORD: SECRET },
      },
      'Shared-Tool': {
        url: 'https://user:' + SECRET + '@example.com/mcp',
      },
    },
    projects: {
      '/workspace/my-app': {
        mcpServers: {
          'repo-helper': { env: { API_KEY: SECRET } },
        },
      },
      '/workspace/other-app': {
        mcpServers: {
          'unrelated-tool': { env: { API_KEY: SECRET } },
        },
      },
    },
  });
  const claudeFromJson = detectMod.parseClaudeJsonMcpServers(claudeJson, '/workspace/my-app/');
  assert.deepStrictEqual(claudeFromJson, ['my-db', 'Shared-Tool', 'repo-helper']);
  assert.ok(!JSON.stringify(claudeFromJson).includes(SECRET));

  const mcpJson = JSON.stringify({
    mcpServers: {
      browser: { command: 'node', args: ['server.js'], env: { COOKIE: SECRET } },
    },
  });
  const fromMcpJson = detectMod.parseMcpJsonServers(mcpJson);
  assert.deepStrictEqual(fromMcpJson, ['browser']);
  assert.ok(!JSON.stringify(fromMcpJson).includes(SECRET));
  assert.deepStrictEqual(detectMod.parseMcpJsonServers('{bad json'), []);

  const listOutput = [
    'Checking MCP server health...',
    '',
    'my-db: https://api.example.com/mcp?auth=' + SECRET + ' - Connected',
    'docs.remote: npx -y docs-mcp --key ' + SECRET + ' - Connected',
    'claude.ai Docs: https://docs.example.com/mcp - Connected',
  ].join('\n');
  const fromList = detectMod.parseClaudeMcpList(listOutput);
  assert.deepStrictEqual(fromList, ['my-db', 'docs.remote', 'claude.ai Docs']);
  assert.ok(!JSON.stringify(fromList).includes(SECRET));

  const codexToml = [
    '# [mcp_servers.commented_out]',
    'model = "gpt-5"',
    '[mcp_servers.shared-tool]',
    'command = "npx"',
    'args = ["--token=' + SECRET + '"]',
    '[mcp_servers.shared-tool.env]',
    'API_TOKEN = "' + SECRET + '"',
    'FAKE = "[mcp_servers.not_a_table]"',
    '[mcp_servers."codex-docs"]',
    'url = "https://example.com/' + SECRET + '"',
  ].join('\n');
  const fromCodex = detectMod.parseCodexTomlMcpServers(codexToml);
  assert.deepStrictEqual(fromCodex, ['shared-tool', 'codex-docs']);
  assert.ok(!JSON.stringify(fromCodex).includes(SECRET));

  const claudeOnly = detectMod.computeClaudeOnly(
    {
      claude: ['my-db', 'Shared-Tool', 'browser', 'claude.ai Docs'],
      codex: ['shared-tool'],
      gemini: ['browser'],
      agy: 'not checked',
    },
    ['codex']
  );
  assert.deepStrictEqual(claudeOnly, ['my-db', 'browser', 'claude.ai Docs']);

  const claudeOnlyBoth = detectMod.computeClaudeOnly(
    {
      claude: ['my-db', 'Shared-Tool', 'browser'],
      codex: ['shared-tool'],
      gemini: ['BROWSER'],
      agy: 'not checked',
    },
    ['codex', 'gemini']
  );
  assert.deepStrictEqual(claudeOnlyBoth, ['my-db']);
});

test('detect reports connectors across engines and claudeOnly against selected helper engines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'es-conn-'));
  const home = path.join(tmp, 'home');
  const esHome = path.join(tmp, 'eshome');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.gemini'), { recursive: true });

  const SECRET = 'sk-super-secret-value-12345';
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'my-db': { env: { KEY: SECRET } }, 'shared-db': { env: { KEY: SECRET } } },
  }));
  fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({
    mcpServers: { browser: { args: [SECRET] } },
  }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.shared-db]\n[mcp_servers.shared-db.env]\nTOKEN="' + SECRET + '"\n');
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({
    mcpServers: { 'gemini-only': { token: SECRET }, browser: { token: SECRET } },
  }));

  const claudeStub = path.join(tmp, 'stub-claude.cjs');
  const missingStub = path.join(tmp, 'missing.cjs');
  fs.writeFileSync(claudeStub, [
    'const args = process.argv.slice(2);',
    'if (args.includes("--version")) { console.log("claude 2.0.0"); process.exit(0); }',
    'if (args[0] === "mcp" && args[1] === "list") { console.log("cli-conn: https://example.com/' + SECRET + ' - Connected"); process.exit(0); }',
    'process.exit(1);',
  ].join('\n'));

  const prev = {
    ENGINE_SWITCH_BIN_CLAUDE: process.env.ENGINE_SWITCH_BIN_CLAUDE,
    ENGINE_SWITCH_BIN_CODEX: process.env.ENGINE_SWITCH_BIN_CODEX,
    ENGINE_SWITCH_BIN_GEMINI: process.env.ENGINE_SWITCH_BIN_GEMINI,
    ENGINE_SWITCH_BIN_AGY: process.env.ENGINE_SWITCH_BIN_AGY,
  };
  process.env.ENGINE_SWITCH_BIN_CLAUDE = claudeStub;
  process.env.ENGINE_SWITCH_BIN_CODEX = missingStub;
  process.env.ENGINE_SWITCH_BIN_GEMINI = missingStub;
  process.env.ENGINE_SWITCH_BIN_AGY = missingStub;

  try {
    // Only codex is selected in config -> browser (only on gemini) remains claudeOnly.
    cfgMod.writeConfig({ engines: ['codex', 'claude'], defaults: { helper: 'codex' }, fallback: ['codex', 'claude'] }, path.join(esHome, 'config.json'));
    const res = detectMod.detect(home, esHome, repo);
    assert.deepStrictEqual(res.connectors, {
      claude: ['my-db', 'shared-db', 'browser', 'cli-conn'],
      codex: ['shared-db'],
      gemini: ['gemini-only', 'browser'],
      agy: 'not checked',
      claudeOnly: ['my-db', 'browser', 'cli-conn'],
    });
    assert.ok(!JSON.stringify(res).includes(SECRET));
    assert.match(detectMod.formatSummary(res), /claude-only connectors: my-db, browser, cli-conn/);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
