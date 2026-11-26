'use strict';
// Cross-model code review for PRs (--pr <n>) and local branch diffs (--base <ref>).
// Usage:
//   node review.cjs --pr <n> [--dir <worktree>] [--engine codex|gemini|claude] [--chat <session-id>] [--repo <owner/name>] [--cli gemini|agy] [--max-wait <s>] [--no-commit]
//   node review.cjs --base <ref> [--dir <worktree>] [--engine codex|gemini|claude] [--chat <session-id>] [--cli gemini|agy] [--max-wait <s>] [--no-commit]
// Exit codes:
//   0 : verdict written (reviews/REVIEW-PR<n>.md or reviews/REVIEW-<branch>.md)
//   3 : no engine available (every engine in chain missing, logged out, or proven at quota ceiling)
//   1 : error (usage error, git/gh failure, timeout, non-quota engine failure, secret leak, invalid verdict)
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KNOWN_ENGINES, engineHome, loadConfig } = require('./config.cjs');
const { readQuotaFile, checkQuota, markCeiling, looksLikeQuotaError, appendAuditLog } = require('./ceiling.cjs');
const { readChatKey } = require('./engine-switch.cjs');
const { loginFolderCandidates } = require('./detect.cjs');

const GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'];
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_CONCURRENT = 3;
const AUTH_ERROR_RE = /not logged in|please log\s*in|login required|auth(?:entication)? (?:required|failed|expired)|unauthorized|sign in|run .*login|invalid api key|api key.*not found/i;
const ENV_SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i;
const SECRET_VALUE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b(ghp|gho)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bAKIA[0-9A-Z]{16}/,
  /\bxox[abp]-[A-Za-z0-9-]{8,}/,
];

// ---------- pure helpers ----------

function parseArgs(argv) {
  const args = Array.from(argv || []);
  const out = {
    pr: null,
    base: null,
    dir: null,
    engine: null,
    chat: null,
    repo: null,
    cli: null,
    maxWait: null,
    noCommit: false,
  };
  const valueFlags = {
    '--pr': 'pr',
    '--base': 'base',
    '--dir': 'dir',
    '--engine': 'engine',
    '--chat': 'chat',
    '--repo': 'repo',
    '--cli': 'cli',
    '--max-wait': 'maxWait',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--no-commit') {
      out.noCommit = true;
    } else if (Object.prototype.hasOwnProperty.call(valueFlags, a)) {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a);
      out[valueFlags[a]] = args[++i];
    } else {
      throw new Error('unknown argument: ' + a);
    }
  }
  if (!out.pr && !out.base) throw new Error('must pass --pr <n> or --base <ref>');
  if (out.pr && !/^\d+$/.test(out.pr)) throw new Error('--pr must be a positive integer');
  if (out.engine && !KNOWN_ENGINES.includes(out.engine)) {
    throw new Error('--engine must be one of: ' + KNOWN_ENGINES.join(', '));
  }
  if (out.cli && out.cli !== 'gemini' && out.cli !== 'agy') {
    throw new Error('--cli must be gemini or agy');
  }
  if (out.maxWait !== null) {
    const n = Number(out.maxWait);
    if (!Number.isFinite(n) || n < 0) throw new Error('--max-wait must be a non-negative number');
    out.maxWait = n;
  }
  return out;
}

// PURE. Build ordered engine chain. Moves preferred to the front; claude goes straight to claude.
function buildEngineChain(preferred, configOrder, enabledEngines, overrideEngine) {
  if (overrideEngine) return KNOWN_ENGINES.includes(overrideEngine) ? [overrideEngine] : [];
  const enabled = Array.isArray(enabledEngines) && enabledEngines.length ? enabledEngines : KNOWN_ENGINES;
  const pref = KNOWN_ENGINES.includes(preferred) ? preferred : 'codex';
  if (pref === 'claude') return enabled.includes('claude') ? ['claude'] : [];
  const order = Array.isArray(configOrder) && configOrder.length ? configOrder : ['codex', 'gemini', 'claude'];
  const chain = [];
  if (enabled.includes(pref)) chain.push(pref);
  for (const eng of order) {
    if (KNOWN_ENGINES.includes(eng) && enabled.includes(eng) && !chain.includes(eng)) {
      chain.push(eng);
    }
  }
  return chain;
}

// PURE. Strict fallback: move to next engine ONLY when missing, logged-out, or proven at ceiling.
// Never fall back because the engine was slow (timeout) or crashed with another error.
function shouldFallbackReason(reasonKind) {
  return reasonKind === 'missing' || reasonKind === 'logged-out' || reasonKind === 'ceiling';
}

