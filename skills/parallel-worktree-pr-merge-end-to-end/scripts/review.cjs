'use strict';
// Review by a model that did not write the change. The reviewer may also commit fixes.
//   node review.cjs --pr <n> [--dir <worktree>] [--engine <name>] [--max-wait <seconds>]
// Writes reviews/REVIEW-PR<n>.md on the PR branch:
//   line 1  VERDICT: APPROVE | BLOCK
//   line 2  REVIEWED-HEAD: <sha of the code that was reviewed, after any fixes>
// Exit: 0 review written, 3 no engine available or no usable verdict, 2 usage error.
const fs = require('fs');
const path = require('path');
const common = require('./common.cjs');
const { loadConfig, repoRoot } = require('./config.cjs');

// ---------- pure decisions ----------

// PURE. "src/auth/**" style globs -> RegExp over forward-slash paths.
function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

// PURE. Does this set of changed files need a review by another model?
function needsReview(reviewCfg, files) {
  const list = files.map(normPath).filter(Boolean);
  if (reviewCfg.requiredFor === 'never') return false;
  if (list.length === 0) return false;
  if (reviewCfg.requiredFor === 'always') return true;
  const res = (reviewCfg.criticalPaths || []).map(globToRegExp);
  return list.some((f) => res.some((r) => r.test(f)));
}

// PURE. quota = {windowPct, weekPct} | null (unreadable). Claude manages its own limits.
function engineAllowed(name, engCfg, quota) {
  if (name === 'claude') return { ok: true, solo: false };
  const solo = !!(engCfg && engCfg.sharedAccount) || !quota;
  if (!quota) return { ok: true, solo: true };
  const win = engCfg.maxWindowPct === undefined ? 90 : engCfg.maxWindowPct;
  const week = engCfg.maxWeekPct === undefined ? 80 : engCfg.maxWeekPct;
  if (quota.windowPct > win || quota.weekPct > week) return { ok: false, solo };
  return { ok: true, solo };
}

// PURE. First engine in order that is installed and inside its quota. solo = only one at a time.
function pickEngine(cfgReview, available, quotas, skip) {
  for (const name of cfgReview.engines) {
    if ((skip || []).includes(name)) continue;
    if (!available[name]) continue;
    const a = engineAllowed(name, cfgReview[name], quotas[name] || null);
    if (a.ok) return { engine: name, solo: a.solo };
  }
  return null;
}

// PURE. Any BLOCK line wins over APPROVE. No verdict line = null.
function parseVerdict(text) {
  const found = [];
  const re = /^\s*\**VERDICT:\s*(APPROVE|BLOCK)\**\s*$/gim;
  let m;
  while ((m = re.exec(String(text)))) found.push(m[1].toUpperCase());
  if (!found.length) return null;
  return found.includes('BLOCK') ? 'BLOCK' : 'APPROVE';
}

// PURE
function formatReviewFile(verdict, head, body) {
  const cleaned = String(body).split(/\r?\n/).filter((l) => !/^\s*\**VERDICT:/i.test(l)).join('\n').trim();
  return 'VERDICT: ' + verdict + '\nREVIEWED-HEAD: ' + head + '\n\n' + cleaned + '\n';
}

// PURE
function parseReviewFile(text) {
  const lines = String(text).split(/\r?\n/);
  const v = /^VERDICT: (APPROVE|BLOCK)$/.exec(lines[0] || '');
  const h = /^REVIEWED-HEAD: ([0-9a-f]{7,64})$/.exec(lines[1] || '');
  if (!v || !h) return null;
  return { verdict: v[1], head: h[1] };
}

// PURE. May this review file open the merge gate for the current head?
//   headIsDescendant : REVIEWED-HEAD is an ancestor of (or equal to) the current head
//   filesSinceReview : files changed between REVIEWED-HEAD and the current head
//   baseMovedFiles   : files changed on the base branch since the review (merged in, not our code)
function gateReviewOk(fileText, ctx) {
  const rv = parseReviewFile(fileText);
  if (!rv) return { ok: false, reason: 'review file missing or malformed' };
  if (rv.verdict !== 'APPROVE') return { ok: false, reason: 'review verdict is ' + rv.verdict };
  if (!ctx.headIsDescendant) return { ok: false, reason: 'reviewed head is not part of this branch' };
  const moved = new Set(ctx.baseMovedFiles.map(normPath));
  const own = ctx.filesSinceReview.map(normPath).filter((f) => !f.startsWith('reviews/') && !moved.has(f));
  if (own.length) return { ok: false, reason: 'code changed after the review: ' + own.slice(0, 5).join(', ') };
  return { ok: true, reason: 'approved' };
}

