/**
 * lib/resolvers.js — the multi-method target resolution cascade.
 *
 * WHY: SmartClient renders most of its UI into generic divs and canvases with volatile
 * generated IDs. The DOM is the WEAKEST signal here, which is exactly why nav.js resolves a
 * target to pixel coordinates and then clicks with page.mouse. This module generalises that
 * into an ordered fallback chain:
 *
 *   Tier 1  DOM text + y-band   (~5ms, free)      nav.resolveLabel; the normal path
 *   Tier 2  OCR (Tesseract)     (~200-500ms)      text painted into a canvas
 *   Tier 3  Template match      (~100ms)          icons and unlabelled buttons, vs a crop
 *   Tier 4  Vision model        (~2-5s, and $)    ambiguous or novel layouts
 *
 * THE UNIFORM RETURN SHAPE IS THE POINT. Every tier returns the same thing: a click point
 * {x, y}, or null. Not a locator, not a handle, not a selector — the same two numbers. That
 * is what makes a fallback safe to add. A caller (or a guard) written against one tier's
 * output would silently stop working the moment a different tier won, and it would stop
 * working in the worst possible way: quietly, on the rare path, in production.
 *
 * CRITICAL SAFETY INVARIANT: every tier only RESOLVES coordinates. The click is still issued
 * by the caller via page.mouse.click(x, y), which means lib/guard.js's capture-phase DOM
 * listener fires on the resulting click no matter which tier located it. Adding OCR, template
 * matching, or a vision model creates NO hole in the Save/Submit block. If a tier returned
 * something clickable itself, that guarantee would be gone.
 *
 * GRACEFUL DEGRADATION: OCR is skipped when the Tesseract binary is absent, the vision tier
 * is skipped when no vision command is configured, and template match is skipped when no
 * reference crop exists. A tier that cannot run returns {pick:null, skipped:'<reason>'} and
 * the cascade continues. Note the asymmetry with redaction: a resolver that cannot run is
 * allowed to give up, because failing to find a button ends in a visible error. A redaction
 * that cannot run is not allowed to give up, because that ends in a file on disk.
 *
 * Each successful non-DOM resolution logs the winning tier and coordinates, so "the DOM tier
 * went stale and OCR found it at (x,y)" is visible in the run log and can be turned into a
 * durable selector or band fix.
 *
 * PRIVACY NOTE: the vision tier sends a screenshot of the current page to whatever command
 * `resolvers.vision.command` names. If that command is a hosted model, the capture leaves
 * this machine. Drop 'vlm' from `resolvers.tiers` to make that impossible.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { config, resolvePath } = require('./config');

const REPO_ROOT = path.join(__dirname, '..');

// ── capability probes (cached) ────────────────────────────────────────────────
let _tesseract, _tessBin, _vision, _sharp, _pixelmatch, _png;

// Resolve the tesseract binary. On Windows it is frequently installed but NOT on PATH, so
// the search order is: TESSERACT_BIN, then any paths listed in
// `resolvers.tesseractCandidates` (which may use ${ENVVAR} expansion), then bare
// 'tesseract' and hope PATH has it. Cached, because this is called per resolution.
function tesseractBin() {
  if (_tessBin !== undefined) return _tessBin;
  const configured = (config().resolvers || {}).tesseractCandidates || [];
  const expand = (value) => String(value).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  const candidates = [process.env.TESSERACT_BIN, ...configured.map(expand)]
    .filter(Boolean)
    .filter((candidate) => !/\$\{|^$/.test(candidate));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) { _tessBin = candidate; return _tessBin; } } catch { /* unreadable */ }
  }
  _tessBin = 'tesseract'; // last resort: rely on PATH
  return _tessBin;
}

// A resolved absolute .exe path must be spawned WITHOUT a shell: shell:true does not quote
// the path, so any space in a Program Files style install directory splits the command into
// two arguments. Only the bare-PATH fallback needs a shell (it is a .cmd shim on Windows).
function tessSpawnOpts(extra = {}) {
  const bin = tesseractBin();
  const viaPath = bin === 'tesseract';
  return { bin, opts: { shell: viaPath && process.platform === 'win32', ...extra } };
}