// PURE.
function looksLikeAuthError(text) {
  return AUTH_ERROR_RE.test(String(text || ''));
}

// PURE. Any BLOCK line wins over APPROVE. No verdict line = null.
function parseVerdict(text) {
  const found = [];
  const re = /^\s*\**VERDICT:\s*(APPROVE|BLOCK)\**\s*$/gim;
  let m;
  while ((m = re.exec(String(text || '')))) found.push(m[1].toUpperCase());
  if (!found.length) return null;
  return found.includes('BLOCK') ? 'BLOCK' : 'APPROVE';
}

// PURE. Exact format shared with parallel-worktree-pr-merge-end-to-end.
function formatReviewFile(verdict, head, body) {
  const cleaned = String(body || '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\**VERDICT:/i.test(l) && !/^\s*REVIEWED-HEAD:/i.test(l))
    .join('\n')
    .trim();
  return 'VERDICT: ' + verdict + '\nREVIEWED-HEAD: ' + head + '\n\n' + (cleaned ? cleaned + '\n' : '');
}

// PURE.
function parseReviewFile(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const v = /^VERDICT:\s*(APPROVE|BLOCK)\s*$/.exec(lines[0] || '');
  const h = /^REVIEWED-HEAD:\s*([0-9a-f]{7,64})\s*$/.exec(lines[1] || '');
  if (!v || !h) return null;
  return { verdict: v[1], head: h[1] };
}

// PURE.
function safeBranchSlug(branch) {
  const s = String(branch || 'HEAD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'HEAD';
}

// PURE.
function reviewFilePath(opts) {
  if (opts && opts.pr) return 'reviews/REVIEW-PR' + opts.pr + '.md';
  return 'reviews/REVIEW-' + safeBranchSlug(opts && (opts.branch || opts.base)) + '.md';
}

// PURE. Names of functions touched by a unified diff, to look for their callers.
function extractSymbols(diff) {
  const names = new Set();
  const pats = [
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/,
    /^\+\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\+\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^\+\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
  ];
  for (const line of String(diff || '').split(/\r?\n/)) {
    for (const p of pats) {
      const m = p.exec(line);
      if (m && m[1].length > 2) names.add(m[1]);
    }
  }
  return Array.from(names).slice(0, 20);
}

// PURE.
function buildPrompt(p) {
  const maxDiff = 200000;
  const rawDiff = String(p.diff || '');
  const diff = rawDiff.length > maxDiff ? rawDiff.slice(0, maxDiff) + '\n[diff truncated; read the rest with git]' : rawDiff;
  const targetLabel = p.pr ? 'pull request #' + p.pr : 'branch ' + (p.branch || 'HEAD') + ' against ' + (p.base || 'base');
  return [
    'You are reviewing ' + targetLabel + ' as an independent reviewer. You did not write this change.',
    'Read the actual code, tests, and callers in the working tree. Do NOT trust the PR title or author description; verify everything directly against the source.',
    'Hunt for: wrong behavior, missed edge cases, broken callers, security/auth regressions, secret exposure, data loss, and missing or weak tests.',
    'You are inside the branch worktree. You may inspect any source file and run targeted checks.',
    'If you find a clear defect you can fix safely, fix it and leave the edit in the working tree (or commit only the files you changed without --no-verify). Never push, never run git add -A, never delete or rename files, and never edit .git, .github, .githooks, .claude, or .codex.',
    'Do not rewrite style or refactor unrelated code.',
    'Security rule: never print, log, or commit secrets, API keys, tokens, passwords, or environment variables; never read .env.',
    'Before your final line, list findings with severity (P1/P2/P3), file:line, what you checked, what you fixed, and what you could not prove.',
    'End your answer with exactly one final line: "VERDICT: APPROVE" (no blocking problem remains) or "VERDICT: BLOCK" (a problem remains that the author must resolve).',
    '',
    '## Target', targetLabel, '',
    '## Author Title / Description (untrusted context — verify in code)',
    p.title || '(none)',
    p.body || '(empty)', '',
    '## Changed files',
    (p.files && p.files.length ? p.files.join('\n') : '(none)'), '',
    '## Callers of changed functions (git grep)',
    p.callers || '(none found)', '',
    '## Diff',
    diff,
  ].join('\n');
}

// PURE.
function buildPermissionsObject(dirPosix) {
  return {
    permissions: {
      allow: ['command(*)', 'read_file(*)', 'write_file(' + dirPosix + '/**)'],
      deny: [],
    },
  };
}

// PURE. Build CLI arguments for each supported reviewer engine.
function buildReviewCommand(engine, cfg, opts) {
  const o = opts || {};
  if (engine === 'codex') {
    const cx = (cfg && cfg.codex) || {};
    const model = cx.model && cx.model !== '<latest>' ? cx.model : 'gpt-6.2-sol';
    const effort = cx.effort || 'medium';
    const args = ['exec'];
    if (!o.isRepo) args.push('--skip-git-repo-check');
    args.push('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false');
    if (o.gitCommonDir) {
      args.push('-c', "sandbox_workspace_write.writable_roots=['" + o.gitCommonDir + "']");
    }
    if (model) args.push('-m', model);
    if (effort) args.push('-c', 'model_reasoning_effort="' + effort + '"');
    args.push('-C', o.dir, '-o', o.answerFile, '-');
    return { bin: 'codex', args, stdinMode: 'prompt' };
  }

  if (engine === 'gemini') {
    const gm = (cfg && cfg.gemini) || {};
    const cli = o.cli || gm.cli || 'gemini';
    const model = gm.model && gm.model !== '<latest>' ? gm.model : 'gemini-4-hydrogen-high';
    if (cli === 'agy') {
      const prompt = 'Read the entire file ' + o.requestPosix + ' and follow its instructions. Only write files inside ' + o.dirPosix + '.';
      return {
        bin: 'agy',
        args: [
          '-p', prompt,
          '--model', model,
          '--mode', 'accept-edits',
          '--output-format', 'json',
          '--print-timeout', String(o.timeoutSec || 1500) + 's',
          '--settings', o.permissionsPosix,
          '--add-dir', o.tempDirPosix,
          '--add-dir', o.dirPosix,
          '--sandbox',
        ],
        stdinMode: 'none',
      };
    }
    const args = [];
    if (model) args.push('-m', model);
    args.push('-p', 'Follow the code review instructions provided on stdin.', '--sandbox');
    return { bin: 'gemini', args, stdinMode: 'prompt' };
  }

  if (engine === 'claude') {
    const rc = (cfg && cfg.review && cfg.review.claude) || {};
    const model = rc.model && rc.model !== '<latest>' ? rc.model : 'sonnet';
    const effort = rc.effort || 'medium';
    const args = ['-p'];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return { bin: 'claude', args, stdinMode: 'prompt' };
  }

  throw new Error('unknown engine: ' + engine);
}

// PURE. Extract text from agy JSON output or plain stdout.
function extractOutputText(cli, stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return '';
  if (cli === 'agy') {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.response === 'string') return parsed.response;
      if (typeof parsed.text === 'string') return parsed.text;
      if (typeof parsed.output === 'string') return parsed.output;
      if (parsed.error) return String(parsed.error.message || parsed.error);
    } catch (_) {
      // fall back to raw stdout
    }
  }
  return raw;
}

