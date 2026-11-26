'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULTS, mergeDeep } = require('../config.cjs');
const { decide, knownAgentTypes, parseAttempt, hasExternalMcp } = require('../hooks/model-router.cjs');

const HOOK_SCRIPT = path.resolve(__dirname, '..', 'hooks', 'model-router.cjs');
const FIND = 'Find where auth.ts handles tokens.';
const SEARCH = 'JOB: search\n' + FIND;
const JUDGE = 'JOB: judgment - diagnose why the test suite failed\n' + FIND;

function call(subagentType, model, prompt = FIND, toolName = 'Agent', extra = {}) {
  const ti = Object.assign({ description: 'helper task', prompt, run_in_background: true }, extra);
  if (subagentType !== undefined) ti.subagent_type = subagentType;
  if (model !== undefined) ti.model = model;
  return { tool_name: toolName, tool_input: ti };
}

test('Explore defaults to Haiku unless declared judgment with a non-reading reason', () => {
  assert.deepStrictEqual(decide(call('Explore', 'sonnet'), DEFAULTS), {
    updatedInput: Object.assign({}, call('Explore', 'sonnet').tool_input, { model: 'haiku' }),
  });
  assert.deepStrictEqual(decide(call('Explore', undefined), DEFAULTS), {
    updatedInput: Object.assign({}, call('Explore', undefined).tool_input, { model: 'haiku' }),
  });
  assert.deepStrictEqual(decide(call('Explore', 'opus', '', 'Task'), DEFAULTS), {
    updatedInput: Object.assign({}, call('Explore', 'opus', '', 'Task').tool_input, { model: 'haiku' }),
  });
  assert.strictEqual(decide(call('Explore', 'haiku'), DEFAULTS), null);

  // Explore with judgment without reason or reading reason stays on Haiku
  assert.deepStrictEqual(decide(call('Explore', 'sonnet', 'JOB: judgment\n' + FIND), DEFAULTS), {
    updatedInput: Object.assign({}, call('Explore', 'sonnet', 'JOB: judgment\n' + FIND).tool_input, { model: 'haiku' }),
  });
  assert.deepStrictEqual(decide(call('Explore', 'sonnet', 'JOB: judgment - read 40 files\n' + FIND), DEFAULTS), {
    updatedInput: Object.assign({}, call('Explore', 'sonnet', 'JOB: judgment - read 40 files\n' + FIND).tool_input, { model: 'haiku' }),
  });

  // Explore with real judgment reason runs on asked model at medium effort
  const jExplore = call('Explore', 'sonnet', 'JOB: judgment - cross-check three sources\n' + FIND);
  assert.deepStrictEqual(decide(jExplore, DEFAULTS), {
    updatedInput: Object.assign({}, jExplore.tool_input, { effort: 'medium' }),
  });
});

test('general subagents without a valid JOB line are denied with clear explanation', () => {
  const missingCases = [
    call('general-purpose', 'sonnet'),
    call('general-purpose', undefined),
    call(undefined, 'sonnet'),
    call('', 'sonnet'),
    call('claude', 'sonnet'),
    call('general-purpose', 'haiku'),
    call('general-purpose', 'sonnet', 'Explain how JOB: search works in the hook.'),
    call('general-purpose', 'sonnet', 'JOB: judgment\n' + FIND),
    call('general-purpose', 'sonnet', FIND + '\nJOB: judgment -   \n'),
    call('general-purpose', 'opus', 'JOB: judgment\ndiagnose PR\n'),
    call('general-purpose', 'sonnet', 'JOB: search and list\n' + FIND),
    call('general-purpose', 'sonnet', 'JOB: searcher\n' + FIND),
    { tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 42 } },
    call('general-purpose', 'sonnet', FIND, 'Task'),
  ];

  for (const c of missingCases) {
    const res = decide(c, DEFAULTS);
    assert.ok(res && typeof res.deny === 'string', 'expected deny for ' + JSON.stringify(c));
    assert.match(res.deny, /JOB: search/);
    assert.match(res.deny, /JOB: judgment/);
    assert.match(res.deny, /ATTEMPT: 2/);
    assert.match(res.deny, /ATTEMPT: 3/);
  }
});