function hasTesseract() {
  if (_tesseract === undefined) {
    try {
      const { bin, opts } = tessSpawnOpts();
      _tesseract = spawnSync(bin, ['--version'], opts).status === 0;
    } catch { _tesseract = false; }
  }
  return _tesseract;
}
/** True when a vision command is configured AND present on this machine. */
function hasVision() {
  if (_vision === undefined) {
    const vision = (config().resolvers || {}).vision || {};
    if (!vision.command) { _vision = false; return _vision; }
    try {
      const probe = vision.versionArgs || ['--version'];
      _vision = spawnSync(vision.command, probe, { shell: process.platform === 'win32' }).status === 0;
    } catch { _vision = false; }
  }
  return _vision;
}
function sharp() { return _sharp || (_sharp = require('sharp')); }
function pixelmatch() { return _pixelmatch || (_pixelmatch = require('pixelmatch')); }
function PNG() { return _png || (_png = require('pngjs').PNG); }

// ── Tier 2: OCR ─────────────────────────────────────────────────────────────
/**
 * Locate `label` by OCRing the current viewport. Uses Tesseract's TSV output to get a
 * bounding box per word, then matches (exact or contains) and returns the box center.
 * Skipped gracefully if the tesseract binary isn't installed.
 */
async function resolveByOCR(page, label, opts = {}) {
  if (!hasTesseract()) return { pick: null, skipped: 'no-tesseract' };
  const { contains = false, ymin = 0, ymax = 1e9, xmin = 0, xmax = 1e9 } = opts;
  const buf = await page.screenshot();               // viewport PNG
  // Temp images go to the OS temp dir, never the repo: an intermediate of a page that has
  // not been redacted yet must not land anywhere a `git add .` could pick it up.
  const tmp = path.join(os.tmpdir(), `capture-ocr-${process.pid}.png`);
  await sharp()(buf).grayscale().normalise().toFile(tmp);
  // tesseract <img> stdout tsv  → columns incl. left top width height conf text
  const { bin: tbin, opts: topts } = tessSpawnOpts({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const r = spawnSync(tbin, [tmp, 'stdout', '--psm', '11', 'tsv'], topts);
  try { fs.unlinkSync(tmp); } catch {}
  if (r.status !== 0 || !r.stdout) return { pick: null, skipped: 'ocr-failed' };

  const rows = r.stdout.split('\n').slice(1).map(l => l.split('\t')).filter(c => c.length >= 12);
  // Reassemble line-level phrases so multi-word labels ("Submit for Review") match.
  const words = rows.map(c => ({
    x: +c[6], y: +c[7], w: +c[8], h: +c[9], conf: +c[10], text: (c[11] || '').trim(),
    line: `${c[2]}:${c[3]}:${c[4]}`,
  })).filter(w => w.text && w.conf > 40 && w.y >= ymin && w.y <= ymax && w.x >= xmin && w.x <= xmax);

  const hits = [];
  // exact single-word / contains match
  for (const w of words) {
    const m = contains ? w.text.toLowerCase().includes(label.toLowerCase()) : w.text === label;
    if (m) hits.push({ x: w.x + w.w / 2, y: w.y + w.h / 2, w: w.w, h: w.h, conf: w.conf });
  }
  // multi-word: group words on the same line and test the joined phrase
  if (!hits.length && label.includes(' ')) {
    const byLine = {};
    for (const w of words) (byLine[w.line] ||= []).push(w);
    for (const grp of Object.values(byLine)) {
      grp.sort((a, b) => a.x - b.x);
      const phrase = grp.map(w => w.text).join(' ');
      const m = contains ? phrase.toLowerCase().includes(label.toLowerCase()) : phrase === label;
      if (m) {
        const xs = grp.map(w => w.x), ys = grp.map(w => w.y);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        const x1 = Math.max(...grp.map(w => w.x + w.w)), y1 = Math.max(...grp.map(w => w.y + w.h));
        hits.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, conf: 60 });
      }
    }
  }
  hits.sort((a, b) => a.y - b.y || a.x - b.x);
  return { pick: hits[opts.nth || 0] || null, total: hits.length, via: 'ocr' };
}

