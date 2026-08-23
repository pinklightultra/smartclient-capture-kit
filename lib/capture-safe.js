/**
 * lib/capture-safe.js — the capture front door. Everything that writes a PNG goes
 * through safeShot(), so redaction is not something a script can forget to call.
 */
const path = require('path');
const { redact, findLabeledColumnValueBoxes, RedactionError } = require('./redact');
const { waitForIsc, resolveLabel, clickLabel, clickAndWait, isPresent, openAdmin } = require('./nav');
const { config } = require('./config');

/** Default crop, from capture.config.json. */
function defaultCrop() {
  return (config().capture || {}).crop || null;
}

/** Grid columns whose values are always covered, from capture.config.json. */
function environmentColumns() {
  return (config().redaction || {}).columnLabels || [];
}

/**
 * Capture a screenshot with redaction applied and VERIFIED first.
 *
 * Aborts rather than writing a file when a column we were told to redact is visibly
 * present on screen but the resolver could not find any of its values. That combination
 * used to yield an empty extraBoxes array, which was indistinguishable from "this screen
 * has no such column" and produced a clean-looking, unredacted capture.
 */
async function safeShot(page, screenshotDir, name, opts = {}) {
  const labels = [...new Set([...(opts.redactColumns || []), ...environmentColumns()])];
  const columns = await findLabeledColumnValueBoxes(page, labels);
  if (columns.unresolvedLabels.length) {
    throw new RedactionError(
      `column(s) ${columns.unresolvedLabels.join(', ')} are visible on this screen but no ` +
      `values could be located under them, so they cannot be covered`,
      { unresolvedLabels: columns.unresolvedLabels, presentLabels: columns.presentLabels },
    );
  }
  return redact(page, path.join(screenshotDir, `${name}.png`), {
    crop: opts.crop || defaultCrop(),
    extraBoxes: columns.boxes,
    safeTexts: opts.safeTexts || [],
    requireBoxes: opts.requireBoxes,
    allowUnredacted: !!opts.allowUnredacted,
  });
}

async function requireClick(page, label, opts = {}) {
  const result = await clickAndWait(page, label, opts);
  if (!result.ok) throw new Error(`Required read-only navigation label not found: ${label}`);
  return result;
}

async function openMenuItem(page, label, expect = null) {
  const menuLabel = (config().navigation || {}).menuLabel || 'Menu';
  const menu = page.locator(`text=${menuLabel}`).first();
  await menu.click();
  await page.waitForTimeout(1200);
  const result = await clickLabel(page, label, {
    ymin: 65, ymax: 500, referenceStop: false, _noRefStop: true,
  });
  if (!result.ok) {
    await page.keyboard.press('Escape');
    return false;
  }
  await waitForIsc(page, { budget: 20000, expect: expect || label, settle: 800 });
  return true;
}

