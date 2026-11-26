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
  return typeof id === 'string' && id === id.trim() && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

// PURE.
function defaultChatKey(cfg) {
  const d = (cfg && cfg.defaults) || {};
  return {
    helper: cfg && cfg.newChatsMode === 'all-chats' && KNOWN_ENGINES.includes(d.helper) ? d.helper : 'claude',
    reviewer: KNOWN_ENGINES.includes(d.reviewer) ? d.reviewer : 'codex',
    history: [],
  };
}

function chatKeyPath(sessionId, home) {
  if (!isValidSessionId(sessionId)) return null;
  const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)
    ? sessionId.toLowerCase()
    : sessionId;
  return path.join(engineHome(home), 'chats', id + '.json');
}

function readChatKey(sessionId, home, cfg) {
  const resolvedCfg = cfg || loadConfig(undefined, home);
  const def = defaultChatKey(resolvedCfg);
  const file = chatKeyPath(sessionId, home);
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const fields = Object.keys(parsed).map((name) => name.trim().toLowerCase());
    if (!fields.some((name) => VALID_ROLES.includes(name))
      || fields.some((name) => !VALID_ROLES.includes(name) && name !== 'history')) return null;
    const key = { ...def, history: Array.isArray(parsed.history) ? parsed.history : [] };
    for (const role of VALID_ROLES) {
      const names = Object.keys(parsed).filter((name) => name.trim().toLowerCase() === role);
      if (names.length === 0) continue;
      if (names.length !== 1 || typeof parsed[names[0]] !== 'string') return null;
      key[role] = parsed[names[0]].trim().toLowerCase();
      if (!KNOWN_ENGINES.includes(key[role])) return null;
    }
    return key;
  } catch (err) {
    return err.code === 'ENOENT' ? def : null;
  }
}

function updateChatKey(sessionId, role, engine, reason, home, cfg) {
  if (!isValidSessionId(sessionId)) throw new Error('invalid or missing --chat <session-id>');
  if (!VALID_ROLES.includes(role)) throw new Error('role must be helper or reviewer');
  if (!KNOWN_ENGINES.includes(engine)) throw new Error('engine must be codex, gemini or claude');
  const current = readChatKey(sessionId, home, cfg);
  if (!current) throw new Error('invalid chat key; restore it before switching engines');
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
  const temp = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
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
    if (!key) {
      console.error('invalid chat key');
      return 2;
    }
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

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
