'use strict';
// Reads and validates .parallel-pr.json. CLI: node config.cjs [--dir <path>]  (prints the resolved config)
const fs = require('fs');
const path = require('path');
const { git, parseFlags } = require('./common.cjs');

const CONFIG_FILE = '.parallel-pr.json';

const DEFAULTS = {
  version: 1,
  repo: null,
  baseBranch: 'main',
  docsDirectToBase: false,
  worktreeDir: '../<repo>-wt',
  linkDependencies: ['node_modules'],
  testCommand: null,
  quickCheckCommand: null,
  parallel: { suiteSlots: 2, stuckSuiteMinutes: 15, minFreeMemoryGB: 2 },
  review: {
    requiredFor: 'critical',
    criticalPaths: [],
    engines: ['claude'],
    claude: { model: 'sonnet', effort: 'medium' },
    codex: { model: '<latest>', effort: 'medium', maxWindowPct: 90, maxWeekPct: 80, sharedAccount: false },
    gemini: { model: '<latest>', maxWindowPct: 90, maxWeekPct: 80, sharedAccount: false },
    maxParallel: 2,
  },
  helpers: { engines: ['claude'], claude: { search: 'haiku', judgment: 'sonnet', thirdTry: 'opus' } },
  deploy: {
    mode: 'none',
    command: null,
    ssh: { host: null, user: null, path: null, update: null },
    healthUrl: null,
    restartWindow: null,
  },
  timezone: 'UTC',
  language: 'en',
  defectLog: 'docs/DEFECTS.md',
};

function isObj(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

// Objects merge key by key; arrays and scalars from the user replace the default.
function mergeDeep(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(extra || {})) {
    if (isObj(extra[k]) && isObj(base[k])) out[k] = mergeDeep(base[k], extra[k]);
    else out[k] = extra[k];
  }
  return out;
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

// PURE. Returns a list of error strings (empty = valid).
function validateConfig(cfg) {
  const e = [];
  if (cfg.version !== 1) e.push('version must be 1');
  if (typeof cfg.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) e.push('repo must look like owner/name');
  if (typeof cfg.baseBranch !== 'string' || !/^[\w./-]+$/.test(cfg.baseBranch) || cfg.baseBranch.startsWith('-')) e.push('baseBranch is not a safe branch name');
  if (typeof cfg.worktreeDir !== 'string' || !cfg.worktreeDir) e.push('worktreeDir must be a non-empty string');
  if (!Array.isArray(cfg.linkDependencies) || cfg.linkDependencies.some((d) => typeof d !== 'string' || d.startsWith('/') || d.includes('..'))) e.push('linkDependencies must be relative paths inside the repo');
  const p = cfg.parallel || {};
  if (!Number.isInteger(p.suiteSlots) || p.suiteSlots < 1) e.push('parallel.suiteSlots must be an integer >= 1');
  if (typeof p.stuckSuiteMinutes !== 'number' || p.stuckSuiteMinutes < 0) e.push('parallel.stuckSuiteMinutes must be >= 0');
  if (typeof p.minFreeMemoryGB !== 'number' || p.minFreeMemoryGB < 0) e.push('parallel.minFreeMemoryGB must be >= 0');
  const r = cfg.review || {};
  if (!['always', 'critical', 'never'].includes(r.requiredFor)) e.push('review.requiredFor must be always, critical or never');
  if (!Array.isArray(r.criticalPaths)) e.push('review.criticalPaths must be a list');
  if (!Array.isArray(r.engines) || r.engines.some((x) => !['claude', 'codex', 'gemini'].includes(x))) e.push('review.engines must list claude, codex, gemini');
  if (!Number.isInteger(r.maxParallel) || r.maxParallel < 1) e.push('review.maxParallel must be an integer >= 1');
  for (const n of ['claude', 'codex', 'gemini']) {
    const m = r[n] && r[n].model;
    if (m !== undefined && m !== null && !/^[\w.:\/<>-]+$/.test(m)) e.push('review.' + n + '.model has unsafe characters');
  }
  const d = cfg.deploy || {};
  if (!['none', 'platform', 'vps-actions', 'vps-ssh', 'command'].includes(d.mode)) e.push('deploy.mode is not valid');
  if (d.mode === 'command' && !d.command) e.push('deploy.command is required when mode is command');
  if (d.mode === 'vps-ssh') {
    const s = d.ssh || {};
    if (!s.host || !s.user || !s.path || !s.update) e.push('deploy.ssh needs host, user, path and update');
    if (s.host && !/^[\w.-]+$/.test(s.host)) e.push('deploy.ssh.host is not a plain host name');
    if (s.user && !/^[\w.-]+$/.test(s.user)) e.push('deploy.ssh.user is not a plain user name');
  }
  if (d.restartWindow !== null && d.restartWindow !== undefined && !/^\d\d:\d\d-\d\d:\d\d$/.test(d.restartWindow)) e.push('deploy.restartWindow must look like 03:00-05:30');
  if (d.healthUrl && !/^https?:\/\//.test(d.healthUrl)) e.push('deploy.healthUrl must start with http:// or https://');
  if (!validTimezone(cfg.timezone)) e.push('timezone is not a valid IANA name');
  return e;
}

// Root of the working tree that contains cwd (works inside a worktree too).
function repoRoot(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  if (r.status !== 0) throw new Error('not inside a git repository: ' + cwd);
  return path.resolve(r.stdout.trim());
}

// Root of the MAIN checkout, even when cwd is a linked worktree.
function mainRoot(cwd) {
  const r = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) throw new Error('not inside a git repository: ' + cwd);
  return path.dirname(path.resolve(r.stdout.trim()));
}

function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    const err = new Error(CONFIG_FILE + ' not found in ' + root + ' (run the setup first)');
    err.code = 'NOCONFIG';
    throw err;
  }
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = mergeDeep(DEFAULTS, user);
  const errors = validateConfig(cfg);
  if (errors.length) {
    const err = new Error('invalid ' + CONFIG_FILE + ':\n - ' + errors.join('\n - '));
    err.code = 'BADCONFIG';
    throw err;
  }
  return cfg;
}

// Defaults when there is no usable config (used by test-queue outside a configured repo).
function loadConfigOrDefaults(cwd) {
  try {
    return loadConfig(repoRoot(cwd));
  } catch (_) {
    return mergeDeep(DEFAULTS, {});
  }
}

// "../<repo>-wt" -> absolute folder next to the main checkout.
function resolveWorktreeDir(mainRootPath, cfg) {
  const name = cfg.repo ? cfg.repo.split('/')[1] : path.basename(mainRootPath);
  return path.resolve(mainRootPath, cfg.worktreeDir.replace(/<repo>/g, name));
}

function main(argv) {
  let flags;
  try {
    flags = parseFlags(argv, { dir: 'string' }).flags;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  try {
    const cfg = loadConfig(repoRoot(path.resolve(flags.dir || process.cwd())));
    console.log(JSON.stringify(cfg, null, 2));
    return 0;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
}

module.exports = { CONFIG_FILE, DEFAULTS, mergeDeep, validateConfig, repoRoot, mainRoot, loadConfig, loadConfigOrDefaults, resolveWorktreeDir };

if (require.main === module) process.exit(main(process.argv.slice(2)));
