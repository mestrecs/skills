'use strict';
// Read-only detection of installed CLIs (claude, codex, gemini, agy), hook presence, and lean agent file.
// Never opens or prints credential files or .env.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineHome, globalConfigPath, loadConfig } = require('./config.cjs');

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

function runVersion(bin) {
  const upper = bin.toUpperCase();
  const stub = process.env['MODEL_ROUTER_BIN_' + upper] || process.env['ENGINE_SWITCH_BIN_' + upper];
  const opts = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  let r;
  if (stub) {
    if (stub.endsWith('.cjs') || stub.endsWith('.js')) {
      r = cp.spawnSync(process.execPath, [stub, '--version'], opts);
    } else {
      r = cp.spawnSync(stub, ['--version'], Object.assign({}, opts, { shell: process.platform === 'win32' }));
    }
  } else {
    r = cp.spawnSync(bin, ['--version'], Object.assign({}, opts, { shell: process.platform === 'win32' }));
  }
  const ok = !r.error && r.status === 0;
  return { ok, output: (r.stdout || '') + '\n' + (r.stderr || '') };
}

// PURE.
function detectEngineInfo(name, versionRes, homeDir, existsFn) {
  const installed = Boolean(versionRes && versionRes.ok);
  const version = installed ? parseVersion(versionRes.output) : null;
  const checkExists = existsFn || ((rel) => fs.existsSync(path.join(homeDir || os.homedir(), rel)));
  const authed = installed && loginFolderCandidates(name).some(checkExists);
  return { installed, version, authed };
}

function settingsContain(homeDir, cwd, needle) {
  const files = [
    path.join(homeDir || os.homedir(), '.claude', 'settings.json'),
    path.join(homeDir || os.homedir(), '.claude', 'settings.local.json'),
  ];
  if (cwd) {
    files.push(path.join(cwd, '.claude', 'settings.json'));
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
  }
  for (const file of files) {
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(needle)) return true;
    } catch (_) {
      // ignore unreadable settings files
    }
  }
  return false;
}

function leanAgentExists(homeDir, cwd, agentName) {
  const fileName = (agentName || 'helper') + '.md';
  const candidates = [path.join(homeDir || os.homedir(), '.claude', 'agents', fileName)];
  if (cwd) candidates.push(path.join(cwd, '.claude', 'agents', fileName));
  return candidates.some((f) => fs.existsSync(f));
}

function detect(homeDir, engineSwitchHome, cwd) {
  const realHome = homeDir || os.homedir();
  const workDir = cwd || process.cwd();
  const cfg = loadConfig(workDir, engineSwitchHome);
  const agentName = (cfg.modelRouting && cfg.modelRouting.leanHelper && cfg.modelRouting.leanHelper.agentName) || 'helper';
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
    hookConfigured: settingsContain(realHome, workDir, 'model-router.cjs'),
    engineGuardConfigured: settingsContain(realHome, workDir, 'engine-guard.cjs'),
    leanAgentInstalled: leanAgentExists(realHome, workDir, agentName),
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
  parts.push('config: ' + (info.configExists ? 'present' : 'missing'));
  parts.push('model-router hook: ' + (info.hookConfigured ? 'configured' : 'not configured'));
  if (info.engineGuardConfigured !== undefined) {
    parts.push('engine-guard hook: ' + (info.engineGuardConfigured ? 'configured' : 'not configured'));
  }
  if (info.leanAgentInstalled !== undefined) {
    parts.push('lean agent: ' + (info.leanAgentInstalled ? 'installed' : 'not installed'));
  }
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
