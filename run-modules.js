#!/usr/bin/env node
/**
 * Modular screenshot runner.
 *
 * Usage:
 *   node run-modules.js --env staging --modules login,home,admin
 *   node run-modules.js --url https://staging.example.com --modules login
 *   node run-modules.js --env staging --modules login --user jsmith --pass '<password>'
 *   node run-modules.js --env staging --modules login --out D:/captures
 *   node run-modules.js --list          (show available modules)
 *   node run-modules.js --list-envs     (show configured environments)
 *
 * --out defaults to `capture.outputDir` from the config file, itself defaulting to
 * ./screenshots. Captures are filed under <out>/<env-label>/<YYYY-MM-DD>.
 *
 * Each module captures one area of the application independently.
 * Prerequisites are resolved automatically (e.g. admin requires login).
 *
 * Prefer --env over --url: it keeps hostnames out of your shell history and out of any
 * command you paste somewhere. Prefer .env or CAPTURE_USER/CAPTURE_PASS over --pass,
 * which is visible in the process list to every other user on the machine.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { config, resolvePath, resolveUrl, resolveCreds, listEnvironments, envLabel } = require('./lib/config');
const { installClickGuard, guardEnabled } = require('./lib/guard');
const { safeShot } = require('./lib/capture-safe');

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const MODULES_DIR = path.join(__dirname, 'modules');

const registry = {};
fs.readdirSync(MODULES_DIR).filter(f => f.endsWith('.js')).forEach(f => {
  const Mod = require(path.join(MODULES_DIR, f));
  registry[Mod.moduleName] = Mod;
});

if (has('--list')) {
  console.log('Available modules:\n');
  Object.values(registry).forEach(M => {
    const deps = M.prerequisites.length ? ` (requires: ${M.prerequisites.join(', ')})` : '';
    console.log(`  ${M.moduleName.padEnd(12)} ${M.description}${deps}`);
  });
  process.exit(0);
}

if (has('--list-envs')) {
  listEnvironments();
  process.exit(0);
}

const baseUrl = resolveUrl(args);
const moduleList = (get('--modules') || '').split(',').filter(Boolean);
const headed = has('--headed');
const record = has('--record');

if (!baseUrl || !moduleList.length) {
  console.error('Usage: node run-modules.js --env <environment> --modules <mod1,mod2,...> [--headed]');
  console.error('       node run-modules.js --url <base-url> --modules <mod1,mod2,...> [--headed]');
  console.error('       node run-modules.js --list');
  console.error('       node run-modules.js --list-envs');
  process.exit(1);
}

// Validate credentials are available before launching browser
const creds = resolveCreds(args);

function resolveOrder(requested) {
  const resolved = [];
  const seen = new Set();

  function resolve(name) {
    if (seen.has(name)) return;
    const Mod = registry[name];
    if (!Mod) {
      console.error(`Unknown module: ${name}`);
      console.error(`Available: ${Object.keys(registry).join(', ')}`);
      process.exit(1);
    }
    for (const dep of Mod.prerequisites) {
      resolve(dep);
    }
    seen.add(name);
    resolved.push(name);
  }

  requested.forEach(resolve);
  return resolved;
}

const label = envLabel(baseUrl);
const timestamp = new Date().toISOString().slice(0, 10);
// `capture.outputDir` is documented as a config key and had no readers anywhere in the
// repo: this line hardcoded 'screenshots' under __dirname, so setting the key did nothing
// and captures could not be redirected off the repo at all. A config key that is silently
// ignored is worse than no key, because it reads as a decision the user already made.
const outDir = get('--out') || resolvePath((config().capture || {}).outputDir || 'screenshots');
const screenshotDir = path.join(outDir, label, timestamp);
fs.mkdirSync(screenshotDir, { recursive: true });

/**
 * Capture one screen. Routed through safeShot() so redaction is applied and VERIFIED
 * before the PNG exists, rather than being a step a module can forget.
 *
 * This used to call page.screenshot() directly. capture-safe.js described itself as
 * "the capture front door" and was imported by nothing, so every screenshot this kit
 * produced through its documented entry point was unredacted while the README claimed
 * the opposite. A front door that nothing walks through is not a control.
 *
 * A RedactionError here is the module working: it means a region that was supposed to
 * be covered could not be located, and the correct outcome is no file rather than a
 * clean-looking one. It aborts the run instead of being swallowed per-screen, because
 * whatever broke the redactor on this screen almost certainly breaks it on the next.
 */
async function screenshot(page, name) {
  const result = await safeShot(page, screenshotDir, name);
  const covered = result.verified === result.requested
    ? `${result.verified} region(s) covered`
    : `${result.verified}/${result.requested} region(s) covered`;
  console.log(`    📸 ${name}.png (${covered})`);
  return name;
}

async function run() {
  const order = resolveOrder(moduleList);
  console.log(`Target:  ${baseUrl}`);
  console.log(`User:    ${creds.user}`);
  console.log(`Modules: ${order.join(' → ')}`);
  console.log(`Output:  ${screenshotDir}\n`);

  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 200 : 0 });
  const contextOpts = {
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  };
  if (record) {
    const videoDir = path.join(screenshotDir, 'video');
    fs.mkdirSync(videoDir, { recursive: true });
    contextOpts.recordVideo = { dir: videoDir, size: { width: 1440, height: 900 } };
    console.log(`Recording video to: ${videoDir}`);
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // The guard is armed unless CAPTURE_ALLOW_WRITES=1. Report what actually happened rather
  // than what was requested: installClickGuard returns false instead of throwing, so
  // announcing the guard on the strength of guardEnabled() alone can print a shield next to
  // an unguarded run.
  if (guardEnabled()) {
    if (!(await installClickGuard(page))) {
      await browser.close();
      throw new Error('read-only guard failed to install; refusing to run against a live environment');
    }
    console.log('🛡️  READ-ONLY guard active (Save/Submit/Confirm/Apply/Delete clicks blocked)\n');
  } else {
    console.log('⚠️  READ-ONLY guard DISABLED via CAPTURE_ALLOW_WRITES=1. Mutating clicks will reach the application.\n');
  }

  const allResults = [];

  for (const name of order) {
    const Mod = registry[name];
    const instance = new Mod({ page, baseUrl, screenshotDir, screenshot, creds });
    const results = await instance.run();
    allResults.push(...results);
  }

  if (record) {
    const videoPath = await page.video().path();
    console.log(`\nVideo saved: ${videoPath}`);
  }

  await context.close();
  await browser.close();

  const manifest = path.join(screenshotDir, 'capture-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify(allResults, null, 2));
  console.log(`\nManifest: ${manifest}`);
  console.log(`Total: ${allResults.length} screenshots`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
