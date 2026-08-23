/**
 * lib/nav.js — canonical navigation helpers for an Isomorphic SmartClient (ISC) app.
 *
 * Built from a measured head-to-head benchmark (scripts/bench-interaction.js) of the four
 * click strategies and two wait strategies that had accumulated across the capture
 * scripts. The findings drive every design choice in this module:
 *
 *   - element.click() inside page.evaluate ("domClick") NEVER works: 0/8 verified. This
 *     is not flakiness. SmartClient runs its own event manager and only reacts to
 *     TRUSTED input events. A synthetic DOM click is not trusted, so the framework never
 *     sees it. Playwright's mouse API goes through CDP Input.dispatchMouseEvent, which
 *     the browser marks trusted, which is why the coordinate paths work at all.
 *   - page.locator('text=') and a DOM-center page.mouse.click both scored 100% on
 *     correctly-specified targets. locator is more layout-robust; a positional band
 *     (ymin/ymax) is what disambiguates duplicate labels, and locator cannot express one.
 *   - Polling isc.Page.isLoaded() was as reliable as a blind waitForTimeout and about 4x
 *     faster (1.7s vs 7.1s per step).
 *   - A hardcoded pixel click was only safe for a genuinely fixed target (the shell's
 *     top-level Menu button). Everywhere else it is a coin flip.
 *
 * THEREFORE the canonical pattern is:
 *   clickLabel()  -> locator first, then banded DOM-center mouse, then the visual cascade
 *   waitForIsc()  -> poll isc.Page.isLoaded() + dismiss overlays, bounded, with an
 *                    explicit destination post-condition
 *   NEVER page.evaluate(el => el.click()), and never a blind waitForTimeout for load.
 *
 * Read-only doctrine: callers never click Save/Submit (lib/guard.js enforces it) and
 * close context menus with Escape.
 */
const { dismissOverlay } = require('./login');
const { isForbiddenLabel } = require('./guard');
const { config } = require('./config');

/**
 * Wait for the ISC page to report loaded, then clear the shell's loading overlays.
 * Replaces every magic waitForTimeout(6000/8000/12000) the scripts used to carry.
 * @returns {Promise<number>} elapsed ms (best-effort; resolves even if the signal times out)
 */
async function waitForIsc(page, { budget = 15000, settle = 600, expect = null, expectOpts = {} } = {}) {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => typeof window.isc !== 'undefined' && window.isc.Page && window.isc.Page.isLoaded(),
      { timeout: budget }
    );
  } catch { /* best-effort: continue and let dismissOverlay + settle cover it */ }
  await dismissOverlay(page);
  // CRITICAL for view transitions: isc.Page.isLoaded() can report true for the
  // OUTGOING page before the new view renders (benchmark missed this; the live
  // multi-provider run landed on the home dashboard). When the caller names an
  // element it expects on the destination, poll for THAT as the real post-condition.
  if (expect) {
    const deadline = start + budget;
    while (Date.now() < deadline) {
      if (await isPresent(page, expect, expectOpts)) break;
      await dismissOverlay(page);
      await page.waitForTimeout(400);
    }
  }
  if (settle) await page.waitForTimeout(settle); // brief grid-paint settle only
  return Date.now() - start;
}

/**
 * Resolve the click point of a label via DOM-center coordinates, filtered by a
 * vertical band (and optional horizontal band) to disambiguate duplicate labels.
 * Center x is clamped 40px in from the left edge so wide cells click on the text.
 */
async function resolveLabel(page, label, { ymin = 0, ymax = 100000, xmin = 0, xmax = 100000, nth = 0, contains = false } = {}) {
  return page.evaluate(({ label, ymin, ymax, xmin, xmax, nth, contains }) => {
    const hits = [];
    for (const el of document.querySelectorAll('td, div, span, a, button')) {
      const txt = (el.innerText || el.textContent || '').trim();
      const match = contains ? txt.includes(label) : txt === label;
      if (match) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 &&
            r.y >= ymin && r.y <= ymax && r.x >= xmin && r.x <= xmax) {
          hits.push({ x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2, w: r.width, h: r.height });
        }
      }
    }
    hits.sort((a, b) => a.y - b.y || a.x - b.x);
    return { total: hits.length, pick: hits[nth] || null };
  }, { label, ymin, ymax, xmin, xmax, nth });
}

