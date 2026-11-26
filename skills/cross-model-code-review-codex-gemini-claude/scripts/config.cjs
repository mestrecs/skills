'use strict';
// Reads, validates and writes engine-switch configuration.
// Global config: ~/.engine-switch/config.json (overridable via ENGINE_SWITCH_HOME).
// Optional project override: <cwd>/.engine-switch.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const KNOWN_ENGINES = ['codex', 'gemini', 'claude'];
const KNOWN_EFFORTS = ['low', 'medium', 'high'];
const KNOWN_GEMINI_CLIS = ['gemini', 'agy'];
const KNOWN_SWITCH_MODES = ['percent-or-error', 'error-only'];
const KNOWN_CHAT_MODES = ['opt-in', 'all-chats'];

const DEFAULTS = {
  version: 1,
  engines: ['codex', 'gemini', 'claude'],
  defaults: {
    helper: 'claude',
    reviewer: 'codex',
  },
  newChatsMode: 'opt-in',
  fallback: ['codex', 'claude'],
  switchOn: {
    mode: 'percent-or-error',
    maxWindowPct: 90,
    maxWeekPct: 80,
    stopMidRun: true,
    ceilingValidMinutes: 30,
  },
  codex: {
    model: '<latest>',
    effort: 'medium',
    maxConcurrent: 2,
    sharedAccount: false,
    sharePct: 100,
  },
  gemini: {
    cli: 'gemini',
    model: '<latest>',
    maxConcurrent: 1,
    sharedAccount: false,
    sharePct: 100,
  },
  review: {
    order: ['codex', 'gemini', 'claude'],
    maxConcurrent: 3,
    timeoutMinutes: 60,
    auditLog: '~/.engine-switch/review-history.jsonl',
    claude: {
      model: 'sonnet',
      effort: 'medium',
    },
  },
  guard: {
    allowAgents: [],
    toolExceptions: [],
    auditLog: '~/.engine-switch/claude-exceptions.jsonl',
  },
};

function engineHome(home) {
  return home || process.env.ENGINE_SWITCH_HOME || path.join(os.homedir(), '.engine-switch');
}

function isObj(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

// Objects merge key by key; arrays and scalars from extra replace base.
function mergeDeep(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isObj(extra[k]) && isObj(base[k])) out[k] = mergeDeep(base[k], extra[k]);
    else out[k] = extra[k];
  }
  return out;
}

function isPct(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

function isSafeModel(m) {
  return typeof m === 'string' && (m === '<latest>' || /^[\w][\w.:\/ -]*$/.test(m));
}

// PURE. Returns an array of validation error strings (empty = valid).
function validateConfig(cfg) {
  const errors = [];
  if (!isObj(cfg)) return ['config must be an object'];
  if (cfg.version !== 1) errors.push('version must be 1');

  if (!Array.isArray(cfg.engines) || cfg.engines.length === 0 || cfg.engines.some((e) => !KNOWN_ENGINES.includes(e))) {
    errors.push('engines must be a non-empty list of codex, gemini, claude');
  }

  const d = cfg.defaults || {};
  if (!KNOWN_ENGINES.includes(d.helper)) errors.push('defaults.helper must be codex, gemini or claude');
  if (!KNOWN_ENGINES.includes(d.reviewer)) errors.push('defaults.reviewer must be codex, gemini or claude');
  if (!KNOWN_CHAT_MODES.includes(cfg.newChatsMode)) errors.push('newChatsMode must be opt-in or all-chats');

  if (!Array.isArray(cfg.fallback) || cfg.fallback.length === 0 || cfg.fallback.some((e) => !KNOWN_ENGINES.includes(e))) {
    errors.push('fallback must be a non-empty list of codex, gemini, claude');
  }

  const sw = cfg.switchOn || {};
  if (!KNOWN_SWITCH_MODES.includes(sw.mode)) errors.push('switchOn.mode must be percent-or-error or error-only');
  if (!isPct(sw.maxWindowPct)) errors.push('switchOn.maxWindowPct must be a number between 0 and 100');
  if (!isPct(sw.maxWeekPct)) errors.push('switchOn.maxWeekPct must be a number between 0 and 100');
  if (typeof sw.stopMidRun !== 'boolean') errors.push('switchOn.stopMidRun must be a boolean');
  if (typeof sw.ceilingValidMinutes !== 'number' || !Number.isFinite(sw.ceilingValidMinutes * 60_000) || sw.ceilingValidMinutes <= 0) {
    errors.push('switchOn.ceilingValidMinutes must be a positive number');
  }

  const cx = cfg.codex || {};
  if (!isSafeModel(cx.model)) errors.push('codex.model must be a safe non-empty model name');
  if (!KNOWN_EFFORTS.includes(cx.effort)) errors.push('codex.effort must be low, medium or high');
  if (!Number.isSafeInteger(cx.maxConcurrent) || cx.maxConcurrent < 1) errors.push('codex.maxConcurrent must be an integer >= 1');
  if (typeof cx.sharedAccount !== 'boolean') errors.push('codex.sharedAccount must be a boolean');
  if (typeof cx.sharePct !== 'number' || !Number.isFinite(cx.sharePct) || cx.sharePct < 1 || cx.sharePct > 100) {
    errors.push('codex.sharePct must be a number between 1 and 100');
  }

  const gm = cfg.gemini || {};
  if (!KNOWN_GEMINI_CLIS.includes(gm.cli)) errors.push('gemini.cli must be gemini or agy');
  if (gm.effort !== undefined && (gm.cli !== 'agy' || !KNOWN_EFFORTS.includes(gm.effort))) errors.push('gemini.effort requires agy and must be low, medium or high');
  if (!isSafeModel(gm.model)) errors.push('gemini.model must be a safe non-empty model name');
  if (!Number.isSafeInteger(gm.maxConcurrent) || gm.maxConcurrent < 1) errors.push('gemini.maxConcurrent must be an integer >= 1');
  if (typeof gm.sharedAccount !== 'boolean') errors.push('gemini.sharedAccount must be a boolean');
  if (typeof gm.sharePct !== 'number' || !Number.isFinite(gm.sharePct) || gm.sharePct < 1 || gm.sharePct > 100) {
    errors.push('gemini.sharePct must be a number between 1 and 100');
  }

  const rv = cfg.review || {};
  if (!Array.isArray(rv.order) || rv.order.length === 0 || rv.order.some((e) => !KNOWN_ENGINES.includes(e))) {
    errors.push('review.order must be a non-empty list of codex, gemini, claude');
  }
  if (!Number.isSafeInteger(rv.maxConcurrent) || rv.maxConcurrent < 1) errors.push('review.maxConcurrent must be an integer >= 1');
  if (typeof rv.timeoutMinutes !== 'number' || !Number.isFinite(rv.timeoutMinutes) || rv.timeoutMinutes <= 0 || rv.timeoutMinutes * 60_000 > 2_147_483_647) {
    errors.push('review.timeoutMinutes must fit in a positive Node timer');
  }
  for (const engine of KNOWN_ENGINES) {
    const limit = rv[engine]?.maxConcurrent;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      errors.push('review.' + engine + '.maxConcurrent must be an integer >= 1');
    }
  }
  if (rv.auditLog !== undefined && (typeof rv.auditLog !== 'string' || !rv.auditLog.trim())) {
    errors.push('review.auditLog must be a non-empty path');
  }
  const rc = rv.claude || {};
  if (!isSafeModel(rc.model)) errors.push('review.claude.model must be a safe non-empty model name');
  if (!KNOWN_EFFORTS.includes(rc.effort)) errors.push('review.claude.effort must be low, medium or high');

  const g = cfg.guard || {};
  if (!Array.isArray(g.allowAgents) || g.allowAgents.some((a) => typeof a !== 'string' || !/^[a-z0-9_.:-]+$/i.test(a.trim()))) {
    errors.push('guard.allowAgents must be a list of non-empty agent names');
  }
  if (!Array.isArray(g.toolExceptions) || g.toolExceptions.some((t) => typeof t !== 'string' || !/^[a-z0-9_.:-]+$/i.test(t.trim()))) {
    errors.push('guard.toolExceptions must be a list of exact tool names');
  }
  if (typeof g.auditLog !== 'string' || !g.auditLog.trim()) {
    errors.push('guard.auditLog must be a non-empty path');
  }

  return errors;
}