// PURE. Names of functions touched by a unified diff, to look for their callers.
function extractSymbols(diff) {
  const names = new Set();
  const pats = [
    /^\+\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\+\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/,
    /^\+\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\+\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^\+\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
  ];
  for (const line of String(diff).split(/\r?\n/)) {
    for (const p of pats) {
      const m = p.exec(line);
      if (m && m[1].length > 2) names.add(m[1]);
    }
  }
  return Array.from(names).slice(0, 20);
}

// PURE
function buildPrompt(p) {
  const maxDiff = 200000;
  const diff = p.diff.length > maxDiff ? p.diff.slice(0, maxDiff) + '\n[diff truncated; read the rest with git]' : p.diff;
  return [
    'You are reviewing pull request #' + p.number + ' as an independent reviewer. You did not write this change.',
    'Look for: wrong behaviour, missed edge cases, broken callers, security problems, missing or weak tests, data loss.',
    'You are inside the PR branch checkout. You may read any file and run read-only commands.',
    'If you find a clear defect that you can fix safely, fix it and commit on this branch (small commit, only the files you changed, never use --no-verify). Do not push.',
    'Do not rewrite style or refactor beyond the defect.',
    'End your answer with exactly one final line: "VERDICT: APPROVE" (no blocking problem remains) or "VERDICT: BLOCK" (a problem remains that the author must resolve). Explain each problem with file and line before that line.',
    '',
    '## Title', p.title, '',
    '## Description', p.body || '(empty)', '',
    '## Callers of changed functions (git grep)', p.callers || '(none found)', '',
    '## Diff', diff,
  ].join('\n');
}

// PURE. How to start each engine. Prompt always goes through stdin.
function engineCommand(name, engCfg) {
  const model = engCfg && engCfg.model && engCfg.model !== '<latest>' ? engCfg.model : null;
  if (name === 'claude') return { args: ['-p'].concat(model ? ['--model', model] : []) };
  if (name === 'codex') {
    const a = ['exec', '--sandbox', 'workspace-write'];
    if (model) a.push('-m', model);
    if (engCfg && engCfg.effort) a.push('-c', 'model_reasoning_effort=' + engCfg.effort);
    return { args: a.concat(['-']) };
  }
  if (name === 'gemini') return { args: (model ? ['-m', model] : []).concat(['-p', 'Instructions-on-stdin']) };
  throw new Error('unknown engine ' + name);
}

// ---------- I/O ----------

function readQuota(name) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(common.parallelHome(), 'quota-' + name + '.json'), 'utf8'));
    if (typeof q.windowPct === 'number' && typeof q.weekPct === 'number') return q;
  } catch (_) { /* unreadable: allowed, one at a time */ }
  return null;
}

function listChanged(dir, base) {
  const r = common.git(dir, ['diff', '--name-only', 'origin/' + base + '...HEAD']);
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

function findCallers(dir, diff) {
  const lines = [];
  for (const sym of extractSymbols(diff)) {
    const r = common.git(dir, ['grep', '-n', '-w', '-e', sym, '--', '.']);
    if (r.status === 0) lines.push('### ' + sym, r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 6).join('\n'));
  }
  return lines.join('\n');
}

function commitLeftovers(dir, ignore) {
  const st = common.git(dir, ['status', '--porcelain', '-z']);
  const files = [];
  for (const entry of st.stdout.split('\0').filter(Boolean)) {
    const f = entry.slice(3);
    if (!ignore.some((i) => f === i || f.startsWith(i + '/'))) files.push(f);
  }
  if (!files.length) return false;
  common.git(dir, ['add', '--'].concat(files));
  return common.git(dir, ['commit', '-m', 'review: fixes by the reviewer', '--'].concat(files)).status === 0;
}

