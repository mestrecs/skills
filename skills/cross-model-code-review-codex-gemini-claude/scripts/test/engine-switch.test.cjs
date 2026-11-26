'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../engine-switch.cjs');
const cfgMod = require('../config.cjs');

const SID = '11111111-2222-3333-4444-555555555555';
const SCRIPT = path.resolve(__dirname, '..', 'engine-switch.cjs');

test('default reviewer is codex when no config or chat file exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-sw-'));
  try {
    const key = sw.readChatKey(SID, home, cfgMod.DEFAULTS);
    assert.strictEqual(key.reviewer, 'codex');
    assert.strictEqual(key.helper, 'claude');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('per-chat reviewer switch is isolated per session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-sw2-'));
  try {
    sw.updateChatKey(SID, 'reviewer', 'gemini', 'use gemini reviewer', home, cfgMod.DEFAULTS);
    const key = sw.readChatKey(SID, home, cfgMod.DEFAULTS);
    assert.strictEqual(key.reviewer, 'gemini');
    assert.strictEqual(key.history.length, 1);
    assert.strictEqual(key.history[0].role, 'reviewer');

    const other = sw.readChatKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', home, cfgMod.DEFAULTS);
    assert.strictEqual(other.reviewer, 'codex');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI switches reviewer per chat and rejects bad engine', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-rev-swcli-'));
  const env = Object.assign({}, process.env, { ENGINE_SWITCH_HOME: home });
  try {
    const set = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID, 'reviewer', 'claude', 'use claude reviewer'], { env, encoding: 'utf8' });
    assert.strictEqual(set.status, 0);
    assert.match(set.stdout, /OK reviewer -> claude/);

    const view = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID], { env, encoding: 'utf8' });
    assert.strictEqual(view.status, 0);
    assert.match(view.stdout, /reviewer claude/);

    const bad = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID, 'reviewer', 'unknown'], { env, encoding: 'utf8' });
    assert.strictEqual(bad.status, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