// PURE. Parse `git status --porcelain -z` output.
function parsePorcelain(porcelain) {
  const parts = String(porcelain || '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || p.length < 4) continue;
    const xy = p.slice(0, 2);
    const item = { xy, path: p.slice(3), from: null };
    if (/[RC]/.test(xy)) {
      item.from = parts[i + 1] || null;
      i += 1;
    }
    out.push(item);
  }
  return out;
}

// PURE. Validate edits left by the reviewer in the worktree.
function validateReviewerChanges(porcelain, reviewRelPath) {
  const target = String(reviewRelPath || '').replace(/\\/g, '/');
  const files = [];
  for (const it of parsePorcelain(porcelain)) {
    const p = it.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (p === target) continue;
    if (/^\.(codex|git|github|githooks|claude)(\/|$)/i.test(p)) {
      return { ok: false, reason: 'reviewer modified forbidden path: ' + p };
    }
    if (/D/.test(it.xy) || /R/.test(it.xy)) {
      return { ok: false, reason: 'reviewer deleted or renamed file: ' + p };
    }
    files.push(p);
  }
  return { ok: true, files };
}

// PURE. Collect long (>= 12 char) secret-like env var values for leak comparison (never print).
function collectEnvSecretValues(env) {
  const out = [];
  for (const k of Object.keys(env || {})) {
    if (ENV_SECRET_NAME_RE.test(k)) {
      const v = String(env[k] || '');
      if (v.length >= 12) out.push(v);
    }
  }
  return out;
}