/**
 * Canonical click. Strategy order (both scored 100% in the benchmark):
 *   1) Playwright locator (layout-robust, waits for actionability) — used when the
 *      label is UNBANDED or single-match, since locator can't read our y-band.
 *   2) Banded DOM-center mouse click — the disambiguator for duplicate labels and
 *      the reliable primary inside ISC grids.
 * We prefer the banded mouse path whenever a band is supplied (that's the case the
 * benchmark showed locator needs help with); otherwise we try locator first.
 *
 * @param {string} label exact trimmed text to match
 * @param {object} opts  {ymin,ymax,xmin,xmax,nth,button,preferLocator}
 * @returns {Promise<{ok:boolean, via:string, matches:number}>}
 */
async function clickLabel(page, label, opts = {}) {
  const { button = 'left', nth = 0 } = opts;

  // Read-only guard, second layer (the DOM capture listener in lib/guard.js is the
  // first). Refuse to even issue a left-click on a forbidden mutating control when
  // CAPTURE_READONLY/CAPTURE_NO_SUBMIT is set. Right-clicks (context menus) are
  // inspection-only and remain allowed.
  if (button === 'left' && isForbiddenLabel(label)) {
    return { ok: false, via: 'blocked-readonly', matches: 0, blocked: label };
  }
  const banded = opts.ymin != null || opts.ymax != null || opts.xmin != null || opts.xmax != null;

  // For banded targets (or substring matches, which a text= locator can't do),
  // go straight to DOM-center mouse — the disambiguator.
  if ((banded || opts.contains) && !opts.preferLocator) {
    const { total, pick } = await resolveLabel(page, label, opts);
    if (pick) {
      await page.mouse.click(pick.x, pick.y, { button });
      return { ok: true, via: 'mouseXY', matches: total };
    }
  }

  // Locator path (default for unbanded / preferLocator).
  try {
    const loc = page.locator(`text="${label}"`);
    const n = await loc.count();
    if (n > 0) {
      await loc.nth(nth).click({ button, timeout: 5000 });
      return { ok: true, via: 'locator', matches: n };
    }
  } catch { /* fall through to mouse fallback */ }

  // Fallback: DOM-center mouse even if unbanded.
  const { total, pick } = await resolveLabel(page, label, opts);
  if (pick) {
    await page.mouse.click(pick.x, pick.y, { button });
    return { ok: true, via: 'mouseXY-fallback', matches: total };
  }

  // Visual fallback cascade (OCR -> template -> vision model). Only runs when the DOM
  // found nothing, and only if not disabled. Every tier returns the SAME {x,y} shape and
  // the click is still issued here via page.mouse — which is what keeps lib/guard.js's
  // capture-phase listener effective no matter which tier won. Set
  // opts.visualFallback=false to skip (hot loops), opts.tiers to reorder or trim.
  if (opts.visualFallback !== false) {
    const { resolveCascade } = require('./resolvers');
    const configured = (config().resolvers || {}).tiers || ['dom', 'ocr', 'template', 'vlm'];
    const visualTiers = configured.filter((tier) => tier !== 'dom');
    const casc = await resolveCascade(
      page, label,
      { ...opts, tiers: opts.tiers || visualTiers, onTier: (m) => console.log(m) },
      resolveLabel,
    );
    if (casc.pick) {
      await page.mouse.click(casc.pick.x, casc.pick.y, { button });
      return { ok: true, via: `visual:${casc.via}`, matches: 1, attempts: casc.attempts };
    }
  }
  // Every resolution path missed. If reference-stop is armed, treat an unresolvable label
  // as an unclear item and hard-stop rather than let the caller proceed on a guessed
  // screen. Opt in with CAPTURE_REFERENCE_STOP=1 (or opts.referenceStop) so hot loops
  // that legitimately expect misses are not disrupted.
  if ((process.env.CAPTURE_REFERENCE_STOP === '1' || opts.referenceStop) && !opts._noRefStop) {
    const { referenceStop } = require('./reference-stop');
    await referenceStop({
      term: label,
      context: `nav.clickLabel could not resolve "${label}" (DOM, locator, and visual tiers all missed)`,
      outDir: opts.screenshotDir || process.cwd(),
      page,
    });
  }
  return { ok: false, via: 'none', matches: 0 };
}

