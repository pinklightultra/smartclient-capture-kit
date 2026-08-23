/**
 * bench-interaction.js — Head-to-head benchmark of click and wait strategies.
 *
 * This is the script that produced the conclusions lib/nav.js is built on: which way of
 * clicking a SmartClient control actually works, and which way of waiting actually
 * detects that the click landed. Re-run it against your own application before trusting
 * those defaults, because the answers are shell-specific.
 *
 * READ-ONLY. Navigates config screens only. NEVER clicks Save/Submit.
 * Closes any context menu with Escape. Takes NO doc screenshots (metrics only;
 * a couple of debug PNGs are routed through redact() if --shots is passed).
 *
 * It logs in once, then for a battery of increasingly hard targets runs each
 * click strategy and each wait strategy, verifying success by a POST-CONDITION
 * (an expected element becomes present/visible), and records found/fired/verified
 * + elapsed ms. Output: bench-results.json + a printed table.
 *
 * Strategies compared:
 *   A) domClick   — page.evaluate + el.click()
 *   B) mouseXY    — page.mouse.click on DOM-center coords
 *   C) pixel      — fixed pixel coordinates
 *   D) locator    — page.locator('text=...').click()
 * Wait strategies:
 *   fixed  — waitForTimeout(N)
 *   signal — poll isc.Page.isLoaded() + dismissOverlay, bounded
 *
 * Usage: node scripts/bench-interaction.js --env staging [--shots]
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { login, dismissOverlay } = require('../lib/login');
const { resolveUrl } = require('../lib/config');
const { installClickGuard } = require('../lib/guard');

// This benchmark clicks a lot of controls it has not seen before, against a shared
// environment, which is exactly the situation the guard exists for. The header has always
// claimed READ-ONLY; before this it was claiming it on the strength of the target list
// alone, with nothing enforcing it.
process.env.CAPTURE_READONLY = '1';
process.env.CAPTURE_NO_SUBMIT = '1';

// Resolved from --env/--url against capture.config.json, like every other entry point.
// This was a hardcoded internal hostname, which is both a leak and useless to anyone else.
const BASE_URL = resolveUrl(process.argv.slice(2));
if (!BASE_URL) {
  console.error('Usage: node scripts/bench-interaction.js --env <name> | --url <base-url> [--shots]');
  process.exit(1);
}
const OUT = path.join(__dirname, '..', 'screenshots', 'bench', new Date().toISOString().slice(0, 10));
fs.mkdirSync(OUT, { recursive: true });
const WANT_SHOTS = process.argv.includes('--shots');

const results = [];
const log = (...a) => console.log(...a);

// ---- wait strategies -------------------------------------------------------
async function waitFixed(page, ms = 6000) {
  await page.waitForTimeout(ms);
  await dismissOverlay(page);
}
async function waitSignal(page, budget = 15000) {
  const start = Date.now();
  // ISC page-loaded signal + settle, bounded by budget
  try {
    await page.waitForFunction(
      () => typeof window.isc !== 'undefined' && window.isc.Page && window.isc.Page.isLoaded(),
      { timeout: budget }
    );
  } catch { /* fall through; record as best-effort */ }
  await dismissOverlay(page);
  // brief settle for grid paint
  await page.waitForTimeout(600);
  return Date.now() - start;
}

// ---- element resolution ----------------------------------------------------
async function resolveCoords(page, label, { ymin = 0, ymax = 10000, nth = 0 } = {}) {
  return page.evaluate(({ label, ymin, ymax, nth }) => {
    const hits = [];
    for (const el of document.querySelectorAll('td, div, span, a')) {
      if ((el.innerText || '').trim() === label) {
        const r = el.getBoundingClientRect();
        if (r.y >= ymin && r.y <= ymax && r.width > 0 && r.height > 0) {
          hits.push({ x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, count: hits.length });
        }
      }
    }
    return { total: hits.length, pick: hits[nth] || null };
  }, { label, ymin, ymax, nth });
}

