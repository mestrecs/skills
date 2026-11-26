'use strict';
// Per-chat engine key in ~/.engine-switch/chats/<session>.json.
// Usage:
//   node engine-switch.cjs --chat <session-id>
//   node engine-switch.cjs --chat <session-id> <helper|reviewer> <codex|gemini|claude> ["reason"]
const fs = require('fs');
const path = require('path');
const { KNOWN_ENGINES, engineHome, loadConfig } = require('./config.cjs');

const VALID_ROLES = ['helper', 'reviewer'];

// PURE.
function isValidSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(id);
}

// PURE.
function defaultChatKey(cfg) {
  const d = (cfg && cfg.defaults) || {};
  return {
    helper: KNOWN_ENGINES.includes(d.helper) ? d.helper : 'claude',
    reviewer: KNOWN_ENGINES.includes(d.reviewer) ? d.reviewer : 'codex',
    history: [],
  };
}

function chatKeyPath(sessionId, home) {
  if (!isValidSessionId(sessionId)) return null;
  return path.join(engineHome(home), 'chats', sessionId + '.json');
}

function readChatKey(sessionId, home, cfg) {
  const resolvedCfg = cfg || loadConfig(process.cwd(), home);
  const def = defaultChatKey(resolvedCfg);
  const file = chatKeyPath(sessionId, home);
  if (!file || !fs.existsSync(file)) return def;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({}, def, parsed);
  } catch (_) {
    return def;
  }
}

function updateChatKey(sessionId, role, engine, reason, home, cfg) {
  if (!isValidSessionId(sessionId)) throw new Error('invalid or missing --chat <session-id>');
  if (!VALID_ROLES.includes(role)) throw new Error('role must be helper or reviewer');
  if (!KNOWN_ENGINES.includes(engine)) throw new Error('engine must be codex, gemini or claude');
  const current = readChatKey(sessionId, home, cfg);
  const entry = {
    at: new Date().toISOString(),
    role,
    from: current[role],
    to: engine,
    reason: String(reason || ''),
  };
  current.history = (Array.isArray(current.history) ? current.history : []).concat([entry]).slice(-30);
  current[role] = engine;
  const file = chatKeyPath(sessionId, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
  return current;
}

// PURE.
function parseArgs(argv) {
  const args = Array.from(argv || []);
  const idx = args.indexOf('--chat');
  const chat = idx >= 0 ? args[idx + 1] : null;
  const rest = idx >= 0 ? args.slice(0, idx).concat(args.slice(idx + 2)) : args;
  return { chat, role: rest[0] || null, engine: rest[1] || null, reason: rest[2] || '' };
}

function main(argv) {
  const { chat, role, engine, reason } = parseArgs(argv);
  if (!isValidSessionId(chat)) {
    console.error('usage: engine-switch.cjs --chat <session-id> [<helper|reviewer> <codex|gemini|claude> ["reason"]]');
    return 2;
  }
  if (!role) {
    const key = readChatKey(chat);
    console.log('chat ' + chat.slice(0, 8) + ': helper ' + key.helper + ' | reviewer ' + key.reviewer);
    return 0;
  }
  if (!VALID_ROLES.includes(role) || !KNOWN_ENGINES.includes(engine)) {
    console.error('usage: engine-switch.cjs --chat <session-id> <helper|reviewer> <codex|gemini|claude> ["reason"]');
    return 2;
  }
  const updated = updateChatKey(chat, role, engine, reason);
  console.log('OK ' + role + ' -> ' + engine + ' for chat ' + chat.slice(0, 8) + '. Now: helper ' + updated.helper + ' | reviewer ' + updated.reviewer);
  return 0;
}

module.exports = {
  VALID_ROLES,
  isValidSessionId,
  defaultChatKey,
  chatKeyPath,
  readChatKey,
  updateChatKey,
  parseArgs,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