// PURE.
function hasSecretPattern(text, envSecretValues) {
  const t = String(text || '');
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(t))) return true;
  return (envSecretValues || []).some((v) => typeof v === 'string' && v.length >= 12 && t.indexOf(v) !== -1);
}

// PURE. Strip git location vars and secret env vars (except explicit engine API keys if needed).
function stripSecretEnv(env, allowKeys) {
  const allow = new Set(allowKeys || []);
  const out = {};
  for (const k of Object.keys(env || {})) {
    if (GIT_VARS.includes(k)) continue;
    if (ENV_SECRET_NAME_RE.test(k) && !allow.has(k)) continue;
    out[k] = env[k];
  }
  return out;
}

// PURE.
function effectiveMaxConcurrent(cfg, engine) {
  const rv = (cfg && cfg.review) || {};
  if (rv[engine] && Number.isInteger(rv[engine].maxConcurrent) && rv[engine].maxConcurrent >= 1) {
    return rv[engine].maxConcurrent;
  }
  if (Number.isInteger(rv.maxConcurrent) && rv.maxConcurrent >= 1) return rv.maxConcurrent;
  return DEFAULT_MAX_CONCURRENT;
}

// PURE. Lock staleness check for review concurrency slots.
function isStaleLock(info, ctx) {
  if (!info) return ctx.fileAgeMs > 5000;
  if (!ctx.alive) return true;
  if (ctx.stuckMs > 0 && ctx.now - info.startedAt > ctx.stuckMs) return true;
  return false;
}

// ---------- I/O ----------

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of GIT_VARS) delete env[k];
  return Object.assign(env, extra || {});
}

function runSync(cmd, args, opts) {
  const o = opts || {};
  const r = cp.spawnSync(cmd, args, {
    cwd: o.cwd,
    env: o.env || cleanEnv(),
    input: o.input,
    encoding: 'utf8',
    shell: Boolean(o.shell),
    timeout: o.timeout,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  let status = r.status;
  if (status === null || status === undefined) status = 1;
  if (r.error && r.error.code === 'ENOENT') status = 127;
  return { status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function git(dir, args, opts) {
  return runSync('git', args, Object.assign({ cwd: dir }, opts || {}));
}

function gitOut(dir, args) {
  const r = git(dir, args);
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

function gh(args, opts) {
  const stub = process.env.ENGINE_SWITCH_GH;
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) return runSync(process.execPath, [stub].concat(args), opts);
    return runSync(stub, args, Object.assign({}, opts || {}, { shell: process.platform === 'win32' }));
  }
  return runSync('gh', args, opts);
}

function getBinStub(bin) {
  return process.env['ENGINE_SWITCH_BIN_' + bin.toUpperCase()] || null;
}

function checkVersion(bin) {
  const stub = getBinStub(bin);
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) return runSync(process.execPath, [stub, '--version'], { timeout: 15000 });
    return runSync(stub, ['--version'], { timeout: 15000, shell: process.platform === 'win32' });
  }
  return runSync(bin, ['--version'], { timeout: 15000, shell: process.platform === 'win32' });
}

function hasLoginState(engine, bin) {
  const stub = getBinStub(bin);
  const customHome = process.env.ENGINE_SWITCH_USER_HOME;
  if (stub && !customHome) return true;
  const userHome = customHome || os.homedir();
  if (engine === 'gemini' && bin === 'gemini' && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    return true;
  }
  if (engine === 'claude' && process.env.ANTHROPIC_API_KEY) return true;
  if (engine === 'codex' && process.env.OPENAI_API_KEY) return true;
  return loginFolderCandidates(bin).some((rel) => fs.existsSync(path.join(userHome, rel)));
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
        try { fs.unlinkSync(file); } catch (_) {}
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(file) {
  if (!file) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info.pid === process.pid) fs.unlinkSync(file);
  } catch (_) {}
}

