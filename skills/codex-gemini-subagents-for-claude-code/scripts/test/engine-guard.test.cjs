'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS } = require('../config.cjs');
const { markCeiling, recentCeiling, CEILING_VALID_MS, ceilingFilePath } = require('../ceiling.cjs');
const { decide } = require('../hooks/engine-guard.cjs');

const SID = '11111111-2222-3333-4444-555555555555';
const HOOK_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'engine-guard.cjs');
const keyOf = (helper) => () => ({ helper });
const agentCall = (subagentType, prompt = 'do task', toolName = 'Agent') => ({
  session_id: SID,
  tool_name: toolName,
  tool_input: { subagent_type: subagentType, prompt },
});
const noCeiling = () => false;
const ceilingsOf = (...engines) => (eng) => engines.includes(eng);
const noopAudit = () => {};

test('key claude allows everything including empty, fork, named agents, and Workflow', () => {
  for (const t of [undefined, '', 'general-purpose', 'Explore', 'Plan', 'fork', 'custom-deployer']) {
    assert.strictEqual(decide(agentCall(t), keyOf('claude'), noCeiling, DEFAULTS, noopAudit), null);
  }
  assert.strictEqual(decide({ session_id: SID, tool_name: 'Workflow', tool_input: { script: 'x' } }, keyOf('claude'), noCeiling, DEFAULTS, noopAudit), null);
  assert.strictEqual(decide(agentCall('general-purpose'), () => null, noCeiling, DEFAULTS, noopAudit), null);
});

test('key codex and gemini deny empty, general-purpose, Explore, Plan, fork, named agents, and Workflow', () => {
  const blocked = [undefined, '', 'general-purpose', 'Explore', 'Plan', 'fork', 'deployer', 'pre-flight-smoke', 'eval-runner'];
  for (const eng of ['codex', 'gemini']) {
    for (const t of blocked) {
      const denyAgent = decide(agentCall(t), keyOf(eng), noCeiling, DEFAULTS, noopAudit);
      assert.ok(denyAgent, `${eng} must deny Agent ${t}`);
      assert.match(denyAgent, new RegExp(eng.toUpperCase()));
      assert.match(denyAgent, /CLAUDE-ONLY: ceiling/);
      assert.match(denyAgent, /CLAUDE-ONLY: tool/);

      const denyTask = decide(agentCall(t, 'p', 'Task'), keyOf(eng), noCeiling, DEFAULTS, noopAudit);
      assert.ok(denyTask, `${eng} must deny Task ${t}`);
    }
    const denyWorkflow = decide({ session_id: SID, tool_name: 'Workflow', tool_input: { script: 'run()' } }, keyOf(eng), noCeiling, DEFAULTS, noopAudit);
    assert.ok(denyWorkflow);
    assert.match(denyWorkflow, /Workflow/);
  }
});

test('allow-list passes freely and supports custom reviewer agent in config', () => {
  const customCfg = Object.assign({}, DEFAULTS, {
    guard: Object.assign({}, DEFAULTS.guard, { allowAgents: ['web-fetch', 'claude-code-guide', 'statusline-setup', 'pr-reviewer'] }),
  });
  for (const t of ['web-fetch', 'claude-code-guide', 'statusline-setup', 'pr-reviewer']) {
    assert.strictEqual(decide(agentCall(t), keyOf('codex'), noCeiling, customCfg, noopAudit), null);
    assert.strictEqual(decide(agentCall(t), keyOf('gemini'), noCeiling, customCfg, noopAudit), null);
  }
  // Workflow is never allow-listed even if configured
  assert.ok(decide({ session_id: SID, tool_name: 'Workflow', tool_input: {} }, keyOf('codex'), noCeiling, customCfg, noopAudit));
});

test('loopholes denied: arbitrary text after CLAUDE-ONLY:, trailing text on ceiling line, keyword stuffing in tool', () => {
  const denials = [
    'CLAUDE-ONLY: Codex is at 90% ceiling',
    'CLAUDE-ONLY: ceiling because I checked manually',
    'CLAUDE-ONLY: ceiling extra-text',
    'CLAUDE-ONLY: needs the supabase mcp server',
    'CLAUDE-ONLY: open chrome browser',
    'CLAUDE-ONLY: tool bash',
    'CLAUDE-ONLY: tool',
    'CLAUDE-ONLY: ',
  ];
  for (const prompt of denials) {
    assert.ok(decide(agentCall('general-purpose', prompt), keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), `should deny: ${prompt}`);
    assert.ok(decide(agentCall('general-purpose', prompt), keyOf('gemini'), ceilingsOf('gemini', 'codex'), DEFAULTS, noopAudit), `should deny on gemini: ${prompt}`);
  }
});