test('general subagents with JOB: search route to Haiku without injecting effort', () => {
  for (const c of [
    call('general-purpose', 'sonnet', SEARCH),
    call('general-purpose', 'sonnet', FIND + '\n  job: Search'),
    call('general-purpose', undefined, SEARCH),
    call('claude', 'opus', SEARCH),
  ]) {
    assert.deepStrictEqual(decide(c, DEFAULTS), {
      updatedInput: Object.assign({}, c.tool_input, { model: 'haiku' }),
    });
  }
  assert.strictEqual(decide(call('general-purpose', 'haiku', SEARCH), DEFAULTS), null);
});

test('general subagents with reading-verb judgment reasons are denied; genuine judgment verbs pass at medium effort', () => {
  const readingExcuses = [
    'JOB: judgment - read all 20 log files',
    'JOB: judgment - reading full conversation logs',
    'JOB: judgment - find where the webhook drops requests',
    'JOB: judgment - (locate the rounding rule)',
    'JOB: judgment - Inventory all guard checks',
    'JOB: judgment - just list the routes in src',
    'JOB: judgment - need to count failing specs',
    'JOB: judgment - extract column names from SQL',
    'JOB: judgment - search every controller for auth',
    'JOB: judgment - read the log and diagnose the bug',
  ];
  for (const p of readingExcuses) {
    const res = decide(call('general-purpose', 'sonnet', p + '\n' + FIND), DEFAULTS);
    assert.ok(res && res.deny, 'reading verb excuse must be denied: ' + p);
    assert.match(res.deny, /JOB: search/);
  }

  const realJudgments = [
    'JOB: judgment - diagnose the failure by reading the log',
    'JOB: judgment - readiness check on the deploy script',
    'JOB: judgment - review the reading of the CSV parser',
    'JOB: judgment - compare two versions of the module',
    'JOB: judgment - (write migration tests)',
  ];
  for (const p of realJudgments) {
    const c = call('general-purpose', 'sonnet', p + '\n' + FIND);
    assert.deepStrictEqual(decide(c, DEFAULTS), {
      updatedInput: Object.assign({}, c.tool_input, { effort: 'medium' }),
    });
  }

  // Both JOB: search and JOB: judgment -> judgment wins
  const both = call('general-purpose', 'sonnet', 'JOB: search\nJOB: judgment - decide which parser to keep\n' + FIND);
  assert.deepStrictEqual(decide(both, DEFAULTS), {
    updatedInput: Object.assign({}, both.tool_input, { effort: 'medium' }),
  });
});

