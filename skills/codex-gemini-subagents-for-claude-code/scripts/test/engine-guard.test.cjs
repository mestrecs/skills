'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config.cjs');
const DEFAULTS = { ...config.DEFAULTS, guard: { ...config.DEFAULTS.guard, toolExceptions: ['my-db', 'browser', 'claude.ai Docs'] } };
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
  assert.match(decide(agentCall('general-purpose'), () => null, noCeiling, DEFAULTS, noopAudit), /invalid chat engine key/);
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

test('named allow-list requires a matching tool declaration and an audit', () => {
  const customCfg = { ...DEFAULTS, guard: { ...DEFAULTS.guard, allowAgents: ['review-agent'], toolExceptions: [] } };
  const audits = [];
  for (const engine of ['codex', 'gemini']) {
    assert.ok(decide(agentCall('review-agent'), keyOf(engine), noCeiling, customCfg, noopAudit));
    assert.equal(decide(agentCall(' REVIEW-AGENT ', '  CLAUDE-ONLY: tool review-agent\r\nTask'), keyOf(engine), noCeiling, customCfg, (entry) => audits.push(entry)), null);
    assert.ok(decide(agentCall('fOrK', 'CLAUDE-ONLY: tool review-agent'), keyOf(engine), noCeiling, customCfg, noopAudit));
    assert.ok(decide(agentCall('review-agent', 'CLAUDE-ONLY: tool browser'), keyOf(engine), noCeiling, customCfg, noopAudit));
  }
  assert.deepEqual(audits.map((entry) => entry.detail), ['review-agent', 'review-agent']);
});

test('loopholes denied: arbitrary text after CLAUDE-ONLY:, trailing text on ceiling line, keyword stuffing in tool', () => {
  const denials = [
    'CLAUDE-ONLY: Codex is at 90% ceiling',
    'CLAUDE-ONLY: ceiling because I checked manually',
    'CLAUDE-ONLY: ceiling extra-text',
    'CLAUDE-ONLY: needs the my-db connector',
    'CLAUDE-ONLY: open chrome browser',
    'CLAUDE-ONLY: tool bash',
    'CLAUDE-ONLY: tool browser notes',
    'CLAUDE-ONLY: tool browser\nCLAUDE-ONLY: ceiling',
    'CLAUDE-ONLY: tool',
    'CLAUDE-ONLY: ',
  ];
  for (const prompt of denials) {
    assert.ok(decide(agentCall('general-purpose', prompt), keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), `should deny: ${prompt}`);
    assert.ok(decide(agentCall('general-purpose', prompt), keyOf('gemini'), ceilingsOf('gemini', 'codex'), DEFAULTS, noopAudit), `should deny on gemini: ${prompt}`);
  }
});

test('ceiling exceptions come from the task prompt or leading Workflow comment', () => {
  const task = agentCall('general-purpose', 'Task\nCLAUDE-ONLY: ceiling\nDo work');
  assert.ok(decide(task, keyOf('codex'), noCeiling, DEFAULTS, noopAudit));
  assert.equal(decide(task, keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), null);
  task.tool_input.prompt = 'Task';
  task.tool_input.description = 'CLAUDE-ONLY: ceiling';
  assert.ok(decide(task, keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit));
  const workflow = { session_id: SID, tool_name: 'Workflow', tool_input: { script: 'step()', args: { note: 'CLAUDE-ONLY: ceiling' } } };
  assert.ok(decide(workflow, keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit));
  workflow.tool_input.script = '// CLAUDE-ONLY: ceiling\r\nstep()';
  assert.equal(decide(workflow, keyOf('codex'), ceilingsOf('codex'), DEFAULTS, noopAudit), null);
});

