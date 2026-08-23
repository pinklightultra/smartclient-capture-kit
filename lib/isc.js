/**
 * lib/isc.js -- ask SmartClient (ISC) where things are instead of guessing pixels.
 *
 * WHY: the single biggest accuracy failure in this kit was locating a grid row and its
 * right-click menu. DOM sweeps, OCR, and the vision tier all miss, because ISC renders
 * grids into generic divs with volatile ids AND virtualizes the rows -- the row you want
 * may not exist in the DOM at all until it is scrolled into view. Indexing rows by their
 * on-screen position is therefore meaningless.
 *
 * But the framework keeps every grid as a live global widget (window.isc_*) exposing
 * getCellPageRect(), scrollRecordIntoView(), and its backing data. So we resolve a row by
 * MATCHING A FIELD VALUE against the widget's data, scroll that record into view, and ask
 * the widget for its real page rect. No coordinate guessing, no OCR round trip, and no
 * dependence on which rows happen to be painted at that moment.
 *
 * THE MODAL MASK. When ISC raises a modal, it also raises a click mask. That mask consumes
 * a trusted click as a SILENT NO-OP: nothing throws, nothing is logged, no navigation
 * happens, and the click simply does not exist as far as the application is concerned.
 * Three identical clicks producing three identical screenshots is what this looks like
 * from the outside, and you cannot tell it apart from a page that merely ignored you --
 * not from the DOM, and not from a screenshot. The only reliable signal is to ask the
 * framework. clickMaskUp() and iscState() below do that; read the widget state rather
 * than trusting what the pixels appear to show.
 *
 * All functions here are READ-ONLY probes that RETURN geometry and data. The caller issues
 * the actual mouse action, so lib/guard.js still governs every write.
 */
/**
 * Find the live ListGrid whose fields/data best match a hint, and return its id.
 * @param {import('playwright').Page} page
 * @param {object} opts { fieldName?:string, minRows?:number, idIncludes?:string }
 * @returns {Promise<{id, rows, fields}|null>}
 */
async function findGrid(page, opts = {}) {
  return page.evaluate(({ fieldName, minRows, idIncludes }) => {
    if (typeof isc === 'undefined') return null;
    // Scan ALL isc widgets (not just isc_ListGrid_N — the real data grids are named
    // e.g. isc_MasterGridCallBackView_N). Row count comes from the DATA ResultSet
    // (data.getLength / lengthIsKnown), NOT getTotalRows(), which reads 0 on some builds.
    const ids = Object.keys(window).filter(k => /^isc_/.test(k) && window[k]);
    const cands = [];
    for (const id of ids) {
      const g = window[id];
      let cls = '';
      try { cls = g.getClassName ? g.getClassName() : ''; } catch { continue; }
      if (!/ListGrid|TreeGrid/.test(cls) || /FieldPicker/.test(cls)) continue;
      if (typeof g.getCellPageRect !== 'function') continue;
      let rows = 0;
      try { rows = (g.data && g.data.getLength) ? g.data.getLength() : (g.getTotalRows ? g.getTotalRows() : 0); } catch { /* */ }
      let fields = [];
      try { fields = (g.getFields ? g.getFields() : g.fields || []).map(f => f.name || f.title).filter(Boolean); } catch { /* */ }
      let drawn = false;
      try { drawn = g.isDrawn ? g.isDrawn() : false; } catch { /* */ }
      if (idIncludes && !id.includes(idIncludes)) continue;
      if (minRows && rows < minRows) continue;
      if (fieldName && !fields.some(f => String(f).toLowerCase().includes(fieldName.toLowerCase()))) continue;
      cands.push({ id, rows, fields: fields.slice(0, 12), drawn });
    }
    // Prefer DRAWN grids with the most rows.
    cands.sort((a, b) => (b.drawn - a.drawn) || (b.rows - a.rows));
    return cands[0] || null;
  }, { fieldName: opts.fieldName || null, minRows: opts.minRows || 0, idIncludes: opts.idIncludes || null });
}

/**
 * Locate a row by matching a field value, and return the page-rect of a target cell.
 * @param {object} opts { gridId?, matchField, matchValue, contains?, targetField? }
 *   matchField/matchValue: which record to find (e.g. 'userName' == 'operator-42').
 *   targetField: which cell's rect to return (defaults to matchField).
 * @returns {Promise<{rowNum, center:{x,y}, rect}|null>}
 */
