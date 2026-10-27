/**
 * lib/beat-runner.js - robustness runtime for scripted walkthroughs.
 *
 * A "beat" is one step of a walkthrough: an action plus the post-condition that proves
 * the action landed. Design goals:
 *
 *  1. A beat must not soft-fail. Clicking the wrong thing and continuing is the failure
 *     mode that produces a whole run of plausible-looking captures of the wrong screens.
 *     Every beat asserts something that must be true on screen afterwards, and throws
 *     when it is not. That is what makes archive/resume trustworthy.
 *  2. Transient render lag should not fail a run that would pass on a second try, so
 *     runBeat() retries the action AND its assertion together with linear backoff.
 *  3. A failed run must be a useful reference. On final failure it writes a screenshot,
 *     the expected-vs-actual, and the visible-label list, so the next person can see
 *     exactly what the page looked like instead of guessing from a stack trace.
 *
 * Assertions are declarative so a generated steps file reads as intent:
 *   "assert": { "type": "textVisible", "text": "Modify Roles" }
 * The vocabulary lives here and is tested once; the generated script stays thin.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

// ── Low-level DOM predicates (run in-page). Return booleans/strings only. ──────

/** Is a trimmed-text label visible anywhere (optionally within a band)? */
async function isTextVisible(page, text, opts = {}) {
  return page.evaluate(({ text, ymin, ymax, xmin, xmax, contains }) => {
    for (const el of document.querySelectorAll('td,div,span,a,button,label,nobr')) {
      const t = (el.innerText || el.textContent || '').trim();
      const hit = contains ? t.includes(text) : t === text;
      if (!hit) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.y < (ymin ?? -1e9) || r.y > (ymax ?? 1e9)) continue;
      if (r.x < (xmin ?? -1e9) || r.x > (xmax ?? 1e9)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      return true;
    }
    return false;
  }, { text, ymin: opts.ymin, ymax: opts.ymax, xmin: opts.xmin, xmax: opts.xmax, contains: !!opts.contains });
}

/** Does any visible text input hold a non-empty value? (profile-loaded signal) */
async function anyInputHasValue(page) {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('input')) {
      const ty = (el.type || 'text').toLowerCase();
      if (ty !== 'text' && ty !== '') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 15) continue;
      if ((el.value || '').trim().length) return true;
    }
    return false;
  });
}

// ── Assertion vocabulary. Each returns {ok, detail}. Add types here as needed. ─

const ASSERTIONS = {
  // Text present (exact, or contains) - optionally within a coordinate band.
  async textVisible(page, a) {
    const ok = await isTextVisible(page, a.text, a);
    return { ok, detail: `expected text ${a.contains ? 'containing ' : ''}"${a.text}" to be visible` };
  },
  // Text absent - for verifying a dialog closed / view left.
  async textGone(page, a) {
    const ok = !(await isTextVisible(page, a.text, a));
    return { ok, detail: `expected "${a.text}" to be gone` };
  },
  // The profile/form is populated (a loaded user, a filled form).
  async formPopulated(page) {
    const ok = await anyInputHasValue(page);
    return { ok, detail: 'expected at least one form field to be populated' };
  },
  // A grid under a named column header actually has data rows beneath it.
  //
  // The obvious implementation -- "the empty-grid placeholder is absent" -- is wrong in
  // both directions: the placeholder text can appear elsewhere on a busy page, and a grid
  // that failed to load shows no placeholder at all. So this locates the header, then
  // requires at least `min` non-empty leaf cells below it whose horizontal extent overlaps
  // the header's column, and reports the count it found.
  async gridHasRows(page, a) {
    const res = await page.evaluate(({ headerText, emptyText, reach }) => {
      let header = null;
      for (const el of document.querySelectorAll('td,div,span,nobr')) {
        if ((el.innerText || el.textContent || '').trim() !== headerText) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { header = r; break; }
      }
      if (!header) return { rows: 0, header: false, empty: false };
      const centerX = header.left + header.width / 2;
      let rows = 0;
      let empty = false;
      for (const el of document.querySelectorAll('td,div,span,nobr')) {
        if (el.children.length) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (!text) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (r.top <= header.bottom + 1 || r.top > header.bottom + reach) continue;
        if (r.left > centerX || r.right < centerX) continue;
        if (emptyText && text.indexOf(emptyText) !== -1) { empty = true; continue; }
        rows += 1;
      }
      return { rows, header: true, empty };
    }, {
      headerText: a.header,
      emptyText: a.emptyText || 'No items to show',
      reach: a.reach || 700,
    });
    const min = a.min || 1;
    if (!res.header) {
      return { ok: false, detail: `grid header "${a.header}" is not on screen at all` };
    }
    if (res.empty && res.rows < min) {
      return { ok: false, detail: `grid "${a.header}" shows its empty placeholder (0 rows)` };
    }
    return {
      ok: res.rows >= min,
      detail: `expected grid "${a.header}" to have >= ${min} row(s) under its column; found ${res.rows}`,
    };
  },
  // Always-true sentinel for rebuild beats that only need to have run.
  async none() { return { ok: true, detail: 'no assertion' }; },
};

