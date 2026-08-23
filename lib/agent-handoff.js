/**
 * lib/agent-handoff.js — hand a failed beat to an external coding agent, while it's warm.
 *
 * WHY THIS EXISTS
 * ---------------
 * beat-runner.js already writes a rich failure payload for any failed beat:
 *   FAILURE-<label>.png    the screen at the moment of failure
 *   FAILURE-<label>.json   {beat, phase, reason, assertion, page:{visibleLabels, inputs, url}}
 * which is expected-vs-actual plus a DOM snapshot — very close to exactly what a second
 * agent needs to diagnose the break. This module pipes that payload (and the PNG, for
 * agents that accept an image) to a configured CLI non-interactively, so a fix can be
 * proposed while the session, the environment state, and the screen are all still current
 * rather than in a next-day post-mortem.
 *
 * The whole feature is opt-in and off by default: `agentHandoff.command` in
 * capture.config.json is null unless you set it, and the hook only fires when
 * CAPTURE_AGENT_HANDOFF=1.
 *
 * SAFETY RULES (baked into every prompt, not left to the agent's judgement):
 *   Captures run against real environments that other people are using. The agent must
 *   never drive the UI into a mutating action. The prompt states the ban explicitly, and
 *   every child process inherits CAPTURE_READONLY=1 and CAPTURE_NO_SUBMIT=1 so lib/guard.js
 *   refuses Save/Submit defensively even if the prompt is ignored. The agent is there to
 *   fix SELECTORS, WAITS, NAV PATHS and ASSERTIONS.
 *
 * The prompt is written to the child's stdin, never passed as a shell argument: it is large
 * and full of quotes and newlines, which shell:true on Windows will corrupt, and building a
 * command string out of page content is an injection risk.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const REPO_ROOT = path.join(__dirname, '..');

/** The rules every handoff prompt carries, regardless of which agent is configured. */
const SAFETY_PREAMBLE = `You are an automated repair agent for a Playwright screenshot and
walkthrough tool that drives an Isomorphic SmartClient application. A capture step ("beat")
just failed. Your job is to make the capture pass again by fixing the SCRIPT, SELECTORS,
WAITS, NAV PATHS, or ASSERTIONS.

ABSOLUTE RULES — violating any of these is a critical failure:
1. These scripts run against real, shared environments. You must NEVER add, enable, or
   trigger a mutating action: no clicking Save, Submit, Confirm, Apply, Delete, OK-on-a-form,
   or anything that writes data. Close dialogs with Escape only. This tool is capture-only.
2. Do not weaken a post-condition assertion just to make it pass. If the beat genuinely
   cannot reach its target, say so in your final message instead of faking success.
3. Prefer fixes in lib/nav.js helpers or in the beat's own selector, band, or wait, following
   the canonical patterns documented at the top of lib/nav.js: locator first, banded
   DOM-centre mouse fallback, isc.Page.isLoaded() plus an explicit destination
   post-condition. NEVER page.evaluate(el => el.click()) — a synthetic click is not a trusted
   event and the framework will not see it. NEVER a blind waitForTimeout for a page load.
4. Any re-run you launch MUST keep the guard variables set: CAPTURE_READONLY=1
   CAPTURE_NO_SUBMIT=1.`;

/**
 * Build the diagnosis prompt from a FAILURE-*.json report.
 * @param {object} report parsed FAILURE json
 * @param {object} opts   {rerunCmd, allowRerun, hasImage}
 */
function buildPrompt(report, opts = {}) {
  const page = report.page || {};
  const labels = (page.visibleLabels || []).map((l) => `${l.t}@(${l.x},${l.y})`).join(', ');
  const inputs = (page.inputs || [])
    .map((i) => `${i.id || '?'}="${i.value}"${i.readonly ? '(ro)' : ''}`).join(', ');
  const rerunLine = opts.allowRerun && opts.rerunCmd
    ? `\nAfter you apply a fix, VERIFY it by re-running (the guard variables are mandatory):\n`
      + `    CAPTURE_READONLY=1 CAPTURE_NO_SUBMIT=1 ${opts.rerunCmd}\n`
      + `Inspect the new FAILURE-*.json and the exit code. Iterate until it passes or you are `
      + `confident the target is genuinely unreachable.`
    : '\nDo NOT launch a browser or re-run anything. Propose the minimal patch as a unified '
      + 'diff and explain it. A human will re-run.';
  const imageLine = opts.hasImage
    ? 'The failure screenshot is attached.'
    : `Failure screenshot on disk: ${report.screenshot || '(none)'}`;

  return `${SAFETY_PREAMBLE}

FAILED BEAT
  label:     ${report.beat}
  phase:     ${report.phase ?? '?'}   idx: ${report.idx ?? '?'}
  reason:    ${report.reason}
  assertion: ${JSON.stringify(report.assertion)}
  page url:  ${page.url || '?'}

${imageLine} DOM snapshot at the moment of failure:
  visible labels: ${labels || '(none captured)'}
  inputs:         ${inputs || '(none)'}

Diagnose why the beat's action or post-condition failed. Likely causes, in rough order:
a stale selector, a label that moved out of its y-band, a view transition that was not
awaited (isc.Page.isLoaded() can return true for the OUTGOING view), an overlay or modal
click mask that was never dismissed, or a grid row that is virtualised and not rendered.
${rerunLine}

End with a one-paragraph summary: root cause, what you changed, and whether the capture
now passes.`;
}

