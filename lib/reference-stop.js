/**
 * lib/reference-stop.js — hard stop when the run hits something it does not understand.
 *
 * WHY THIS EXISTS
 * ---------------
 * The recurring failure mode in documentation capture is not a crash. It is PROCEEDING ON
 * A GUESS: a step names a screen, field, or context-menu option that the resolver cannot
 * actually find, the run keeps going, and you end up with a folder of confident-looking
 * screenshots of the wrong screens. Nothing failed, so nothing told you.
 *
 * This hook is the stop. When a script hits an unclear item — either every resolver tier
 * missed a labelled target, or the author calls referenceStop() explicitly — it:
 *   1. writes UNKNOWN-<term>.json (the same shape as beat-runner's FAILURE-*.json),
 *   2. optionally runs an external lookup command for reference material on the term,
 *   3. prints whatever that returned, and
 *   4. throws, so the run halts for a human decision.
 *
 * The lookup command is configured in capture.config.json (`referenceLookup`). With no
 * command configured this degrades to steps 1, 3 and 4, which is still the important part.
 *
 * Read-only: it reads the DOM and shells out to the lookup command. It never touches the
 * application UI.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config, resolvePath } = require('./config');

/**
 * Run the configured lookup command for a term. Returns {text, ok}. Never throws.
 *
 * The term is passed as a separate argv entry rather than interpolated into a command
 * string: on Windows, shell:true splits a spaced argument and silently corrupts it.
 * Use "{term}" anywhere in `args` to control placement; otherwise the term is appended.
 */
function lookupReferences(term, opts = {}) {
  const cfg = { ...(config().referenceLookup || {}), ...opts };
  if (!cfg.command) {
    return { text: 'no referenceLookup.command configured — no references fetched', ok: false };
  }
  const template = Array.isArray(cfg.args) ? cfg.args : [];
  const args = template.some((a) => String(a).includes('{term}'))
    ? template.map((a) => String(a).replace('{term}', term))
    : [...template, term];
  try {
    const result = spawnSync(cfg.command, args, {
      cwd: cfg.cwd ? resolvePath(cfg.cwd) : process.cwd(),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      encoding: 'utf-8',
      timeout: cfg.timeoutMs || 60000,
      shell: process.platform === 'win32',
    });
    if (result.status === 0 && result.stdout) return { text: result.stdout.trim(), ok: true };
    return { text: (result.stderr || 'lookup command returned no output').trim(), ok: false };
  } catch (e) {
    return { text: `lookup command failed: ${e.message}`, ok: false };
  }
}

/**
 * Hard-stop the run to reference documentation for an unclear item.
 * @param {object} opts
 *   term    {string} the unclear thing (variable, screen, field, label) — REQUIRED
 *   context {string} what you were doing when you hit it
 *   outDir  {string} where to write UNKNOWN-<term>.json (defaults to cwd)
 *   page    {object} optional Playwright page — snapshots the visible labels and url
 * @throws Always. Writing the report and printing references are side effects; the throw
 *         is the point.
 */
async function referenceStop(opts = {}) {
  const { term, context = '', outDir = process.cwd(), page = null } = opts;
  if (!term) throw new Error('referenceStop requires { term }');

  const safe = term.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  const reportPath = path.join(outDir, `UNKNOWN-${safe}.json`);

  let snapshot = null;
  if (page) {
    try {
      snapshot = await page.evaluate(() => {
        const labels = [];
        for (const el of document.querySelectorAll('td,div,span,a,button')) {
          const text = (el.innerText || '').trim();
          if (text && text.length < 40) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.y > 0 && rect.y < 1080) {
              labels.push({ t: text, x: Math.round(rect.x), y: Math.round(rect.y) });
            }
          }
        }
        return { url: location.href, visibleLabels: labels.slice(0, 60) };
      });
    } catch { /* best-effort */ }
  }

  const refs = lookupReferences(term, opts.lookup || {});

  const report = {
    kind: 'stop-and-reference',
    term,
    context,
    at: new Date().toISOString(),
    page: snapshot,
    references: refs.text,
    referencesResolved: refs.ok,
  };
  try { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); } catch { /* ignore */ }

  const banner =
    `\n${'='.repeat(72)}\n` +
    'STOP AND REFERENCE — unclear item hit during capture\n' +
    `  term:    ${term}\n` +
    (context ? `  context: ${context}\n` : '') +
    `  report:  ${path.basename(reportPath)}\n` +
    `${'-'.repeat(72)}\n` +
    `${refs.text}\n` +
    `${'='.repeat(72)}\n`;
  process.stderr.write(banner);

  // Hard stop: halt the run so a human decides, rather than capturing a guessed screen.
  throw new Error(`stop-and-reference: unclear "${term}" — run halted. See ${path.basename(reportPath)}.`);
}

module.exports = { referenceStop, lookupReferences };