// ── Tier 3: template match ─────────────────────────────────────────────────────
/**
 * Locate a control by sliding a saved reference crop over the screenshot and finding the
 * lowest-difference position (coarse grid + refine). Reference crops live in the directory
 * named by `resolvers.templateDir`. Best for icons and unlabelled buttons that never carry
 * text. Skipped if no template file is found for `name`.
 *
 * The kit ships no crops. They are screenshots of your own application, which means they
 * are yours to keep local — .gitignore blocks the whole class.
 *
 * @param {string} name basename of the reference crop (without .png)
 * @param {object} opts {threshold=0.12 max mean-diff to accept, step=8 coarse stride}
 */
async function resolveByTemplate(page, name, opts = {}) {
  const templateDir = resolvePath((config().resolvers || {}).templateDir || 'assets/templates');
  const tplPath = opts.templatePath || path.join(templateDir, `${name}.png`);
  if (!fs.existsSync(tplPath)) return { pick: null, skipped: 'no-template' };
  const { threshold = 0.12, step = 8 } = opts;

  const shotBuf = await page.screenshot();
  const scene = PNG().sync.read(await sharp()(shotBuf).png().toBuffer());
  const tpl = PNG().sync.read(await sharp()(fs.readFileSync(tplPath)).png().toBuffer());
  if (tpl.width > scene.width || tpl.height > scene.height) return { pick: null, skipped: 'template-too-big' };

  const pm = pixelmatch();
  const diffAt = (ox, oy) => {
    // crop scene window == template size, diff against template
    const win = new (PNG())({ width: tpl.width, height: tpl.height });
    for (let y = 0; y < tpl.height; y++) {
      for (let x = 0; x < tpl.width; x++) {
        const si = ((oy + y) * scene.width + (ox + x)) * 4;
        const di = (y * tpl.width + x) * 4;
        win.data[di] = scene.data[si]; win.data[di + 1] = scene.data[si + 1];
        win.data[di + 2] = scene.data[si + 2]; win.data[di + 3] = scene.data[si + 3];
      }
    }
    const nMismatch = pm(win.data, tpl.data, null, tpl.width, tpl.height, { threshold: 0.1 });
    return nMismatch / (tpl.width * tpl.height); // fraction of mismatched pixels
  };

  let best = { score: 1, x: 0, y: 0 };
  for (let oy = 0; oy + tpl.height <= scene.height; oy += step) {
    for (let ox = 0; ox + tpl.width <= scene.width; ox += step) {
      const s = diffAt(ox, oy);
      if (s < best.score) best = { score: s, x: ox, y: oy };
    }
  }
  // refine around the coarse winner
  for (let oy = Math.max(0, best.y - step); oy <= Math.min(scene.height - tpl.height, best.y + step); oy++) {
    for (let ox = Math.max(0, best.x - step); ox <= Math.min(scene.width - tpl.width, best.x + step); ox++) {
      const s = diffAt(ox, oy);
      if (s < best.score) best = { score: s, x: ox, y: oy };
    }
  }
  if (best.score > threshold) return { pick: null, skipped: `no-match(${best.score.toFixed(3)})` };
  return { pick: { x: best.x + tpl.width / 2, y: best.y + tpl.height / 2, score: best.score }, via: 'template' };
}

