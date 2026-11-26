'use strict';
// Run a helper task via Gemini CLI (`gemini`) or Antigravity CLI (`agy`) with per-run permissions and sandbox.
// Usage:
//   node run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>] [--cli gemini|agy]
//   node run-gemini.cjs --quota-only
// Exit 3: at quota ceiling (before start, mid-run via watchdog, or quota error in output) + writes ceiling marker.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('./config.cjs');
const { readQuotaFile, checkQuota, markCeiling, looksLikeQuotaError } = require('./ceiling.cjs');

const WATCHDOG_INTERVAL_MS = 60 * 1000;
const HARD_LIMIT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_S = 1500;

const HELPER_RULES = (dir) =>
  '\n\nRules: Only write files inside ' + dir + '. Never run git push directly, never use --no-verify, '
  + 'never merge pull requests manually, never run broad test suites unless explicitly requested, '
  + 'and never print, log or commit secrets or environment variables.\n';

// PURE.
function parseArgs(argv) {
  const args = Array.from(argv || []);
  const out = { quotaOnly: false, deliver: false, model: null, timeout: null, cli: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quota-only') out.quotaOnly = true;
    else if (a === '--deliver') out.deliver = true;
    else if (a === '--model' && i + 1 < args.length) out.model = args[++i];
    else if (a === '--timeout' && i + 1 < args.length) out.timeout = Number(args[++i]);
    else if (a === '--cli' && i + 1 < args.length) out.cli = args[++i];
    else if (a === '--effort' && i + 1 < args.length) i += 1; // accepted for CLI parity
    else out.positional.push(a);
  }
  return out;
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

// PURE. Build CLI argument list for `gemini` or `agy`.
function buildGeminiArgs(opts) {
  const prompt = 'Read the entire file ' + opts.requestPosix + ' and follow its instructions. Only write files inside ' + opts.dirPosix + '.';
  if (opts.cli === 'agy') {
    const args = [
      '-p', prompt,
      '--model', opts.model,
      '--mode', 'accept-edits',
      '--output-format', 'json',
      '--print-timeout', opts.timeoutSec + 's',
      '--settings', opts.permissionsPosix,
      '--add-dir', opts.tempDirPosix,
      '--add-dir', opts.dirPosix,
    ];
    if (!opts.deliver) args.push('--sandbox');
    return args;
  }
  const args = ['-p', prompt, '--model', opts.model];
  if (!opts.deliver) args.push('--sandbox');
  return args;
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

function spawnGemini(cli, args, cwd) {
  const stub = process.env.ENGINE_SWITCH_BIN_GEMINI || (cli === 'agy' ? process.env.ENGINE_SWITCH_BIN_AGY : null);
  const opts = { cwd, windowsHide: true };
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) {
      return cp.spawn(process.execPath, [stub].concat(args), opts);
    }
    return cp.spawn(stub, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
  }
  return cp.spawn(cli, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
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
      markCeiling('gemini', initial.reason);
      console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'gemini', reason: initial.reason, quota: initial.quota }));
      process.exit(3);
    }
    console.log(JSON.stringify({ ok: true, atCeiling: false, engine: 'gemini', quota: initial.quota }));
    process.exit(0);
  }

  if (parsed.positional.length < 3) {
    console.error('usage: run-gemini.cjs <dir> <request.md> <answer.txt> [--deliver] [--model <m>] [--timeout <s>]');
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
    markCeiling('gemini', initial.reason);
    console.log(JSON.stringify({ ok: false, atCeiling: true, engine: 'gemini', reason: initial.reason }));
    process.exit(3);
  }

  const cli = parsed.cli || (cfg.gemini && cfg.gemini.cli) || 'gemini';
  const model = parsed.model || (cfg.gemini && cfg.gemini.model) || 'gemini-4-hydrogen-high';
  const timeoutSec = Number.isFinite(parsed.timeout) && parsed.timeout > 0 ? parsed.timeout : DEFAULT_TIMEOUT_S;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-gemini-'));
  const cleanupTemp = () => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  };

  const dirPosix = dir.split(path.sep).join('/');
  const tempDirPosix = tempDir.split(path.sep).join('/');
  const reqCopy = path.join(tempDir, 'request.md');
  const permsFile = path.join(tempDir, 'permissions.json');

  fs.writeFileSync(reqCopy, fs.readFileSync(requestFile, 'utf8') + HELPER_RULES(dirPosix), 'utf8');
  fs.writeFileSync(permsFile, JSON.stringify(buildPermissionsObject(dirPosix)), 'utf8');

  const args = buildGeminiArgs({
    cli,
    model,
    deliver: parsed.deliver,
    timeoutSec,
    dirPosix,
    tempDirPosix,
    requestPosix: reqCopy.split(path.sep).join('/'),
    permissionsPosix: permsFile.split(path.sep).join('/'),
  });

  const startedAt = Date.now();
  const child = spawnGemini(cli, args, dir);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-16384); });
  child.stdin.end();

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
    process.exit(1);
  });

  child.on('close', (status) => {
    clearInterval(watchdog);
    clearTimeout(hardTimer);
    cleanupTemp();
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const extracted = extractOutputText(cli, stdout);

    if (stoppedKind === 'ceiling') {
      markCeiling('gemini', stoppedReason);
      console.log(JSON.stringify({ ok: false, atCeiling: true, stoppedMidRun: true, engine: 'gemini', cli, seconds, reason: stoppedReason }));
      process.exit(3);
    }
    if (stoppedKind === 'timeout') {
      console.log(JSON.stringify({ ok: false, timedOut: true, engine: 'gemini', cli, seconds, reason: stoppedReason }));
      process.exit(1);
    }

    const quotaErr = (status !== 0 && looksLikeQuotaError(stderr + '\n' + stdout + '\n' + extracted))
      || (status === 0 && !extracted.trim() && looksLikeQuotaError(stderr + '\n' + stdout));
    if (quotaErr) {
      markCeiling('gemini', 'quota or rate-limit error in ' + cli + ' output');
      console.log(JSON.stringify({ ok: false, atCeiling: true, quotaError: true, engine: 'gemini', cli, exitCode: status, seconds }));
      process.exit(3);
    }

    if (extracted) {
      fs.mkdirSync(path.dirname(answerFile), { recursive: true });
      fs.writeFileSync(answerFile, extracted + '\n', 'utf8');
    }

    const ok = status === 0 && Boolean(extracted.trim());
    console.log(JSON.stringify({ ok, engine: 'gemini', cli, exitCode: status, seconds }));
    if (extracted.trim()) console.log(extracted.slice(0, 3000));
    else if (stderr.trim()) console.log(stderr.slice(-1500));
    process.exit(ok ? 0 : 1);
  });
}

module.exports = {
  WATCHDOG_INTERVAL_MS,
  HARD_LIMIT_MS,
  DEFAULT_TIMEOUT_S,
  parseArgs,
  buildPermissionsObject,
  buildGeminiArgs,
  extractOutputText,
  checkGeminiCeiling,
};

if (require.main === module) main();