function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let cfg;
  try { cfg = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (_) {}
  if (!isObj(cfg)) throw Object.assign(new Error('config must be a JSON object'), { code: 'BADCONFIG' });
  return cfg;
}

function assertValidConfig(cfg) {
  const errors = validateConfig(cfg);
  if (errors.length) throw Object.assign(new Error('invalid config: ' + errors.join('; ')), { code: 'BADCONFIG' });
  return cfg;
}

function globalConfigPath(home) {
  return path.join(engineHome(home), 'config.json');
}

function loadConfig(cwd, home) {
  let cfg = mergeDeep(DEFAULTS, {});
  const globalUser = readConfigFile(globalConfigPath(home));
  if (globalUser) cfg = mergeDeep(cfg, globalUser);
  if (cwd) {
    const projectUser = readConfigFile(path.join(cwd, '.engine-switch.json'));
    if (projectUser) cfg = mergeDeep(cfg, projectUser);
  }
  return assertValidConfig(cfg);
}

function writeConfig(rawCfg, filePath, home) {
  if (!isObj(rawCfg)) throw Object.assign(new Error('config must be an object'), { code: 'BADCONFIG' });
  const cfg = assertValidConfig(mergeDeep(DEFAULTS, rawCfg));
  const dest = filePath || globalConfigPath(home);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return dest;
}

function resolveAuditLogPath(auditLog, home) {
  const base = engineHome(home);
  const raw = String(auditLog || DEFAULTS.guard.auditLog);
  if (raw.startsWith('~/.engine-switch/') || raw.startsWith('~/.engine-switch\\')) {
    return path.join(base, raw.slice('~/.engine-switch/'.length));
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function main(argv) {
  const args = argv || [];
  if (args[0] === '--validate' && args[1]) {
    const raw = readConfigFile(args[1]);
    if (!raw) throw new Error('config file not found');
    const cfg = mergeDeep(DEFAULTS, raw);
    const errors = validateConfig(cfg);
    if (errors.length) {
      console.error(errors.join('\n'));
      return 2;
    }
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  }
  if (args[0] === '--write' && args[1]) {
    const raw = JSON.parse(args[1]);
    const dest = writeConfig(raw);
    console.log(dest);
    return 0;
  }
  console.log(JSON.stringify(loadConfig(process.cwd()), null, 2));
  return 0;
}

module.exports = {
  KNOWN_ENGINES,
  KNOWN_EFFORTS,
  KNOWN_GEMINI_CLIS,
  KNOWN_SWITCH_MODES,
  KNOWN_CHAT_MODES,
  DEFAULTS,
  engineHome,
  mergeDeep,
  validateConfig,
  loadConfig,
  writeConfig,
  globalConfigPath,
  resolveAuditLogPath,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