// ---- click strategies (each returns {found, fired}) ------------------------
async function clickDom(page, label, opts = {}) {
  const fired = await page.evaluate(({ label, ymin = 0, ymax = 10000 }) => {
    for (const el of document.querySelectorAll('td, div, span, a')) {
      if ((el.innerText || '').trim() === label) {
        const r = el.getBoundingClientRect();
        if (r.y >= ymin && r.y <= ymax && r.width > 0) { el.click(); return true; }
      }
    }
    return false;
  }, { label, ...opts });
  return { found: fired, fired };
}
async function clickMouse(page, label, opts = {}) {
  const { pick } = await resolveCoords(page, label, opts);
  if (!pick) return { found: false, fired: false };
  await page.mouse.click(pick.x, pick.y);
  return { found: true, fired: true };
}
async function clickPixel(page, _label, opts = {}) {
  // pixel strategy only meaningful for fixed targets; caller passes opts.px
  if (!opts.px) return { found: false, fired: false, skipped: true };
  await page.mouse.click(opts.px[0], opts.px[1]);
  return { found: true, fired: true };
}
async function clickLocator(page, label, opts = {}) {
  try {
    const loc = page.locator(`text="${label}"`);
    const n = await loc.count();
    if (n === 0) return { found: false, fired: false };
    const target = loc.nth(opts.nth || 0);
    await target.click({ timeout: 4000 });
    return { found: true, fired: true, ambiguousCount: n };
  } catch (e) {
    return { found: false, fired: false, err: e.message.split('\n')[0] };
  }
}
const STRATS = { domClick: clickDom, mouseXY: clickMouse, pixel: clickPixel, locator: clickLocator };