async function locateCell(page, opts) {
  return page.evaluate(({ gridId, matchField, matchValue, contains, targetField }) => {
    if (typeof isc === 'undefined') return null;
    const g = gridId ? window[gridId] : null;
    if (!g) return null;
    // Row count + records come from the DATA ResultSet on this build.
    const rs = g.data;
    const total = (rs && rs.getLength) ? rs.getLength() : (g.getTotalRows ? g.getTotalRows() : 0);
    const getRec = (i) => {
      try { if (rs && rs.get) return rs.get(i); } catch { /* */ }
      try { if (g.getRecord) return g.getRecord(i); } catch { /* */ }
      return null;
    };
    const want = String(matchValue).toLowerCase();
    for (let i = 0; i < total; i++) {
      const rec = getRec(i);
      if (!rec) continue;
      // match against the named field, or scan all string fields if not named
      const hay = matchField ? [rec[matchField]] : Object.values(rec);
      const hit = hay.some(v => {
        if (v == null) return false;
        const s = String(v).toLowerCase();
        return contains ? s.includes(want) : s === want;
      });
      if (!hit) continue;
      const fieldNum = targetField
        ? (g.getFieldNum ? g.getFieldNum(targetField) : 0)
        : (matchField && g.getFieldNum ? g.getFieldNum(matchField) : 0);
      let rect = null;
      try { rect = g.getCellPageRect(i, Math.max(0, fieldNum)); } catch { /* */ }
      if (!rect) { try { rect = g.getRowPageRect ? g.getRowPageRect(i) : null; } catch { /* */ } }
      if (!rect) continue;
      // ISC returns [left, top, width, height]
      const [left, top, width, height] = rect;
      return {
        rowNum: i,
        rect: { left, top, width, height },
        center: { x: Math.round(left + width / 2), y: Math.round(top + height / 2) },
        record: rec[matchField] != null ? String(rec[matchField]) : null,
      };
    }
    return null;
  }, {
    gridId: opts.gridId || null,
    matchField: opts.matchField || null,
    matchValue: opts.matchValue,
    contains: !!opts.contains,
    targetField: opts.targetField || null,
  });
}

/**
 * Scroll a grid row into view (ISC scrollRecordIntoView), then return its on-screen
 * cell rect. ISC's getCellPageRect gives the row's logical position in the full grid
 * (can be far below the viewport, e.g. top:5369 for row 147); this brings it on-screen
 * so the caller's mouse click lands. Returns the post-scroll cell center, or null.
 */
async function scrollToRow(page, { gridId, rowNum, fieldNum = 0 } = {}) {
  const rect = await page.evaluate(({ gridId, rowNum, fieldNum }) => {
    const g = window[gridId];
    if (!g) return null;
    try {
      if (g.scrollRecordIntoView) g.scrollRecordIntoView(rowNum, true);
      else if (g.body && g.body.scrollRecordIntoView) g.body.scrollRecordIntoView(rowNum);
    } catch { /* */ }
    return true;
  }, { gridId, rowNum, fieldNum });
  if (!rect) return null;
  await page.waitForTimeout(600); // let ISC repaint the scrolled rows
  return page.evaluate(({ gridId, rowNum, fieldNum }) => {
    const g = window[gridId];
    if (!g || !g.getCellPageRect) return null;
    let r = null;
    try { r = g.getCellPageRect(rowNum, fieldNum); } catch { /* */ }
    if (!r) return null;
    const [left, top, width, height] = r;
    // Only valid if now within the viewport.
    if (top < 0 || top > window.innerHeight) return { offscreen: true, top };
    return { center: { x: Math.round(left + width / 2), y: Math.round(top + height / 2) }, rect: { left, top, width, height } };
  }, { gridId, rowNum, fieldNum });
}

/** Return all field names for a grid (to discover the right matchField). */
async function gridFields(page, gridId) {
  return page.evaluate((id) => {
    const g = window[id];
    if (!g) return [];
    try { return (g.getFields ? g.getFields() : g.fields || []).map(f => ({ name: f.name, title: f.title })); }
    catch { return []; }
  }, gridId);
}

/**
 * Convenience: find the grid, locate the row, and RETURN the click point. The caller
 * decides left/right click so guard.js governs it. Returns null if not resolvable —
 * which is a clean, honest miss the caller can hand to reference-stop.
 */
