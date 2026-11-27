'use strict';
// Machine-wide queue for test suites: only N suites run at once on this computer, and only
// when there is free memory. Usage:
//   node test-queue.cjs [--timeout <seconds>] -- <command> [args...]
//   node test-queue.cjs [--timeout <seconds>] --batch -- "command one" "command two"
// Exit code = the command's exit code (2 usage, 124 gave up waiting).
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const common = require('./common.cjs');
const { loadConfigOrDefaults } = require('./config.cjs');

// PURE
function memoryOk(freeBytes, minFreeGB) {
  return freeBytes / (1024 ** 3) >= minFreeGB;
}

// PURE. Resolves what to spawn. One argument = a full command line written by the repository
// owner in the config (run through the shell); several arguments = a plain argument array.
function buildSpawn(cmdArgs, platform) {
  if (cmdArgs.length === 1) return { cmd: cmdArgs[0], args: [], shell: true };
  let cmd = cmdArgs[0];
  if (platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(cmd)) cmd += '.cmd';
  return { cmd, args: cmdArgs.slice(1), shell: platform === 'win32' && /\.cmd$/.test(cmd) };
}

// PURE. macOS keeps most RAM as cache, so os.freemem() reports a few hundred MB on an idle Mac
// and a queue that trusts it waits forever. What a new process can really get is free +
// inactive + speculative + purgeable pages, as `vm_stat` prints them.
function availableFromVmStat(text) {
  const size = Number((/page size of (\d+) bytes/.exec(text) || [])[1]);
  if (!size) return null;
  let pages = 0;
  let seen = false;
  for (const key of ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable']) {
    const m = new RegExp(key + ':\\s+(\\d+)').exec(text);
    if (m) { pages += Number(m[1]); seen = true; }
  }
  return seen ? pages * size : null;
}

function freeBytes() {
  if (process.env.PARALLEL_PR_FREEMEM_GB) return Number(process.env.PARALLEL_PR_FREEMEM_GB) * 1024 ** 3;
  if (process.platform === 'darwin') {
    const r = cp.spawnSync('vm_stat', [], { encoding: 'utf8' });
    const avail = r.status === 0 ? availableFromVmStat(r.stdout) : null;
    if (avail !== null) return Math.max(avail, os.freemem());
  }
  return os.freemem();
}

function runBatch(commands, logsDir) {
  const failures = [];
  const output = [];
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => /TOKEN|SECRET|PASSW|CREDENTIAL|(?:API|PRIVATE|ACCESS)_?KEY/i.test(key) && value.length >= 8)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  const redact = (text) => secrets.reduce((safe, value) => safe.split(value).join('[redacted]'), text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[abp]-[\w-]{8,}|AKIA[A-Z0-9]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|Bearer[ \t]+[\w./+=-]+)/gi, '[redacted]');
  for (const [index, command] of commands.entries()) {
    const result = common.run(command, [], { shell: true });
    const text = redact(result.stdout + '\n' + result.stderr);
    const label = 'Test command ' + (index + 1) + ' (exit ' + result.status + ')';
    output.push('=== ' + label + ' ===\n' + text);
    if (result.status !== 0) {
      failures.push(label);
      const names = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(?:not ok\b|FAIL(?:ED)?\s|✖\s)/.test(line));
      failures.push(...new Set(names));
    }
  }
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const log = path.join(logsDir, Date.now() + '-' + process.pid + '.log');
    fs.writeFileSync(log, output.join('\n'), { mode: 0o600, flag: 'wx' });
    console.error('[test-queue] full suite log: ' + log);
  } catch (err) {
    console.error('[test-queue] could not save suite log (' + err.code + ')');
  }
  if (failures.length) console.error('[test-queue] suite failures:\n' + failures.join('\n'));
  return failures.length ? 1 : 0;
}

function main(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) {
    console.error('usage: test-queue.cjs [--timeout <seconds>] -- <command...>');
    return 2;
  }
  let flags;
  try {
    flags = common.parseFlags(argv.slice(0, sep), { timeout: 'string', batch: 'bool' }).flags;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const cmdArgs = argv.slice(sep + 1);
  const cfg = loadConfigOrDefaults(process.cwd());
  const slotsDir = path.join(common.parallelHome(), 'slots');
  const logFile = path.join(common.parallelHome(), 'queue.jsonl');
  const stuckMs = cfg.parallel.stuckSuiteMinutes * 60 * 1000;
  const pollMs = Number(process.env.PARALLEL_PR_POLL_MS) || 3000;
  const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
  const started = Date.now();
  let slot = null;
  let announced = false;

  while (!slot) {
    if (memoryOk(freeBytes(), cfg.parallel.minFreeMemoryGB)) {
      slot = common.tryAcquireSlot(slotsDir, cfg.parallel.suiteSlots, { cwd: path.basename(process.cwd()) }, stuckMs);
    }
    if (slot) break;
    if (Date.now() > deadline) {
      common.appendLog(logFile, { event: 'gave-up', waitedMs: Date.now() - started });
      console.error('[test-queue] gave up waiting for a free slot');
      return 124;
    }
    if (!announced) {
      console.error('[test-queue] waiting for a free slot or free memory...');
      announced = true;
    }
    common.sleepSync(pollMs);
  }

  const release = () => common.releaseLock(slot);
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const waitedMs = Date.now() - started;
  let code;
  if (flags.batch) {
    code = runBatch(cmdArgs, path.join(common.parallelHome(), 'suite-logs'));
  } else {
    const sp = buildSpawn(cmdArgs, process.platform);
    const child = cp.spawnSync(sp.cmd, sp.args, { stdio: 'inherit', shell: sp.shell, env: common.cleanEnv(), windowsHide: true });
    code = child.status === null ? 1 : child.status;
  }
  common.appendLog(logFile, { event: 'ran', waitedMs, runMs: Date.now() - started - waitedMs, exit: code, dir: path.basename(process.cwd()) });
  return code;
}

module.exports = { memoryOk, buildSpawn, availableFromVmStat };

if (require.main === module) process.exit(main(process.argv.slice(2)));
