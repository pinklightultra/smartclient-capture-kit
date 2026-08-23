/**
 * probe-isc-state.js - what is actually on screen after login, per ISC.
 *
 * Written to diagnose a specific failure: three clicks in a row changed nothing, and the
 * DOM carried a "Change Password" panel, which explained it -- a modal mask swallows every
 * click aimed at the page behind it. DOM label sweeps cannot tell a drawn widget from a
 * hidden one, so ask ISC instead. It knows which widgets are drawn, visible, masked and
 * modal. Reach for this first when a click reports success and nothing happens.
 *
 * Read-only: enumerates widgets and returns geometry. Clicks nothing.
 *
 * Usage: node scripts/probe-isc-state.js --env staging
 * Writes probe/isc_state_<env>.json
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { login } = require('../lib/login');
const { installClickGuard } = require('../lib/guard');
const { resolveUrl, envLabel } = require('../lib/config');

// Read-only by construction, but the guard is armed anyway: it costs nothing and means a
// future edit that adds a click cannot quietly turn this into a writing script.
process.env.CAPTURE_READONLY = '1';
process.env.CAPTURE_NO_SUBMIT = '1';

const args = process.argv.slice(2);
const get = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const baseUrl = resolveUrl(args);
if (!baseUrl) {
  // Without this, envLabel below throws "Invalid URL" on a bare invocation, which reads
  // as a bug in the probe rather than a missing argument.
  console.error('Usage: node scripts/probe-isc-state.js --env <name> | --url <base-url>');
  process.exit(1);
}
const envName = get('--env') || envLabel(baseUrl);
// Inside the repo, and gitignored: the output enumerates a live application's widgets.
const OUT = path.join(__dirname, '..', 'probe', `isc_state_${envName}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const PROBE = `(() => {
  if (typeof isc === 'undefined') return { isc: false };
  const out = { isc: true, pageLoaded: !!(isc.Page && isc.Page.isLoaded && isc.Page.isLoaded()), widgets: [] };
  try { out.currentMask = !!(isc.Canvas && isc.Canvas.clickMaskUp && isc.Canvas.clickMaskUp()); } catch (e) { out.currentMask = 'err'; }
  const ids = Object.keys(window).filter(k => /^isc_/.test(k) && window[k]);
  out.widgetCount = ids.length;
  for (const id of ids) {
    const w = window[id];
    let cls = '';
    try { cls = w.getClassName ? w.getClassName() : ''; } catch (e) { continue; }
    if (!cls) continue;
    let drawn = false, visible = false, rect = null, title = '', modal = false;
    try { drawn = w.isDrawn ? w.isDrawn() : false; } catch (e) {}
    try { visible = w.isVisible ? w.isVisible() : false; } catch (e) {}
    try { rect = w.getPageRect ? w.getPageRect() : null; } catch (e) {}
    try { title = String(w.title || w.getTitle && w.getTitle() || '').slice(0, 60); } catch (e) {}
    try { modal = !!w.isModal; } catch (e) {}
    if (!drawn || !visible) continue;
    if (rect && (rect[2] < 8 || rect[3] < 8)) continue;
    out.widgets.push({ id, cls, title, rect, modal });
  }
  // Menus and windows are what matter for finding a route and for spotting a modal.
  out.interesting = out.widgets.filter(w => /Menu|Window|Dialog|Prompt|TabSet|ToolStrip|NavBar/.test(w.cls))
                               .map(w => ({ id: w.id, cls: w.cls, title: w.title, rect: w.rect, modal: w.modal }));
  return out;
})()`;

/** Every menu item ISC knows about, with the widget that owns it. This is how the
 *  route is found without hunting pixels: menu items carry their titles even when
 *  the menu is closed. */
const MENUS = `(() => {
  if (typeof isc === 'undefined') return [];
  const out = [];
  for (const id of Object.keys(window).filter(k => /^isc_/.test(k) && window[k])) {
    const w = window[id];
    let cls = '';
    try { cls = w.getClassName ? w.getClassName() : ''; } catch (e) { continue; }
    if (!/Menu/.test(cls)) continue;
    let items = [];
    try {
      const data = w.getData ? w.getData() : (w.data || []);
      const arr = data && data.toArray ? data.toArray() : data;
      items = (arr || []).map(it => String((it && (it.title || it.name)) || '')).filter(Boolean).slice(0, 60);
    } catch (e) {}
    let drawn = false;
    try { drawn = w.isDrawn ? w.isDrawn() : false; } catch (e) {}
    if (items.length) out.push({ id, cls, drawn, items });
  }
  return out;
})()`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  if (!(await installClickGuard(page))) {
    await browser.close();
    throw new Error('read-only guard failed to install; refusing to log in to a live environment');
  }
  const log = { env: envName, baseUrl };
  try {
    await login(page, baseUrl);
    await page.waitForTimeout(6000);
    log.state = await page.evaluate(PROBE);
    log.menus = await page.evaluate(MENUS);
    console.log(`isc=${log.state.isc} loaded=${log.state.pageLoaded} widgets=${log.state.widgetCount} drawn=${log.state.widgets.length} mask=${log.state.currentMask}`);
    console.log(`menus with items: ${log.menus.length}`);
  } catch (e) {
    log.error = e.message;
    console.error(`FAILED: ${e.message}`);
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(log, null, 1), 'utf8');
    console.log(`wrote ${OUT}`);
    await browser.close();
  }
})();
