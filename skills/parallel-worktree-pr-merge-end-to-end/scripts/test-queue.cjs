'use strict';
// Machine-wide queue for test suites: only N suites run at once on this computer, and only
// when there is free memory. Usage:
//   node test-queue.cjs [--timeout <seconds>] -- <command> [args...]
// Exit code = the command's exit code (2 usage, 124 gave up waiting).
const os = require('os');
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

function freeBytes() {
  if (process.env.PARALLEL_PR_FREEMEM_GB) return Number(process.env.PARALLEL_PR_FREEMEM_GB) * 1024 ** 3;
  return os.freemem();
}

function main(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) {
    console.error('usage: test-queue.cjs [--timeout <seconds>] -- <command...>');
    return 2;
  }
  let flags;
  try {
    flags = common.parseFlags(argv.slice(0, sep), { timeout: 'string' }).flags;
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
  const sp = buildSpawn(cmdArgs, process.platform);
  const child = cp.spawnSync(sp.cmd, sp.args, { stdio: 'inherit', shell: sp.shell, env: common.cleanEnv(), windowsHide: true });
  const code = child.status === null ? 1 : child.status;
  common.appendLog(logFile, { event: 'ran', waitedMs, runMs: Date.now() - started - waitedMs, exit: code, dir: path.basename(process.cwd()) });
  return code;
}

module.exports = { memoryOk, buildSpawn };

if (require.main === module) process.exit(main(process.argv.slice(2)));
