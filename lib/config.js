/**
 * lib/config.js — the single source of truth for everything environment-specific.
 *
 * Nothing else in the kit is allowed to hardcode a hostname, a URL path, a DOM
 * selector, a nav route, a pixel coordinate, or a credential location. It all comes
 * from capture.config.json (overridable with CAPTURE_CONFIG=/path/to/other.json),
 * merged over the built-in defaults below so a partial config file still works.
 *
 * Credential resolution order:
 *   1. CLI args:            --user <u> --pass <p>
 *   2. Environment vars:    CAPTURE_USER / CAPTURE_PASS
 *   3. .env file:           CAPTURE_USER=... / CAPTURE_PASS=...
 *
 * Environment resolution:
 *   --url <url>     an explicit base URL (wins)
 *   --env <name>    a key under `environments` in capture.config.json
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = process.env.CAPTURE_CONFIG
  ? path.resolve(process.env.CAPTURE_CONFIG)
  : path.join(ROOT, 'capture.config.json');

// Built-in defaults. A config file only needs to state what it changes.
const DEFAULTS = {
  environments: {},
  app: {
    loginPath: '/cas/login',
    loginServicePath: '/app/index.html',
    appPath: '/app/index.html',
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: 'input[type="submit"]',
    loadingOverlayText: 'Loading',
    overlayClassFragments: ['screenCover', 'glasspane', 'modalMask'],
    authPathFragment: '/cas/',
  },
  viewport: { width: 1440, height: 900 },
  capture: {
    outputDir: 'screenshots',
    crop: { left: 0, top: 56, width: 1440, height: 844 },
  },
  redaction: {
    identityPrefix: 'ID:',
    requireBoxes: 1,
    columnLabels: [],
    labelPatterns: [],
    valuePatterns: [],
  },
  guard: {
    forbiddenTerms: ['Save', 'Submit', 'Confirm', 'Apply', 'Delete', 'Remove', 'Upload'],
  },
  navigation: {
    menuLabel: 'Menu',
    adminLabel: 'Admin',
    adminMenuItemPixel: [1090, 97],
    adminPostCondition: { label: 'Access', ymin: 75, ymax: 110 },
    tabBarY: 95,
    tabs: [],
    paths: {},
  },
  resolvers: {
    tiers: ['dom', 'ocr', 'template'],
    templateDir: 'assets/templates',
    tesseractCandidates: [],
    vision: { command: null, args: [], timeoutMs: 60000 },
  },
  referenceLookup: { command: null, args: [], cwd: null },
  agentHandoff: { command: null, args: [], timeoutMs: 900000 },
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge `override` onto `base`, ignoring `$comment` documentation keys. */
function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (key === '$comment') continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

let _config;

/** The merged configuration object. Loaded once, cached. */
function config() {
  if (_config) return _config;
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      throw new Error(`capture config is not valid JSON: ${CONFIG_FILE}\n  ${e.message}`);
    }
  }
  _config = merge(DEFAULTS, fileConfig);
  _config.configFile = CONFIG_FILE;
  _config.root = ROOT;
  return _config;
}

/** Resolve a config-relative path (e.g. templateDir, outputDir) to an absolute one. */
function resolvePath(relative) {
  return path.isAbsolute(relative) ? relative : path.join(ROOT, relative);
}

function loadEnvironments() {
  return config().environments || {};
}

function argGetter(args) {
  return (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
  };
}

function resolveUrl(args) {
  const get = argGetter(args);

  const url = get('--url');
  if (url) return url;

  const envName = get('--env');
  if (envName) {
    const envs = loadEnvironments();
    const env = envs[envName];
    if (!env) {
      console.error(`Unknown environment: "${envName}"`);
      const names = Object.keys(envs);
      console.error(names.length ? `Available: ${names.join(', ')}` : 'No environments are defined yet.');
      console.error(`Define environments under "environments" in: ${CONFIG_FILE}`);
      process.exit(1);
    }
    return env.url;
  }

  return null;
}

/** Parse a KEY=value .env file into a plain object. Never logs its contents. */
function readDotenv() {
  const dotenvPath = path.join(ROOT, '.env');
  if (!fs.existsSync(dotenvPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(dotenvPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Find credentials, or stop the process explaining how to supply them.
 *
 * `opts.optional` returns null instead of exiting, for the one caller that can legitimately
 * continue without them: a REPL resuming a saved session never touches the login form. It
 * stays opt-in because for every other entry point, discovering the absence of credentials
 * after launching a browser and navigating is strictly worse than failing on line one.
 */
function resolveCreds(args, opts = {}) {
  const get = argGetter(args);

  const cliUser = get('--user');
  const cliPass = get('--pass');
  if (cliUser && cliPass) return { user: cliUser, pass: cliPass };

  if (process.env.CAPTURE_USER && process.env.CAPTURE_PASS) {
    return { user: process.env.CAPTURE_USER, pass: process.env.CAPTURE_PASS };
  }

  const env = readDotenv();
  if (env.CAPTURE_USER && env.CAPTURE_PASS) {
    return { user: env.CAPTURE_USER, pass: env.CAPTURE_PASS };
  }

  if (opts.optional) return null;

  console.error('No credentials found. Provide them one of these ways:');
  console.error('  --user <user> --pass <pass>       (CLI arguments)');
  console.error('  CAPTURE_USER / CAPTURE_PASS       (environment variables)');
  console.error('  .env file                         (see .env.example)');
  process.exit(1);
}

function listEnvironments() {
  const envs = loadEnvironments();
  if (!Object.keys(envs).length) {
    console.log(`No environments defined. Add them under "environments" in ${CONFIG_FILE}.`);
    return;
  }
  console.log('Available environments:\n');
  Object.entries(envs).forEach(([name, cfg]) => {
    console.log(`  ${name.padEnd(14)} ${cfg.url}`);
    if (cfg.description) console.log(`  ${''.padEnd(14)} ${cfg.description}`);
  });
}

/** Short, filesystem-safe label for an environment, used in output paths. */
function envLabel(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    const named = Object.entries(loadEnvironments())
      .find(([, cfg]) => { try { return new URL(cfg.url).hostname === hostname; } catch { return false; } });
    if (named) return named[0];
    // Falling back to the first DNS label. An IP address has no meaningful first label, so
    // 10.1.2.3 would otherwise file every screenshot under "10" and collide across hosts.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname.replace(/\./g, '-');
    return hostname.split('.')[0] || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  config, resolvePath, resolveUrl, resolveCreds, loadEnvironments, listEnvironments,
  envLabel, readDotenv, CONFIG_FILE, ROOT, DEFAULTS,
};
