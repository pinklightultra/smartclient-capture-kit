/**
 * lib/guard.js - read-only click guard for captures against a shared environment.
 *
 * WHY: these captures often run against an environment other people are using. A
 * mutating click - Save, Submit, Confirm, Apply, Delete - is not a bug you can undo by
 * re-running. A capture-phase DOM listener intercepts any click landing on a forbidden
 * control and cancels it BEFORE the application's own handler sees it.
 *
 * Armed by default. Set CAPTURE_ALLOW_WRITES=1 to disable it deliberately.
 *
 * WHY A DOM CAPTURE LISTENER (not wrapping the Playwright calls): clicks reach the app by
 * many paths - page.mouse.click(x,y), locator.click(), page.click(), even a stray real
 * click from a human watching a headed run. All of them dispatch genuine
 * pointerdown/mousedown/click DOM events. One capture-phase listener at the document
 * level catches every path uniformly and can preventDefault + stopImmediatePropagation
 * before the SmartClient handler runs. Wrapping the Node-side API would have missed the
 * coordinate paths, which are exactly the ones this kit relies on most.
 *
 * The guard is installed via addInitScript (survives navigations) AND applied to the
 * current document immediately. Blocked attempts are recorded on window.__captureBlocked
 * and mirrored to the Node console via an exposed binding.
 */

const { config } = require('./config');

const DEFAULT_FORBIDDEN = ['Save', 'Submit', 'Confirm', 'Apply', 'Delete', 'Remove', 'Upload'];

/** Forbidden terms from capture.config.json, falling back to the built-in list. */
function forbiddenTerms() {
  const configured = (config().guard || {}).forbiddenTerms;
  return Array.isArray(configured) && configured.length ? configured : DEFAULT_FORBIDDEN;
}

/**
 * True unless writes have been explicitly allowed.
 *
 * The guard is armed by DEFAULT and has to be switched off deliberately with
 * CAPTURE_ALLOW_WRITES=1. It was originally opt-in via CAPTURE_READONLY=1, which meant the
 * protection was absent in exactly the case it was written for: someone running the kit for
 * the first time, against a shared environment, without having read this file. Forgetting a
 * variable should cost you a blocked click, not a saved record.
 *
 * CAPTURE_READONLY=1 / CAPTURE_NO_SUBMIT=1 are honoured, and they WIN over
 * CAPTURE_ALLOW_WRITES. Six places set them on purpose -- setup.js, scripts/smoke-test.js,
 * scripts/probe-isc-state.js, scripts/bench-interaction.js, and the child environments in
 * lib/agent-handoff.js:153 and lib/resolvers.js:275 -- and every one of them is asking for
 * the guard, never for permission to write. Resolving the conflict toward "armed" is the
 * only direction that cannot surprise a caller: the worst case is a blocked click in a
 * process that wanted to write, which is loud, versus a saved record in a process that
 * asked to be read-only, which is not.
 *
 * Until this line was written they were dead variables: guardEnabled() read
 * CAPTURE_ALLOW_WRITES alone, so an agent-handoff child that set CAPTURE_READONLY=1 and
 * inherited CAPTURE_ALLOW_WRITES=1 from its parent ran unguarded.
 */
function guardEnabled() {
  if (process.env.CAPTURE_READONLY === '1' || process.env.CAPTURE_NO_SUBMIT === '1') return true;
  return process.env.CAPTURE_ALLOW_WRITES !== '1';
}

/**
 * The in-page guard. Serialized and injected. Kept dependency-free.
 * Cancels clicks whose target (or nearest button/anchor/labelled ancestor) has text
 * or a value/label matching a forbidden term (word-boundary, case-insensitive).
 */