// ---- post-condition check --------------------------------------------------
async function present(page, label, { ymin = 0, ymax = 10000 } = {}) {
  return page.evaluate(({ label, ymin, ymax }) => {
    for (const el of document.querySelectorAll('td, div, span, a')) {
      if ((el.innerText || '').trim() === label) {
        const r = el.getBoundingClientRect();
        if (r.y >= ymin && r.y <= ymax && r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }, { label, ymin, ymax });
}

// Return to a known Admin landing between trials (click Menu>Admin fresh is heavy;
// instead we re-open the tab we need each trial and verify from current state).
async function openAdmin(page) {
  await page.locator('text=Menu').first().click();
  await page.waitForTimeout(1800);
  await page.mouse.click(1090, 97);
  await waitSignal(page, 15000);
  await page.waitForTimeout(2500);
  await dismissOverlay(page);
}

// ---- one benchmark trial ---------------------------------------------------
async function trial({ page, scenario, strat, waitName, click, label, opts, verifyLabel, verifyOpts }) {
  const t0 = Date.now();
  let rec = { scenario, strategy: strat, wait: waitName, found: false, fired: false, verified: false, ms: 0, note: '' };
  try {
    const r = await STRATS[click](page, label, opts);
    rec.found = r.found; rec.fired = r.fired;
    if (r.skipped) { rec.note = 'n/a for pixel'; rec.ms = Date.now() - t0; return rec; }
    if (r.ambiguousCount > 1) rec.note = `locator matched ${r.ambiguousCount}`;
    if (r.err) rec.note = r.err;
    if (r.fired) {
      if (waitName === 'fixed') await waitFixed(page, 6000);
      else await waitSignal(page, 15000);
      rec.verified = await present(page, verifyLabel, verifyOpts || {});
    }
  } catch (e) {
    rec.note = 'threw: ' + e.message.split('\n')[0];
  }
  rec.ms = Date.now() - t0;
  return rec;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  log('logging in (fresh headless browser; not touching your CDP Chrome)...');
  if (!(await installClickGuard(page))) {
    throw new Error('read-only guard failed to install; refusing to benchmark clicks on a live environment');
  }
  await login(page, BASE_URL);
  await openAdmin(page);
  log('admin open. beginning trials.\n');

  // Scenario battery. Each entry runs across the applicable strategies × waits.
  // Targets chosen for difficulty: tab labels (unique), ambiguous labels,
  // async-loaded grid sections, and a deep item requiring prior expansion.
  const scenarios = [
    // S1: unique tab label, verify tab content region appears
    { scenario: 'S1 tab:Access (unique label)', label: 'Access', opts: { ymin: 75, ymax: 110 },
      verifyLabel: 'Feature Packages', verifyOpts: { ymin: 100, ymax: 860 },
      pixelPx: null },
    // S2: ambiguous label — "Search" exists as top menu AND elsewhere
    { scenario: 'S2 ambiguous:Search', label: 'Search', opts: { ymin: 40, ymax: 90 },
      verifyLabel: 'Member', verifyOpts: {} },
    // S3: async grid section — Codes must load, then Feature Packages appears
    { scenario: 'S3 async:Codes>FeaturePackages', label: 'Codes', opts: { ymin: 100, ymax: 260 },
      verifyLabel: 'Feature Packages', verifyOpts: { ymin: 100, ymax: 860 } },
    // S4: fixed-position element (Menu) — the only fair test for pixel strategy
    { scenario: 'S4 fixed:Menu (pixel-fair)', label: 'Menu', opts: { ymin: 40, ymax: 90 },
      verifyLabel: 'Admin', verifyOpts: {}, pixelPx: [1078, 69] },
  ];

  const clickStrats = ['domClick', 'mouseXY', 'locator', 'pixel'];
  const waits = ['fixed', 'signal'];

  for (const s of scenarios) {
    for (const strat of clickStrats) {
      // pixel only run on the pixel-fair scenario
      if (strat === 'pixel' && !s.pixelPx) continue;
      for (const waitName of waits) {
        // re-establish clean Admin state before each trial
        await openAdmin(page).catch(() => {});
        // for S2/S3 we need to be on the right tab; openAdmin lands on Main.
        // Navigate the known-good precondition with mouseXY (the control), so the
        // trial only measures the ONE action under test.
        if (s.scenario.startsWith('S2')) {
          // S2 tests clicking top-menu Search; precondition is just Admin open — ok
        } else if (s.scenario.startsWith('S3')) {
          await clickMouse(page, 'Access', { ymin: 75, ymax: 110 }); await waitSignal(page);
        }
        const opts = { ...s.opts };
        if (strat === 'pixel') opts.px = s.pixelPx;
        const rec = await trial({
          page, scenario: s.scenario, strat, waitName,
          click: strat, label: s.label, opts,
          verifyLabel: s.verifyLabel, verifyOpts: s.verifyOpts,
        });
        results.push(rec);
        log(`${rec.verified ? 'PASS' : (rec.fired ? 'fired?' : 'MISS ')}  ${s.scenario.padEnd(34)} ${strat.padEnd(9)} ${waitName.padEnd(7)} ${rec.ms}ms ${rec.note}`);
        if (WANT_SHOTS && !rec.verified && rec.fired) {
          try { const { redact } = require('../lib/redact');
            await redact(page, path.join(OUT, `fail-${s.scenario.slice(0,6).replace(/\W/g,'')}-${strat}-${waitName}.png`)); } catch {}
        }
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'bench-results.json'), JSON.stringify(results, null, 2));
  await browser.close();

  // ---- summary ----
  log('\n===== SUMMARY (verified success rate by strategy) =====');
  const byStrat = {};
  for (const r of results) {
    byStrat[r.strategy] ??= { n: 0, pass: 0, ms: 0 };
    byStrat[r.strategy].n++; if (r.verified) byStrat[r.strategy].pass++; byStrat[r.strategy].ms += r.ms;
  }
  for (const [k, v] of Object.entries(byStrat))
    log(`  ${k.padEnd(9)} ${v.pass}/${v.n} verified   avg ${Math.round(v.ms / v.n)}ms`);
  log('\n===== by wait strategy =====');
  const byWait = {};
  for (const r of results) {
    byWait[r.wait] ??= { n: 0, pass: 0, ms: 0 };
    byWait[r.wait].n++; if (r.verified) byWait[r.wait].pass++; byWait[r.wait].ms += r.ms;
  }
  for (const [k, v] of Object.entries(byWait))
    log(`  ${k.padEnd(7)} ${v.pass}/${v.n} verified   avg ${Math.round(v.ms / v.n)}ms`);
  log(`\nresults: ${path.join(OUT, 'bench-results.json')}`);
}

run().catch(e => { console.error('BENCH FAILED:', e.message); process.exit(1); });
