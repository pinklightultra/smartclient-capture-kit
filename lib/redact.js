/**
 * lib/redact.js - configurable DOM-overlay redactor for pre-capture masking.
 *
 * WHAT THIS IS
 * ------------
 * A discovery pass finds on-screen regions you have declared sensitive, injects opaque
 * overlays over them in the live DOM, VERIFIES the overlays are attached and painted,
 * and only then takes the screenshot. The sensitive pixels are never in any image on
 * disk, so there is no post-process blur to forget, get wrong, or reverse.
 *
 * WHAT IT IS NOT
 * --------------
 * This is NOT a compliance control and it does not implement any named de-identification
 * standard. It covers exactly three things, all configured in capture.config.json under
 * `redaction`:
 *
 *   1. `identityPrefix`   the logged-in operator badge in the shell's top bar.
 *   2. `valuePatterns`    leaf text matching a regular expression you supply. The shipped
 *                         defaults match US SSN, 10-digit phone/fax, email address,
 *                         numeric dates, IPv4, http(s) URLs, and 7+ character uppercase
 *                         alphanumeric identifiers.
 *   3. `labelPatterns` /  a field label or grid column header you name, whose adjacent
 *      `columnLabels`     VALUE is covered (the label itself stays readable).
 *
 * Anything outside those three mechanisms is the caller's problem. Free text, prose in a
 * notes field, an avatar or photo, a barcode, a signature image, a name that matches no
 * pattern and sits under no labelled column, text rendered into a <canvas>, and anything
 * scrolled out of the captured region are all NOT detected. Review your captures.
 *
 * FAIL CLOSED
 * -----------
 * Every path that cannot apply or cannot verify a redaction throws RedactionError and no
 * file is written. A warning that a redaction was skipped is worse than useless: the
 * screenshot still lands on disk and the warning scrolls off. There are seven such throw
 * sites in this module and one more in capture-safe.js; README.md lists them under
 * "Redaction fails closed".
 */
const sharp = require('sharp');
const { config } = require('./config');

/** Marker attribute on injected overlays. Also the handle used to verify + clean up. */
const OVERLAY_ATTR = 'data-capture-redaction';

/** Thrown whenever a redaction cannot be applied or verified. Never caught internally. */
class RedactionError extends Error {
  constructor(message, detail = {}) {
    super(`redaction aborted: ${message}`);
    this.name = 'RedactionError';
    this.detail = detail;
  }
}

function redactionConfig() {
  return config().redaction || {};
}

/**
 * Discover sensitive regions on the current page.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 *   safeTexts {string[]} values that must stay readable (a config code you are
 *             documenting, for example). Matched EXACTLY after whitespace trimming  - 
 *             there is deliberately no prefix or fuzzy matching, because a loose
 *             exemption silently un-redacts anything that happens to resemble it.
 * @returns {Promise<{boxes: object[], exempted: string[]}>}
 */
