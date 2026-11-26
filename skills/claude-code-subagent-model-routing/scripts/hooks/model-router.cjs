'use strict';
// Claude Code PreToolUse hook (matcher: Agent|Task).
// Enforces model and effort routing when Claude subagents run:
// - Explore: always Haiku unless declared `JOB: judgment - <reason>` (and reason does not start with a reading verb)
// - General (empty, general-purpose, claude, or lean helper): requires `JOB: search` (Haiku) or
//   `JOB: judgment - <what it must conclude>` (asked model, medium effort by default)
// - ATTEMPT: 2 -> high effort; ATTEMPT: 3 -> high effort and unlocks Opus; ATTEMPT: 4+ -> denied (stop and escalate)
// - Named agents: keep their own model; set effort when missing (unless Haiku)
// - Optional lean helper swap (off by default, only when agent type is listed in chat transcript and no TOOLS: all / MCP)
// Any internal error prints nothing and exits 0 so the chat is never blocked.
const fs = require('fs');
const { DEFAULTS, DEFAULT_READING_VERBS, loadConfig, mergeDeep } = require('../config.cjs');

const HANDLED_TOOLS = new Set(['Agent', 'Task']);
const ATTEMPT_RE = /^[ \t]*ATTEMPT:[ \t]*([1-9]\d*)[ \t]*\r?$/gmi;
const TOOLS_ALL_RE = /^[ \t]*TOOLS:[ \t]*all\b/mi;
const JOB_SEARCH_RE = /^[ \t]*JOB:[ \t]*search[ \t]*\r?$/mi;
const JOB_JUDGMENT_RE = /^[ \t]*JOB:[ \t]*judgment[ \t]+[-\u2013\u2014][ \t]*([^\r\n]+)$/mi;
const MCP_REF_RE = /mcp__([a-z0-9_-]+)__/gi;