/** Evaluate a declarative assertion object; returns {ok, detail}. */
async function checkAssertion(page, assertion) {
  if (!assertion || !assertion.type) return { ok: true, detail: 'no assertion' };
  const fn = ASSERTIONS[assertion.type];
  if (!fn) return { ok: false, detail: `unknown assertion type "${assertion.type}"` };
  try {
    return await fn(page, assertion);
  } catch (e) {
    return { ok: false, detail: `assertion "${assertion.type}" threw: ${e.message}` };
  }
}

// ── Failure reporting - the "useful reference" payload. ────────────────────────

/** Snapshot the page for debugging: visible labels, inputs, and open dialogs. */
async function snapshotPage(page) {
  return page.evaluate(() => {
    const labels = [];
    for (const el of document.querySelectorAll('td,div,span,a,button')) {
      const t = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      if (t && t.length < 40 && r.width > 0 && r.height > 0 && r.y < 900)
        labels.push({ t, x: Math.round(r.x), y: Math.round(r.y) });
    }
    // De-dupe by text, keep first position.
    const seen = new Set(); const uniq = [];
    for (const l of labels) { if (!seen.has(l.t)) { seen.add(l.t); uniq.push(l); } }
    const inputs = [];
    document.querySelectorAll('input').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 15) inputs.push({ id: el.id || '', value: el.value || '', x: Math.round(r.x), y: Math.round(r.y), readonly: !!el.readOnly });
    });
    return { visibleLabels: uniq.slice(0, 120), inputs: inputs.slice(0, 60), url: location.href };
  });
}

/**
 * Write a full failure report for one beat. Produces:
 *   <dir>/FAILURE-<label>.png    screenshot at the moment of failure
 *   <dir>/FAILURE-<label>.json   expected/actual + page snapshot
 * Returns the report object.
 */
async function captureFailure(page, dir, beat, reason) {
  const safe = String(beat.label || 'beat').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const shot = path.join(dir, `FAILURE-${safe}.png`);
  const rpt = path.join(dir, `FAILURE-${safe}.json`);
  let snap = null;
  // Redact the diagnostic too. A failure shot is still a picture of a live application,
  // and this one lands next to the run rather than in screenshots/, so it is the most
  // likely PNG to get attached to a ticket. If redaction itself is what failed, writing
  // NO image is the right outcome -- an undiagnosable failure beats a leaked one.
  try {
    const { redact } = require('./redact');
    await redact(page, shot);
  } catch (e) { /* redaction failed or page is gone: deliberately leave no image */ }
  try { snap = await snapshotPage(page); } catch (e) { /* ignore */ }
  const report = {
    beat: beat.label,
    phase: beat.phase,
    idx: beat.idx,
    reason,
    assertion: beat.assert || null,
    at: new Date().toISOString(),
    screenshot: shot,
    page: snap,
  };
  try { fs.writeFileSync(rpt, JSON.stringify(report, null, 2)); } catch (e) { /* ignore */ }
  report.jsonPath = rpt; // in-memory only (not serialized); used by the agent handoff hook
  return report;
}

