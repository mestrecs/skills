'use strict';
// Read-only detection of installed CLIs (claude, codex, gemini, agy, optional gh) and login presence.
// Never opens or prints credential files or .env.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineHome, globalConfigPath } = require('./config.cjs');

const ENGINE_BINS = ['claude', 'codex', 'gemini', 'agy'];

// PURE. Extract semver-like version string from `--version` output.
function parseVersion(output) {
  const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(String(output || ''));
  return m ? m[1] : null;
}

// PURE. Relative directories under $HOME whose presence suggests sign-in has happened.
function loginFolderCandidates(engine) {
  if (engine === 'claude') return ['.claude'];
  if (engine === 'codex') return ['.codex'];
  if (engine === 'gemini') return ['.gemini'];
  if (engine === 'agy') return [path.join('.gemini', 'antigravity-cli'), '.antigravity', '.agy'];
  return [];
}

function hasAnyFolder(homeDir, rels) {
  const base = homeDir || os.homedir();
  return rels.some((rel) => fs.existsSync(path.join(base, rel)));
}

function runCommand(bin, args, stubEnvKey) {
  const stub = stubEnvKey ? process.env[stubEnvKey] : null;
  const opts = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  let r;
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) {
      r = cp.spawnSync(process.execPath, [stub].concat(args), opts);
    } else {
      r = cp.spawnSync(stub, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
    }
  } else {
    r = cp.spawnSync(bin, args, Object.assign({}, opts, { shell: process.platform === 'win32' }));
  }
  const ok = !r.error && r.status === 0;
  return { ok, output: (r.stdout || '') + '\n' + (r.stderr || '') };
}

function runVersion(bin) {
  return runCommand(bin, ['--version'], 'ENGINE_SWITCH_BIN_' + bin.toUpperCase());
}

// PURE.
function detectEngineInfo(name, versionRes, homeDir, existsFn) {
  const installed = Boolean(versionRes && versionRes.ok);
  const version = installed ? parseVersion(versionRes.output) : null;
  const checkExists = existsFn || ((rel) => fs.existsSync(path.join(homeDir || os.homedir(), rel)));
  const authed = installed && loginFolderCandidates(name).some(checkExists);
  return { installed, version, authed };
}

function detectGh() {
  const ver = runCommand('gh', ['--version'], 'ENGINE_SWITCH_GH');
  if (!ver.ok) return { installed: false, version: null, authed: false };
  const auth = runCommand('gh', ['auth', 'status'], 'ENGINE_SWITCH_GH');
  return { installed: true, version: parseVersion(ver.output), authed: auth.ok };
}

function hookRegistered(homeDir) {
  try {
    const file = path.join(homeDir || os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').includes('engine-guard.cjs');
  } catch (_) {
    return false;
  }
}

function detect(homeDir, engineSwitchHome) {
  const realHome = homeDir || os.homedir();
  const engines = {};
  for (const name of ENGINE_BINS) {
    engines[name] = detectEngineInfo(name, runVersion(name), realHome);
  }
  return {
    os: process.platform,
    node: process.version,
    configExists: fs.existsSync(globalConfigPath(engineSwitchHome)),
    configPath: globalConfigPath(engineSwitchHome),
    engineHome: engineHome(engineSwitchHome),
    hookConfigured: hookRegistered(realHome),
    gh: detectGh(),
    engines,
  };
}

// PURE.
function formatSummary(info) {
  const parts = [];
  for (const name of ENGINE_BINS) {
    const e = info.engines[name];
    if (!e || !e.installed) parts.push(name + ': not installed');
    else parts.push(name + ': installed' + (e.version ? ' (' + e.version + ')' : '') + ', ' + (e.authed ? 'signed-in folder found' : 'not signed in'));
  }
  if (info.gh) {
    if (!info.gh.installed) parts.push('gh: not installed');
    else parts.push('gh: installed' + (info.gh.version ? ' (' + info.gh.version + ')' : '') + ', ' + (info.gh.authed ? 'signed in' : 'not signed in'));
  }
  parts.push('config: ' + (info.configExists ? 'present' : 'missing'));
  parts.push('hook: ' + (info.hookConfigured ? 'configured' : 'not configured'));
  return parts.join('; ');
}

function main() {
  const result = detect();
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

module.exports = {
  ENGINE_BINS,
  parseVersion,
  loginFolderCandidates,
  hasAnyFolder,
  detectEngineInfo,
  formatSummary,
  detect,
};

if (require.main === module) process.exit(main());
