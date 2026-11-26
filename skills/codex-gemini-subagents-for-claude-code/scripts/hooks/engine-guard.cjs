'use strict';
// Claude Code PreToolUse guard hook (matcher: Agent|Task|Workflow).
// Enforces the per-chat helper engine key (~/.engine-switch/chats/<session>.json):
// - claude -> allow all
// - codex / gemini -> block Claude subagents (empty type, general-purpose, Explore, Plan, fork,
//   any named agent not in guard.allowAgents, and Workflow) unless one of the two valid exceptions is present:
//   1) CLAUDE-ONLY: ceiling  (requires recent ceiling marker for the engine and any codex fallback)
//   2) CLAUDE-ONLY: tool <name>  (where <name> matches configured guard.toolExceptions)
// Every allowed exception is logged to ~/.engine-switch/claude-exceptions.jsonl.
// Any internal error prints nothing and exits 0 so the chat is never broken.
const path = require('path');
const { DEFAULTS, loadConfig } = require('../config.cjs');
const { recentCeiling, appendAuditLog } = require('../ceiling.cjs');
const { readChatKey } = require('../engine-switch.cjs');

const HANDLED_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const DEFAULT_ALLOW_AGENTS = DEFAULTS.guard.allowAgents.slice();
const DEFAULT_TOOL_EXCEPTIONS = DEFAULTS.guard.toolExceptions.slice();

