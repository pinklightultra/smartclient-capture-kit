/**
 * lib/isc-nav.js — walk an "Admin > A > B > C" navigation path.
 *
 * A generic label click cannot do this, because a path crosses THREE structurally different
 * kinds of segment and each one needs a different confirmation. Getting this wrong is what
 * produced a whole overnight batch of screenshots of the wrong screens:
 *
 *   1. TAB        the shell's top nav strip (config: navigation.tabBarY / navigation.tabs).
 *                 Clicking one opens a dropdown or panel. Needs a banded click, because the
 *                 same word often appears again lower down the page.
 *   2. DROP-ITEM  the item that appears after a tab opens. An ordinary label in a dropdown
 *                 or left column; click it and wait for the load signal.
 *   3. SECTION    an expandable section header inside a workspace. THE LABEL DOES NOT CHANGE
 *                 WHEN IT EXPANDS, so "the label is still there" proves nothing. Arrival has
 *                 to be confirmed by a DIFFERENT element — a column header or field that only
 *                 exists once the section is open. That is what expectPerSeg is for.
 *
 * Per segment: try it as a fresh visible leaf label, then fall back to a banded tab click.
 * Returns {ok, reached:[...], failedAt} so a caller can report how far it actually got
 * rather than just "failed". Read-only; the caller redacts and screenshots.
 */const nav = require('./nav');
const { config } = require('./config');

/** y of the shell's tab strip. */
function tabBarY() {
  return (config().navigation || {}).tabBarY || 95;
}

/**
 * Labels to treat as tabs rather than as list items. Configure them: a tab and a list item
 * that share a word are indistinguishable from the DOM alone, and guessing picks the wrong
 * one silently.
 */
function knownTabs() {
  return (config().navigation || {}).tabs || [];
}

/** Click a visible leaf label by exact text, return its click result. */
async function clickVisibleLabel(page, label, { ymin = 105, ymax = 900, xmax = 100000 } = {}) {
  const pick = await page.evaluate(({ label, ymin, ymax, xmax }) => {
    let best = null;
    for (const el of document.querySelectorAll('td, div, span, nobr, a')) {
      if (el.children.length) continue;
      if ((el.innerText || '').trim() !== label) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.y >= ymin && r.y <= ymax && r.x <= xmax) {
        if (!best || r.y < best.y) best = { x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + r.height / 2) };
      }
    }
    return best;
  }, { label, ymin, ymax, xmax });
  if (!pick) return { ok: false };
  await page.mouse.click(pick.x, pick.y);
  return { ok: true, at: pick };
}

/**
 * Navigate an "Admin > ..." path. Each non-Admin segment is resolved by type.
 * @param {object} opts { expectPerSeg?: {seg: {expect, expectOpts}} }  optional
 *        post-conditions to confirm arrival for specific segments.
 */
async function navigatePath(page, navPath, opts = {}) {
  const segs = navPath.split('>').map((s) => s.trim()).filter(Boolean);
  const reached = [];
  await nav.openAdmin(page);
  reached.push('Admin');

  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    const isTab = knownTabs().includes(seg);
    let done = false;

    if (isTab) {
      // Banded tab click at the top bar; confirm the NEXT segment (a dropdown item)
      // becomes visible, or just that the tab is active.
      const next = segs[i + 1];
      const r = await nav.clickAndWait(page, seg, { ymin: tabBarY() - 12, ymax: tabBarY() + 12, expect: next || seg }).catch(() => ({ ok: false }));
      done = r.ok;
      if (!done) {
        // fallback: plain banded click without expect
        const r2 = await nav.clickLabel(page, seg, { ymin: tabBarY() - 12, ymax: tabBarY() + 12 }).catch(() => ({ ok: false }));
        await page.waitForTimeout(1200);
        done = r2.ok;
      }
    } else {
      // Dropdown item or section header: click the visible label, then confirm by an
      // explicit post-condition if provided (section headers don't change their own text).
      const exp = (opts.expectPerSeg || {})[seg];
      let r = await clickVisibleLabel(page, seg, { ymin: 105, ymax: 900, xmax: 500 });
      if (!r.ok) {
        // maybe it's rendered as a wider/plain label; let nav.clickLabel try (locator + visual)
        r = await nav.clickLabel(page, seg, {}).catch(() => ({ ok: false }));
      }
      await page.waitForTimeout(1000);
      if (r.ok && exp) {
        await nav.waitForIsc(page, { expect: exp.expect, expectOpts: exp.expectOpts || {} });
        const present = await nav.isPresent(page, exp.expect, exp.expectOpts || {});
        done = present;
      } else {
        done = r.ok;
      }
    }

    if (!done) return { ok: false, reached, failedAt: seg };
    reached.push(seg);
    await page.waitForTimeout(600);
  }
  return { ok: true, reached };
}

module.exports = { navigatePath, clickVisibleLabel, knownTabs, tabBarY };