async function filterVisibleGrid(page, value, fieldCandidates, opts = {}) {
  const result = await page.evaluate(({ value, fieldCandidates }) => {
    const normalized = fieldCandidates.map((candidate) => candidate.toLowerCase());
    for (const key of Object.keys(window)) {
      try {
        const grid = window[key];
        if (!grid || !grid.Class || !String(grid.Class).includes('Grid') ||
            !grid.isVisible || !grid.isVisible() || !grid.getFields) continue;
        const fields = grid.getFields() || [];
        const field = fields.find((candidate) => {
          const name = String(candidate.name || '').toLowerCase();
          const title = String(candidate.title || '').toLowerCase();
          return normalized.some((wanted) => name === wanted || title === wanted ||
            name.includes(wanted) || title.includes(wanted));
        });
        if (!field || !grid.setFilterEditorValue) continue;
        grid.setFilterEditorValue(field.name, value);
        if (grid.filterData) grid.filterData();
        return { found: true, grid: key, field: field.name };
      } catch (_) {}
    }
    return { found: false };
  }, { value, fieldCandidates });
  if (result.found) {
    await waitForIsc(page, { budget: 12000, settle: 1200 });
    return result;
  }

  // Some SmartClient grids are not published as enumerable window globals.
  // Fall back to the visible filter editor under a matching column header.
  const domFilter = await page.evaluate(({ candidates, region }) => {
    const wanted = candidates.map((value) => value.toLowerCase());
    const minX = region.minX == null ? 0 : region.minX;
    const maxX = region.maxX == null ? 100000 : region.maxX;
    const minY = region.minY == null ? 0 : region.minY;
    const maxY = region.maxY == null ? 100000 : region.maxY;
    const visible = (rect) => rect.width > 2 && rect.height > 2 && rect.top >= 0;
    const leaves = Array.from(document.querySelectorAll('td, th, div, span'))
      .filter((element) => element.children.length === 0)
      .map((element) => ({
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter((item) => item.text && visible(item.rect) &&
        item.rect.left >= minX && item.rect.right <= maxX &&
        item.rect.top >= minY && item.rect.bottom <= maxY);
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => visible(item.rect) && !item.element.disabled && !item.element.readOnly);

    for (const header of leaves) {
      const normalized = header.text.toLowerCase();
      if (!wanted.some((candidate) => normalized === candidate || normalized.includes(candidate))) continue;
      const input = inputs
        .filter((item) => {
          const center = item.rect.left + item.rect.width / 2;
          return center >= header.rect.left - 4 && center <= header.rect.right + 4 &&
            item.rect.top >= header.rect.top - 70 && item.rect.top <= header.rect.bottom + 90;
        })
        .sort((a, b) => {
          const headerCenter = header.rect.top + header.rect.height / 2;
          const aDistance = Math.abs((a.rect.top + a.rect.height / 2) - headerCenter);
          const bDistance = Math.abs((b.rect.top + b.rect.height / 2) - headerCenter);
          return aDistance - bDistance;
        })[0];
      if (input) {
        return {
          found: true,
          via: 'dom-filter-editor',
          x: input.rect.left + Math.min(input.rect.width / 2, 80),
          y: input.rect.top + input.rect.height / 2,
          header: header.text,
        };
      }
    }
    return { found: false, via: 'none' };
  }, { candidates: fieldCandidates, region: opts.region || {} });

  if (!domFilter.found) return domFilter;
  await page.mouse.click(domFilter.x, domFilter.y);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await waitForIsc(page, { budget: 12000, settle: 1200 });
  return domFilter;
}

async function fillInputBesideLabel(page, label, value) {
  const input = await page.evaluate((wanted) => {
    const labels = Array.from(document.querySelectorAll('td, div, span, label'))
      .filter((element) => element.children.length === 0)
      .map((element) => ({
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter((item) => item.rect.width > 2 && item.rect.height > 2 &&
        item.text.replace(/\s*:$/, '') === wanted.replace(/\s*:$/, ''));
    const inputs = Array.from(document.querySelectorAll('input'))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.width > 2 && item.rect.height > 2 &&
        !item.element.disabled && !item.element.readOnly);
    for (const item of labels) {
      const match = inputs
        .filter((candidate) => Math.abs(candidate.rect.top - item.rect.top) < 12 &&
          candidate.rect.left >= item.rect.right - 8 && candidate.rect.left < item.rect.right + 500)
        .sort((a, b) => a.rect.left - b.rect.left)[0];
      if (match) return {
        found: true,
        x: match.rect.left + Math.min(match.rect.width / 2, 80),
        y: match.rect.top + match.rect.height / 2,
      };
    }
    return { found: false };
  }, label);
  if (!input.found) return false;
  await page.mouse.click(input.x, input.y);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(value);
  return true;
}

/**
 * Type into the first editable input that sits just below a named heading — the pattern
 * for a filter box in a panel whose grid ISC will not expose as a widget.
 *
 * @param {object} opts {xmin,xmax} horizontal band for the input, {maxBelow} vertical reach
 */
async function filterUnderHeading(page, heading, value, opts = {}) {
  const { xmin = 0, xmax = 100000, maxBelow = 90, headingOpts = {} } = opts;
  const found = await resolveLabel(page, heading, headingOpts);
  if (!found.pick) return false;
  const inputs = page.locator('input');
  const matches = [];
  const count = await inputs.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = inputs.nth(index);
    if (!(await candidate.isVisible()) || !(await candidate.isEditable())) continue;
    const box = await candidate.boundingBox();
    if (!box) continue;
    if (box.x >= xmin && box.x <= xmax &&
        box.y >= found.pick.y && box.y <= found.pick.y + maxBelow &&
        box.width > 50 && box.height > 10) {
      matches.push({ index, box });
    }
  }
  matches.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  if (!matches.length) return false;
  const input = inputs.nth(matches[0].index);
  await input.fill(value);
  if ((await input.inputValue()) !== value) return false;
  await input.press('Enter');
  await waitForIsc(page, { budget: 12000, settle: 1200 });
  return true;
}

async function rightClickFirstGridRow(page, headerLabel, opts = {}) {
  const target = await page.evaluate(({ headerLabel, region }) => {
    const minX = region.minX == null ? 0 : region.minX;
    const maxX = region.maxX == null ? 100000 : region.maxX;
    const minY = region.minY == null ? 100 : region.minY;
    const maxY = region.maxY == null ? 860 : region.maxY;
    const visible = (rect) => rect.width > 2 && rect.height > 2 &&
      rect.left >= minX && rect.right <= maxX && rect.top >= minY && rect.bottom <= maxY;
    const leaves = Array.from(document.querySelectorAll('td, th, div, span'))
      .filter((element) => element.children.length === 0)
      .map((element) => ({
        element,
        text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter((item) => item.text && visible(item.rect));
    const headers = leaves
      .filter((item) => item.text.toLowerCase() === headerLabel.toLowerCase())
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const header = headers[0];
    if (!header) return { found: false, reason: 'header-not-found' };
    const centerX = header.rect.left + Math.min(header.rect.width / 2, 50);
    const rows = leaves
      .filter((item) => item.rect.top > header.rect.bottom + 2 &&
        item.rect.top < header.rect.bottom + 700 &&
        item.rect.left <= centerX && item.rect.right >= centerX)
      .sort((a, b) => a.rect.top - b.rect.top);
    if (rows.length) {
      const row = rows[0];
      return {
        found: true,
        x: row.rect.left + Math.min(row.rect.width / 2, 50),
        y: row.rect.top + row.rect.height / 2,
        text: row.text,
        fallback: false,
      };
    }
    return {
      found: true,
      x: centerX,
      y: Math.min(maxY - 10, header.rect.bottom + 55),
      text: '',
      fallback: true,
    };
  }, { headerLabel, region: opts.region || {} });
  if (!target.found) return target;
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await page.waitForTimeout(900);
  return target;
}

async function selectContextMenuItem(page, label, expect = null) {
  const result = await clickLabel(page, label, {
    ymin: 90,
    ymax: 860,
    referenceStop: false,
    _noRefStop: true,
  });
  if (!result.ok) return result;
  await waitForIsc(page, { budget: 12000, expect, settle: 700 });
  return result;
}

module.exports = {
  defaultCrop,
  environmentColumns,
  safeShot,
  requireClick,
  openMenuItem,
  filterVisibleGrid,
  fillInputBesideLabel,
  filterUnderHeading,
  rightClickFirstGridRow,
  selectContextMenuItem,
  waitForIsc,
  clickLabel,
  resolveLabel,
  isPresent,
  openAdmin,
};