// ── Tier 4: vision model ───────────────────────────────────────────────────────
/**
 * Ask an external vision model for the pixel coordinates of `label`'s clickable control.
 * The current screenshot is passed to the command named by `resolvers.vision.command`,
 * along with a JSON schema so the answer can be parsed rather than scraped. A model sees
 * what a human sees, so this survives arbitrary DOM and canvas rendering.
 *
 * Skipped when no vision command is configured, which is the default.
 *
 * THIS TIER SENDS A SCREENSHOT OF THE PAGE TO THE CONFIGURED COMMAND. If that command
 * talks to a hosted model, the capture leaves the machine, and it does so on a fallback
 * path that only fires when the cheaper tiers miss — i.e. rarely and unpredictably. That
 * is a data-handling decision, not an implementation detail. Remove 'vlm' from
 * `resolvers.tiers` if the answer is no.
 */
async function resolveByVLM(page, label, opts = {}) {
  if (!hasVision()) return { pick: null, skipped: 'no-vision-command' };
  const vision = (config().resolvers || {}).vision || {};
  const tmpDir = os.tmpdir();
  const shot = path.join(tmpDir, `capture-vlm-${process.pid}.png`);
  const vp = page.viewportSize() || config().viewport || { width: 1440, height: 900 };
  await page.screenshot({ path: shot });

  const schemaPath = path.join(tmpDir, `capture-vlm-schema-${process.pid}.json`);
  fs.writeFileSync(schemaPath, JSON.stringify({
    type: 'object', additionalProperties: false,
    required: ['found', 'x', 'y', 'reason'],
    properties: {
      found: { type: 'boolean' },
      x: { type: 'number' }, y: { type: 'number' },
      reason: { type: 'string' },
    },
  }));
  // Band awareness: the DOM/OCR/template tiers honor ymin/ymax/xmin/xmax to disambiguate
  // duplicate labels, but the VLM sees the whole screen and would otherwise ignore them
  // (this is what made it resolve "Dashboard" to the Main button on the left instead of
  // the top-right dropdown). Translate any supplied band into an explicit search-region
  // instruction, and reject an out-of-band pick after the fact.
  const hasBand = opts.ymin != null || opts.ymax != null || opts.xmin != null || opts.xmax != null;
  const bx0 = opts.xmin != null ? Math.round(opts.xmin) : 0;
  const bx1 = opts.xmax != null && opts.xmax < 1e5 ? Math.round(opts.xmax) : vp.width;
  const by0 = opts.ymin != null ? Math.round(opts.ymin) : 0;
  const by1 = opts.ymax != null && opts.ymax < 1e5 ? Math.round(opts.ymax) : vp.height;
  const bandClause = hasBand
    ? ` IMPORTANT: only consider controls whose CENTER falls inside the rectangle x=${bx0}..${bx1}, y=${by0}..${by1} (pixels). Ignore anything outside that region even if it matches the text.`
    : '';
  const prompt = `The attached ${vp.width}x${vp.height} screenshot is a screenshot of a business web application. Find the clickable control best matching "${label}"${opts.hint ? ' (' + opts.hint + ')' : ''}.${bandClause} Return its CENTER pixel coordinates in the image's own pixel space (top-left origin). If it is not visible, set found=false. Do NOT describe how to click it — only locate it. reason: one short phrase on what you saw.`;

  const out = await new Promise((resolve) => {
    // The argv template lives in config so any CLI that can take an image, a JSON schema,
    // and a prompt on stdin can be dropped in. Placeholders: {root} {image} {schema} {out}.
    const args = (vision.args || []).map((arg) => String(arg)
      .replace('{root}', REPO_ROOT)
      .replace('{image}', shot)
      .replace('{schema}', schemaPath)
      .replace('{out}', shot + '.msg'));
    if (vision.stdinSentinel) args.push(vision.stdinSentinel);
    const child = spawn(vision.command, args, {
      cwd: REPO_ROOT, shell: process.platform === 'win32',
      env: { ...process.env, CAPTURE_READONLY: '1', CAPTURE_NO_SUBMIT: '1' },
    });
    child.stdin.write(prompt); child.stdin.end();
    let done = false;
    const budget = opts.timeoutMs || vision.timeoutMs || 60000;
    const timer = setTimeout(() => { if (!done) { child.kill('SIGKILL'); resolve(null); } }, budget);
    child.on('close', () => {
      done = true; clearTimeout(timer);
      try { resolve(fs.readFileSync(shot + '.msg', 'utf8')); } catch { resolve(null); }
    });
    child.on('error', () => { done = true; clearTimeout(timer); resolve(null); });
  });
  try { fs.unlinkSync(shot); fs.unlinkSync(shot + '.msg'); fs.unlinkSync(schemaPath); } catch {}
  if (!out) return { pick: null, skipped: 'vlm-no-output' };
  let obj; try { obj = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); } catch { return { pick: null, skipped: 'vlm-parse' }; }
  if (!obj.found) return { pick: null, skipped: 'vlm-not-found', reason: obj.reason };
  // The screenshot may be at a different pixel scale than CSS coords; scale back.
  // sharp() is the lazy require above, so sharp()(input) is correct. `shot` is already
  // unlinked by this point, so the existsSync branch never taken -- the buffer path is
  // the live one. Left as-is rather than "simplified" into sharp(buf), which would call
  // the loader with an ignored argument and then .metadata() on the module itself.
  const meta = await sharp()(fs.existsSync(shot) ? shot : await page.screenshot()).metadata().catch(() => null);
  let x = obj.x, y = obj.y;
  if (meta && meta.width && meta.width !== vp.width) { const s = vp.width / meta.width; x *= s; y *= s; }
  // Enforce the band even if the model drifted outside it (belt to the prompt's suspenders).
  // A small tolerance absorbs center-vs-edge rounding.
  if (hasBand) {
    const tol = 8;
    if (x < bx0 - tol || x > bx1 + tol || y < by0 - tol || y > by1 + tol) {
      return { pick: null, skipped: `vlm-out-of-band(${Math.round(x)},${Math.round(y)})`, reason: obj.reason };
    }
  }
  return { pick: { x, y, reason: obj.reason }, via: 'vlm' };
}