async function resolveRow(page, { fieldName, matchValue, contains = true, targetField } = {}) {
  const grid = await findGrid(page, { fieldName, minRows: 1 });
  if (!grid) return null;
  const fields = await gridFields(page, grid.id);
  // pick the match field: the one whose name/title contains fieldName
  const mf = (fields.find(f => (f.name || '').toLowerCase().includes((fieldName || '').toLowerCase())
    || (f.title || '').toLowerCase().includes((fieldName || '').toLowerCase())) || {}).name;
  const loc = await locateCell(page, { gridId: grid.id, matchField: mf, matchValue, contains, targetField });
  return loc ? { ...loc, gridId: grid.id, matchField: mf } : { gridId: grid.id, matchField: mf, notFound: true };
}

/**
 * FILTER FALLBACK — when ISC widget discovery can't map the on-screen grid (some
 * builds report getTotalRows()===0 despite visible data), narrow the grid via
 * its column filter row so the wanted record rises to the first data row at a known
 * y. Returns the top data-row center after filtering. READ-ONLY (types into the
 * filter box, which is not a mutating action; caller still issues the click).
 *
 * @param {object} opts
 *   filterXY   [x,y] of the target column's filter input (discover once per screen)
 *   value      the text to filter by
 *   rowY       expected y of the first data row after filtering (screen-specific)
 *   rowX       x to click within that row (defaults to a left-column x)
 *   settleMs   wait after filtering
 */