async function findPiiBoxes(page, opts = {}) {
  const cfg = redactionConfig();
  const payload = {
    safeTextValues: Array.isArray(opts.safeTexts) ? opts.safeTexts.map(String) : [],
    identityPrefix: cfg.identityPrefix || 'ID:',
    valuePatterns: cfg.valuePatterns || [],
    labelPatterns: cfg.labelPatterns || [],
  };

  return page.evaluate(({ safeTextValues, identityPrefix, valuePatterns, labelPatterns }) => {
    const boxes = [];
    const exempted = [];
    const push = (r, pad = 0, source = 'auto') => {
      if (r && r.width > 2 && r.height > 2) {
        boxes.push({
          left: Math.max(0, Math.floor(r.x - pad)),
          top: Math.max(0, Math.floor(r.y - pad)),
          width: Math.ceil(r.width + pad * 2),
          height: Math.ceil(r.height + pad * 2),
          source,
        });
      }
    };
    const isLeaf = (el) => el.children.length === 0;
    const txt = (el) => (el.innerText || el.value || '').trim();

    const VALUE_RX = valuePatterns.map((src) => new RegExp(src));
    const LABEL_RX = labelPatterns.length
      ? new RegExp('^(' + labelPatterns.join('|') + ')\\s*:?$', 'i')
      : null;

    // Exact-match-only exemption. Anything not byte-identical to a declared safe value
    // stays subject to redaction.
    const safeText = new Set(safeTextValues.map((v) => v.trim()));
    const isSafeText = (t) => {
      const normalized = String(t || '').trim();
      if (!safeText.has(normalized)) return false;
      exempted.push(normalized);
      return true;
    };
    const looksSensitive = (t) => t && !isSafeText(t) && VALUE_RX.some((re) => re.test(t));

    const all = Array.from(document.querySelectorAll('td, div, span, th, input'));
    const leaves = all.filter(isLeaf)
      .map((el) => ({ el, t: txt(el), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.width > 0 && x.r.height > 0 && x.r.height < 40);

    // 1) The shell's logged-in identity badge, e.g. "ID:<operator>".
    const idRx = new RegExp('^' + identityPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const { t, r } of leaves) {
      if (idRx.test(t) && r.y < 80) push(r, 2, 'identity-badge');
    }

    // 2) Content-based: any leaf whose text matches a configured value pattern.
    for (const { t, r } of leaves) {
      if (looksSensitive(t)) push(r, 1, 'value-pattern');
    }

    // 3) Label-based: for each labelled field/column, cover its VALUE only.
    if (LABEL_RX) {
      const labels = leaves.filter((x) => LABEL_RX.test(x.t));
      for (const lab of labels) {
        const labelGrid = lab.el.closest('.listGrid');
        const cx = lab.r.x + lab.r.width / 2;
        for (const { el, t, r } of leaves) {
          if (!t || LABEL_RX.test(t)) continue;            // skip empties + the label itself
          const center = r.x + r.width / 2;
          const sameGrid = labelGrid && el.closest('.listGrid') === labelGrid;
          const underColumn = sameGrid &&
            Math.abs(center - cx) < Math.max(lab.r.width, 70) &&
            r.y > lab.r.y + 4 && r.y < lab.r.y + 900;
          const rightOfLabel = !labelGrid && Math.abs(r.y - lab.r.y) < 8 &&
            r.x > lab.r.x + lab.r.width - 2 && r.x < lab.r.x + lab.r.width + 260;
          if (underColumn) push(r, 1, 'label-column');
          if (rightOfLabel) push(r, 1, 'label-form');
        }
      }
    }

    return { boxes, exempted: Array.from(new Set(exempted)) };
  }, payload);
}

/**
 * Find the non-empty VALUES belonging to explicitly named grid columns - for
 * environment-specific configuration (a Company, a Plan, a Queue) that is not matched
 * by any value pattern but should not leave the building.
 *
 * Columns are located by their visible header text; no screen coordinates are hardcoded.
 *
 * Also reports `unresolvedLabels`: labels that ARE present on screen as a header but
 * whose column yielded zero value boxes. That combination means the resolver failed on a
 * column that exists, which callers must treat as a hard failure rather than as
 * "nothing to redact".
 *
 * @returns {Promise<{boxes: object[], presentLabels: string[], unresolvedLabels: string[]}>}
 */
async function findLabeledColumnValueBoxes(page, labels) {
  return page.evaluate((wantedLabels) => {
    const normalized = wantedLabels.map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase());
    const wanted = new Set(normalized);
    const all = Array.from(document.querySelectorAll('td, div, span, th'));
    const cellElement = (el) => {
      let node = el;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        if ((node.tagName === 'TD' || node.tagName === 'TH') &&
            rect.width > 2 && rect.height > 2 && rect.height < 45) {
          return node;
        }
      }
      return el;
    };
    const leaves = all
      .filter((el) => el.children.length === 0)
      .map((el) => ({
        el,
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        rect: el.getBoundingClientRect(),
      }))
      .filter((x) => x.text && x.rect.width > 2 && x.rect.height > 2 && x.rect.height < 40);

    const headers = leaves.filter((x) => wanted.has(x.text.toLowerCase()));
    const boxes = [];
    const resolved = new Set();
    const present = new Set();
    for (const header of headers) {
      present.add(header.text.toLowerCase());
      const headerCellEl = cellElement(header.el);
      const headerCell = headerCellEl.getBoundingClientRect();
      const headerGrid = headerCellEl.closest('.listGrid');
      const left = headerCell.left;
      const right = headerCell.right;
      for (const value of leaves) {
        if (wanted.has(value.text.toLowerCase())) continue;
        const valueCellEl = cellElement(value.el);
        if (headerGrid && valueCellEl.closest('.listGrid') !== headerGrid) continue;
        const center = value.rect.left + value.rect.width / 2;
        const below = value.rect.top >= headerCell.bottom && value.rect.top < headerCell.top + 900;
        const inColumn = center >= left - 2 && center <= right + 2;
        if (below && inColumn) {
          const valueCell = valueCellEl.getBoundingClientRect();
          boxes.push({
            left: Math.max(0, Math.floor(valueCell.left)),
            top: Math.max(0, Math.floor(valueCell.top)),
            width: Math.ceil(valueCell.width),
            height: Math.ceil(valueCell.height),
            source: `column:${header.text}`,
          });
          resolved.add(header.text.toLowerCase());
        }
      }
    }

    // SmartClient can expose duplicate leaf nodes for one painted cell.
    const deduped = boxes.filter((box, index) => boxes.findIndex((other) =>
      Math.abs(other.left - box.left) < 2 &&
      Math.abs(other.top - box.top) < 2 &&
      Math.abs(other.width - box.width) < 2 &&
      Math.abs(other.height - box.height) < 2
    ) === index);

    const presentLabels = Array.from(present);
    return {
      boxes: deduped,
      presentLabels,
      unresolvedLabels: presentLabels.filter((label) => !resolved.has(label)),
    };
  }, labels);
}