/** Click a label then wait for the ISC load signal. Convenience for nav steps. */
async function clickAndWait(page, label, opts = {}) {
  const r = await clickLabel(page, label, opts);
  // opts.expect names an element that should appear on the destination — the
  // reliable post-condition for a view transition (not just the load signal).
  if (r.ok) await waitForIsc(page, { ...(opts.wait || {}), expect: opts.expect, expectOpts: opts.expectOpts || {} });
  return r;
}

/** Right-click a label (for ISC grid context menus). Uses DOM-center coords. */
async function rightClickLabel(page, label, opts = {}) {
  return clickLabel(page, label, { ...opts, button: 'right' });
}

/** Assert a label is present within an optional band — post-condition check. */
async function isPresent(page, label, opts = {}) {
  const { pick } = await resolveLabel(page, label, opts);
  return !!pick;
}

/**
 * Open the shell's admin area (menu button, then the admin item in the dropdown).
 *
 * The menu button is the ONE fixed-position target where a pixel click is defensible —
 * the benchmark found pixel clicks safe only for a genuinely static control. Both the
 * pixel and the arrival post-condition come from capture.config.json (`navigation`), so
 * this works on a shell laid out differently from the one it was written against.
 */
async function openAdmin(page, opts = {}) {
  const navCfg = config().navigation || {};
  const adminPx = opts.adminPx || navCfg.adminMenuItemPixel || [1090, 97];
  const post = opts.postCondition || navCfg.adminPostCondition || null;

  await page.locator(`text=${navCfg.menuLabel || 'Menu'}`).first().click();
  await page.waitForTimeout(1500); // dropdown animation, not a load — a small fixed wait is fine

  // Resolve the menu item by its label first, and fall back to the measured pixel only if
  // that misses. This is the order the README argues for everywhere else: a banded
  // DOM-center mouse click beats fixed coordinates, which are "reliable only for a
  // genuinely fixed target". This function used to go straight to the pixel, which both
  // contradicted that and left `navigation.adminLabel` with no readers in the entire repo.
  //
  // The band is the dropdown's vertical extent, not the whole screen: "Admin" also appears
  // in the page chrome once the section is open, and resolving to that would click nothing
  // useful while still reporting success.
  const adminLabel = opts.adminLabel || navCfg.adminLabel || null;
  let viaLabel = false;
  if (adminLabel) {
    const hit = await clickLabel(page, adminLabel, {
      ymin: 65, ymax: 500, referenceStop: false, _noRefStop: true,
    });
    viaLabel = !!hit.ok;
  }
  if (!viaLabel) await page.mouse.click(adminPx[0], adminPx[1]);
  // Post-condition: an element that only exists on the destination must actually render.
  // Waiting only on isc.Page.isLoaded() here returned while still on the home dashboard
  // (see the waitForIsc note above) — the classic silent wrong-screen capture.
  await waitForIsc(page, {
    budget: 20000,
    expect: post ? post.label : null,
    expectOpts: post ? { ymin: post.ymin, ymax: post.ymax } : {},
  });
  await page.waitForTimeout(1000);
  await dismissOverlay(page);
}

module.exports = {
  waitForIsc, resolveLabel, clickLabel, clickAndWait, rightClickLabel, isPresent, openAdmin,
};