test('missing session, malformed state, and alternate Claude-launching tools are denied', () => {
  const run = (call) => decide(call, keyOf('codex'), noCeiling, DEFAULTS, noopAudit);
  assert.match(run({ ...agentCall('Explore'), session_id: null }), /invalid session ID/);
  assert.match(run(agentCall('Explore', 'task', ' AGENT ')), /denied/);
  assert.ok(run({ ...agentCall('Explore'), session_id: SID + '\n' }));
  // Skill and WebFetch stay usable (blocking them would stop every skill, this one included); see "Known limits".
  for (const name of ['Skill', 'REPL']) assert.equal(run(agentCall(undefined, 'task', name)), null);
  assert.equal(run({ session_id: SID, tool_name: 'WebFetch', tool_input: { prompt: 'Read page' } }), null);
  // Quoted text and heredocs are data; bash -c / eval / $( ) are commands.
  for (const command of ['node -e "s.replace(1, \'(claude -p here)\')"', 'echo "(claude is great)"', "cat > a.md <<'EOF'\nclaude -p x\nEOF\necho done"]) {
    assert.equal(run({ session_id: SID, tool_name: 'Bash', tool_input: { command } }), null, command);
  }
  for (const command of ['bash -c "claude -p x"', 'eval "claude -p z"', 'x=$(claude -p oi)', '"/opt/bin/claude" -p x']) {
    assert.ok(run({ session_id: SID, tool_name: 'Bash', tool_input: { command } }), command);
  }
  for (const tool_name of ['PowerShell', 'Monitor']) {
    assert.ok(run({ session_id: SID, tool_name, tool_input: { command: ' & "C:/Program Files/Claude/Claude.exe" -p "task"' } }));
  }
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

test('CLAUDE-ONLY: tool <name> allows configured tools, logs exception, and lists allowed names on denial', () => {
  const entries = [];
  const capture = (e) => entries.push(e);
  for (const name of ['my-db', 'browser', 'claude.ai Docs']) {
    assert.strictEqual(decide(agentCall('general-purpose', `Run query\nCLAUDE-ONLY: tool ${name}`), keyOf('gemini'), noCeiling, DEFAULTS, capture), null);
  }
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].exception, 'tool');
  assert.strictEqual(entries[0].engine, 'gemini');

  const denyWithList = decide(agentCall('general-purpose', 'CLAUDE-ONLY: tool unknown-tool'), keyOf('codex'), noCeiling, DEFAULTS, noopAudit);
  assert.match(denyWithList, /my-db, browser, claude\.ai Docs/);
  assert.match(denyWithList, /reconfigure/);

  const emptyToolsCfg = { ...config.DEFAULTS, guard: { ...config.DEFAULTS.guard, toolExceptions: [] } };
  const denyEmpty = decide(agentCall('general-purpose', 'CLAUDE-ONLY: tool my-db'), keyOf('codex'), noCeiling, emptyToolsCfg, noopAudit);
  assert.match(denyEmpty, /no Claude-only tool exceptions are configured/);
  assert.match(denyEmpty, /reconfigure/);
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

test('unauditable exceptions are denied; hook output and malformed input follow PreToolUse', () => {
  assert.match(
    decide(agentCall('general-purpose', 'CLAUDE-ONLY: tool my-db'), keyOf('codex'), noCeiling, DEFAULTS, () => { throw new Error('disk full'); }),
    /could not be audited/
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
    assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');

    // Allowed exception appends to claude-exceptions.jsonl
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ guard: { toolExceptions: ['browser'] } }));
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

    // Bash fast-path: normal command exits 0 silently
    const bashOk = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'git log -p' } }),
      encoding: 'utf8',
    });
    assert.strictEqual(bashOk.status, 0);
    assert.strictEqual(bashOk.stdout, '');

    // Bash claude -p denied on codex chat
    const bashDenied = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'claude -p "x"' } }),
      encoding: 'utf8',
    });
    assert.strictEqual(bashDenied.status, 0);
    assert.strictEqual(JSON.parse(bashDenied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Bash: claude -p / --print at command position is denied on codex/gemini; non-print commands pass fast before reading files', () => {
  const bashCall = (command) => ({
    session_id: SID,
    tool_name: 'Bash',
    tool_input: { command },
  });

  const deniedCommands = [
    'claude -p "x"',
    'cd a && claude --model sonnet -p x',
    'npx claude --print x',
    'command "claude" -p x',
    'npx --yes @anthropic-ai/claude-code --print x',
    'claude',
    'CLAUDE --print x',
    'FOO=1 claude -p x',
    '/usr/bin/claude -p x',
    String.raw`C:\bin\claude.exe -p x`,
  ];
  for (const cmd of deniedCommands) {
    const denyCodex = decide(bashCall(cmd), keyOf('codex'), noCeiling, DEFAULTS, noopAudit);
    assert.ok(denyCodex, `codex must deny Bash: ${cmd}`);
    assert.match(denyCodex, /CODEX/);
    assert.ok(decide(bashCall(cmd), keyOf('gemini'), noCeiling, DEFAULTS, noopAudit), `gemini must deny Bash: ${cmd}`);
    assert.strictEqual(decide(bashCall(cmd), keyOf('claude'), noCeiling, DEFAULTS, noopAudit), null, `claude must allow Bash: ${cmd}`);
  }

  // Non-print Bash commands must return null without calling readKey or readCeiling
  const failRead = () => { throw new Error('fast path must not read files'); };
  for (const cmd of ['git log -p', 'echo claude', 'grep -n "claude -p" file.js', 'claude --version', '']) {
    assert.strictEqual(decide(bashCall(cmd), failRead, failRead, DEFAULTS, failRead), null, `must pass fast: ${cmd}`);
  }

  // Even if "bash" is in allowAgents, Bash claude -p is still blocked
  const badCfg = Object.assign({}, DEFAULTS, {
    guard: Object.assign({}, DEFAULTS.guard, { allowAgents: ['bash', 'web-fetch'] }),
  });
  assert.ok(decide(bashCall('claude -p "x"'), keyOf('codex'), noCeiling, badCfg, noopAudit));

  // Shell comment # CLAUDE-ONLY: ceiling works when marker exists
  const withComment = '# CLAUDE-ONLY: ceiling\nclaude -p "x"';
  assert.ok(decide(bashCall(withComment), keyOf('codex'), noCeiling, DEFAULTS, noopAudit));
  const audits = [];
  assert.strictEqual(decide(bashCall(withComment), keyOf('codex'), ceilingsOf('codex'), DEFAULTS, (e) => audits.push(e)), null);
  assert.strictEqual(audits.length, 1);
  assert.strictEqual(audits[0].tool, 'Bash');
  assert.strictEqual(audits[0].exception, 'ceiling');
});
