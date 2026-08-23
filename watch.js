#!/usr/bin/env node
/**
 * watch.js -- run a capture, and hand every failure report to the configured agent CLI.
 *
 * WHY: a long capture run that fails on beat 40 of 60 leaves a FAILURE-*.json and stops being
 * useful until you read it. This wraps the run, watches for those reports as they appear, and
 * hands each one to the agent configured in capture.config.json under `agentHandoff`. The
 * wrapped command keeps its own stdout, so you watch the run normally.
 *
 * USAGE:
 *   node watch.js -- node run-modules.js --env staging --modules login,home
 *   node watch.js --watch-dir . -- npm run capture
 *   node watch.js --rerun -- node run-modules.js --env staging --modules login
 *
 * FLAGS (before the -- separator):
 *   --watch-dir <dir>   where FAILURE-*.json appear. Default: the repo root.
 *   --rerun             let the agent re-run the capture itself. Off by default; see below.
 *   --interval <ms>     poll interval. Default 1500.
 *
 * WHAT THIS DOES NOT DO, stated plainly because the shape of the tool invites the assumption:
 * it does not verify a fix. It hands a report to an agent and collects that agent's notes.
 * Nothing here re-runs the failed beat, diffs the result, or confirms anything was repaired.
 * If you want that, read the notes and run the capture again yourself.
 *
 * --rerun grants the agent permission to start its own browser against your environment while
 * your capture may still be running. Two sessions against one authenticated app is a good way
 * to invalidate the session you are using. The in-page guard from lib/guard.js is forced on in
 * any browser the agent starts, so a mutating control still cannot be clicked, but the guard
 * defends the application, not your run.
 *
 * The agent is given write access to this repo by whatever CLI you configured. That is the
 * point of the tool and it is also the risk: review the diff afterwards. Nothing here gates,
 * sandboxes, or rolls back an edit.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { agentHandoff, agentAvailable } = require('./lib/agent-handoff');
const { config } = require('./lib/config');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('Usage: node watch.js [--watch-dir <dir>] [--rerun] [--interval <ms>] -- <command...>');
  console.error('Example: node watch.js -- node run-modules.js --env staging --modules login');
  process.exit(1);
}

const flags = argv.slice(0, sep);
const command = argv.slice(sep + 1);
const flag = (name, fallback) => {
  const i = flags.indexOf(name);
  return i !== -1 && flags[i + 1] ? flags[i + 1] : fallback;
};

const WATCH_DIR = path.resolve(flag('--watch-dir', __dirname));
const INTERVAL = Number(flag('--interval', 1500));
const ALLOW_RERUN = flags.includes('--rerun');

const handoffCfg = config().agentHandoff || {};
if (!handoffCfg.command) {
  console.error('agentHandoff.command is null in capture.config.json.');
  console.error('Set it to your agent CLI, or run the capture directly -- this wrapper would');
  console.error('otherwise just be a slower way to run the same command.');
  process.exit(1);
}
if (!agentAvailable()) {
  console.error(`Configured agent CLI "${handoffCfg.command}" is not on PATH (or --version failed).`);
  process.exit(1);
}

// A missing watch directory is the failure this tool is least able to notice on its own: it
// would poll an empty result forever and then report a clean run. Check it once, up front,
// rather than swallowing readdir errors in the loop.
if (!fs.existsSync(WATCH_DIR) || !fs.statSync(WATCH_DIR).isDirectory()) {
  console.error(`--watch-dir is not a directory: ${WATCH_DIR}`);
  process.exit(1);
}

/**
 * Reports already handed off, keyed by path AND mtime.
 *
 * Keying on path alone is wrong in the one case that matters most. Reports are named after the
 * beat that failed, so when an agent's fix does not work and the SAME beat fails again, the
 * path is unchanged. A path-keyed set treats that as already-seen and silently drops it, which
 * makes the tool deaf to the single strongest signal available: that the fix did not take.
 */
const seen = new Set();
const keyFor = (file) => {
  try { return `${file}@${fs.statSync(file).mtimeMs}`; } catch { return null; }
};

let queue = [];
let draining = false;
let handoffs = 0;
let readdirFailures = 0;

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const reportPath = queue.shift();
    handoffs += 1;
    const res = await agentHandoff(reportPath, {
      allowRerun: ALLOW_RERUN,
      rerunCmd: ALLOW_RERUN ? command.join(' ') : null,
    });
    if (res.error) console.error(`[watch] handoff error: ${res.error}`);
  }
  draining = false;
}

function poll() {
  let files;
  try {
    files = fs.readdirSync(WATCH_DIR);
  } catch (e) {
    // Counted and reported at the end. Silence here is how "the directory vanished" becomes
    // indistinguishable from "nothing failed".
    readdirFailures += 1;
    return;
  }
  for (const name of files) {
    if (!/^FAILURE-.*\.json$/.test(name)) continue;
    const full = path.join(WATCH_DIR, name);
    const key = keyFor(full);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    console.log(`[watch] new failure report: ${name}`);
    queue.push(full);
  }
  if (queue.length) drain();
}

console.log(`[watch] agent: ${handoffCfg.command}`);
console.log(`[watch] watching: ${WATCH_DIR}`);
console.log(`[watch] rerun: ${ALLOW_RERUN ? 'ALLOWED (agent may drive its own browser)' : 'off (diagnose only)'}`);
console.log(`[watch] running: ${command.join(' ')}\n`);

const child = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: { ...process.env, CAPTURE_READONLY: '1', CAPTURE_NO_SUBMIT: '1' },
  shell: process.platform === 'win32',
});

const timer = setInterval(poll, INTERVAL);

child.on('error', (e) => {
  clearInterval(timer);
  console.error(`[watch] could not start "${command[0]}": ${e.message}`);
  process.exit(1);
});

child.on('close', async (code) => {
  clearInterval(timer);
  poll();              // catch a report written just as the run ended
  await drain();       // and finish any handoff still in flight

  console.log(`\n[watch] wrapped command exited ${code}.`);
  console.log(`[watch] failure reports handed off: ${handoffs}`);
  if (readdirFailures) {
    console.error(`[watch] could not read ${WATCH_DIR} on ${readdirFailures} poll(s).`);
    console.error('[watch] reports written during those polls were missed. Treat the count above');
    console.error('[watch] as a floor, not a total.');
  }
  if (handoffs) {
    console.log('[watch] those are diagnoses, not fixes. Nothing here re-ran or verified a beat.');
  }
  // Exit on the wrapped command's code. The handoffs are diagnostics; whether the CAPTURE
  // succeeded is the only thing this process can honestly report, and that is the child's code.
  process.exit(readdirFailures ? 1 : code);
});
