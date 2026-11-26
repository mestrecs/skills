'use strict';
// Run a helper task via Codex CLI in a worktree/folder with quota ceiling checks and a mid-run watchdog.
// Usage:
//   node run-codex.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--effort <e>]
//   node run-codex.cjs --quota-only
// Exit 3: at quota ceiling (before start, mid-run via watchdog, or quota error in output) + writes ceiling marker.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config.cjs');
const { readQuotaFile, checkQuota, markCeiling, looksLikeQuotaError } = require('./ceiling.cjs');

const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HARD_LIMIT_MS = 60 * 60 * 1000;

const HELPER_RULES = (dir) =>
  '\n\nRules: Only write files inside ' + dir + '. Never run git push directly, never use --no-verify, '
  + 'never merge pull requests manually, never run broad test suites unless explicitly requested, '
  + 'and never print, log or commit secrets or environment variables.\n';

// PURE.
function parseArgs(argv) {
  const args = Array.from(argv || []);
  const out = { quotaOnly: false, deliver: false, model: null, effort: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quota-only') out.quotaOnly = true;
    else if (a === '--deliver') out.deliver = true;
    else if (a === '--model' && i + 1 < args.length) out.model = args[++i];
    else if (a === '--effort' && i + 1 < args.length) out.effort = args[++i];
    else out.positional.push(a);
  }
  return out;
}

// PURE. Build Codex CLI argument array.
function buildCodexArgs(opts) {
  const base = ['exec'];
  if (!opts.isRepo || opts.deliver) base.push('--skip-git-repo-check');
  if (opts.deliver) {
    base.push('-s', 'danger-full-access');
  } else {
    base.push('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false');
    if (opts.gitCommonDir) {
      // Single quotes inside TOML string literal: cmd.exe strips double quotes on Windows.
      base.push('-c', "sandbox_workspace_write.writable_roots=['" + opts.gitCommonDir + "']");
    }
  }
  if (opts.model) base.push('-m', opts.model);
  if (opts.effort) base.push('-c', 'model_reasoning_effort="' + opts.effort + '"');
  base.push('-C', opts.dir, '-o', opts.answerFile, '-');
  return base;
}

function detectGitCommonDir(dir) {
  try {
    const r = cp.spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) return { isRepo: false, gitCommonDir: '' };
    return { isRepo: true, gitCommonDir: String(r.stdout || '').trim().replace(/\\/g, '/') };
  } catch (_) {
    return { isRepo: false, gitCommonDir: '' };
  }
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

function spawnCodex(args) {
  const stub = process.env.ENGINE_SWITCH_BIN_CODEX;
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) {
      return cp.spawn(process.execPath, [stub].concat(args), { windowsHide: true });
    }
    return cp.spawn(stub, args, { windowsHide: true, shell: process.platform === 'win32' });
  }
  return cp.spawn('codex', args, { windowsHide: true, shell: process.platform === 'win32' });
}