function tryAcquireSlot(dir, max, meta, stuckMs) {
  for (let i = 0; i < max; i++) {
    const file = path.join(dir, 'slot-' + i + '.lock');
    if (tryCreateLock(file, meta, stuckMs)) return file;
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(child) {
  try {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) {}
}

function spawnEngine(bin, args, cwd, env) {
  const stub = getBinStub(bin);
  const opts = { cwd, env, windowsHide: true };
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) {
      return cp.spawn(process.execPath, [stub].concat(args), opts);
    }
    return cp.spawn(stub, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
  }
  return cp.spawn(bin, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
}

function detectGitCommonDir(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0) return { isRepo: false, gitCommonDir: '' };
  return { isRepo: true, gitCommonDir: r.stdout.trim().replace(/\\/g, '/') };
}

function findCallers(dir, diff) {
  const lines = [];
  for (const sym of extractSymbols(diff)) {
    const r = git(dir, ['grep', '-n', '-w', '-e', sym, '--', '.']);
    if (r.status === 0 && r.stdout.trim()) {
      lines.push('### ' + sym, r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'));
    }
  }
  return lines.join('\n');
}

function resolveDiffBase(dir, preferredRef) {
  const check = git(dir, ['rev-parse', '--verify', preferredRef]);
  if (check.status === 0) return preferredRef;
  if (preferredRef.startsWith('origin/')) {
    const shortRef = preferredRef.slice('origin/'.length);
    if (git(dir, ['rev-parse', '--verify', shortRef]).status === 0) return shortRef;
  }
  return null;
}

function computeDiff(dir, baseRef) {
  let r = git(dir, ['diff', baseRef + '...HEAD']);
  let filesR = git(dir, ['diff', '--name-only', baseRef + '...HEAD']);
  if (r.status !== 0) {
    r = git(dir, ['diff', baseRef + '..HEAD']);
    filesR = git(dir, ['diff', '--name-only', baseRef + '..HEAD']);
  }
  if (r.status !== 0) throw new Error('git diff failed against ' + baseRef + ': ' + (r.stderr || r.stdout).trim());
  const files = filesR.status === 0 ? filesR.stdout.split(/\r?\n/).filter(Boolean) : [];
  return { diff: r.stdout, files };
}

function runSingleEngine(engine, cfg, ctx) {
  return new Promise((resolve) => {
    const gmCli = ctx.cliOverride || (cfg.gemini && cfg.gemini.cli) || 'gemini';
    const bin = engine === 'gemini' ? gmCli : engine;

    const ver = checkVersion(bin);
    if (ver.status !== 0) {
      resolve({ outcome: 'missing', engine, reason: bin + ' binary not found or --version failed' });
      return;
    }

    if (!hasLoginState(engine, bin)) {
      resolve({ outcome: 'logged-out', engine, reason: bin + ' does not appear to be signed in' });
      return;
    }

    if (engine !== 'claude') {
      const quota = readQuotaFile(engine);
      const qReason = checkQuota(quota, cfg.switchOn, cfg[engine]);
      if (qReason) {
        markCeiling(engine, qReason);
        resolve({ outcome: 'ceiling', engine, reason: qReason });
        return;
      }
    }

    const timeoutMin = (cfg.review && cfg.review.timeoutMinutes) || DEFAULT_TIMEOUT_MINUTES;
    const timeoutMs = Number(process.env.ENGINE_SWITCH_TIMEOUT_MS) || (timeoutMin * 60 * 1000);
    const watchdogMs = Number(process.env.ENGINE_SWITCH_WATCHDOG_MS) || WATCHDOG_INTERVAL_MS;
    const pollMs = Number(process.env.ENGINE_SWITCH_POLL_MS) || 3000;
    const maxConcurrent = effectiveMaxConcurrent(cfg, engine);
    const slotsDir = path.join(engineHome(), 'review-slots', engine);
    const stuckMs = (timeoutMin + 15) * 60 * 1000;

    let slot = null;
    (async () => {
      const waitStarted = Date.now();
      while (!(slot = tryAcquireSlot(slotsDir, maxConcurrent, { pr: ctx.pr || null, base: ctx.baseRef }, stuckMs))) {
        if (Date.now() - waitStarted >= ctx.maxWaitMs) {
          resolve({ outcome: 'error', engine, reason: 'timed out waiting for a ' + engine + ' review slot (max ' + maxConcurrent + ' concurrent)' });
          return;
        }
        await sleepAsync(pollMs);
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-review-'));
      const cleanupTemp = () => {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      };

      const answerFile = path.join(tempDir, 'answer.txt');
      const requestFile = path.join(tempDir, 'request.md');
      const permsFile = path.join(tempDir, 'permissions.json');
      const dirPosix = ctx.dir.split(path.sep).join('/');
      const tempDirPosix = tempDir.split(path.sep).join('/');

      fs.writeFileSync(requestFile, ctx.prompt, 'utf8');
      fs.writeFileSync(permsFile, JSON.stringify(buildPermissionsObject(dirPosix)), 'utf8');

      const cmd = buildReviewCommand(engine, cfg, {
        dir: ctx.dir,
        dirPosix,
        answerFile,
        requestPosix: requestFile.split(path.sep).join('/'),
        permissionsPosix: permsFile.split(path.sep).join('/'),
        tempDirPosix,
        cli: gmCli,
        timeoutSec: Math.max(60, Math.round(timeoutMs / 1000)),
        isRepo: ctx.gitInfo.isRepo,
        gitCommonDir: ctx.gitInfo.gitCommonDir,
      });

      const allowEnv = engine === 'gemini'
        ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
        : (engine === 'claude' ? ['ANTHROPIC_API_KEY'] : []);
      const childEnv = stripSecretEnv(process.env, allowEnv);
      if (engine === 'claude') delete childEnv.CLAUDECODE;

      const startedAt = Date.now();
      const child = spawnEngine(cmd.bin, cmd.args, ctx.dir, childEnv);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16384); });
      child.stdin.on('error', () => {});
      if (cmd.stdinMode === 'prompt') child.stdin.end(ctx.prompt);
      else child.stdin.end();

      let stoppedKind = null;
      let stoppedReason = null;

      const watchdog = engine === 'claude' ? null : setInterval(() => {
        if (cfg.switchOn && cfg.switchOn.stopMidRun === false) return;
        const q = readQuotaFile(engine);
        const r = checkQuota(q, cfg.switchOn, cfg[engine]);
        if (r && !stoppedKind) {
          stoppedKind = 'ceiling';
          stoppedReason = 'MID-RUN CEILING: ' + r;
          killTree(child);
        }
      }, watchdogMs);

      const hardTimer = setTimeout(() => {
        if (!stoppedKind) {
          stoppedKind = 'timeout';
          stoppedReason = engine + ' review exceeded timeout (' + Math.round(timeoutMs / 1000) + 's)';
          killTree(child);
        }
      }, timeoutMs);

      const finish = (res) => {
        if (watchdog) clearInterval(watchdog);
        clearTimeout(hardTimer);
        releaseLock(slot);
        cleanupTemp();
        resolve(res);
      };

      child.on('error', (err) => {
        if (err && err.code === 'ENOENT') {
          finish({ outcome: 'missing', engine, reason: cmd.bin + ' not found' });
          return;
        }
        finish({ outcome: 'error', engine, reason: String(err.message || err) });
      });

      child.on('close', (status) => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        if (stoppedKind === 'ceiling') {
          markCeiling(engine, stoppedReason);
          finish({ outcome: 'ceiling', engine, seconds, reason: stoppedReason });
          return;
        }
        if (stoppedKind === 'timeout') {
          finish({ outcome: 'timeout', engine, seconds, reason: stoppedReason });
          return;
        }

        let output = '';
        if (engine === 'codex') {
          try { output = fs.readFileSync(answerFile, 'utf8'); } catch (_) {}
          if (!output.trim()) output = stdout;
        } else if (engine === 'gemini') {
          output = extractOutputText(gmCli, stdout);
        } else {
          output = stdout;
        }

        const combined = stderr + '\n' + stdout + '\n' + output;
        if ((status !== 0 && looksLikeQuotaError(combined)) || (status === 0 && !output.trim() && looksLikeQuotaError(combined))) {
          const reason = 'quota or rate-limit error in ' + cmd.bin + ' output';
          markCeiling(engine, reason);
          finish({ outcome: 'ceiling', engine, seconds, reason });
          return;
        }

        if ((status !== 0 && looksLikeAuthError(combined)) || (status === 0 && !output.trim() && looksLikeAuthError(combined))) {
          finish({ outcome: 'logged-out', engine, seconds, reason: cmd.bin + ' authentication required' });
          return;
        }

        if (status !== 0) {
          finish({
            outcome: 'error',
            engine,
            seconds,
            reason: cmd.bin + ' exited with code ' + status + ': ' + (stderr || stdout).trim().slice(-400),
          });
          return;
        }

        const verdict = parseVerdict(output);
        if (!verdict) {
          finish({
            outcome: 'bad-verdict',
            engine,
            seconds,
            reason: cmd.bin + ' finished without a valid VERDICT: APPROVE|BLOCK line',
          });
          return;
        }

        finish({ outcome: 'ok', engine, seconds, verdict, output });
      });
    })().catch((err) => {
      releaseLock(slot);
      resolve({ outcome: 'error', engine, reason: String(err.message || err) });
    });
  });
}

