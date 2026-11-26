'use strict';
// Read-only detection of installed CLIs (claude, codex, gemini, agy), login presence, and connector names.
// Never opens or prints credential files, .env, or connector config values/env/args/URLs/tokens.
const { spawnCliSync } = require('./cli-process.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineHome, globalConfigPath, loadConfig } = require('./config.cjs');

const ENGINE_BINS = ['claude', 'codex', 'gemini', 'agy'];
const AGY_CONNECTOR_FILES = [
  path.join('.gemini', 'config', 'mcp_config.json'),
  path.join('.gemini', 'antigravity-cli', 'mcp_config.json'),
  path.join('.gemini', 'antigravity-cli', 'settings.json'),
  path.join('.gemini', 'antigravity', 'mcp_config.json'),
  path.join('.antigravity', 'settings.json'),
  path.join('.agy', 'settings.json'),
];

function isPlainObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// PURE. Deduplicate connector names case-insensitively while preserving first-seen casing.
function dedupeCaseInsensitive(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names || []) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeProjectPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || /^[a-z]:\//i.test(s)) s = s.toLowerCase();
  return s;
}

// PURE. Extract MCP server names only from JSON containing an `mcpServers` object.
function parseMcpJsonServers(text) {
  const obj = parseJsonObject(text);
  if (!obj || !isPlainObject(obj.mcpServers)) return [];
  return dedupeCaseInsensitive(Object.keys(obj.mcpServers));
}

// PURE. Extract MCP server names from `~/.claude.json` (top-level `mcpServers` and `projects[<cwd>].mcpServers`).
function parseClaudeJsonMcpServers(text, cwd) {
  const obj = parseJsonObject(text);
  if (!obj) return [];
  const names = [];
  if (isPlainObject(obj.mcpServers)) names.push(...Object.keys(obj.mcpServers));
  if (cwd && isPlainObject(obj.projects)) {
    const target = normalizeProjectPath(cwd);
    for (const [projKey, projVal] of Object.entries(obj.projects)) {
      if ((projKey === cwd || (target && normalizeProjectPath(projKey) === target)) && isPlainObject(projVal) && isPlainObject(projVal.mcpServers)) {
        names.push(...Object.keys(projVal.mcpServers));
      }
    }
  }
  return dedupeCaseInsensitive(names);
}

// PURE. Extract MCP server names from `claude mcp list` output (name before `:` on each server line).
function parseClaudeMcpList(output) {
  const names = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const m = /^[ \t]*([^:\r\n]+?):(?:\s|$)/.exec(rawLine);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || /^(?:error|warning|usage|note|hint)$/i.test(name)) continue;
    names.push(name);
  }
  return dedupeCaseInsensitive(names);
}

// PURE. Extract `[mcp_servers.<name>]` table names from Codex `config.toml` without a TOML library.
function parseCodexTomlMcpServers(text) {
  const names = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const m = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_-]+))[ \t]*(?:\.[^\]]*)?\][ \t]*(?:#.*)?$/.exec(rawLine);
    if (!m) continue;
    names.push(m[1] || m[2] || m[3]);
  }
  return dedupeCaseInsensitive(names);
}

// PURE. Return Claude connector names absent from all selected helper engines (case-insensitive).
function computeClaudeOnly(connectors, selectedEngines) {
  const claudeList = Array.isArray(connectors && connectors.claude) ? connectors.claude : [];
  const helpers = Array.isArray(selectedEngines) ? selectedEngines : ['codex', 'gemini'];
  const helperSet = new Set();
  for (const eng of helpers) {
    const key = String(eng || '').trim().toLowerCase();
    if (!key || key === 'claude') continue;
    const list = connectors && connectors[key];
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (typeof name === 'string' && name.trim()) helperSet.add(name.trim().toLowerCase());
    }
  }
  return dedupeCaseInsensitive(claudeList).filter((name) => !helperSet.has(name.toLowerCase()));
}

function readFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

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
  const stub = process.env['ENGINE_SWITCH_BIN_' + bin.toUpperCase()];
  const opts = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  const r = spawnCliSync(stub || bin, ['--version'], opts);
  const ok = !r.error && r.status === 0;
  return { ok, output: (r.stdout || '') + '\n' + (r.stderr || '') };
}