function main(argv) {
  let parsed;
  try {
    parsed = common.parseFlags(argv, { pr: 'string', dir: 'string', engine: 'string', 'max-wait': 'string' });
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const f = parsed.flags;
  if (!f.pr || !/^\d+$/.test(f.pr)) {
    console.error('usage: review.cjs --pr <n> [--dir <worktree>] [--engine claude|codex|gemini] [--max-wait <s>]');
    return 2;
  }
  const dir = path.resolve(f.dir || process.cwd());
  let cfg;
  try { cfg = loadConfig(repoRoot(dir)); } catch (e) { console.error(e.message); return 2; }
  const rc = cfg.review;

  const view = common.gh(['pr', 'view', f.pr, '--repo', cfg.repo, '--json', 'headRefOid,headRefName,title,body']);
  if (view.status !== 0) { console.error('could not read PR ' + f.pr + ': ' + view.stderr.trim()); return 2; }
  const pr = JSON.parse(view.stdout);
  const head = common.gitOut(dir, ['rev-parse', 'HEAD']);
  if (head !== pr.headRefOid) { console.error('local HEAD is not the PR head; push first (local ' + head.slice(0, 8) + ', PR ' + String(pr.headRefOid).slice(0, 8) + ')'); return 2; }

  const diffR = common.git(dir, ['diff', 'origin/' + cfg.baseBranch + '...HEAD']);
  const prompt = buildPrompt({ number: f.pr, title: pr.title, body: pr.body, diff: diffR.stdout, callers: findCallers(dir, diffR.stdout) });

  const order = f.engine ? Object.assign({}, rc, { engines: [f.engine] }) : rc;
  const tried = [];
  const maxWaitMs = Number(f['max-wait'] || 600) * 1000;
  const logFile = path.join(common.parallelHome(), 'queue.jsonl');

  for (;;) {
    const available = {};
    const quotas = {};
    for (const n of order.engines) {
      if (tried.includes(n)) continue;
      available[n] = common.engineRun(n, ['--version'], { timeout: 20000 }).status === 0;
      quotas[n] = readQuota(n);
    }
    const pick = pickEngine(order, available, quotas, tried);
    if (!pick) { console.error('[review] no review engine available (tried: ' + (tried.join(', ') || 'none') + ')'); return 3; }

    const slotsDir = path.join(common.parallelHome(), 'review-slots', pick.engine);
    const slots = pick.solo ? 1 : rc.maxParallel;
    const started = Date.now();
    let slot = null;
    while (!(slot = common.tryAcquireSlot(slotsDir, slots, { pr: f.pr }, 30 * 60 * 1000))) {
      if (Date.now() - started > maxWaitMs) { console.error('[review] waited too long for a ' + pick.engine + ' slot'); return 3; }
      common.sleepSync(Number(process.env.PARALLEL_PR_POLL_MS) || 3000);
    }
    let res;
    try {
      const cmd = engineCommand(pick.engine, rc[pick.engine]);
      console.error('[review] running ' + pick.engine);
      res = common.engineRun(pick.engine, cmd.args, { cwd: dir, input: prompt, timeout: 25 * 60 * 1000 });
    } finally {
      common.releaseLock(slot);
    }
    common.appendLog(logFile, { event: 'review', engine: pick.engine, pr: f.pr, exit: res.status, waitedMs: Date.now() - started });
    const verdict = res.status === 0 ? parseVerdict(res.stdout) : null;
    if (!verdict) {
      console.error('[review] ' + pick.engine + ' gave no usable verdict (exit ' + res.status + '); trying the next engine');
      tried.push(pick.engine);
      continue;
    }

    commitLeftovers(dir, cfg.linkDependencies.concat(['reviews']));
    const reviewedHead = common.gitOut(dir, ['rev-parse', 'HEAD']);
    const rel = 'reviews/REVIEW-PR' + f.pr + '.md';
    fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), formatReviewFile(verdict, reviewedHead, res.stdout));
    common.git(dir, ['add', '--', rel]);
    const c = common.git(dir, ['commit', '-m', 'review: PR ' + f.pr + ' ' + verdict, '--', rel]);
    if (c.status !== 0) { console.error('[review] could not commit the review file: ' + (c.stderr || c.stdout).trim()); return 3; }
    const push = common.git(dir, ['push', 'origin', 'HEAD:refs/heads/' + pr.headRefName]);
    if (push.status !== 0) { console.error('[review] could not push the review: ' + push.stderr.trim()); return 3; }
    console.error('[review] ' + verdict + ' by ' + pick.engine + ' -> ' + rel);
    return 0;
  }
}

module.exports = {
  globToRegExp, needsReview, engineAllowed, pickEngine, parseVerdict, formatReviewFile, parseReviewFile,
  gateReviewOk, extractSymbols, buildPrompt, engineCommand, listChanged, normPath,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
