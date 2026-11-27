'use strict';
// Run a helper task via Codex CLI in a worktree/folder with quota ceiling checks and a mid-run watchdog.
// Usage:
//   node run-codex.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--effort <e>]
//   node run-codex.cjs --quota-only
// Exit 3: at quota ceiling (before start, mid-run via watchdog, or quota error in output) + writes ceiling marker.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnCli, killTree, reserveHelper } = require('./cli-process.cjs');
const { engineHome, loadConfig } = require('./config.cjs');
const { readQuotaFile, checkQuota, markCeiling, looksLikeQuotaError } = require('./ceiling.cjs');

const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HARD_LIMIT_MS = 60 * 60 * 1000;

const { buildHelperPrompt } = require('./helper-prompt.cjs');

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
      base.push('--add-dir', opts.gitCommonDir);
    }
  }
  if (opts.model && opts.model !== '<latest>') base.push('-m', opts.model);
  if (opts.effort) base.push('-c', 'model_reasoning_effort=' + JSON.stringify(opts.effort));
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
      if (!markCeiling('codex', initial.reason)) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'codex', reason: initial.reason, quota: initial.quota }));
      process.exitCode = 3;      return;
    }
    console.log(JSON.stringify({ ok: true, atCeiling: false, engine: 'codex', quota: initial.quota }));
    process.exitCode = 0;    return;
  }

  if (parsed.positional.length < 3) {
    console.error('usage: run-codex.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--effort <e>]');
    process.exitCode = 2;    return;
  }

  const dir = path.resolve(parsed.positional[0]);
  const requestFile = path.resolve(parsed.positional[1]);
  const answerFile = path.resolve(parsed.positional[2]);

  if (!fs.existsSync(dir) || !fs.existsSync(requestFile)) {
    console.error('directory or request file not found');
    process.exitCode = 2;    return;
  }

  if (initial.reason) {
    if (!markCeiling('codex', initial.reason)) {
      console.error('could not write quota ceiling marker');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'codex', reason: initial.reason }));
    process.exitCode = 3;    return;
  }

  const prompt = buildHelperPrompt(fs.readFileSync(requestFile, 'utf8'), dir);
  const gitInfo = detectGitCommonDir(dir);
  const model = parsed.model || (cfg.codex && cfg.codex.model) || '<latest>';
  const effort = parsed.effort || (cfg.codex && cfg.codex.effort) || 'medium';
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-codex-'));
  const stageAnswer = path.join(stageDir, 'answer.txt');
  const cleanup = () => { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {} };
  const args = buildCodexArgs({
    dir,
    answerFile: stageAnswer,
    deliver: parsed.deliver,
    model,
    effort,
    isRepo: gitInfo.isRepo,
    gitCommonDir: gitInfo.gitCommonDir,
  });

  const startedAt = Date.now();
  let child;
  try {
    process.once('exit', reserveHelper(path.join(engineHome(), 'helper-slots', 'codex'), cfg.codex.maxConcurrent));
    process.once('exit', cleanup);
    child = spawnCli(process.env.ENGINE_SWITCH_BIN_CODEX || 'codex', args, { cwd: dir });
  } catch (err) {
    cleanup();
    throw err;
  }
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
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
    process.exitCode = 1;    return;
  });

  child.on('close', (status) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    let answer = '';
    try { answer = fs.readFileSync(stageAnswer, 'utf8'); } catch (_) {}

    if (stoppedKind === 'ceiling') {
      if (!markCeiling('codex', stoppedReason)) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, stoppedMidRun: true, engine: 'codex', seconds, reason: stoppedReason }));
      process.exitCode = 3;      return;
    }
    if (stoppedKind === 'timeout') {
      console.log(JSON.stringify({ ok: false, timedOut: true, engine: 'codex', seconds, reason: stoppedReason }));
      process.exitCode = 1;      return;
    }

    const quotaErr = (status !== 0 || !answer.trim()) && looksLikeQuotaError(stderr);
    if (quotaErr) {
      if (!markCeiling('codex', 'quota or rate-limit error in codex output')) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, quotaError: true, engine: 'codex', exitCode: status, seconds }));
      process.exitCode = 3;      return;
    }

    const ok = status === 0 && Boolean(answer.trim());
    if (ok) {
      fs.mkdirSync(path.dirname(answerFile), { recursive: true });
      fs.writeFileSync(answerFile, answer, 'utf8');
    }

    console.log(JSON.stringify({ ok, engine: 'codex', exitCode: status, seconds }));
    process.exitCode = ok ? 0 : 1;
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

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
