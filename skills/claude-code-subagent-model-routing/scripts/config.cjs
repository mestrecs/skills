'use strict';
// Reads, validates, and writes shared engine-switch + model-routing configuration.
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

const DEFAULT_READING_VERBS = [
  'read', 'reading',
  'find', 'finding',
  'locate', 'locating',
  'list', 'listing',
  'count', 'counting',
  'extract', 'extracting',
  'search', 'searching',
  'inventory', 'inventorying',
];

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
    model: 'gpt-6.2-sol',
    effort: 'medium',
    maxConcurrent: 2,
    sharedAccount: false,
    sharePct: 100,
  },
  gemini: {
    cli: 'gemini',
    model: 'gemini-4-hydrogen-high',
    maxConcurrent: 1,
    sharedAccount: false,
    sharePct: 100,
  },
  guard: {
    allowAgents: ['web-fetch', 'claude-code-guide', 'statusline-setup'],
    toolExceptions: ['mcp', 'browser', 'chrome', 'supabase', 'database'],
    auditLog: '~/.engine-switch/claude-exceptions.jsonl',
  },
  modelRouting: {
    searchModel: 'haiku',
    defaultEffort: 'medium',
    retryEffort: 'high',
    opusMinAttempt: 3,
    maxAttempts: 3,
    capNamedAgentOpus: false,
    highEffortAgents: [],
    readingVerbs: DEFAULT_READING_VERBS.slice(),
    leanHelper: {
      enabled: false,
      agentName: 'helper',
      requireTranscriptListing: true,
      includedMcps: [],
    },
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
    if (isObj(extra[k]) && isObj(base[k])) out[k] = mergeDeep(base[k], extra[k]);
    else out[k] = extra[k];
  }
  return out;
}

function isPct(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
}

function isSafeModel(m) {
  return typeof m === 'string' && m.length > 0 && /^[\w.:\/<>-]+$/.test(m);
}

function isStringArray(arr) {
  return Array.isArray(arr) && arr.every((item) => typeof item === 'string' && item.trim().length > 0);
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
  if (typeof sw.ceilingValidMinutes !== 'number' || !Number.isFinite(sw.ceilingValidMinutes) || sw.ceilingValidMinutes <= 0) {
    errors.push('switchOn.ceilingValidMinutes must be a positive number');
  }

  const cx = cfg.codex || {};
  if (!isSafeModel(cx.model)) errors.push('codex.model must be a safe non-empty model name');
  if (!KNOWN_EFFORTS.includes(cx.effort)) errors.push('codex.effort must be low, medium or high');
  if (!Number.isInteger(cx.maxConcurrent) || cx.maxConcurrent < 1) errors.push('codex.maxConcurrent must be an integer >= 1');
  if (typeof cx.sharedAccount !== 'boolean') errors.push('codex.sharedAccount must be a boolean');
  if (typeof cx.sharePct !== 'number' || !Number.isFinite(cx.sharePct) || cx.sharePct < 1 || cx.sharePct > 100) {
    errors.push('codex.sharePct must be a number between 1 and 100');
  }

  const gm = cfg.gemini || {};
  if (!KNOWN_GEMINI_CLIS.includes(gm.cli)) errors.push('gemini.cli must be gemini or agy');
  if (!isSafeModel(gm.model)) errors.push('gemini.model must be a safe non-empty model name');
  if (!Number.isInteger(gm.maxConcurrent) || gm.maxConcurrent < 1) errors.push('gemini.maxConcurrent must be an integer >= 1');
  if (typeof gm.sharedAccount !== 'boolean') errors.push('gemini.sharedAccount must be a boolean');
  if (typeof gm.sharePct !== 'number' || !Number.isFinite(gm.sharePct) || gm.sharePct < 1 || gm.sharePct > 100) {
    errors.push('gemini.sharePct must be a number between 1 and 100');
  }

  const g = cfg.guard || {};
  if (!isStringArray(g.allowAgents)) errors.push('guard.allowAgents must be a list of non-empty agent names');
  if (!isStringArray(g.toolExceptions)) errors.push('guard.toolExceptions must be a list of non-empty tool keywords');
  if (typeof g.auditLog !== 'string' || !g.auditLog.trim()) errors.push('guard.auditLog must be a non-empty path');

  const mr = cfg.modelRouting || {};
  if (!isSafeModel(mr.searchModel)) errors.push('modelRouting.searchModel must be a safe non-empty model name');
  if (!KNOWN_EFFORTS.includes(mr.defaultEffort)) errors.push('modelRouting.defaultEffort must be low, medium or high');
  if (!KNOWN_EFFORTS.includes(mr.retryEffort)) errors.push('modelRouting.retryEffort must be low, medium or high');
  if (!Number.isInteger(mr.opusMinAttempt) || mr.opusMinAttempt < 1) {
    errors.push('modelRouting.opusMinAttempt must be an integer >= 1');
  }
  if (!Number.isInteger(mr.maxAttempts) || mr.maxAttempts < 1) {
    errors.push('modelRouting.maxAttempts must be an integer >= 1');
  }
  if (typeof mr.capNamedAgentOpus !== 'boolean') {
    errors.push('modelRouting.capNamedAgentOpus must be a boolean');
  }
  if (!isStringArray(mr.highEffortAgents)) {
    errors.push('modelRouting.highEffortAgents must be a list of non-empty agent names');
  }
  if (!isStringArray(mr.readingVerbs) || mr.readingVerbs.length === 0) {
    errors.push('modelRouting.readingVerbs must be a non-empty list of verbs');
  }
  const lh = mr.leanHelper || {};
  if (typeof lh.enabled !== 'boolean') errors.push('modelRouting.leanHelper.enabled must be a boolean');
  if (typeof lh.agentName !== 'string' || !/^[\w.-]+$/.test(lh.agentName)) {
    errors.push('modelRouting.leanHelper.agentName must be a safe non-empty agent name');
  }
  if (typeof lh.requireTranscriptListing !== 'boolean') {
    errors.push('modelRouting.leanHelper.requireTranscriptListing must be a boolean');
  }
  if (!isStringArray(lh.includedMcps)) {
    errors.push('modelRouting.leanHelper.includedMcps must be a list of non-empty MCP prefixes');
  }

  return errors;
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function globalConfigPath(home) {
  return path.join(engineHome(home), 'config.json');
}

function loadConfig(cwd, home) {
  let cfg = mergeDeep(DEFAULTS, {});
  const globalUser = readJsonSafe(globalConfigPath(home));
  if (globalUser) cfg = mergeDeep(cfg, globalUser);
  if (cwd) {
    const projectUser = readJsonSafe(path.join(cwd, '.engine-switch.json'));
    if (projectUser) cfg = mergeDeep(cfg, projectUser);
  }
  return cfg;
}

function writeConfig(rawCfg, filePath, home) {
  const cfg = mergeDeep(DEFAULTS, rawCfg || {});
  const errors = validateConfig(cfg);
  if (errors.length) {
    const err = new Error('invalid config:\n - ' + errors.join('\n - '));
    err.code = 'BADCONFIG';
    throw err;
  }
  const dest = filePath || globalConfigPath(home);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return dest;
}

function main(argv) {
  const args = argv || [];
  if (args[0] === '--validate' && args[1]) {
    const raw = JSON.parse(fs.readFileSync(args[1], 'utf8'));
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
  DEFAULT_READING_VERBS,
  DEFAULTS,
  engineHome,
  mergeDeep,
  validateConfig,
  loadConfig,
  writeConfig,
  globalConfigPath,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