test('key codex: CLAUDE-ONLY: ceiling passes only with recent codex marker (searched in whole tool_input)', () => {
  assert.ok(decide(agentCall('general-purpose', 'Task\nCLAUDE-ONLY: ceiling\nDo work'), keyOf('codex'), noCeiling, DEFAULTS, noopAudit));
  assert.strictEqual(decide(agentCall('general-purpose', 'Task\nCLAUDE-ONLY: ceiling\nDo work'), keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), null);
  assert.strictEqual(decide(agentCall('fork', '# CLAUDE-ONLY: ceiling'), keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), null);
  assert.strictEqual(
    decide({ session_id: SID, tool_name: 'Workflow', tool_input: { script: 'step()', args: { note: 'CLAUDE-ONLY: ceiling' } } }, keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit),
    null
  );
});

test('key gemini: CLAUDE-ONLY: ceiling requires gemini AND codex markers when fallback lists codex', () => {
  assert.ok(decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('gemini'), noCeiling, DEFAULTS, noopAudit));
  assert.ok(decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('gemini'), ceilingsOf('gemini'), DEFAULTS, noopAudit));
  assert.ok(decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('gemini'), ceilingsOf('codex'), DEFAULTS, noopAudit));
  assert.strictEqual(decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('gemini'), ceilingsOf('gemini', 'codex'), DEFAULTS, noopAudit), null);

  // When fallback skips codex, only gemini marker is needed
  const directClaudeCfg = Object.assign({}, DEFAULTS, { fallback: ['claude'] });
  assert.strictEqual(decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('gemini'), ceilingsOf('gemini'), directClaudeCfg, noopAudit), null);
});

test('CLAUDE-ONLY: tool <name> allows configured tools and logs exception', () => {
  const entries = [];
  const capture = (e) => entries.push(e);
  for (const name of ['mcp', 'browser', 'chrome', 'supabase', 'database', 'supabase mcp']) {
    assert.strictEqual(decide(agentCall('general-purpose', `Run query\nCLAUDE-ONLY: tool ${name}`), keyOf('gemini'), noCeiling, DEFAULTS, capture), null);
  }
  assert.strictEqual(entries.length, 6);
  assert.strictEqual(entries[0].exception, 'tool');
  assert.strictEqual(entries[0].engine, 'gemini');
});

test('expired ceiling marker (> 30 min) is rejected; fresh marker passes and writes audit JSONL', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-guard-exp-'));
  try {
    markCeiling('codex', '95%', home);
    const file = ceilingFilePath('codex', home);
    fs.writeFileSync(file, JSON.stringify({ engine: 'codex', at: Date.now() - CEILING_VALID_MS - 5000, reason: 'old' }));

    const readFromHome = (eng, ms) => recentCeiling(eng, home, undefined, ms);
    const audits = [];
    const deny = decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('codex'), readFromHome, DEFAULTS, (e) => audits.push(e));
    assert.ok(deny);
    assert.strictEqual(audits.length, 0);

    markCeiling('codex', '95%', home);
    const allow = decide(agentCall('general-purpose', 'CLAUDE-ONLY: ceiling'), keyOf('codex'), readFromHome, DEFAULTS, (e) => audits.push(e));
    assert.strictEqual(allow, null);
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].exception, 'ceiling');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('audit failure never blocks and hook CLI handles deny, audit log, and malformed input safely', () => {
  assert.strictEqual(
    decide(agentCall('general-purpose', 'CLAUDE-ONLY: tool mcp'), keyOf('codex'), noCeiling, DEFAULTS, () => { throw new Error('disk full'); }),
    null
  );

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-hook-cli-'));
  const env = Object.assign({}, process.env, { ENGINE_SWITCH_HOME: home });
  try {
    fs.mkdirSync(path.join(home, 'chats'), { recursive: true });
    fs.writeFileSync(path.join(home, 'chats', `${SID}.json`), JSON.stringify({ helper: 'codex', reviewer: 'codex' }));

    // Denied Agent call
    const denied = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify(agentCall('Explore', 'search files')),
      encoding: 'utf8',
    });
    assert.strictEqual(denied.status, 0);
    const parsed = JSON.parse(denied.stdout);
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');

    // Allowed exception appends to claude-exceptions.jsonl
    const allowed = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify(agentCall('general-purpose', 'CLAUDE-ONLY: tool browser')),
      encoding: 'utf8',
    });
    assert.strictEqual(allowed.status, 0);
    assert.strictEqual(allowed.stdout.trim(), '');
    const auditFile = path.join(home, 'claude-exceptions.jsonl');
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].exception, 'tool');

    // Malformed stdin -> prints nothing, exits 0
    const broken = cp.spawnSync(process.execPath, [HOOK_SCRIPT], { env, input: '{not-json', encoding: 'utf8' });
    assert.strictEqual(broken.status, 0);
    assert.strictEqual(broken.stdout, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