/** Substitute {root}, {out}, {image}, {report} into a configured argv template. */
function expandArgs(template, vars) {
  return (template || []).map((arg) => String(arg)
    .replace('{root}', vars.root)
    .replace('{out}', vars.out)
    .replace('{image}', vars.image || '')
    .replace('{report}', vars.report));
}

/**
 * Hand one failure report to the configured agent CLI.
 *
 * `exitedCleanly` is deliberately not called `ok`. It means the agent's CLI exited 0, which
 * is a statement about a subprocess and not about your capture. The agent may have diagnosed
 * nothing, diagnosed it wrongly, or weakened an assertion until it passed, and still exit 0.
 * Nothing in this module re-runs the beat or verifies a fix, so there is no value it could
 * return that would honestly mean "repaired". Read the notes.
 *
 * @param {string} reportPath path to a FAILURE-*.json
 * @param {object} opts {allowRerun=false, rerunCmd, onLog, timeoutMs}
 * @returns {Promise<{exitedCleanly:boolean, notesWritten:boolean, finalMessage:string,
 *                    code:number, outFile?:string}>}
 */
function agentHandoff(reportPath, opts = {}) {
  const cfg = config().agentHandoff || {};
  const {
    allowRerun = false,
    rerunCmd = null,
    onLog = (m) => process.stdout.write(m),
    timeoutMs = cfg.timeoutMs || 15 * 60 * 1000,
  } = opts;

  if (!cfg.command) {
    return Promise.resolve({
      exitedCleanly: false, notesWritten: false, finalMessage: '', code: -1,
      error: 'agentHandoff.command is null in capture.config.json',
    });
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const image = report.screenshot && fs.existsSync(report.screenshot) ? report.screenshot : null;
  const prompt = buildPrompt(report, { allowRerun, rerunCmd, hasImage: !!image && !!cfg.imageArgs });
  const outFile = reportPath.replace(/\.json$/, '.agent-fix.md');
  const vars = { root: REPO_ROOT, out: outFile, image, report: reportPath };

  const args = [
    ...expandArgs(cfg.args, vars),
    ...(image && cfg.imageArgs ? expandArgs(cfg.imageArgs, vars) : []),
    ...(cfg.stdinSentinel ? [cfg.stdinSentinel] : []),
  ];

  onLog(`\n[handoff] ${cfg.command} for beat "${report.beat}" (${path.basename(reportPath)})\n`);

  return new Promise((resolve) => {
    const child = spawn(cfg.command, args, {
      cwd: REPO_ROOT,
      // Defence in depth: even if the prompt is ignored, the in-page guard refuses to let a
      // mutating control be clicked in any browser the agent starts.
      env: { ...process.env, CAPTURE_READONLY: '1', CAPTURE_NO_SUBMIT: '1' },
      shell: process.platform === 'win32', // many CLIs are .cmd shims on Windows
    });
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        // Agents that emit JSONL progress events get summarised to one line each; anything
        // else is ignored rather than flooding the capture log.
        try {
          const event = JSON.parse(line);
          const text = event.msg?.text || event.text || event.msg?.message;
          if (text) onLog(`   ${String(text).split('\n')[0].slice(0, 160)}\n`);
        } catch { /* non-JSON progress line */ }
      }
    });
    child.stderr.on('data', (chunk) => {
      onLog(`   [agent] ${chunk.toString().trim().slice(0, 200)}\n`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let finalMessage = '';
      let notesWritten = false;
      try {
        finalMessage = fs.readFileSync(outFile, 'utf8');
        notesWritten = true;
      } catch { /* the agent wrote no notes file */ }
      // Do not name a notes file that does not exist. The previous wording printed
      // "Notes: <filename>" unconditionally, so an agent that produced nothing read
      // identically to one that produced a diagnosis.
      onLog(notesWritten
        ? `[handoff] finished (exit ${code}). Notes: ${path.basename(outFile)}\n`
        : `[handoff] finished (exit ${code}). The agent wrote no notes file.\n`);
      resolve({ exitedCleanly: code === 0, notesWritten, finalMessage, code, outFile });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      onLog(`[handoff] spawn failed: ${e.message}\n`);
      resolve({ exitedCleanly: false, notesWritten: false, finalMessage: '', code: -1, error: e.message });
    });
  });
}

/** True if the configured agent CLI is on PATH. */
function agentAvailable() {
  const cfg = config().agentHandoff || {};
  if (!cfg.command) return false;
  try {
    const probe = cfg.versionArgs || ['--version'];
    const result = spawnSync(cfg.command, probe, { shell: process.platform === 'win32' });
    return result.status === 0;
  } catch { return false; }
}

module.exports = { agentHandoff, buildPrompt, agentAvailable, SAFETY_PREAMBLE, REPO_ROOT };
