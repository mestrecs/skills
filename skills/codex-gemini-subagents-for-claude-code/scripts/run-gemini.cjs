'use strict';
// Run a helper task via Gemini CLI (`gemini`) or Antigravity CLI (`agy`) with per-run permissions and sandbox.
// Usage:
//   node run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>] [--cli gemini|agy] [--effort <e> (agy)]
//   node run-gemini.cjs --quota-only
// Exit 3: at quota ceiling (before start, mid-run via watchdog, or quota error in output) + writes ceiling marker.
const { spawnCli, killTree, reserveHelper } = require('./cli-process.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineHome, loadConfig } = require('./config.cjs');
const { readQuotaFile, checkQuota, markCeiling, looksLikeQuotaError } = require('./ceiling.cjs');

const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HARD_LIMIT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_S = 1500;

const { buildHelperPrompt } = require('./helper-prompt.cjs');

// PURE.
function parseArgs(argv) {
  const args = Array.from(argv || []);
  const out = { quotaOnly: false, deliver: false, model: null, effort: null, timeout: null, cli: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quota-only') out.quotaOnly = true;
    else if (a === '--deliver') out.deliver = true;
    else if (a === '--model' && i + 1 < args.length) out.model = args[++i];
    else if (a === '--timeout' && i + 1 < args.length) out.timeout = Number(args[++i]);
    else if (a === '--cli' && i + 1 < args.length) out.cli = args[++i];
    else if (a === '--effort' && i + 1 < args.length) out.effort = args[++i];
    else out.positional.push(a);
  }
  return out;
}

// PURE. agy per-run permissions: run commands, read anywhere, write only inside the helper's folder.
function buildPermissionsObject(dirPosix) {
  return { permissions: { allow: ['command(*)', 'read_file(*)', 'write_file(' + dirPosix + '/**)'], deny: [] } };
}

// PURE. Build arguments supported by each CLI. Gemini receives its request on stdin.
function buildGeminiArgs(opts) {
  const model = opts.model && opts.model !== '<latest>' ? ['--model', opts.model] : [];
  const args = opts.cli === 'agy'
    ? ['-p', 'Read and follow the request in ' + opts.requestPosix, ...model,
      '--mode', 'accept-edits', '--output-format', 'json', '--print-timeout', opts.timeoutSec + 's',
      '--add-dir', opts.tempDirPosix, '--add-dir', opts.dirPosix]
      // Per-run permissions (agy --settings: "Settings for this session only, never saved"). Never put an allow-all in the
      // person's global agy settings: it leaks into every helper run and lets it write anywhere.
      .concat(opts.permissionsPosix ? ['--settings', opts.permissionsPosix] : [])
    : ['-p', 'Follow the helper request provided on stdin.', ...model, '--approval-mode', 'auto_edit', '--output-format', 'json'];
  if (opts.cli === 'agy' && opts.effort) args.push('--effort', opts.effort);
  if (!opts.deliver) args.push('--sandbox');
  return args;
}

function readJsonResult(stdout) {
  try {
    const data = JSON.parse(stdout);
    const failure = data.error || (data.finished_reason && !['completed', 'stop', 'success'].includes(data.finished_reason));
    const error = data.error ? [data.error.type, data.error.code && 'status code ' + data.error.code, data.error.message || data.error].join(' ') : '';
    return { text: !failure && typeof data.response === 'string' ? data.response : '', error };
  } catch (_) {
    return { text: '', error: '' };
  }
}

function checkGeminiCeiling(cfg) {
  const quota = readQuotaFile('gemini');
  const reason = checkQuota(quota, cfg.switchOn, cfg.gemini);
  return { quota, reason };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const dirArg = parsed.positional[0];
  const cfg = loadConfig(dirArg ? path.resolve(dirArg) : process.cwd());

  const initial = checkGeminiCeiling(cfg);
  if (parsed.quotaOnly) {
    if (initial.reason) {
      if (!markCeiling('gemini', initial.reason)) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'gemini', reason: initial.reason, quota: initial.quota }));
      process.exitCode = 3;      return;
    }
    console.log(JSON.stringify({ ok: true, atCeiling: false, engine: 'gemini', quota: initial.quota }));
    process.exitCode = 0;    return;
  }

  if (parsed.positional.length < 3) {
    console.error('usage: run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>]');
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
    if (!markCeiling('gemini', initial.reason)) {
      console.error('could not write quota ceiling marker');
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'gemini', reason: initial.reason }));
    process.exitCode = 3;    return;
  }

  const cli = parsed.cli || (cfg.gemini && cfg.gemini.cli) || 'gemini';
  if (!['gemini', 'agy'].includes(cli)) throw new Error('CLI must be gemini or agy');
  if (parsed.effort && cli !== 'agy') throw new Error('--effort is supported only by agy');
  const model = parsed.model || cfg.gemini.model;
  const effort = parsed.effort || cfg.gemini.effort;
  const timeoutSec = Number.isFinite(parsed.timeout) && parsed.timeout > 0 ? parsed.timeout : DEFAULT_TIMEOUT_S;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-gemini-'));
  const cleanupTemp = () => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  };

  const dirPosix = dir.split(path.sep).join('/');
  const tempDirPosix = tempDir.split(path.sep).join('/');
  const reqCopy = path.join(tempDir, 'request.md');
  const prompt = buildHelperPrompt(fs.readFileSync(requestFile, 'utf8'), dirPosix);
  if (cli === 'agy') fs.writeFileSync(reqCopy, prompt, 'utf8');
  const permissionsFile = path.join(tempDir, 'permissions.json');
  if (cli === 'agy') fs.writeFileSync(permissionsFile, JSON.stringify(buildPermissionsObject(dirPosix)), 'utf8');

  const args = buildGeminiArgs({
    cli,
    model,
    effort,
    deliver: parsed.deliver,
    timeoutSec,
    dirPosix,
    tempDirPosix,
    requestPosix: reqCopy.split(path.sep).join('/'),
    permissionsPosix: cli === 'agy' ? permissionsFile.split(path.sep).join('/') : null,
  });

  const startedAt = Date.now();
  let child;
  try {
    process.once('exit', reserveHelper(path.join(engineHome(), 'helper-slots', 'gemini'), cfg.gemini.maxConcurrent));
    child = spawnCli(process.env['ENGINE_SWITCH_BIN_' + cli.toUpperCase()]
      || process.env.ENGINE_SWITCH_BIN_GEMINI || cli, args, { cwd: dir });
  } catch (err) {
    cleanupTemp();
    throw err;
  }
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16384); });
  child.stdin.on('error', () => {});
  child.stdin.end(cli === 'gemini' ? prompt : undefined);

  let stoppedReason = null;
  let stoppedKind = null;
  const watchdogMs = Number(process.env.ENGINE_SWITCH_WATCHDOG_MS) || WATCHDOG_INTERVAL_MS;
  const timeoutMs = Number(process.env.ENGINE_SWITCH_TIMEOUT_MS) || Math.min((timeoutSec + 60) * 1000, HARD_LIMIT_MS);

  const watchdog = setInterval(() => {
    if (cfg.switchOn && cfg.switchOn.stopMidRun === false) return;
    const nowCheck = checkGeminiCeiling(cfg);
    if (nowCheck.reason && !stoppedReason) {
      stoppedReason = 'MID-RUN CEILING: ' + nowCheck.reason;
      stoppedKind = 'ceiling';
      killTree(child);
    }
  }, watchdogMs);

  const hardTimer = setTimeout(() => {
    if (!stoppedReason) {
      stoppedReason = 'exceeded run timeout';
      stoppedKind = 'timeout';
      killTree(child);
    }
  }, timeoutMs);

  child.on('error', (err) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    cleanupTemp();
    console.log(JSON.stringify({ ok: false, engine: 'gemini', cli, reason: String(err.message || err) }));
    process.exitCode = 1;    return;
  });

  child.on('close', (status) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    cleanupTemp();
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const { text: extracted, error } = readJsonResult(stdout);

    if (stoppedKind === 'ceiling') {
      if (!markCeiling('gemini', stoppedReason)) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, stoppedMidRun: true, engine: 'gemini', cli, seconds, reason: stoppedReason }));
      process.exitCode = 3;      return;
    }
    if (stoppedKind === 'timeout') {
      console.log(JSON.stringify({ ok: false, timedOut: true, engine: 'gemini', cli, seconds, reason: stoppedReason }));
      process.exitCode = 1;      return;
    }

    const quotaErr = (status !== 0 || !extracted.trim()) && looksLikeQuotaError(stderr + '\n' + error);
    if (quotaErr) {
      if (!markCeiling('gemini', 'quota or rate-limit error in ' + cli + ' output')) {
        console.error('could not write quota ceiling marker');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ok: false, atCeiling: true, quotaError: true, engine: 'gemini', cli, exitCode: status, seconds }));
      process.exitCode = 3;      return;
    }

    if (status === 0 && extracted.trim()) {
      fs.mkdirSync(path.dirname(answerFile), { recursive: true });
      fs.writeFileSync(answerFile, extracted + '\n', 'utf8');
    }

    const ok = status === 0 && Boolean(extracted.trim());
    console.log(JSON.stringify({ ok, engine: 'gemini', cli, exitCode: status, seconds }));
    process.exitCode = ok ? 0 : 1;
  });
}

module.exports = {
  WATCHDOG_INTERVAL_MS,
  HARD_LIMIT_MS,
  DEFAULT_TIMEOUT_S,
  parseArgs,
  buildPermissionsObject,
  buildGeminiArgs,
  readJsonResult,
  checkGeminiCeiling,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