test('ATTEMPT gating: 1 -> medium, 2 -> high (no opus), 3 -> high + opus allowed, 4+ -> denied everywhere', () => {
  // Attempt 1 downgrades opus to sonnet at medium effort
  const a1Opus = call('general-purpose', 'opus', JUDGE);
  assert.deepStrictEqual(decide(a1Opus, DEFAULTS), {
    updatedInput: Object.assign({}, a1Opus.tool_input, { model: 'sonnet', effort: 'medium' }),
  });

  // Attempt 2 raises effort to high, still downgrades opus to sonnet
  const a2Sonnet = call('general-purpose', 'sonnet', JUDGE + '\nATTEMPT: 2');
  assert.deepStrictEqual(decide(a2Sonnet, DEFAULTS), {
    updatedInput: Object.assign({}, a2Sonnet.tool_input, { effort: 'high' }),
  });
  const a2Opus = call('general-purpose', 'opus', JUDGE + '\nATTEMPT: 2');
  assert.deepStrictEqual(decide(a2Opus, DEFAULTS), {
    updatedInput: Object.assign({}, a2Opus.tool_input, { model: 'sonnet', effort: 'high' }),
  });

  // Attempt 3 unlocks opus and uses high effort (takes max ATTEMPT if multiple lines exist)
  const a3Opus = call('general-purpose', 'opus', JUDGE + '\nATTEMPT: 2\n  attempt: 3');
  assert.deepStrictEqual(decide(a3Opus, DEFAULTS), {
    updatedInput: Object.assign({}, a3Opus.tool_input, { effort: 'high' }),
  });

  // Inline text mentioning ATTEMPT: 3 does not count
  const inline = call('general-purpose', 'opus', JUDGE + '\nExplain why ATTEMPT: 3 unlocks Opus.');
  assert.deepStrictEqual(decide(inline, DEFAULTS), {
    updatedInput: Object.assign({}, inline.tool_input, { model: 'sonnet', effort: 'medium' }),
  });

  // Search ignores ATTEMPT: 2 and stays on haiku without effort
  const searchA2 = call('general-purpose', 'opus', SEARCH + '\nATTEMPT: 2');
  assert.deepStrictEqual(decide(searchA2, DEFAULTS), {
    updatedInput: Object.assign({}, searchA2.tool_input, { model: 'haiku' }),
  });

  // Attempt 4+ denied across general, Explore, named agents, and fork
  for (const c of [
    call('general-purpose', 'opus', JUDGE + '\nATTEMPT: 4'),
    call('Explore', 'sonnet', FIND + '\nATTEMPT: 4'),
    call('code-reviewer', 'opus', 'review PR\nATTEMPT: 5'),
    call('fork', undefined, 'continue\nATTEMPT: 4'),
  ]) {
    const res = decide(c, DEFAULTS);
    assert.ok(res && res.deny, 'attempt 4+ must deny');
    assert.match(res.deny, /3 attempts/);
    assert.match(res.deny, /one line/);
  }
});

test('named agents keep their own model and only receive effort when missing (fork untouched)', () => {
  const reviewer = call('code-reviewer', 'opus', 'review PR #10');
  assert.deepStrictEqual(decide(reviewer, DEFAULTS), {
    updatedInput: Object.assign({}, reviewer.tool_input, { effort: 'medium' }),
  });

  const plan = call('Plan', undefined, 'design module');
  assert.deepStrictEqual(decide(plan, DEFAULTS), {
    updatedInput: Object.assign({}, plan.tool_input, { effort: 'medium' }),
  });

  const retryReviewer = call('code-reviewer', 'sonnet', 'review PR #10\nATTEMPT: 2');
  assert.deepStrictEqual(decide(retryReviewer, DEFAULTS), {
    updatedInput: Object.assign({}, retryReviewer.tool_input, { effort: 'high' }),
  });

  // Named agent already on haiku or with explicit effort is left untouched
  assert.strictEqual(decide(call('claude-code-guide', 'haiku', 'how to configure hooks'), DEFAULTS), null);
  assert.strictEqual(decide(call('code-reviewer', 'sonnet', 'review PR', 'Agent', { effort: 'xhigh' }), DEFAULTS), null);
  assert.strictEqual(decide(call('fork', undefined, 'continue here'), DEFAULTS), null);

  // highEffortAgents config option defaults a named agent to high effort
  const highCfg = mergeDeep(DEFAULTS, { modelRouting: { highEffortAgents: ['deliverer'] } });
  const deliv = call('deliverer', 'sonnet', 'ship PR');
  assert.deepStrictEqual(decide(deliv, highCfg), {
    updatedInput: Object.assign({}, deliv.tool_input, { effort: 'high' }),
  });

  // Non-agent tools or malformed inputs are untouched
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, DEFAULTS), null);
  assert.strictEqual(decide({ tool_name: 'Agent' }, DEFAULTS), null);
  assert.strictEqual(decide(null, DEFAULTS), null);
});