/**
 * The captured region's size in CSS pixels. page.viewportSize() returns null for a
 * context with no emulated viewport (a CDP attach to a real browser window), which used
 * to mean the clamping arithmetic below dereferenced null. Measure in-page instead, and
 * refuse to continue if neither source can tell us the bounds.
 */
async function captureBounds(page) {
  const emulated = page.viewportSize();
  if (emulated && emulated.width > 0 && emulated.height > 0) return emulated;
  const measured = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  })).catch(() => null);
  if (measured && measured.width > 0 && measured.height > 0) return measured;
  throw new RedactionError('cannot determine the captured region size, so overlay bounds cannot be checked');
}

/**
 * Clamp a box into the captured region and REFUSE the capture if clamping lost coverage.
 *
 * Clamping used to be silent: a box starting past the right edge was slid back to
 * `width - 1` and shrunk to 1px, which covered an innocent pixel somewhere else and left
 * the sensitive text uncovered. Any box that is not fully inside the region, or whose
 * clamped area is smaller than the requested area, is a redaction we cannot apply.
 */
function clampOrThrow(box, bounds) {
  const requested = {
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
  const left = Math.max(0, requested.left);
  const top = Math.max(0, requested.top);
  const right = Math.min(bounds.width, requested.left + requested.width);
  const bottom = Math.min(bounds.height, requested.top + requested.height);
  const width = right - left;
  const height = bottom - top;

  if (width < 1 || height < 1) {
    throw new RedactionError(
      `a region to redact lies entirely outside the captured area (${requested.left},${requested.top} ${requested.width}x${requested.height})`,
      { box, bounds },
    );
  }
  if (width < requested.width || height < requested.height) {
    throw new RedactionError(
      `a region to redact extends past the captured area and would be only partly covered ` +
      `(wanted ${requested.width}x${requested.height} at ${requested.left},${requested.top}, ` +
      `could cover ${width}x${height}) - widen the viewport or narrow the crop`,
      { box, bounds },
    );
  }
  return { left, top, width, height, source: box.source || 'auto' };
}

/**
 * Inject the overlays and report, per overlay, whether it is actually attached to the
 * document AND painted at the requested geometry. Returns {attached, painted, mismatches}.
 *
 * This is the check that used to be missing entirely: the old code appended overlay divs
 * and screenshotted on the next line, so an injection that did nothing - a re-render that
 * dropped the nodes, a CSP that refused the inline styles, an evaluate against a
 * navigated-away document - produced a clean-looking unredacted PNG.
 */
async function applyOverlays(page, boxes, attr) {
  return page.evaluate(({ overlayBoxes, attr }) => {
    document.querySelectorAll(`[${attr}]`).forEach((el) => el.remove());
    let attached = 0;
    const mismatches = [];
    overlayBoxes.forEach((box, index) => {
      const overlay = document.createElement('div');
      overlay.setAttribute(attr, String(index));
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
        background: '#fff',
        zIndex: '2147483647',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(overlay);
      if (!overlay.isConnected) { mismatches.push({ index, reason: 'not-connected' }); return; }
      const r = overlay.getBoundingClientRect();
      // 1px tolerance for sub-pixel layout rounding.
      if (Math.abs(r.width - box.width) > 1 || Math.abs(r.height - box.height) > 1 ||
          Math.abs(r.left - box.left) > 1 || Math.abs(r.top - box.top) > 1) {
        mismatches.push({
          index,
          reason: 'geometry-drift',
          wanted: box,
          got: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        });
        return;
      }
      const style = getComputedStyle(overlay);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1) {
        mismatches.push({ index, reason: 'not-painted' });
        return;
      }
      attached += 1;
    });
    return { attached, requested: overlayBoxes.length, mismatches, present: document.querySelectorAll(`[${attr}]`).length };
  }, { overlayBoxes: boxes, attr });
}

async function removeOverlays(page, attr) {
  await page.evaluate((a) => {
    document.querySelectorAll(`[${a}]`).forEach((el) => el.remove());
  }, attr).catch(() => { /* page closed; nothing left to clean */ });
}