function stopReason(maxAttempts) {
  return 'This item has reached the configured limit of ' + maxAttempts + ' attempts. ' +
    'Stop here and report in one line to the user what broke, what was tried, and what help is needed.';
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// PURE. Build regex matching reasons that start with a reading/searching verb.
function buildReadingRegex(verbs) {
  const list = Array.isArray(verbs) && verbs.length ? verbs : DEFAULT_READING_VERBS;
  const escaped = list.map((v) => escapeRegex(String(v).trim())).filter(Boolean);
  return new RegExp('^(?:(?:just|only|simply|need\\s+to|to)\\s+)?(?:' + escaped.join('|') + ')\\b', 'i');
}

// PURE. Highest ATTEMPT: N declared on its own line in the prompt; 1 when absent.
function parseAttempt(prompt) {
  let max = 1;
  let m;
  ATTEMPT_RE.lastIndex = 0;
  const text = String(prompt || '');
  while ((m = ATTEMPT_RE.exec(text)) !== null) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

// PURE. Returns true if the prompt mentions an mcp__<server>__ tool not included in the lean helper.
function hasExternalMcp(prompt, includedMcps) {
  const allowed = new Set(
    (Array.isArray(includedMcps) ? includedMcps : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
  );
  let m;
  MCP_REF_RE.lastIndex = 0;
  const text = String(prompt || '');
  while ((m = MCP_REF_RE.exec(text)) !== null) {
    if (!allowed.has(m[1].toLowerCase())) return true;
  }
  return false;
}

// PURE. Parse Claude Code JSONL transcript `agent_listing_delta` records to discover known agent types.
function knownAgentTypes(transcriptText) {
  let types = new Set();
  for (const line of String(transcriptText == null ? '' : transcriptText).split(/\r?\n/)) {
    if (!line || line.indexOf('"agent_listing_delta"') === -1) continue;
    let attachment = null;
    try {
      attachment = JSON.parse(line).attachment;
    } catch (_) {
      continue;
    }
    if (!attachment || attachment.type !== 'agent_listing_delta') continue;
    if (attachment.isInitial) types = new Set();
    for (const t of attachment.addedTypes || []) types.add(t);
    for (const t of attachment.removedTypes || []) types.delete(t);
  }
  return types;
}

function isLeanAvailable(input, routingCfg, readFileFn) {
  const lh = (routingCfg && routingCfg.leanHelper) || {};
  if (!lh.enabled) return false;
  if (lh.requireTranscriptListing === false) return true;
  if (input && typeof input.leanAvailable === 'boolean') return input.leanAvailable;
  if (input && Array.isArray(input.knownAgentTypes)) {
    return input.knownAgentTypes.includes(lh.agentName || 'helper');
  }
  if (!input || !input.transcript_path) return false;
  try {
    const reader = readFileFn || ((p) => fs.readFileSync(p, 'utf8'));
    return knownAgentTypes(reader(input.transcript_path)).has(lh.agentName || 'helper');
  } catch (_) {
    return false;
  }
}

function formatMissingJobDenial(routingCfg) {
  const searchModel = routingCfg.searchModel;
  const defaultEffort = routingCfg.defaultEffort;
  const retryEffort = routingCfg.retryEffort;
  const opusMin = routingCfg.opusMinAttempt;
  return (
    'Subagent request is missing a JOB declaration. ' +
    'Default effort is ' + defaultEffort + '; ATTEMPT: 2 raises effort to ' + retryEffort + '; ' +
    'Opus requires ATTEMPT: ' + opusMin + ' (otherwise downgraded to Sonnet). ' +
    'Add ONE line to the prompt and retry: ' +
    '"JOB: search" (find, read, list, count, extract; runs on ' + searchModel + ') or ' +
    '"JOB: judgment - <what it must conclude>" (diagnose, review, write or edit code, decide across sources). ' +
    'Treat search findings from a small model as leads, not proof: open the source before acting.'
  );
}

function formatReadingReasonDenial(routingCfg) {
  return (
    'The declared reason starts with a reading/search verb, and reading (even across many files) is search, not judgment. ' +
    'Choose one and retry: ' +
    '"JOB: search" if the helper only finds, reads, lists, counts, or extracts (runs on ' + routingCfg.searchModel + '); or ' +
    '"JOB: judgment - <what it must conclude>" starting with the judgment verb (diagnose, review, decide, compare, write code) if reading is only the means.'
  );
}

function normalizeRoutingConfig(config) {
  const base = DEFAULTS.modelRouting;
  if (!config) return base;
  const raw = config.modelRouting ? config.modelRouting : config;
  return mergeDeep(base, raw);
}

// PURE. Returns { deny: string }, { updatedInput: object }, or null (nothing to change).
function decide(input, config, leanAvailableArg) {
  if (!input || typeof input.tool_name !== 'string' || !HANDLED_TOOLS.has(input.tool_name.trim())) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return null;

  const mr = normalizeRoutingConfig(config);
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  const attempt = parseAttempt(prompt);
  if (attempt > mr.maxAttempts) {
    return { deny: stopReason(mr.maxAttempts) };
  }

  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type.trim() : '';
  const normalizedType = type.toLowerCase();
  if (normalizedType === 'fork') return null;

  const leanName = (mr.leanHelper && mr.leanHelper.agentName) || 'helper';
  const generalTypes = new Set(['', 'general-purpose', 'claude', leanName.toLowerCase()]);
  const isExplore = normalizedType === 'explore';
  const isGeneral = generalTypes.has(normalizedType);
  const isNamed = !isExplore && !isGeneral;

  const readingRe = buildReadingRegex(mr.readingVerbs);
  const patch = {};
  let runOnSearchModel = false;

  if (isExplore || isGeneral) {
    const judgmentMatch = prompt.match(JOB_JUDGMENT_RE);
    const reason = judgmentMatch?.[1].replace(/^[\s"'(\[]+/, '').trim();
    if (reason && /[a-z0-9]/i.test(reason)) {
      if (readingRe.test(reason)) {
        if (!isExplore) return { deny: formatReadingReasonDenial(mr) };
        runOnSearchModel = true;
      }
    } else if (isExplore) {
      runOnSearchModel = true;
    } else if (JOB_SEARCH_RE.test(prompt)) {
      runOnSearchModel = true;
    } else {
      return { deny: formatMissingJobDenial(mr) };
    }

    const leanEnabled = Boolean(mr.leanHelper && mr.leanHelper.enabled);
    const leanKnown = typeof leanAvailableArg === 'boolean'
      ? leanAvailableArg
      : (mr.leanHelper && mr.leanHelper.requireTranscriptListing === false)
        || Boolean(input.leanAvailable)
        || (Array.isArray(input.knownAgentTypes) && input.knownAgentTypes.includes(leanName));

    if (
      isGeneral
      && type !== leanName
      && leanEnabled
      && leanKnown
      && !TOOLS_ALL_RE.test(prompt)
      && !hasExternalMcp(prompt, mr.leanHelper && mr.leanHelper.includedMcps)
    ) {
      patch.subagent_type = leanName;
    }

    const model = runOnSearchModel ? mr.searchModel : ti.model || 'sonnet';
    if (ti.model !== model) patch.model = model;
  }

  const shouldCapOpus = !isNamed || Boolean(mr.capNamedAgentOpus);
  const currentModel = String(patch.model || ti.model || '');
  if (shouldCapOpus && attempt < mr.opusMinAttempt && /opus/i.test(currentModel)) {
    patch.model = 'sonnet';
  }

  const finalModel = String(patch.model || ti.model || '');
  const isSearchResult = finalModel === mr.searchModel || /haiku/i.test(finalModel);
  const updated = { ...ti, ...patch };
  if (runOnSearchModel && finalModel === 'haiku' && ti.effort !== undefined) {
    delete updated.effort;
    return { updatedInput: updated };
  }
  if ((!isNamed || ti.effort == null) && !isSearchResult) {
    const alwaysHigh = isNamed && mr.highEffortAgents.includes(type);
    const effort = (!alwaysHigh && attempt < 2) ? mr.defaultEffort : mr.retryEffort;
    if (ti.effort !== effort) updated.effort = patch.effort = effort;
  }

  return Object.keys(patch).length ? { updatedInput: updated } : null;
}

if (require.main === module) {
  process.stdin.setEncoding('utf8');
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const cwd = input.cwd || process.cwd();
      const cfg = loadConfig(cwd);
      const lean = isLeanAvailable(input, cfg.modelRouting);
      const res = decide(input, cfg, lean);
      if (res && res.updatedInput) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: res.updatedInput,
          },
        }));
      } else if (res && res.deny) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: res.deny,
          },
        }));
      }
    } catch (_) {
      // Internal error: print nothing and exit 0 so the chat is never blocked.
    }
  });
}

module.exports = {
  HANDLED_TOOLS,
  buildReadingRegex,
  parseAttempt,
  hasExternalMcp,
  knownAgentTypes,
  isLeanAvailable,
  decide,
};
