'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// Keep arguments out of cmd.exe. Windows npm shims just forward to a JS entry point.
function resolveCli(bin, args, opts = {}) {
  if (/\.[cm]?js$/i.test(bin)) {
    const script = path.resolve(bin);
    if (!fs.existsSync(script)) throw Object.assign(new Error('CLI script not found'), { code: 'ENOENT' });
    return { file: process.execPath, args: [script, ...args] };
  }
  if (process.platform !== 'win32') return { file: bin, args };

  const query = cp.spawnSync('where.exe', [bin], {
    encoding: 'utf8', cwd: opts.cwd, env: opts.env, windowsHide: true, timeout: 5000,
  });
  if (query.error) throw query.error;
  for (const file of (query.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (/\.(exe|com)$/i.test(file)) return { file, args };
    if (!/\.cmd$/i.test(file)) continue;
    const shim = fs.readFileSync(file, 'utf8');
    const target = /"%dp0%[\\/]([^"\r\n]+\.[cm]?js)"[ \t]+%\*/i.exec(shim);
    if (!target) continue;
    const entry = path.resolve(path.dirname(file), target[1]);
    if (fs.existsSync(entry)) return { file: process.execPath, args: [entry, ...args] };
  }
  const code = query.status === 1 ? 'ENOENT' : 'UNSUPPORTED_CLI';
  throw Object.assign(new Error(code === 'ENOENT' ? 'CLI not found: ' + bin : 'Unsupported Windows CLI launcher: ' + bin), { code });
}

function spawnCliSync(bin, args, opts = {}) {
  try {
    const cmd = resolveCli(bin, args, opts);
    return cp.spawnSync(cmd.file, cmd.args, { ...opts, windowsHide: true });
  } catch (error) {
    return { error, status: null };
  }
}

module.exports = { spawnCliSync };
