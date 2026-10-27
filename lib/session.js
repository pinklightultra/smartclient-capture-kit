/**
 * lib/session.js - log in ONCE, reuse the authenticated session across many runs.
 *
 * WHY: every capture cold-launches a browser and does a full form login (~15-20s). Over a
 * few hundred items that is hours of pure login. The auth is cookie-based, so we save
 * Playwright's storageState after one login and replay it - subsequent contexts land
 * already-authenticated. Falls back to a fresh login when the saved state is missing or
 * stale (i.e. the app bounced us back to the login form).
 *
 * The state file holds LIVE SESSION COOKIES. Treat it exactly like a password: it lives
 * under .auth/, which .gitignore blocks, and is keyed per environment host.
 */
const fs = require('fs');
const path = require('path');
const { login, dismissOverlay, appUrl } = require('./login');
const { config } = require('./config');

const AUTH_DIR = path.join(__dirname, '..', '.auth');

function viewport() {
  return config().viewport || { width: 1440, height: 900 };
}

function loginPathFragment() {
  return (config().app || {}).loginPath || '/';
}

function stateFile(baseUrl) {
  const host = new URL(baseUrl).hostname.replace(/\W+/g, '_');
  return path.join(AUTH_DIR, `${host}.json`);
}

/** True if we appear to be on an authenticated app page rather than the login form. */
async function isAuthenticated(page) {
  try {
    if (new URL(page.url()).pathname.startsWith(loginPathFragment())) return false;
    return await page.evaluate(
      () => typeof window.isc !== 'undefined' && window.isc.Page && window.isc.Page.isLoaded(),
    );
  } catch {
    return false;
  }
}

/**
 * Establish auth once and persist it. Opens a context, logs in via the form, saves
 * storageState. Call this a single time before a batch (or let getContext do it lazily).
 * @returns {Promise<string>} path to the saved state file
 */
async function primeSession(browser, baseUrl, creds) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const ctx = await browser.newContext({ viewport: viewport(), ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await login(page, baseUrl, creds);
  const file = stateFile(baseUrl);
  await ctx.storageState({ path: file });
  await ctx.close();
  return file;
}

/**
 * Get an authenticated context+page, reusing the saved session if valid.
 * Re-primes automatically if the saved state is absent or has expired.
 * @returns {Promise<{context, page, reused:boolean}>}
 */
async function getAuthedPage(browser, baseUrl, creds, opts = {}) {
  const file = stateFile(baseUrl);
  const haveState = fs.existsSync(file);

  if (haveState) {
    const ctx = await browser.newContext({
      viewport: viewport(),
      ignoreHTTPSErrors: true,
      storageState: file,
    });
    const page = await ctx.newPage();
    // Navigate to the app and check we're really in (cookies may have expired).
    await page.goto(appUrl(baseUrl), { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (await isAuthenticated(page)) {
      await dismissOverlay(page);
      return { context: ctx, page, reused: true };
    }
    await ctx.close(); // stale - fall through to re-prime
  }

  // No/stale state: log in fresh, save, and return that context.
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const ctx = await browser.newContext({ viewport: viewport(), ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await login(page, baseUrl, creds);
  await ctx.storageState({ path: file });
  return { context: ctx, page, reused: false };
}

module.exports = { primeSession, getAuthedPage, isAuthenticated, stateFile, AUTH_DIR };