function extractStrings(val, out) {
  const list = out || [];
  if (typeof val === 'string') list.push(val);
  else if (Array.isArray(val)) {
    for (const item of val) extractStrings(item, list);
  } else if (val && typeof val === 'object') {
    for (const k of Object.keys(val)) extractStrings(val[k], list);
  }
  return list;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildToolRegex(toolList) {
  const items = Array.isArray(toolList) && toolList.length ? toolList : DEFAULT_TOOL_EXCEPTIONS;
  return new RegExp('\\b(?:' + items.map((t) => escapeRegex(t.trim())).filter(Boolean).join('|') + ')\\b', 'i');
}

// PURE. Search the entire serialized tool_input for valid exception lines.
function findExceptions(toolInput, toolRegex) {
  const combined = extractStrings(toolInput).join('\n');
  const lines = combined.split(/\r?\n/);
  let ceilingLine = null;
  let toolLine = null;
  let invalidLine = null;

  for (const raw of lines) {
    const m = /^\s*(?:#\s*)?CLAUDE-ONLY:\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const body = m[1].trim();
    if (/^ceiling$/i.test(body)) {
      ceilingLine = 'ceiling';
    } else {
      const tm = /^tool\s+(.+)$/i.exec(body);
      if (tm && toolRegex.test(tm[1])) {
        toolLine = body;
      } else {
        invalidLine = body;
      }
    }
  }
  return { ceilingLine, toolLine, invalidLine };
}

function formatDenial(engine, sessionId, detail, toolExceptions) {
  const list = (toolExceptions && toolExceptions.length ? toolExceptions : DEFAULT_TOOL_EXCEPTIONS).join('|');
  const sid = sessionId || '<session>';
  return (
    'This chat\'s helper engine is ' + engine.toUpperCase() + ' (key ~/.engine-switch/chats/' + sid + '.json). '
    + detail + ' '
    + 'Valid exceptions in the request: '
    + '(1) exact line "CLAUDE-ONLY: ceiling" with a recent ceiling marker; or '
    + '(2) "CLAUDE-ONLY: tool <name>" matching [' + list + '].'
  );
}

function recordAudit(writeAudit, entry, cfg) {
  try {
    if (typeof writeAudit === 'function') {
      writeAudit(entry);
    } else {
      appendAuditLog(entry, undefined, cfg && cfg.guard && cfg.guard.auditLog);
    }
  } catch (_) {
    // audit logging errors must never block the chat
  }
}

// PURE (with injected readers/audit). Returns null to allow, or denial reason string.
function decide(input, readKey, readCeiling, config, writeAudit) {
  if (!input || !HANDLED_TOOLS.has(input.tool_name)) return null;

  const cfg = config || DEFAULTS;
  const guardCfg = cfg.guard || {};
  const isWorkflow = input.tool_name === 'Workflow';
  const ti = input.tool_input || {};
  const subagentType = isWorkflow ? 'Workflow' : String(ti.subagent_type || '').trim().toLowerCase();

  const allowList = new Set(
    (Array.isArray(guardCfg.allowAgents) ? guardCfg.allowAgents : DEFAULT_ALLOW_AGENTS)
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );
  if (!isWorkflow && allowList.has(subagentType)) return null;

  const key = typeof readKey === 'function' ? readKey(input.session_id) : readChatKey(input.session_id, undefined, cfg);
  const engine = key && String(key.helper || '').trim().toLowerCase();
  if (engine !== 'codex' && engine !== 'gemini') return null;

  const toolExceptions = Array.isArray(guardCfg.toolExceptions) && guardCfg.toolExceptions.length
    ? guardCfg.toolExceptions
    : DEFAULT_TOOL_EXCEPTIONS;
  const toolRegex = buildToolRegex(toolExceptions);
  const { ceilingLine, toolLine, invalidLine } = findExceptions(ti, toolRegex);

  if (toolLine) {
    recordAudit(writeAudit, {
      at: Date.now(),
      sessionId: input.session_id || null,
      engine,
      tool: input.tool_name,
      subagentType: subagentType || null,
      exception: 'tool',
      detail: toolLine,
    }, cfg);
    return null;
  }

  const validMinutes = (cfg.switchOn && typeof cfg.switchOn.ceilingValidMinutes === 'number')
    ? cfg.switchOn.ceilingValidMinutes
    : 30;
  const validityMs = validMinutes * 60 * 1000;
  const hasCeiling = typeof readCeiling === 'function'
    ? (eng) => Boolean(readCeiling(eng, validityMs))
    : (eng) => recentCeiling(eng, undefined, undefined, validityMs);

  if (ceilingLine) {
    if (engine === 'codex') {
      if (hasCeiling('codex')) {
        recordAudit(writeAudit, {
          at: Date.now(),
          sessionId: input.session_id || null,
          engine,
          tool: input.tool_name,
          subagentType: subagentType || null,
          exception: 'ceiling',
          detail: ceilingLine,
        }, cfg);
        return null;
      }
      return formatDenial(
        engine,
        input.session_id,
        'Denied: "CLAUDE-ONLY: ceiling" requires a recent Codex ceiling marker (within ' + validMinutes + ' min). Run `node scripts/run-codex.cjs --quota-only` first.',
        toolExceptions
      );
    }

    const fallback = Array.isArray(cfg.fallback) ? cfg.fallback : ['codex', 'claude'];
    const requiresCodex = fallback.includes('codex');
    const gotGemini = hasCeiling('gemini');
    const gotCodex = !requiresCodex || hasCeiling('codex');

    if (gotGemini && gotCodex) {
      recordAudit(writeAudit, {
        at: Date.now(),
        sessionId: input.session_id || null,
        engine,
        tool: input.tool_name,
        subagentType: subagentType || null,
        exception: 'ceiling',
        detail: ceilingLine,
      }, cfg);
      return null;
    }

    if (!gotGemini && !gotCodex) {
      return formatDenial(
        engine,
        input.session_id,
        'Denied: both Gemini and Codex ceiling markers (within ' + validMinutes + ' min) are required before falling back to Claude.',
        toolExceptions
      );
    }
    if (!gotGemini) {
      return formatDenial(
        engine,
        input.session_id,
        'Denied: Gemini ceiling marker (within ' + validMinutes + ' min) is missing.',
        toolExceptions
      );
    }
    return formatDenial(
      engine,
      input.session_id,
      'Denied: Gemini is at ceiling, so fallback must try Codex first. Prove Codex is at ceiling with `node scripts/run-codex.cjs --quota-only`.',
      toolExceptions
    );
  }

  const target = isWorkflow
    ? 'the Workflow tool'
    : 'agent "' + (subagentType || '(general-purpose)') + '"';
  const extra = invalidLine !== null
    ? ' The line "CLAUDE-ONLY: ' + invalidLine + '" is not a valid exception.'
    : '';
  const nextStep = engine === 'gemini'
    ? 'Delegate via `scripts/run-gemini.cjs` (fall back to `scripts/run-codex.cjs` if Gemini exits 3).'
    : 'Delegate via `scripts/run-codex.cjs`.';

  return formatDenial(
    engine,
    input.session_id,
    'Denied because ' + target + ' starts a Claude subagent.' + extra + ' ' + nextStep,
    toolExceptions
  );
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      const cwd = input.cwd || process.cwd();
      const cfg = loadConfig(cwd);
      const reason = decide(
        input,
        (sid) => readChatKey(sid, undefined, cfg),
        (eng, ms) => recentCeiling(eng, undefined, undefined, ms),
        cfg
      );
      if (reason) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }));
      }
    } catch (_) {
      // Internal error: print nothing and exit 0 so the chat is never blocked.
    }
    process.exit(0);
  });
}

module.exports = {
  HANDLED_TOOLS,
  DEFAULT_ALLOW_AGENTS,
  DEFAULT_TOOL_EXCEPTIONS,
  extractStrings,
  buildToolRegex,
  findExceptions,
  decide,
};