/**
 * Discover, cover, verify, capture, crop, write.
 *
 * @param {import('playwright').Page} page
 * @param {string} filePath  destination PNG
 * @param {object} opts
 *   crop        {left,top,width,height} optional post-capture crop
 *   extraBoxes  additional regions from the caller (e.g. findLabeledColumnValueBoxes)
 *   safeTexts   values to leave readable (exact match)
 *   requireBoxes minimum verified regions; defaults to redaction.requireBoxes in config
 *   allowUnredacted  set true ONLY for a screen you have confirmed carries nothing
 *                    sensitive; bypasses the requireBoxes floor and records the choice
 * @returns {Promise<{requested:number, applied:number, verified:number, boxes:number,
 *                    cropped:boolean, sources:object, exempted:string[]}>}
 * @throws {RedactionError} on any redaction that cannot be applied or verified
 */
async function redact(page, filePath, opts = {}) {
  const cfg = redactionConfig();
  const { crop = null, extraBoxes = [], safeTexts = [], allowUnredacted = false } = opts;
  const floor = opts.requireBoxes != null
    ? opts.requireBoxes
    : (cfg.requireBoxes != null ? cfg.requireBoxes : 1);

  const discovered = await findPiiBoxes(page, { safeTexts });
  const boxes = [...discovered.boxes, ...extraBoxes];

  // FLOOR. Zero discovered regions on an application screen means detection failed, not
  // that the screen is clean - every authenticated screen in this shell carries at least
  // the operator identity badge. Refusing here is what stops a silently broken selector
  // from producing an archive of unredacted captures.
  if (boxes.length < floor && !allowUnredacted) {
    throw new RedactionError(
      `found ${boxes.length} region(s) to redact but at least ${floor} was required. ` +
      `Either the discovery selectors no longer match this screen, or the screen genuinely ` +
      `has nothing sensitive - in which case pass { allowUnredacted: true } deliberately.`,
      { found: boxes.length, floor },
    );
  }

  const bounds = await captureBounds(page);
  const safeBoxes = boxes.map((b) => clampOrThrow(b, bounds));

  let result;
  try {
    const applied = await applyOverlays(page, safeBoxes, OVERLAY_ATTR);
    if (applied.attached !== safeBoxes.length || applied.mismatches.length) {
      throw new RedactionError(
        `${applied.attached}/${safeBoxes.length} overlays verified in the DOM` +
        (applied.mismatches.length ? `; first problem: ${applied.mismatches[0].reason}` : ''),
        { applied },
      );
    }

    const raw = await page.screenshot({ fullPage: false });

    // The overlays must STILL be there after the capture. An app that re-renders between
    // injection and screenshot can drop them mid-flight, and the resulting PNG would look
    // fine while containing the real pixels.
    const after = await page.evaluate((a) => document.querySelectorAll(`[${a}]`).length, OVERLAY_ATTR);
    if (after !== safeBoxes.length) {
      throw new RedactionError(
        `overlays disappeared during capture (${after}/${safeBoxes.length} still present) - the ` +
        `application re-rendered mid-shot, so the image cannot be trusted`,
        { after, expected: safeBoxes.length },
      );
    }

    let buf = raw;
    if (crop) {
      const meta = await sharp(raw).metadata();
      const c = {
        left: Math.max(0, Math.floor(crop.left)),
        top: Math.max(0, Math.floor(crop.top)),
        width: Math.floor(crop.width),
        height: Math.floor(crop.height),
      };
      if (c.left + c.width > meta.width || c.top + c.height > meta.height) {
        throw new RedactionError(
          `crop ${c.width}x${c.height} at ${c.left},${c.top} does not fit the ${meta.width}x${meta.height} capture`,
          { crop: c, meta },
        );
      }
      buf = await sharp(buf).extract(c).png().toBuffer();
    }
    await sharp(buf).toFile(filePath);

    const sources = {};
    for (const b of safeBoxes) sources[b.source] = (sources[b.source] || 0) + 1;
    result = {
      requested: boxes.length,
      applied: applied.attached,
      verified: after,
      boxes: after,                     // verified count, not the requested count
      cropped: !!crop,
      allowedUnredacted: allowUnredacted && boxes.length === 0,
      sources,
      exempted: discovered.exempted,
    };
  } finally {
    await removeOverlays(page, OVERLAY_ATTR);
  }
  return result;
}

module.exports = {
  findPiiBoxes, findLabeledColumnValueBoxes, redact,
  RedactionError, OVERLAY_ATTR, clampOrThrow, captureBounds,
};

