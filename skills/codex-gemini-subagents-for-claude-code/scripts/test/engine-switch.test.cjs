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

test('opt-in default helper is claude when no config or chat file exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-switch-'));
  try {
    const key = sw.readChatKey(SID, home, cfgMod.DEFAULTS);
    assert.strictEqual(key.helper, 'claude');
    assert.strictEqual(key.reviewer, 'codex');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('per-chat update persists helper and reviewer independently and caps history', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-switch-upd-'));
  try {
    sw.updateChatKey(SID, 'helper', 'codex', 'use codex helpers', home, cfgMod.DEFAULTS);
    sw.updateChatKey(SID, 'reviewer', 'gemini', 'use gemini reviewer', home, cfgMod.DEFAULTS);
    const key = sw.readChatKey(SID, home, cfgMod.DEFAULTS);
    assert.strictEqual(key.helper, 'codex');
    assert.strictEqual(key.reviewer, 'gemini');
    assert.strictEqual(key.history.length, 2);
    assert.strictEqual(key.history[0].to, 'codex');

    const other = sw.readChatKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', home, cfgMod.DEFAULTS);
    assert.strictEqual(other.helper, 'claude');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI prints current key with no role, updates with role, rejects invalid inputs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-switch-cli-'));
  const env = Object.assign({}, process.env, { ENGINE_SWITCH_HOME: home });
  try {
    const view1 = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID], { env, encoding: 'utf8' });
    assert.strictEqual(view1.status, 0);
    assert.match(view1.stdout, /helper claude \| reviewer codex/);

    const set1 = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID, 'helper', 'gemini', 'save quota'], { env, encoding: 'utf8' });
    assert.strictEqual(set1.status, 0);
    assert.match(set1.stdout, /OK helper -> gemini/);

    const view2 = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID], { env, encoding: 'utf8' });
    assert.strictEqual(view2.status, 0);
    assert.match(view2.stdout, /helper gemini \| reviewer codex/);

    const badChat = cp.spawnSync(process.execPath, [SCRIPT, '--chat', 'bad!'], { env, encoding: 'utf8' });
    assert.strictEqual(badChat.status, 2);

    const badEngine = cp.spawnSync(process.execPath, [SCRIPT, '--chat', SID, 'helper', 'skynet'], { env, encoding: 'utf8' });
    assert.strictEqual(badEngine.status, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('all-chats default, normalized keys, and malformed keys are distinguishable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-switch-key-'));
  try {
    const cfg = { ...cfgMod.DEFAULTS, defaults: { helper: 'gemini' } };
    assert.equal(sw.readChatKey(SID, home, cfg).helper, 'claude');
    assert.equal(sw.readChatKey(SID, home, { ...cfg, newChatsMode: 'all-chats' }).helper, 'gemini');
    const file = sw.chatKeyPath(SID, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ' Helper ': ' CODEX ' }));
    assert.equal(sw.readChatKey(SID, home, cfg).helper, 'codex');
    for (const broken of ['{', '[]', '{"helper":"unknown"}', '{"helper":"codex","HELPER":"claude"}']) {
      fs.writeFileSync(file, broken);
      assert.equal(sw.readChatKey(SID, home, cfg), null);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
