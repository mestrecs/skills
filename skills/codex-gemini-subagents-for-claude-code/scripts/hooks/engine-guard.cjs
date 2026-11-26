'use strict';
// PreToolUse routing guard. Shell inspection is a direct-invocation check, not a sandbox.
const { DEFAULTS, loadConfig } = require('../config.cjs');
const { recentCeiling, appendAuditLog } = require('../ceiling.cjs');
const { isValidSessionId, readChatKey } = require('../engine-switch.cjs');

const AGENT_TOOLS = new Set(['agent', 'task']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'monitor']);
// Only tools that start Claude agents or run commands. Skill and WebFetch stay usable: blocking them would stop the
// chat from using any skill (including this one) or reading a page; see references/guard-hook.md, "Known limits".
const HANDLED_TOOLS = new Set([...AGENT_TOOLS, ...SHELL_TOOLS, 'workflow']);
const CLAUDE_COMMAND = /(?:^|[;&|(\n]|[$\x60])\s*(?:(?:[a-z_]\w*=[^\s]+|command|exec|env|sudo|nohup|npx(?:\s+--yes)?|&)\s+)*(?:["'](?:[^"'\r\n]*[\\/])?(?:claude|@anthropic-ai\/claude-code)(?:\.(?:exe|cmd|ps1|bat))?["']|(?:[^\s"';&|()]*[\\/])?(?:claude|@anthropic-ai\/claude-code)(?:\.(?:exe|cmd|ps1|bat))?)(?=\s|[;&|)]|$)/im;
const INFORMATION_ONLY = /^\s+(?:--version|-v|--help|-h)\s*$/i;

// Quoted text and heredoc bodies are data, not commands (`node -e "... (claude -p) ..."`, `echo "(claude is ...)"`).
// Exceptions: text right after `-c`, `/c`, `-Command` or `eval` is a command again (`bash -c "claude -p x"`), and a quoted
// word without spaces stays as-is so a quoted binary path (`"/opt/bin/claude" -p`) is still caught.
function stripText(command) {
  let s = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?:\n|$)/g, '\n');
  s = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (m, off, all) => {
    if (/(?:\s-c|\s\/c|-Command|\beval)\s*$/i.test(all.slice(0, off))) return '; ' + m.slice(1, -1);
    // A quoted word in command position is a program path, spaces or not (`& "C:/Program Files/.../claude.exe" -p`).
    if (/(?:^|[;&|(\n$\x60])\s*(?:&\s*)?$/.test(all.slice(0, off))) return m;
    return /\s/.test(m) ? '""' : m;
  });
  return s;
}

function isClaudeShell(toolInput) {
  if (!toolInput || typeof toolInput.command !== 'string') return false;
  const command = stripText(toolInput.command.replace(/(?:\\|\x60)\r?\n/g, ''));
  const match = CLAUDE_COMMAND.exec(command);
  return Boolean(match && !INFORMATION_ONLY.test(command.slice(match.index + match[0].length)));
}

function findException(text, comment) {
  if (typeof text !== 'string') return null;
  const lines = text.trimStart().split(/\r?\n/);
  // A shell or workflow declaration must be its own leading source comment.
  if (comment) {
    if (!lines[0].startsWith(comment)) return null;
    lines.splice(0, lines.length, lines[0].slice(comment.length));
  }
  const declarations = lines.map((line) => /^[ \t]*CLAUDE-ONLY:[ \t]*(.*?)[ \t]*$/i.exec(line)).filter(Boolean);
  if (declarations.length !== 1) return null;
  const body = declarations[0][1];
  if (/^ceiling$/i.test(body)) return { kind: 'ceiling', detail: 'ceiling' };
  const tool = /^tool[ \t]+([a-z0-9_.:-]+)$/i.exec(body);
  return tool ? { kind: 'tool', detail: tool[1].toLowerCase() } : null;
}

function decide(input, readKey, readCeiling, config, writeAudit) {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name.trim().toLowerCase() : '';
  if (!HANDLED_TOOLS.has(tool)) return null;

  const ti = input.tool_input || {};
  const shell = SHELL_TOOLS.has(tool);
  if (shell && !isClaudeShell(ti)) return null;
  if (!isValidSessionId(input.session_id)) return 'Claude routing denied: missing or invalid session ID.';

  const cfg = config || DEFAULTS;
  const guard = cfg.guard || {};
  const key = readKey ? readKey(input.session_id) : readChatKey(input.session_id, undefined, cfg);
  const engine = key?.helper;
  if (engine === 'claude') return null;
  if (engine !== 'codex' && engine !== 'gemini') return 'Claude routing denied: invalid chat engine key.';

  const rawType = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
  const type = /^[a-z0-9_.:-]+$/i.test(rawType) ? rawType.toLowerCase() : '';
  const decl = shell ? findException(ti.command, '#')
    : tool === 'workflow' ? findException(ti.script, '//')
      : findException(ti.prompt);
  const allowed = (list, name) => Array.isArray(list) && list.some((value) =>
    typeof value === 'string' && value.trim().toLowerCase() === name
  );
  const allowedNamedAgent = decl && AGENT_TOOLS.has(tool) && type === decl.detail
    && !['general-purpose', 'claude', 'fork', 'explore', 'plan'].includes(type)
    && !ti.team_name && !ti.name && !ti.fork
    && allowed(guard.allowAgents, type);
  const ceilingMs = cfg.switchOn?.ceilingValidMinutes * 60 * 1000;
  const hasCeiling = readCeiling || ((eng, ms) => recentCeiling(eng, undefined, undefined, ms));

  let denial = 'include one exact line "CLAUDE-ONLY: ceiling" or "CLAUDE-ONLY: tool <name>" in the task prompt (leading comment for shell or Workflow).';
  let permitted = false;
  if (decl?.kind === 'tool') {
    permitted = allowedNamedAgent || allowed(guard.toolExceptions, decl.detail);
    if (!permitted) denial = 'the named Claude-only tool is not allow-listed.';
  }
  if (decl?.kind === 'ceiling') {
    const enabled = cfg.engines || DEFAULTS.engines;
    const order = [engine, ...new Set(cfg.fallback || DEFAULTS.fallback)].filter((name) => enabled.includes(name));
    const claude = order.indexOf('claude');
    if (claude < 1) {
      denial = 'the configured fallback does not reach Claude.';
    } else {
      const required = [...new Set(order.slice(0, claude))];
      permitted = Number.isFinite(ceilingMs) && ceilingMs > 0 && required.every((name) => hasCeiling(name, ceilingMs));
      if (!permitted) denial = 'a recent ceiling marker is required for ' + required.join(', ') + '.';
    }
  }

  if (permitted) {
    const entry = {
      at: Date.now(), sessionId: input.session_id, engine, tool: input.tool_name,
      subagentType: type || null, exception: decl.kind, detail: decl.detail,
    };
    try {
      const result = writeAudit ? writeAudit(entry) : appendAuditLog(entry, undefined, guard.auditLog);
      if (result !== false) return null;
    } catch (_) {
      // An exception is authorized only if it can be recorded.
    }
    denial = 'the Claude exception could not be audited.';
  }
  return engine.toUpperCase() + ' helper routing denied ' + input.tool_name + ': ' + denial;
}

if (require.main === module) {
  process.stdin.setEncoding('utf8');
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const tool = typeof input?.tool_name === 'string' ? input.tool_name.trim().toLowerCase() : '';
      if (!HANDLED_TOOLS.has(tool) || (SHELL_TOOLS.has(tool) && !isClaudeShell(input.tool_input))) return;
      let reason;
      try {
        reason = decide(input, undefined, undefined, loadConfig());
      } catch (err) {
        if (err.code !== 'BADCONFIG') throw err;
        reason = 'Claude routing denied because the user-level engine configuration is invalid.';
      }
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
      // Internal error: stay silent and exit 0.
    }
  });
}

module.exports = { decide };
