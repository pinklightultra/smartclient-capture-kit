#!/usr/bin/env node
/**
 * repl.js -- iterate against one live, authenticated browser.
 *
 * WHY: a cold launch plus a login round-trip costs 15-20 seconds (see lib/session.js), and
 * you pay it on every run. Writing a selector or a navigation path takes ten or twenty
 * attempts, so most of the time spent building a capture module is spent logging in. This
 * holds ONE authenticated context open in a REPL: log in once, then re-run your logic against
 * the live session as many times as you like, reloading your own modules from disk in between.
 *
 * USAGE:
 *   node repl.js --env <environment>      # from capture.config.json
 *   node repl.js --url https://host       # ad hoc, no config entry needed
 *   node repl.js --env staging --headless
 *   node repl.js --list-envs              # what is configured
 *   CAPTURE_READONLY=1 node repl.js --env staging     # no-submit click guard (recommended)
 *
 * Credentials come from --user/--pass, CAPTURE_USER/CAPTURE_PASS, or .env, exactly as in
 * run-modules.js. They are optional only when a saved session already exists for the host.
 *
 * IN THE REPL (top-level await is enabled):
 *   page                 - the live authenticated Playwright Page
 *   context, browser     - its context, and the browser
 *   reload('./lib/nav')  - drop the require cache and re-require, after you edit a module
 *   nav, isc, iscNav, redact, guard, session, config   - preloaded
 *   shot('name')         - screenshot to ./repl-shots/name.png
 *   await relogin()      - discard the session and log in fresh; rebinds page and context
 *   .exit                - quit, closing the browser
 *
 * The guard is off unless you ask for it. On a shared or production-adjacent environment,
 * ask for it: an exploratory REPL is exactly where a stray click lands on Save.
 */
const path = require('path');
const fs = require('fs');
const repl = require('repl');
const { chromium } = require('playwright');

const session = require('./lib/session');
const config = require('./lib/config');
const guard = require('./lib/guard');

// Flags are a raw argv array, matching run-modules.js and every script under scripts/.
// lib/config's resolvers call args.indexOf, so an options object parsed from --key=value
// would fail there rather than here, several frames away from the mistake.
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has('--list-envs')) {
  config.listEnvironments();
  process.exit(0);
}

// resolveUrl returns null when neither --url nor --env was given. There is no default
// environment: capture.config.json ships `environments: {}`, because the hosts are yours.
// Catching that here matters because the alternative is `new URL(null)` throwing an opaque
// TypeError from inside lib/session.js, several frames from the actual mistake.
const BASE = config.resolveUrl(args);
if (!BASE) {
  console.error('Usage: node repl.js --env <environment> [--headless]');
  console.error('       node repl.js --url <base-url> [--headless]');
  console.error('       node repl.js --list-envs');
  process.exit(1);
}

// A saved session means we may never touch the login form, so credentials are optional --
// but only in that case, and the distinction is worth being precise about rather than
// swallowing a failure into `undefined`. Note that saved state is not the same as VALID
// saved state: getAuthedPage checks the cookies and falls through to a real login if they
// have expired, which is the path that needs creds we would not have.
const hasSavedSession = fs.existsSync(session.stateFile(BASE));
const creds = config.resolveCreds(args, { optional: hasSavedSession });

const HEADLESS = has('--headless');
const SHOT_DIR = path.join(__dirname, 'repl-shots');

async function main() {
  console.log(`[repl] base url: ${BASE}`);
  console.log(`[repl] guard: ${guard.guardEnabled() ? 'ON (no-submit)' : 'off -- set CAPTURE_READONLY=1 to enable'}`);
  if (hasSavedSession && !creds) {
    console.log('[repl] resuming the saved session. No credentials are available, so if those');
    console.log('[repl] cookies have expired, lib/login.js will stop and ask for them.');
  }
  console.log(`[repl] launching ${HEADLESS ? 'headless' : 'headed'} browser and priming session...`);

  const browser = await chromium.launch({ headless: HEADLESS });
  let { context, page, reused } = await session.getAuthedPage(browser, BASE, creds);
  console.log(`[repl] session ${reused ? 'REUSED (no login)' : 'freshly logged in'}. page is live.`);

  if (guard.guardEnabled()) await guard.installClickGuard(page);

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  /** Drop a module from the require cache and re-require it, so edits take effect. */
  function reload(mod) {
    delete require.cache[require.resolve(mod)];
    const m = require(mod);
    console.log(`[repl] reloaded ${mod}`);
    return m;
  }

  /**
   * Raw screenshot, for looking at what you just did. This is NOT safeShot: nothing is
   * redacted, so anything on screen is on disk. That is the right default for an exploration
   * aid -- you want to see the real page -- but it means repl-shots/ holds unredacted pictures
   * of a live application, which is why .gitignore blocks it and why the reminder below is
   * printed rather than left in a comment. Use safeShot for anything you intend to keep.
   */
  async function shot(name = 'shot') {
    const file = path.join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`[repl] wrote ${file} (NOT redacted -- use safeShot for anything you keep)`);
    return file;
  }

  let r; // assigned below; relogin needs to rebind the names it exposes

  /**
   * Throw away the current session and log in again, then rebind `page` and `context` in the
   * REPL. Re-priming alone is not enough and it is a trap worth naming: it writes fresh cookies
   * to disk while your live `page` keeps its old, dead context, so the browser in front of you
   * is still logged out and the console said "done".
   */
  async function relogin() {
    if (!creds) {
      console.error('[repl] cannot log in again: no credentials. Pass --user/--pass, or set');
      console.error('[repl] CAPTURE_USER / CAPTURE_PASS, and start the REPL again.');
      return null;
    }
    await context.close();
    fs.rmSync(session.stateFile(BASE), { force: true }); // force a real login, not a reuse
    const fresh = await session.getAuthedPage(browser, BASE, creds);
    ({ context, page } = fresh);
    if (guard.guardEnabled()) await guard.installClickGuard(page);
    Object.assign(r.context, { context, page });
    console.log('[repl] logged in fresh; `page` and `context` now point at the new session.');
    return page;
  }

  r = repl.start({ prompt: 'capture> ' });
  Object.assign(r.context, {
    browser, context, page,
    session, config, guard,
    nav: require('./lib/nav'),
    isc: require('./lib/isc'),
    iscNav: require('./lib/isc-nav'),
    redact: require('./lib/redact'),
    reload, shot, relogin, BASE, creds,
  });

  r.on('exit', async () => {
    console.log('\n[repl] closing browser...');
    // A close that fails leaves a headed Chromium and its profile lock behind, which makes the
    // NEXT run fail in a way that looks unrelated. Say so instead of exiting 0 over the top.
    try {
      await browser.close();
      process.exit(0);
    } catch (e) {
      console.error(`[repl] browser did not close cleanly: ${e.message}`);
      console.error('[repl] a Chromium process may still be running; kill it before the next run.');
      process.exit(1);
    }
  });
}

main().catch((e) => { console.error('[repl] fatal:', e); process.exit(1); });