test('lean helper swap is off by default, requires transcript listing when enabled, and respects TOOLS: all and MCPs', () => {
  // Off by default even if leanAvailable=true
  assert.deepStrictEqual(decide(call('general-purpose', 'sonnet', JUDGE), DEFAULTS, true), {
    updatedInput: Object.assign({}, call('general-purpose', 'sonnet', JUDGE).tool_input, { effort: 'medium' }),
  });

  const leanOn = mergeDeep(DEFAULTS, { modelRouting: { leanHelper: { enabled: true } } });

  // Enabled + transcript does NOT list helper -> stays general-purpose
  assert.deepStrictEqual(decide(call('general-purpose', 'sonnet', JUDGE), leanOn, false), {
    updatedInput: Object.assign({}, call('general-purpose', 'sonnet', JUDGE).tool_input, { effort: 'medium' }),
  });

  // Enabled + leanAvailable=true -> swaps to helper
  assert.deepStrictEqual(decide(call('general-purpose', 'sonnet', JUDGE), leanOn, true), {
    updatedInput: Object.assign({}, call('general-purpose', 'sonnet', JUDGE).tool_input, {
      subagent_type: 'helper',
      effort: 'medium',
    }),
  });
  assert.deepStrictEqual(decide(call(undefined, 'sonnet', SEARCH), leanOn, true), {
    updatedInput: Object.assign({}, call(undefined, 'sonnet', SEARCH).tool_input, {
      subagent_type: 'helper',
      model: 'haiku',
    }),
  });

  // TOOLS: all keeps general-purpose
  const toolsAll = call('general-purpose', 'sonnet', JUDGE + '\nTOOLS: all');
  assert.deepStrictEqual(decide(toolsAll, leanOn, true), {
    updatedInput: Object.assign({}, toolsAll.tool_input, { effort: 'medium' }),
  });
  // TOOLS: all inline does NOT suppress swap
  const inlineTools = call('general-purpose', 'sonnet', JUDGE + '\nNo need for TOOLS: all here.');
  assert.deepStrictEqual(decide(inlineTools, leanOn, true), {
    updatedInput: Object.assign({}, inlineTools.tool_input, { subagent_type: 'helper', effort: 'medium' }),
  });

  // External mcp__ reference keeps general-purpose unless listed in includedMcps
  const mcpCall = call('general-purpose', 'sonnet', JUDGE + '\nCall mcp__postgres__query');
  assert.deepStrictEqual(decide(mcpCall, leanOn, true), {
    updatedInput: Object.assign({}, mcpCall.tool_input, { effort: 'medium' }),
  });
  const leanWithPg = mergeDeep(leanOn, { modelRouting: { leanHelper: { includedMcps: ['postgres'] } } });
  assert.deepStrictEqual(decide(mcpCall, leanWithPg, true), {
    updatedInput: Object.assign({}, mcpCall.tool_input, { subagent_type: 'helper', effort: 'medium' }),
  });

  // Calling helper directly without JOB: is still denied
  const directMissing = decide(call('helper', 'sonnet'), leanOn, true);
  assert.ok(directMissing && directMissing.deny);
});

