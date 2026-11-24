'use strict';
// Shared helpers: process running (argument arrays, never shell strings with user input),
// machine-wide lock files with stale detection, tiny utilities. Node >= 18, no dependencies.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'];

// Environment for every child process. Inherited git location variables are removed,
// otherwise a command could act on a different repository than the one we mean.
function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of GIT_VARS) delete env[k];
  return Object.assign(env, extra || {});
}

function run(cmd, args, opts) {
  const o = opts || {};
  const r = cp.spawnSync(cmd, args, {
    cwd: o.cwd,
    env: cleanEnv(o.env),
    input: o.input,
    encoding: 'utf8',
    shell: !!o.shell,
    timeout: o.timeout,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  let status = r.status;
  if (status === null || status === undefined) status = 1;
  if (r.error && r.error.code === 'ENOENT') status = 127;
  return { status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function git(cwd, args, opts) {
  return run('git', args, Object.assign({ cwd }, opts || {}));
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

// `gh` can be replaced by a stub script (tests) through PARALLEL_PR_GH.
function gh(args, opts) {
  const stub = process.env.PARALLEL_PR_GH;
  if (stub) return run(process.execPath, [stub].concat(args), opts);
  return run('gh', args, opts);
}

const SAFE_ARG = /^[A-Za-z0-9_.:\/=+@-]+$/;
function assertSafeArg(value, label) {
  if (typeof value !== 'string' || !SAFE_ARG.test(value)) throw new Error('unsafe value for ' + label);
  return value;
}

// AI CLIs (claude, codex, gemini). PARALLEL_PR_BIN_<NAME> points at a stub script (tests).
function engineRun(name, args, opts) {
  const stub = process.env['PARALLEL_PR_BIN_' + name.toUpperCase()];
  if (stub) return run(process.execPath, [stub].concat(args), opts);
  // On Windows the CLIs are .cmd shims; every argument we pass is validated or fixed.
  return run(name, args, Object.assign({}, opts || {}, { shell: process.platform === 'win32' }));
}

function parallelHome() {
  return process.env.PARALLEL_PR_HOME || path.join(os.homedir(), '.parallel-pr');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function nowIso() {
  return new Date().toISOString();
}

function appendLog(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(Object.assign({ ts: nowIso() }, obj)) + '\n');
  } catch (_) { /* logging must never break the work */ }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// PURE. A lock is stale when its owner is dead, or when it is older than stuckMs.
// An unreadable lock file (being written right now) is stale only after a few seconds.
function isStaleLock(info, ctx) {
  if (!info) return ctx.fileAgeMs > 5000;
  if (!ctx.alive) return true;
  if (ctx.stuckMs > 0 && ctx.now - info.startedAt > ctx.stuckMs) return true;
  return false;
}

// Atomic create (flag wx). Removes a stale lock and retries. true = we own it now.
function tryCreateLock(file, meta, stuckMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify(Object.assign({ pid: process.pid, startedAt: Date.now() }, meta || {})));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = null;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
        info = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {
        if (!fs.existsSync(file)) continue;
      }
      const alive = info ? pidAlive(info.pid) : false;
      if (isStaleLock(info, { now: Date.now(), stuckMs: stuckMs || 0, alive, fileAgeMs: age })) {
        try { fs.unlinkSync(file); } catch (_) { /* someone else removed it */ }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(file);
  } catch (_) { /* already gone */ }
}

// Try slot-0..slot-(max-1) in a directory. Returns the lock file path or null.
function tryAcquireSlot(dir, max, meta, stuckMs) {
  for (let i = 0; i < max; i++) {
    const file = path.join(dir, 'slot-' + i + '.lock');
    if (tryCreateLock(file, meta, stuckMs)) return file;
  }
  return null;
}

function tail(text, n) {
  return String(text).split(/\r?\n/).slice(-n).join('\n');
}

// spec: { name: 'string' | 'bool' } -> { flags, rest }
function parseFlags(argv, spec) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && Object.prototype.hasOwnProperty.call(spec, a.slice(2))) {
      const k = a.slice(2);
      if (spec[k] === 'bool') flags[k] = true;
      else {
        if (i + 1 >= argv.length) throw new Error('missing value for ' + a);
        flags[k] = argv[++i];
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

module.exports = {
  cleanEnv, run, git, gitOut, gh, engineRun, assertSafeArg, parallelHome, sleepSync, nowIso, appendLog,
  pidAlive, isStaleLock, tryCreateLock, releaseLock, tryAcquireSlot, tail, parseFlags,
};
