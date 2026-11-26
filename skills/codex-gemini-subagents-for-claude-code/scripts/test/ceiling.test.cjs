'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ceil = require('../ceiling.cjs');

test('markCeiling and recentCeiling honor validity window', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-ceil-'));
  try {
    assert.strictEqual(ceil.recentCeiling('codex', home), false);
    assert.strictEqual(ceil.markCeiling('codex', 'window at 92%', home), true);
    const data = ceil.readCeiling('codex', home);
    assert.strictEqual(data.engine, 'codex');
    assert.strictEqual(data.reason, 'window at 92%');

    assert.strictEqual(ceil.recentCeiling('codex', home, data.at), true);
    assert.strictEqual(ceil.recentCeiling('codex', home, data.at + ceil.CEILING_VALID_MS), true);
    assert.strictEqual(ceil.recentCeiling('codex', home, data.at + ceil.CEILING_VALID_MS + 1), false);
    assert.strictEqual(ceil.recentCeiling('codex', home, data.at - 1), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readQuotaFile enforces 15-minute freshness and valid fields', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'es-quota-'));
  try {
    const now = 1795651200000;
    const qPath = ceil.quotaFilePath('codex', home);
    fs.writeFileSync(qPath, JSON.stringify({ windowPct: 45, weekPct: 30, at: now - 5 * 60 * 1000 }));
    const fresh = ceil.readQuotaFile('codex', home, now);
    assert.strictEqual(fresh.windowPct, 45);
    assert.strictEqual(fresh.weekPct, 30);

    // Older than 15 minutes -> ignored
    fs.writeFileSync(qPath, JSON.stringify({ windowPct: 99, weekPct: 99, at: now - ceil.QUOTA_MAX_AGE_MS - 1 }));
    assert.strictEqual(ceil.readQuotaFile('codex', home, now), null);

    // Future timestamp -> ignored
    fs.writeFileSync(qPath, JSON.stringify({ windowPct: 99, weekPct: 99, at: now + 60000 }));
    assert.strictEqual(ceil.readQuotaFile('codex', home, now), null);

    // Malformed JSON -> null
    fs.writeFileSync(qPath, '{bad');
    assert.strictEqual(ceil.readQuotaFile('codex', home, now), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('checkQuota respects percent-or-error, error-only, and sharedAccount sharePct', () => {
  const sw = { mode: 'percent-or-error', maxWindowPct: 90, maxWeekPct: 80 };
  assert.strictEqual(ceil.checkQuota({ windowPct: 89, weekPct: 79 }, sw, { sharedAccount: false, sharePct: 50 }), null);
  assert.match(ceil.checkQuota({ windowPct: 90, weekPct: 10 }, sw, {}), /90%/);
  assert.match(ceil.checkQuota({ windowPct: 10, weekPct: 80 }, sw, {}), /80%/);
  assert.strictEqual(ceil.checkQuota({ windowPct: 99, weekPct: 99 }, { mode: 'error-only', maxWindowPct: 90, maxWeekPct: 80 }, {}), null);
  assert.match(ceil.checkQuota({ windowPct: 40, weekPct: 10 }, sw, { sharedAccount: true, sharePct: 40 }), /ceiling 40%/);
});

test('looksLikeQuotaError matches rate limit, quota, 429, usage limit', () => {
  assert.strictEqual(ceil.looksLikeQuotaError('Error 429 Too Many Requests'), true);
  assert.strictEqual(ceil.looksLikeQuotaError('Rate-limit reached'), true);
  assert.strictEqual(ceil.looksLikeQuotaError('API quota exceeded'), true);
  assert.strictEqual(ceil.looksLikeQuotaError('Usage limit reached'), true);
  assert.strictEqual(ceil.looksLikeQuotaError('All tests passed'), false);
});