test('knownAgentTypes parses agent_listing_delta transcript records accurately', () => {
  const delta = (added, isInitial, removed) => JSON.stringify({
    type: 'attachment',
    attachment: { type: 'agent_listing_delta', addedTypes: added, removedTypes: removed || [], isInitial: !!isInitial },
  });
  const base = ['claude', 'Explore', 'general-purpose'];

  assert.strictEqual(knownAgentTypes([delta(base.concat('helper'), true)].join('\n')).has('helper'), true);
  assert.strictEqual(knownAgentTypes([delta(base, true)].join('\n')).has('helper'), false);
  assert.strictEqual(knownAgentTypes([delta(base, true), delta(['helper'])].join('\n')).has('helper'), true);
  assert.strictEqual(knownAgentTypes([delta(base.concat('helper'), true), delta([], false, ['helper'])].join('\n')).has('helper'), false);
  assert.strictEqual(knownAgentTypes([delta(base.concat('helper'), true), delta(base, true)].join('\n')).has('helper'), false);

  const quoted = JSON.stringify({ type: 'user', message: { content: '"agent_listing_delta" {"addedTypes":["helper"]}' } });
  assert.strictEqual(knownAgentTypes(quoted).has('helper'), false);
  assert.strictEqual(parseAttempt('ATTEMPT: 2\nATTEMPT: 3'), 3);
  assert.strictEqual(hasExternalMcp('use mcp__stripe__list', []), true);
  assert.strictEqual(hasExternalMcp('use mcp__stripe__list', ['stripe']), false);
});

test('hook CLI end-to-end handles deny, allow+updatedInput, lean transcript check, and malformed stdin', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cli-'));
  const home = path.join(tmp, 'home');
  const transcript = path.join(tmp, 'chat.jsonl');
  const env = Object.assign({}, process.env, { ENGINE_SWITCH_HOME: home });

  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(
      mergeDeep(DEFAULTS, { modelRouting: { leanHelper: { enabled: true } } })
    ));
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'attachment',
      attachment: { type: 'agent_listing_delta', addedTypes: ['general-purpose', 'Explore', 'helper'], removedTypes: [], isInitial: true },
    }) + '\n');

    // Deny missing JOB
    const denied = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify(call('general-purpose', 'sonnet', FIND)),
      encoding: 'utf8',
    });
    assert.strictEqual(denied.status, 0);
    const deniedOut = JSON.parse(denied.stdout).hookSpecificOutput;
    assert.strictEqual(deniedOut.hookEventName, 'PreToolUse');
    assert.strictEqual(deniedOut.permissionDecision, 'deny');

    // Rewrite search + swap to helper when transcript lists helper
    const rewritten = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify(Object.assign(call('general-purpose', 'sonnet', SEARCH), { transcript_path: transcript })),
      encoding: 'utf8',
    });
    assert.strictEqual(rewritten.status, 0);
    const rewrittenOut = JSON.parse(rewritten.stdout).hookSpecificOutput;
    assert.strictEqual(rewrittenOut.hookEventName, 'PreToolUse');
    assert.strictEqual(rewrittenOut.permissionDecision, undefined);
    assert.strictEqual(rewrittenOut.updatedInput.model, 'haiku');
    assert.strictEqual(rewrittenOut.updatedInput.subagent_type, 'helper');

    // No-op Explore already on haiku -> empty stdout, exit 0
    const noop = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: JSON.stringify(call('Explore', 'haiku', FIND)),
      encoding: 'utf8',
    });
    assert.strictEqual(noop.status, 0);
    assert.strictEqual(noop.stdout, '');

    // Malformed stdin -> empty stdout, exit 0
    const broken = cp.spawnSync(process.execPath, [HOOK_SCRIPT], {
      env,
      input: '{not-json',
      encoding: 'utf8',
    });
    assert.strictEqual(broken.status, 0);
    assert.strictEqual(broken.stdout, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('judgment without model defaults to Sonnet and policy applies despite explicit effort', () => {
  const judgment = call(' Explore ', undefined, JUDGE, 'Agent', { effort: 'max' });
  assert.deepEqual(decide(judgment, DEFAULTS).updatedInput, { ...judgment.tool_input, model: 'sonnet', effort: 'medium' });
  const search = decide(call('general-purpose', 'haiku', SEARCH, 'Agent', { effort: 'max' }), DEFAULTS);
  assert.equal(Object.hasOwn(search.updatedInput, 'effort'), false);
  assert.equal(parseAttempt('ATTEMPT: 3 candidates'), 1);
  assert.equal(parseAttempt('ATTEMPT: 3\r\n'), 3);
});
