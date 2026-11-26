'use strict';
// Ceiling markers, quota file reading, and quota-error detection.
// Generic quota contract: ~/.engine-switch/quota-<engine>.json holding
// {"windowPct": <0-100>, "weekPct": <0-100>, "at": <ms epoch>} (ignored if > 15 min old).
const fs = require('fs');
const path = require('path');
const { engineHome, resolveAuditLogPath } = require('./config.cjs');

const QUOTA_MAX_AGE_MS = 15 * 60 * 1000;
const CEILING_VALID_MS = 30 * 60 * 1000;
// Match provider failure language, not a bare "quota" or an arbitrary number.
const QUOTA_ERROR_RE = /\b(?:insufficient_quota|resource_exhausted|rate_limit_exceeded|usage_limit_reached|too many requests|(?:rate[ -]?limit|quota|usage limit|capacity) (?:has been |is )?(?:reached|exceeded|exhausted)|(?:hit|exceeded|reached) (?:your |the |a )?(?:usage limit|rate limit|quota)|(?:http(?: error)?|status(?: code)?|error code)\s*[:=]?\s*429)\b/i;

function normalizeEngine(engine) {
  const m = String(engine || '').trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(m) ? m : null;
}

function ceilingFilePath(engine, home) {
  const m = normalizeEngine(engine);
  if (!m) return null;
  return path.join(engineHome(home), 'ceilings', m + '.json');
}

function quotaFilePath(engine, home) {
  const m = normalizeEngine(engine);
  if (!m) return null;
  return path.join(engineHome(home), 'quota-' + m + '.json');
}

function markCeiling(engine, reason, home) {
  try {
    const file = ceilingFilePath(engine, home);
    if (!file) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const data = {
      engine: normalizeEngine(engine),
      at: Date.now(),
      reason: String(reason || ''),
    };
    fs.writeFileSync(file, JSON.stringify(data), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function readCeiling(engine, home) {
  try {
    const file = ceilingFilePath(engine, home);
    if (!file || !fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.engine !== normalizeEngine(engine) || typeof data.reason !== 'string' || !data.reason.trim() || typeof data.at !== 'number' || !Number.isFinite(data.at)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function recentCeiling(engine, home, now, validityMs) {
  const data = readCeiling(engine, home);
  if (!data) return false;
  const ref = typeof now === 'number' ? now : Date.now();
  const limit = typeof validityMs === 'number' ? validityMs : CEILING_VALID_MS;
  const age = ref - data.at;
  return age >= 0 && age <= limit;
}

function readQuotaFile(engine, home, now) {
  try {
    const file = quotaFilePath(engine, home);
    if (!file || !fs.existsSync(file)) return null;
    const q = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!q || typeof q.at !== 'number' || !Number.isFinite(q.at)) return null;
    const ref = typeof now === 'number' ? now : Date.now();
    const age = ref - q.at;
    if (age < 0 || age > QUOTA_MAX_AGE_MS) return null;
    const isPercent = (value) => Number.isFinite(value) && value >= 0 && value <= 100;
    const hasWin = isPercent(q.windowPct);
    const hasWeek = isPercent(q.weekPct);
    if ((!hasWin && q.windowPct !== undefined) || (!hasWeek && q.weekPct !== undefined)) return null;
    if (!hasWin && !hasWeek) return null;
    return {
      windowPct: hasWin ? q.windowPct : null,
      weekPct: hasWeek ? q.weekPct : null,
      at: q.at,
    };
  } catch (_) {
    return null;
  }
}

// PURE. Returns reason string if quota exceeds configured ceiling, else null.
function checkQuota(quota, switchOn, engineCfg) {
  if (!quota) return null;
  if (switchOn && switchOn.mode === 'error-only') return null;
  let maxWin = switchOn && typeof switchOn.maxWindowPct === 'number' ? switchOn.maxWindowPct : 90;
  let maxWeek = switchOn && typeof switchOn.maxWeekPct === 'number' ? switchOn.maxWeekPct : 80;
  if (engineCfg && engineCfg.sharedAccount && typeof engineCfg.sharePct === 'number') {
    maxWin = Math.min(maxWin, engineCfg.sharePct);
    maxWeek = Math.min(maxWeek, engineCfg.sharePct);
  }
  if (typeof quota.windowPct === 'number' && quota.windowPct >= maxWin) {
    return 'short window at ' + quota.windowPct + '% (ceiling ' + maxWin + '%)';
  }
  if (typeof quota.weekPct === 'number' && quota.weekPct >= maxWeek) {
    return 'weekly usage at ' + quota.weekPct + '% (ceiling ' + maxWeek + '%)';
  }
  return null;
}

// PURE.
function looksLikeQuotaError(text) {
  return QUOTA_ERROR_RE.test(String(text || ''));
}

function appendAuditLog(entry, home, auditLogPath) {
  try {
    const file = resolveAuditLogPath(auditLogPath, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  QUOTA_MAX_AGE_MS,
  CEILING_VALID_MS,
  QUOTA_ERROR_RE,
  ceilingFilePath,
  quotaFilePath,
  markCeiling,
  readCeiling,
  recentCeiling,
  readQuotaFile,
  checkQuota,
  looksLikeQuotaError,
  appendAuditLog,
};
