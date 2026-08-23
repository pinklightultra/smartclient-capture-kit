#!/usr/bin/env node
/**
 * Interactive setup for the capture kit.
 * Creates a .env file with credentials and verifies environment connectivity.
 *
 * Usage:
 *   node setup.js
 *   node setup.js --add-env          (add a new environment)
 *   node setup.js --test <env-name>  (test connectivity to an environment)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
// Environments live in capture.config.json under "environments", because that is where
// lib/config.js loadEnvironments() reads them from. An earlier version of this script
// wrote a separate environments.json that nothing ever read, so --add-env appeared to
// succeed and --test then reported the environment as unknown.
const CONFIG_FILE = process.env.CAPTURE_CONFIG
  ? path.resolve(process.env.CAPTURE_CONFIG)
  : path.join(ROOT, 'capture.config.json');
const DOTENV_FILE = path.join(ROOT, '.env');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

async function setupCredentials() {
  console.log('\n=== Capture kit setup ===\n');

  if (fs.existsSync(DOTENV_FILE)) {
    const overwrite = await ask('.env file already exists. Overwrite? (y/N) ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Keeping existing credentials.');
      return;
    }
  }

  const user = await ask('Application username: ');
  const pass = await ask('Application password: ');

  // These two names are read by lib/config.js resolveCreds(). Renaming them here without
  // renaming them there produces a .env the kit cannot read, and the only symptom is a
  // "no credentials configured" error that points at setup rather than at the mismatch.
  fs.writeFileSync(DOTENV_FILE, `CAPTURE_USER=${user}\nCAPTURE_PASS=${pass}\n`);
  console.log(`\nCredentials saved to .env`);
  console.log('(.env is gitignored. Keep it that way.)\n');
}

async function addEnvironment() {
  console.log('\n=== Add environment ===\n');

  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`config file not found: ${CONFIG_FILE}`);
  }
  // Round-tripping the whole file preserves the "$comment" keys and the rest of the
  // configuration; only the environments block is touched.
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!cfg.environments || typeof cfg.environments !== 'object') cfg.environments = {};

  const name = (await ask('Short name (e.g. dev, staging, prod): ')).trim();
  if (!name) throw new Error('a short name is required');
  const url = (await ask('Base URL (e.g. https://staging.example.com): ')).trim();
  if (!/^https?:\/\//.test(url)) throw new Error(`base URL must start with http:// or https:// (got "${url}")`);
  const desc = (await ask('Description (optional): ')).trim();

  if (cfg.environments[name]) {
    const overwrite = await ask(`"${name}" already exists (${cfg.environments[name].url}). Overwrite? (y/N) `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Left unchanged.');
      return;
    }
  }

  cfg.environments[name] = desc ? { url, description: desc } : { url };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`\nAdded "${name}" → ${url}`);
  console.log(`Use with: node run-modules.js --env ${name} --modules login`);
}

async function testEnvironment(envName) {
  const { resolveUrl, resolveCreds } = require('./lib/config');
  const { installClickGuard } = require('./lib/guard');
  const { login } = require('./lib/login');

  const fakeArgs = ['--env', envName];
  const url = resolveUrl(fakeArgs);
  if (!url) {
    console.error(`Environment "${envName}" not found.`);
    process.exit(1);
  }

  let creds;
  try {
    creds = resolveCreds([]);
  } catch {
    console.error('No credentials configured. Run: node setup.js');
    process.exit(1);
  }

  console.log(`\nTesting: ${url}`);
  console.log('Credentials: resolved locally');

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  // Arm the guard before the first navigation. This is a real login against a shared
  // environment, so it runs read-only like every other path in the kit. Setting
  // CAPTURE_READONLY here overrides CAPTURE_ALLOW_WRITES in guardEnabled(), so a developer
  // who exported that variable in this shell for some other reason does not get an
  // unguarded connectivity test as a side effect. The check below cannot fail as a result,
  // which is the point of keeping it: if it ever does, the override was removed.
  process.env.CAPTURE_READONLY = '1';
  process.env.CAPTURE_NO_SUBMIT = '1';
  if (!(await installClickGuard(page))) {
    await context.close();
    await browser.close();
    throw new Error('read-only guard failed to install; refusing to log in to a live environment');
  }

  try {
    await login(page, url, creds);
    const state = await page.evaluate(() => ({
      pathname: location.pathname,
      hasIsc: typeof window.isc !== 'undefined',
      iscLoaded: !!(window.isc && window.isc.Page && window.isc.Page.isLoaded()),
      loginFormVisible: !!document.querySelector('#username'),
    }));
    if (!state.hasIsc || !state.iscLoaded || state.loginFormVisible) {
      throw new Error('application did not reach a loaded authenticated state');
    }
    console.log(`  Authenticated application: OK (${state.pathname})`);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  if (has('--add-env')) {
    await addEnvironment();
  } else if (get('--test')) {
    await testEnvironment(get('--test'));
  } else {
    await setupCredentials();
    const addEnv = await ask('Add an environment? (y/N) ');
    if (addEnv.toLowerCase() === 'y') {
      await addEnvironment();
    }
  }
  rl.close();
}

main().catch(err => {
  console.error(err.message);
  rl.close();
  process.exit(1);
});