function checkCodexCeiling(cfg) {
  const quota = readQuotaFile('codex');
  const reason = checkQuota(quota, cfg.switchOn, cfg.codex);
  return { quota, reason };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const dirArg = parsed.positional[0];
  const cfg = loadConfig(dirArg ? path.resolve(dirArg) : process.cwd());

  const initial = checkCodexCeiling(cfg);
  if (parsed.quotaOnly) {
    if (initial.reason) {
      markCeiling('codex', initial.reason);
      console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'codex', reason: initial.reason, quota: initial.quota }));
      process.exit(3);
    }
    console.log(JSON.stringify({ ok: true, atCeiling: false, engine: 'codex', quota: initial.quota }));
    process.exit(0);
  }

  if (parsed.positional.length < 3) {
    console.error('usage: run-codex.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--effort <e>]');
    process.exit(2);
  }

  const dir = path.resolve(parsed.positional[0]);
  const requestFile = path.resolve(parsed.positional[1]);
  const answerFile = path.resolve(parsed.positional[2]);

  if (!fs.existsSync(dir) || !fs.existsSync(requestFile)) {
    console.error('directory or request file not found');
    process.exit(2);
  }

  if (initial.reason) {
    markCeiling('codex', initial.reason);
    console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'codex', reason: initial.reason }));
    process.exit(3);
  }

  const prompt = fs.readFileSync(requestFile, 'utf8') + HELPER_RULES(dir);
  const gitInfo = detectGitCommonDir(dir);
  const model = parsed.model || (cfg.codex && cfg.codex.model) || 'gpt-6.2-sol';
  const effort = parsed.effort || (cfg.codex && cfg.codex.effort) || 'medium';
  const args = buildCodexArgs({
    dir,
    answerFile,
    deliver: parsed.deliver,
    model,
    effort,
    isRepo: gitInfo.isRepo,
    gitCommonDir: gitInfo.gitCommonDir,
  });

  const startedAt = Date.now();
  const child = spawnCodex(args);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-16384); });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16384); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let stoppedReason = null;
  let stoppedKind = null;
  const watchdogMs = Number(process.env.ENGINE_SWITCH_WATCHDOG_MS) || WATCHDOG_INTERVAL_MS;
  const timeoutMs = Number(process.env.ENGINE_SWITCH_TIMEOUT_MS) || HARD_LIMIT_MS;

  const watchdog = setInterval(() => {
    if (cfg.switchOn && cfg.switchOn.stopMidRun === false) return;
    const nowCheck = checkCodexCeiling(cfg);
    if (nowCheck.reason && !stoppedReason) {
      stoppedReason = 'MID-RUN CEILING: ' + nowCheck.reason;
      stoppedKind = 'ceiling';
      killTree(child);
    }
  }, watchdogMs);

  const hardTimer = setTimeout(() => {
    if (!stoppedReason) {
      stoppedReason = 'exceeded 60 minute hard limit';
      stoppedKind = 'timeout';
      killTree(child);
    }
  }, timeoutMs);

  child.on('error', (err) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    console.log(JSON.stringify({ ok: false, engine: 'codex', reason: String(err.message || err) }));
    process.exit(1);
  });

  child.on('close', (status) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    let answer = '';
    try { answer = fs.readFileSync(answerFile, 'utf8'); } catch (_) {}

    if (stoppedKind === 'ceiling') {
      markCeiling('codex', stoppedReason);
      console.log(JSON.stringify({ ok: false, atCeiling: true, stoppedMidRun: true, engine: 'codex', seconds, reason: stoppedReason }));
      process.exit(3);
    }
    if (stoppedKind === 'timeout') {
      console.log(JSON.stringify({ ok: false, timedOut: true, engine: 'codex', seconds, reason: stoppedReason }));
      process.exit(1);
    }

    const quotaErr = (status !== 0 && looksLikeQuotaError(stderr + '\n' + stdout + '\n' + answer))
      || (status === 0 && !answer.trim() && looksLikeQuotaError(stderr + '\n' + stdout));
    if (quotaErr) {
      markCeiling('codex', 'quota or rate-limit error in codex output');
      console.log(JSON.stringify({ ok: false, atCeiling: true, quotaError: true, engine: 'codex', exitCode: status, seconds }));
      process.exit(3);
    }

    const ok = status === 0 && Boolean(answer.trim());
    console.log(JSON.stringify({ ok, engine: 'codex', exitCode: status, seconds }));
    if (answer.trim()) console.log(answer.slice(0, 3000));
    else if (stderr.trim()) console.log(stderr.slice(-1500));
    process.exit(ok ? 0 : 1);
  });
}

module.exports = {
  WATCHDOG_INTERVAL_MS,
  HARD_LIMIT_MS,
  parseArgs,
  buildCodexArgs,
  detectGitCommonDir,
  checkCodexCeiling,
};

if (require.main === module) main();