// ── The cascade ─────────────────────────────────────────────────────────────
/**
 * Resolve a target's click point by trying tiers in order until one returns a pick.
 * Tier 1 (DOM) is provided by the caller as `domResolver` so we don't create a require
 * cycle with nav.js.
 *
 * @param {object} page
 * @param {string} label
 * @param {object} opts   {ymin,ymax,xmin,xmax,nth,contains,template,hint,tiers,onTier}
 * @param {function} domResolver  async (page,label,opts)=>{pick,total} — nav.resolveLabel
 * @returns {Promise<{pick,via,attempts:[{via,skipped?}]}>}
 */
async function resolveCascade(page, label, opts, domResolver) {
  const tiers = opts.tiers || ['dom', 'ocr', 'template', 'vlm'];
  const attempts = [];
  const log = opts.onTier || (() => {});

  for (const tier of tiers) {
    let res;
    if (tier === 'dom') res = domResolver ? await domResolver(page, label, opts) : { pick: null, skipped: 'no-dom-resolver' };
    else if (tier === 'ocr') res = await resolveByOCR(page, label, opts);
    else if (tier === 'template') res = opts.template ? await resolveByTemplate(page, opts.template, opts) : { pick: null, skipped: 'no-template-name' };
    else if (tier === 'vlm') res = await resolveByVLM(page, label, opts);
    else continue;

    if (res && res.pick) {
      attempts.push({ via: tier });
      if (tier !== 'dom') {
        log(`  [resolver] fallback: "${label}" found via ${tier.toUpperCase()} at (${Math.round(res.pick.x)},${Math.round(res.pick.y)})${res.pick.reason ? ' — ' + res.pick.reason : ''}`);
      }
      return { pick: res.pick, via: tier, attempts };
    }
    attempts.push({ via: tier, skipped: (res && res.skipped) || 'no-hit' });
  }
  return { pick: null, via: 'none', attempts };
}

module.exports = {
  resolveCascade, resolveByOCR, resolveByTemplate, resolveByVLM,
  hasTesseract, hasVision, tesseractBin,
};
