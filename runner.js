#!/usr/bin/env node
/**
 * Single-script screenshot runner.
 * Usage: node runner.js --url https://staging.example.com --script scripts/example-screens.js
 *
 * For the module-based runner (prerequisites, named routes) see run-modules.js.
 *
 * --url      Base URL of the environment to target
 * --script   Path to a screen script file. See scripts/example-screens.js, which
 *            documents the contract: export one async function, called with
 *            { page, baseUrl, screenshotDir, screenshot }.
 * --out      Output folder for screenshots (default: `capture.outputDir`, itself
 *            defaulting to ./screenshots). Captures are filed under <out>/<env>/<date>.
 * --headed   Run in headed mode for debugging
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { installClickGuard } = require('./lib/guard');
const { config, resolvePath, envLabel } = require('./lib/config');
const { safeShot } = require('./lib/capture-safe');

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const baseUrl = get('--url');
const scriptPath = get('--script');
// Falls back to `capture.outputDir` before the built-in default, so the config key means
// something here too. See the note in run-modules.js.
const outDir = get('--out') || resolvePath((config().capture || {}).outputDir || 'screenshots');
const headed = has('--headed');

if (!baseUrl || !scriptPath) {
  console.error('Usage: node runner.js --url <base-url> --script <script-path> [--out <dir>] [--headed]');
  process.exit(1);
}

// Screenshots are filed under a short label for the environment. The first DNS label is
// used rather than a list of known domain suffixes, so this works against any host.
const version = envLabel(baseUrl);
const timestamp = new Date().toISOString().slice(0, 10);
const screenshotDir = path.join(outDir, version, timestamp);
fs.mkdirSync(screenshotDir, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 200 : 0 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const guarded = await installClickGuard(page);

  const screenScript = require(path.resolve(scriptPath));

  console.log(`Target: ${baseUrl}`);
  console.log(`Script: ${scriptPath}`);
  console.log(`Output: ${screenshotDir}`);
  console.log(`Read-only guard: ${guarded ? 'ENABLED' : 'disabled'}`);
  console.log('');

  try {
    await screenScript({ page, baseUrl, screenshotDir, screenshot });
    console.log('\nDone.');
  } catch (err) {
    console.error('Script failed:', err.message);
    process.exitCode = 1;
  }

  await browser.close();
}

/**
 * Capture one screen, through safeShot() so redaction is applied and verified before the
 * PNG exists. See the comment on the same function in run-modules.js: this called
 * page.screenshot() directly, which meant an ad-hoc screen script got no redaction at
 * all while the README promised it was mandatory.
 */
async function screenshot(page, name) {
  const result = await safeShot(page, screenshotDir, name);
  console.log(`  Screenshot: ${name}.png (${result.verified}/${result.requested} region(s) covered)`);
}

run();