function pageGuardSource(forbidden, authOpts = {}) {
  const authPath = authOpts.authPathFragment || '/cas/';
  const authSelector = authOpts.authSelector || '#username,#password';
  return `(() => {
    if (window.__captureGuardInstalled) return;
    window.__captureGuardInstalled = true;
    window.__captureBlocked = window.__captureBlocked || [];
    const TERMS = ${JSON.stringify(forbidden)};
    const rx = new RegExp('(^|\\\\b)(' + TERMS.join('|') + ')(\\\\b|$)', 'i');
    // The login form's submit is allowed - it is authentication, not an in-app mutation.
    const AUTH_PATH = ${JSON.stringify(authPath)};
    const AUTH_SELECTOR = ${JSON.stringify(authSelector)};
    const isAuthField = (el) => {
      const t = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
      const onAuthPage = location.pathname.indexOf(AUTH_PATH) !== -1 || !!document.querySelector(AUTH_SELECTOR);
      return onAuthPage && (t === 'submit' || t === 'password' || t === 'text');
    };
    const label = (el) => {
      if (!el) return '';
      const v = el.value || el.getAttribute?.('aria-label') || el.title || '';
      const txt = (el.innerText || el.textContent || '').trim();
      // A big container's innerText can contain "Save" incidentally; only trust it for
      // compact controls (buttons, small cells) to avoid over-blocking whole panels.
      const small = (el.offsetWidth || 0) < 260 && (el.offsetHeight || 0) < 80;
      return (v + ' ' + (small ? txt : '')).trim();
    };
    const forbiddenTarget = (start) => {
      let el = start, hops = 0;
      while (el && hops < 5) {
        if (isAuthField(el)) return null;
        const role = (el.getAttribute && el.getAttribute('role')) || '';
        const tag = (el.tagName || '').toLowerCase();
        const clickable = tag === 'button' || tag === 'a' || role === 'button' ||
          (el.className && /button|Button|btn/.test(el.className)) || tag === 'td' || tag === 'span' || tag === 'div';
        if (clickable && rx.test(label(el))) return el;
        el = el.parentElement; hops++;
      }
      return null;
    };
    const block = (e) => {
      const hit = forbiddenTarget(e.target);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const rec = { term: (label(hit).match(rx) || [])[0], text: label(hit).slice(0, 60), type: e.type, at: Date.now() };
      window.__captureBlocked.push(rec);
      try { window.__captureOnBlock && window.__captureOnBlock(JSON.stringify(rec)); } catch (_) {}
    };
    // Capture phase = we run before the app's bubble-phase handlers.
    for (const ev of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(ev, block, true);
    }
  })();`;
}

/**
 * Install the guard on a page. No-op unless guardEnabled().
 * @param {import('playwright').Page} page
 * @param {object} opts {forbidden:string[], onBlock:(rec)=>void}
 * @returns {Promise<boolean>} whether the guard was installed
 */
async function installClickGuard(page, opts = {}) {
  if (!guardEnabled()) return false;
  const forbidden = opts.forbidden || forbiddenTerms();
  const app = config().app || {};
  const onBlock = opts.onBlock || ((rec) => {
    console.warn(`  [read-only guard] blocked ${rec.type} on "${rec.text}" (matched "${rec.term}")`);
  });
  const src = pageGuardSource(forbidden, {
    authPathFragment: app.authPathFragment,
    authSelector: [app.usernameSelector, app.passwordSelector].filter(Boolean).join(','),
  });
  // Node-side sink for in-page blocks. Bind once per page.
  try {
    await page.exposeFunction('__captureOnBlock', (json) => {
      try { onBlock(JSON.parse(json)); } catch { /* ignore */ }
    });
  } catch { /* already bound (re-install) - ignore */ }
  await page.addInitScript(src);          // survives navigations
  try { await page.evaluate(src); } catch { /* pre-navigation blank page - initScript covers it */ }
  return true;
}

/** Node-side pre-click check used by nav.clickLabel as a second layer. */
function isForbiddenLabel(label, forbidden = null) {
  if (!guardEnabled() || !label) return false;
  const terms = forbidden || forbiddenTerms();
  const rx = new RegExp('(^|\\b)(' + terms.join('|') + ')(\\b|$)', 'i');
  return rx.test(String(label));
}

module.exports = {
  installClickGuard, guardEnabled, isForbiddenLabel, forbiddenTerms,
  DEFAULT_FORBIDDEN, pageGuardSource,
};

