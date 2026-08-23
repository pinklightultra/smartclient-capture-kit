/**
 * Example screen script for runner.js.
 *
 *   node runner.js --url https://staging.example.com --script scripts/example-screens.js
 *
 * THE CONTRACT: a screen script exports one async function. runner.js calls it with
 * { page, baseUrl, screenshotDir, screenshot } and closes the browser afterwards.
 *
 *   page           a Playwright Page, with the read-only click guard already installed
 *   baseUrl        whatever was passed to --url
 *   screenshotDir  <out>/<env-label>/<YYYY-MM-DD>, already created
 *   screenshot     async (page, name) => void. USE THIS. Do not call page.screenshot().
 *
 * `screenshot` is runner.js's wrapper around safeShot(), which applies and VERIFIES
 * redaction before the PNG exists. A raw page.screenshot() writes an unredacted picture of
 * a live application, and nothing downstream will catch it. That is not a hypothetical: the
 * redaction front door in this kit was imported by nothing for its entire history, and
 * every capture taken through the documented entry point was unredacted while the README
 * said otherwise.
 *
 * runner.js does NOT log in for you. It installs the guard and hands you a blank page, so a
 * script can target a public page, an already-authenticated CDP session, or log in itself
 * as this one does.
 *
 * Copy this file, rename it, and edit the walkthrough. It is deliberately short: the useful
 * parts of this kit are the helpers it calls, not this file.
 */

const { login, dismissOverlay } = require('../lib/login');
const { waitForIsc, clickLabel } = require('../lib/nav');

module.exports = async function exampleScreens({ page, baseUrl, screenshot }) {
  // Credentials come from .env or the environment via lib/config's resolveCreds. Passing no
  // creds object is the normal case; setup.js writes the .env this reads.
  await login(page, baseUrl);
  await waitForIsc(page, { budget: 30000, settle: 1200 });
  await dismissOverlay(page);

  await screenshot(page, 'landing');

  // clickLabel resolves a visible text label to pixel coordinates and clicks with
  // page.mouse, because SmartClient renders most controls into generic divs with volatile
  // generated IDs. A y-band disambiguates a label that appears more than once.
  //
  // It returns {ok:false, via:'blocked-readonly'} rather than throwing when the label looks
  // like a mutating control (Save, Submit, Delete and friends). A walkthrough that needs to
  // handle that case should check `ok`, not assume the click landed.
  const opened = await clickLabel(page, 'Menu', { ymin: 0, ymax: 80 });
  if (!opened.ok) {
    // A missing label is a fact about the environment, not necessarily a failure. Say so
    // and carry on; the landing capture above is still worth having.
    console.log(`  skipped: "Menu" did not resolve (${opened.via})`);
    return;
  }
  await page.waitForTimeout(1200);
  await screenshot(page, 'menu-open');

  // safeShot ABORTS instead of writing a file when a column named in
  // redaction.columnLabels is visible but its values cannot be located. Let that throw. A
  // run that stops with no PNG is recoverable; a run that produces a clean-looking
  // unredacted PNG is not.
};