function scanChangesForSecrets(dir, files, envSecrets) {
  const diffR = git(dir, ['diff', 'HEAD', '--'].concat(files));
  if (hasSecretPattern(diffR.stdout, envSecrets)) return true;
  for (const f of files) {
    const abs = path.join(dir, f);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const content = fs.readFileSync(abs, 'utf8');
        if (hasSecretPattern(content, envSecrets)) return true;
      }
    } catch (_) {}
  }
  return false;
}

async function main(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (e) {
    console.error('[review] ' + e.message);
    return 1;
  }

  const dir = path.resolve(flags.dir || process.cwd());
  if (!fs.existsSync(dir)) {
    console.error('[review] directory not found: ' + dir);
    return 1;
  }

  const gitInfo = detectGitCommonDir(dir);
  if (!gitInfo.isRepo) {
    console.error('[review] not a git repository: ' + dir);
    return 1;
  }

  const cfg = loadConfig(dir);
  const chatId = flags.chat || process.env.ENGINE_SWITCH_CHAT || null;
  const chatKey = chatId ? readChatKey(chatId, undefined, cfg) : { reviewer: (cfg.defaults && cfg.defaults.reviewer) || 'codex' };
  const chain = buildEngineChain(
    chatKey.reviewer,
    (cfg.review && cfg.review.order) || ['codex', 'gemini', 'claude'],
    cfg.engines,
    flags.engine
  );

  if (!chain.length) {
    console.error('[review] no configured engines in review chain');
    return 3;
  }

  let title = '';
  let body = '';
  let baseRef = flags.base;
  let branch = '';
  try {
    branch = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch (e) {
    console.error('[review] ' + e.message);
    return 1;
  }

  if (flags.pr) {
    const ghArgs = ['pr', 'view', flags.pr];
    if (flags.repo) ghArgs.push('--repo', flags.repo);
    ghArgs.push('--json', 'headRefOid,headRefName,baseRefName,title,body');
    const view = gh(ghArgs, { cwd: dir });
    if (view.status !== 0) {
      console.error('[review] could not read PR #' + flags.pr + ': ' + (view.stderr || view.stdout).trim());
      return 1;
    }
    let pr;
    try {
      pr = JSON.parse(view.stdout);
    } catch (_) {
      console.error('[review] invalid JSON from gh pr view');
      return 1;
    }
    const localHead = gitOut(dir, ['rev-parse', 'HEAD']);
    if (localHead !== pr.headRefOid) {
      console.error('[review] local HEAD (' + localHead.slice(0, 8) + ') does not match PR head (' + String(pr.headRefOid).slice(0, 8) + '); sync/push first');
      return 1;
    }
    title = pr.title || '';
    body = pr.body || '';
    if (!baseRef) {
      baseRef = resolveDiffBase(dir, 'origin/' + (pr.baseRefName || 'main')) || pr.baseRefName || 'main';
    }
  } else {
    const resolved = resolveDiffBase(dir, baseRef);
    if (!resolved) {
      console.error('[review] base ref not found: ' + baseRef);
      return 1;
    }
    baseRef = resolved;
    title = 'Branch ' + branch + ' vs ' + baseRef;
  }

  const reviewRelPath = reviewFilePath({ pr: flags.pr, branch, base: baseRef });
  const prePorcelain = git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout;
  const preDirty = validateReviewerChanges(prePorcelain, reviewRelPath);
  if (!preDirty.ok || preDirty.files.length > 0) {
    console.error('[review] working tree has uncommitted changes before review; commit or stash first');
    return 1;
  }

  let diffInfo;
  try {
    diffInfo = computeDiff(dir, baseRef);
  } catch (e) {
    console.error('[review] ' + e.message);
    return 1;
  }
  if (!diffInfo.files.length && !diffInfo.diff.trim()) {
    console.error('[review] empty diff between ' + baseRef + ' and HEAD');
    return 1;
  }

  const callers = findCallers(dir, diffInfo.diff);
  const prompt = buildPrompt({
    pr: flags.pr,
    branch,
    base: baseRef,
    title,
    body,
    files: diffInfo.files,
    callers,
    diff: diffInfo.diff,
  });

  const maxWaitMs = (flags.maxWait !== null ? flags.maxWait : 600) * 1000;
  const skipped = [];

  for (const engine of chain) {
    console.error('[review] trying ' + engine + '...');
    const res = await runSingleEngine(engine, cfg, {
      dir,
      pr: flags.pr,
      baseRef,
      prompt,
      gitInfo,
      cliOverride: flags.cli,
      maxWaitMs,
    });

    if (res.outcome === 'ok') {
      const postPorcelain = git(dir, ['status', '--porcelain', '-z', '--untracked-files=all']).stdout;
      const check = validateReviewerChanges(postPorcelain, reviewRelPath);
      if (!check.ok) {
        console.error('[review] ' + check.reason);
        return 1;
      }

      if (check.files.length > 0) {
        const envSecrets = collectEnvSecretValues(process.env);
        if (scanChangesForSecrets(dir, check.files, envSecrets)) {
          console.error('[review] secret pattern detected in reviewer edits; refusing to commit');
          return 1;
        }
        const addFix = git(dir, ['add', '--'].concat(check.files));
        if (addFix.status !== 0) {
          console.error('[review] git add failed for reviewer fixes: ' + addFix.stderr.trim());
          return 1;
        }
        const commitFix = git(dir, ['commit', '-m', 'review: fixes by the reviewer', '--'].concat(check.files));
        if (commitFix.status !== 0) {
          console.error('[review] git commit failed for reviewer fixes: ' + (commitFix.stderr || commitFix.stdout).trim());
          return 1;
        }
      }

      const reviewedHead = gitOut(dir, ['rev-parse', 'HEAD']);
      const verdictText = formatReviewFile(res.verdict, reviewedHead, res.output);
      if (hasSecretPattern(verdictText, collectEnvSecretValues(process.env))) {
        console.error('[review] secret pattern detected in review verdict output; refusing to write');
        return 1;
      }

      const absOut = path.join(dir, reviewRelPath);
      fs.mkdirSync(path.dirname(absOut), { recursive: true });
      fs.writeFileSync(absOut, verdictText, 'utf8');

      if (!flags.noCommit) {
        const addRev = git(dir, ['add', '--', reviewRelPath]);
        if (addRev.status !== 0) {
          console.error('[review] git add failed for verdict file: ' + addRev.stderr.trim());
          return 1;
        }
        const msg = flags.pr
          ? 'review: PR ' + flags.pr + ' ' + res.verdict
          : 'review: ' + safeBranchSlug(branch) + ' ' + res.verdict;
        const commitRev = git(dir, ['commit', '-m', msg, '--', reviewRelPath]);
        if (commitRev.status !== 0) {
          console.error('[review] could not commit verdict file: ' + (commitRev.stderr || commitRev.stdout).trim());
          return 1;
        }
      }

      appendAuditLog(
        {
          at: Date.now(),
          event: 'review',
          engine: res.engine,
          pr: flags.pr || null,
          base: baseRef,
          verdict: res.verdict,
          reviewedHead,
          seconds: res.seconds,
          fixes: check.files,
        },
        undefined,
        path.join(engineHome(), 'review-history.jsonl')
      );

      console.log('VERDICT: ' + res.verdict + ' | ENGINE: ' + res.engine + ' | HEAD: ' + reviewedHead + ' | FILE: ' + reviewRelPath);
      return 0;
    }

    if (shouldFallbackReason(res.outcome)) {
      console.error('[review] ' + engine + ' unavailable (' + res.outcome + ': ' + res.reason + '); trying next engine');
      skipped.push({ engine, outcome: res.outcome, reason: res.reason });
      continue;
    }

    console.error('[review] ' + engine + ' failed (' + res.outcome + '): ' + res.reason);
    return 1;
  }

  const summary = skipped.map((s) => s.engine + '=' + s.outcome).join(', ');
  console.error('[review] no review engine available (' + (summary || 'empty chain') + ')');
  if (skipped.some((s) => s.outcome === 'ceiling')) {
    console.error('[review] ceiling markers recorded; if using Claude subagent fallback with engine-guard, include "CLAUDE-ONLY: ceiling".');
  }
  return 3;
}

module.exports = {
  parseArgs,
  buildEngineChain,
  shouldFallbackReason,
  looksLikeAuthError,
  parseVerdict,
  formatReviewFile,
  parseReviewFile,
  safeBranchSlug,
  reviewFilePath,
  extractSymbols,
  buildPrompt,
  buildPermissionsObject,
  buildReviewCommand,
  extractOutputText,
  parsePorcelain,
  validateReviewerChanges,
  collectEnvSecretValues,
  hasSecretPattern,
  stripSecretEnv,
  effectiveMaxConcurrent,
  isStaleLock,
  tryAcquireSlot,
  releaseLock,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[review] ' + (err && err.message ? err.message : String(err)));
      process.exit(1);
    });
}