function runClaudeMcpList() {
  const stub = process.env.ENGINE_SWITCH_BIN_CLAUDE;
  const r = spawnCliSync(stub || 'claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.error || r.status !== 0) return [];
  return parseClaudeMcpList(r.stdout || '');
}

// PURE.
function detectEngineInfo(name, versionRes, homeDir, existsFn) {
  const installed = Boolean(versionRes && versionRes.ok);
  const version = installed ? parseVersion(versionRes.output) : null;
  const checkExists = existsFn || ((rel) => fs.existsSync(path.join(homeDir || os.homedir(), rel)));
  const authed = installed && loginFolderCandidates(name).some(checkExists);
  return { installed, version, authed };
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

function resolveSelectedHelperEngines(cwd, engineSwitchHome, selectedEngines) {
  if (Array.isArray(selectedEngines)) return selectedEngines;
  if (fs.existsSync(globalConfigPath(engineSwitchHome))) {
    try {
      const cfg = loadConfig(cwd, engineSwitchHome);
      const out = [];
      for (const eng of cfg.engines || []) {
        if (eng === 'codex') out.push('codex');
        else if (eng === 'gemini') out.push(cfg.gemini && cfg.gemini.cli === 'agy' ? 'agy' : 'gemini');
      }
      return out;
    } catch (_) {
      // Ignore invalid config during read-only detection.
    }
  }
  return ['codex', 'gemini', 'agy'];
}

function detectAgyConnectors(homeDir) {
  const names = [];
  let known = false;
  for (const rel of AGY_CONNECTOR_FILES) {
    const text = readFileSafe(path.join(homeDir, rel));
    const obj = parseJsonObject(text);
    if (obj && isPlainObject(obj.mcpServers)) {
      known = true;
      names.push(...Object.keys(obj.mcpServers));
    }
  }
  return known ? dedupeCaseInsensitive(names) : 'not checked';
}

function detectConnectors(homeDir, cwd, enginesInfo, selectedEngines) {
  const realHome = homeDir || os.homedir();
  const workDir = path.resolve(cwd || process.cwd());

  const claudeNames = [
    ...parseClaudeJsonMcpServers(readFileSafe(path.join(realHome, '.claude.json')), workDir),
    ...parseMcpJsonServers(readFileSafe(path.join(workDir, '.mcp.json'))),
    ...(enginesInfo && enginesInfo.claude && enginesInfo.claude.installed ? runClaudeMcpList() : []),
  ];
  const codexNames = parseCodexTomlMcpServers(readFileSafe(path.join(realHome, '.codex', 'config.toml')));
  const geminiNames = [
    ...parseMcpJsonServers(readFileSafe(path.join(realHome, '.gemini', 'settings.json'))),
    ...parseMcpJsonServers(readFileSafe(path.join(workDir, '.gemini', 'settings.json'))),
  ];
  const agyConnectors = detectAgyConnectors(realHome);

  const byEngine = {
    claude: dedupeCaseInsensitive(claudeNames),
    codex: dedupeCaseInsensitive(codexNames),
    gemini: dedupeCaseInsensitive(geminiNames),
    agy: agyConnectors,
  };
  return {
    ...byEngine,
    claudeOnly: computeClaudeOnly(byEngine, selectedEngines),
  };
}

function detect(homeDir, engineSwitchHome, cwd, selectedEngines) {
  const realHome = homeDir || os.homedir();
  const workDir = cwd || process.cwd();
  const engines = {};
  for (const name of ENGINE_BINS) {
    engines[name] = detectEngineInfo(name, runVersion(name), realHome);
  }
  const helperEngines = resolveSelectedHelperEngines(workDir, engineSwitchHome, selectedEngines);
  return {
    os: process.platform,
    node: process.version,
    configExists: fs.existsSync(globalConfigPath(engineSwitchHome)),
    configPath: globalConfigPath(engineSwitchHome),
    engineHome: engineHome(engineSwitchHome),
    hookConfigured: hookRegistered(realHome),
    engines,
    connectors: detectConnectors(realHome, workDir, engines, helperEngines),
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
  parts.push('hook: ' + (info.hookConfigured ? 'configured' : 'not configured'));
  if (info.connectors) {
    const only = info.connectors.claudeOnly || [];
    parts.push('claude-only connectors: ' + (only.length ? only.join(', ') : 'none'));
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
  AGY_CONNECTOR_FILES,
  dedupeCaseInsensitive,
  parseMcpJsonServers,
  parseClaudeJsonMcpServers,
  parseClaudeMcpList,
  parseCodexTomlMcpServers,
  computeClaudeOnly,
  parseVersion,
  loginFolderCandidates,
  hasAnyFolder,
  detectEngineInfo,
  detectConnectors,
  formatSummary,
  detect,
};

if (require.main === module) process.exit(main());