// ── Retry wrapper. Runs fn, then asserts; retries both on failure w/ backoff. ──

/**
 * Run one beat robustly: execute its action, then verify its post-condition,
 * retrying the whole thing up to `tries` times with linear backoff. Throws a
 * descriptive error (after capturing a failure report) if it never passes.
 *
 * @param {object} page       Playwright page
 * @param {object} beat       {label, phase, idx, assert, run(page,ctx)}
 * @param {object} ctx        shared context passed to beat.run
 * @param {object} opts       {tries=3, backoffMs=1500, failDir}
 */
async function runBeat(page, beat, ctx, opts = {}) {
  const tries = opts.tries ?? 3;
  const backoff = opts.backoffMs ?? 1500;
  let lastDetail = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await beat.run(page, ctx);
    } catch (e) {
      lastDetail = `action threw: ${e.message.split('\n')[0]}`;
      if (attempt < tries) { ctx.log(`  retry ${attempt}/${tries - 1} (${lastDetail})`); await page.waitForTimeout(backoff * attempt); continue; }
      const rep = await captureFailure(page, opts.failDir, beat, lastDetail);
      await maybeAgentHandoff(rep, opts, ctx);
      throw new BeatError(beat, lastDetail, rep);
    }
    // Action succeeded - now verify the post-condition.
    const res = await checkAssertion(page, beat.assert);
    if (res.ok) return; // beat passed
    lastDetail = `post-condition failed: ${res.detail}`;
    if (attempt < tries) { ctx.log(`  retry ${attempt}/${tries - 1} (${lastDetail})`); await page.waitForTimeout(backoff * attempt); continue; }
    const rep = await captureFailure(page, opts.failDir, beat, lastDetail);
    await maybeAgentHandoff(rep, opts, ctx);
    throw new BeatError(beat, lastDetail, rep);
  }
}

// -- Optional coding-agent handoff. ------------------------------------------------
//
// When a beat exhausts its retries and its failure report is written, the report can be
// handed to an external coding agent for diagnosis. Configure the CLI in
// capture.config.json (`agentHandoff.command`); a null command disables the hook, which
// is the default. Arm it per-run with CAPTURE_AGENT_HANDOFF=1.
//
// The handoff is DIAGNOSE-ONLY unless you opt in. The capture browser is still open and
// authenticated when this fires, so letting an agent spawn a competing browser session
// against the same environment is not something to do by accident. Set
// CAPTURE_AGENT_RERUN=1 only when the current run is finished or fully isolated.

async function maybeAgentHandoff(report, opts, ctx) {
  if (process.env.CAPTURE_AGENT_HANDOFF !== '1' || !report) return;
  const handoffCfg = config().agentHandoff || {};
  if (!handoffCfg.command) {
    ctx.log('  [handoff] CAPTURE_AGENT_HANDOFF set but agentHandoff.command is null in config');
    return;
  }
  const reportPath = report.jsonPath;
  if (!reportPath) return; // the report file was not written; nothing to hand off
  let agent;
  try { agent = require('./agent-handoff'); } catch { return; }
  if (!agent.agentAvailable()) {
    ctx.log(`  [handoff] configured agent CLI "${handoffCfg.command}" not found on PATH`);
    return;
  }
  try {
    ctx.log('  [handoff] handing the failure report to the configured agent (diagnose-only)');
    await agent.agentHandoff(reportPath, {
      allowRerun: process.env.CAPTURE_AGENT_RERUN === '1',
      rerunCmd: opts.rerunCmd || null,
      onLog: (m) => ctx.log(String(m).replace(/\s+$/, '')),
    });
  } catch (e) {
    ctx.log(`  [handoff] agent handoff error: ${e.message}`);
  }
}

class BeatError extends Error {
  constructor(beat, detail, report) {
    super(`Beat "${beat.label}" failed: ${detail}`);
    this.name = 'BeatError';
    this.beat = beat;
    this.report = report;
  }
}

module.exports = {
  isTextVisible, anyInputHasValue, checkAssertion, snapshotPage, captureFailure, runBeat, BeatError, ASSERTIONS,
};