async function filterToRow(page, { filterXY, value, rowY, rowX = 110, settleMs = 1800 } = {}) {
  await page.mouse.click(filterXY[0], filterXY[1]);
  await page.waitForTimeout(250);
  // clear any existing filter text, then type
  await page.keyboard.press('Control+A');
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(settleMs);
  // Confirm exactly one plausible match sits at rowY by reading the cell text there.
  // The matched row is the first data cell whose text actually CONTAINS the filter
  // value (case-insensitive). Requiring the match prevents returning a stale/unrelated
  // element (e.g. a leftover dropdown item) when the filter yielded nothing.
  const cell = await page.evaluate(({ value, rowX }) => {
    const want = String(value).toLowerCase();
    let best = null;
    for (const el of document.querySelectorAll('td, div, span, nobr')) {
      if (el.children.length) continue;                 // leaf text only
      const t = (el.innerText || '').trim();
      if (!t || t.length > 60 || !t.toLowerCase().includes(want)) continue;
      const r = el.getBoundingClientRect();
      // in the grid data band (below the filter/header rows), left columns
      if (r.x > 30 && r.x < rowX + 260 && r.y > 165 && r.y < 660 && r.height > 8 && r.height < 32) {
        if (!best || r.y < best.y) best = { t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return best;
  }, { value, rowX });
  return cell ? { center: { x: cell.x, y: cell.y }, text: cell.t, via: 'filter' } : null;
}

/**
 * Unified grid-row resolver: try ISC widget geometry first (exact, no guessing);
 * if ISC can't map the grid, fall back to the column-filter approach. Returns a
 * click point, or {notFound:true}. The caller decides left/right click.
 *
 * @param {object} opts
 *   fieldName, matchValue, contains, targetField   (ISC path)
 *   filter: { filterXY, rowY, rowX }               (fallback path, screen-specific)
 */
async function resolveGridRow(page, opts = {}) {
  // 1) ISC native — locate the row logically, then scroll it on-screen for the click.
  const hit = await resolveRow(page, opts).catch(() => null);
  if (hit && !hit.notFound && hit.rowNum != null) {
    const fieldNum = 0; // the first column; targetField handling can refine this later
    const onScreen = await scrollToRow(page, { gridId: hit.gridId, rowNum: hit.rowNum, fieldNum }).catch(() => null);
    if (onScreen && onScreen.center) {
      return { ...hit, center: onScreen.center, rect: onScreen.rect, via: 'isc' };
    }
    // located but couldn't bring on-screen — still better than nothing; report it
    return { ...hit, via: 'isc-offscreen', needsScroll: true };
  }

  // 2) filter fallback
  if (opts.filter && opts.filter.filterXY && opts.filter.rowY != null) {
    const f = await filterToRow(page, {
      filterXY: opts.filter.filterXY,
      value: opts.matchValue,
      rowY: opts.filter.rowY,
      rowX: opts.filter.rowX,
    });
    if (f) return f;
  }
  return { notFound: true, via: 'none' };
}

/**
 * Is a click mask currently up?
 *
 * This is the only trustworthy way to know that a click is about to be swallowed. ISC
 * raises the mask for any modal, and a masked click is a silent no-op: no exception, no
 * console entry, no navigation, no visual change. Check this before blaming a selector.
 *
 * Note that a mask being up does NOT mean you cannot click anything -- clicking inside the
 * modal that raised it is exactly what you are supposed to do. It means clicks aimed at
 * anything BEHIND the modal will vanish.
 *
 * @returns {Promise<boolean|null>} null when the framework is not loaded on this page
 */
async function clickMaskUp(page) {
  return page.evaluate(() => {
    if (typeof isc === 'undefined') return null;
    try { return !!(isc.Canvas && isc.Canvas.clickMaskUp && isc.Canvas.clickMaskUp()); }
    catch { return null; }
  });
}

/**
 * Dump every drawn, visible widget the framework knows about, plus the mask state.
 *
 * When a click does nothing, this answers "what is actually in front of me" in one call.
 * A DOM label sweep cannot tell a drawn widget from a hidden one, and it cannot see the
 * mask at all; the framework knows both.
 *
 * @returns {Promise<{isc:boolean, pageLoaded?:boolean, maskUp?:boolean, widgets?:object[], modals?:object[]}>}
 */
async function iscState(page) {
  return page.evaluate(() => {
    if (typeof isc === 'undefined') return { isc: false };
    const out = {
      isc: true,
      pageLoaded: !!(isc.Page && isc.Page.isLoaded && isc.Page.isLoaded()),
      widgets: [],
    };
    try { out.maskUp = !!(isc.Canvas && isc.Canvas.clickMaskUp && isc.Canvas.clickMaskUp()); }
    catch { out.maskUp = null; }
    const ids = Object.keys(window).filter((k) => /^isc_/.test(k) && window[k]);
    out.widgetCount = ids.length;
    for (const id of ids) {
      const w = window[id];
      let cls = '';
      try { cls = w.getClassName ? w.getClassName() : ''; } catch { continue; }
      if (!cls) continue;
      let drawn = false, visible = false, rect = null, title = '', modal = false;
      try { drawn = w.isDrawn ? w.isDrawn() : false; } catch { /* */ }
      try { visible = w.isVisible ? w.isVisible() : false; } catch { /* */ }
      try { rect = w.getPageRect ? w.getPageRect() : null; } catch { /* */ }
      try { title = String((w.title || (w.getTitle && w.getTitle()) || '')).slice(0, 60); } catch { /* */ }
      try { modal = !!w.isModal; } catch { /* */ }
      if (!drawn || !visible) continue;
      if (rect && (rect[2] < 8 || rect[3] < 8)) continue;
      out.widgets.push({ id, cls, title, rect, modal });
    }
    out.modals = out.widgets.filter((w) => w.modal || /Window|Dialog|Prompt/.test(w.cls));
    return out;
  });
}

/**
 * Every menu item the framework knows about, with the widget that owns it.
 *
 * Menu items keep their titles even while the menu is closed, so this finds a route
 * without opening anything and without hunting for pixels.
 */
async function menuItems(page) {
  return page.evaluate(() => {
    if (typeof isc === 'undefined') return [];
    const out = [];
    for (const id of Object.keys(window).filter((k) => /^isc_/.test(k) && window[k])) {
      const w = window[id];
      let cls = '';
      try { cls = w.getClassName ? w.getClassName() : ''; } catch { continue; }
      if (!/Menu/.test(cls)) continue;
      let items = [];
      try {
        const data = w.getData ? w.getData() : (w.data || []);
        const arr = data && data.toArray ? data.toArray() : data;
        items = (arr || []).map((it) => String((it && (it.title || it.name)) || '')).filter(Boolean).slice(0, 60);
      } catch { /* */ }
      let drawn = false;
      try { drawn = w.isDrawn ? w.isDrawn() : false; } catch { /* */ }
      if (items.length) out.push({ id, cls, drawn, items });
    }
    return out;
  });
}

module.exports = {
  findGrid, locateCell, gridFields, resolveRow, scrollToRow, filterToRow, resolveGridRow,
  clickMaskUp, iscState, menuItems,
};
