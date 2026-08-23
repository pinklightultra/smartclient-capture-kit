/**
 * lib/annotate.js — crop, highlight, arrow, callout and focus-blur for a captured PNG.
 *
 * WHAT THIS IS
 * ------------
 * The step after capture. You have a screenshot and the documentation needs it cropped to
 * the relevant panel with a box around the control and a numbered callout beside it. Every
 * mark is drawn as SVG and composited by sharp, so the source image is never re-encoded
 * more than once and the marks are crisp at any size.
 *
 * Order is fixed and matters: CROP first, then blur, then boxes, arrows and callouts on
 * top. Every coordinate you pass is relative to the image AFTER cropping, because measuring
 * against the original and having the crop silently shift your boxes is the mistake this
 * ordering exists to prevent. `describe()` prints the post-crop dimensions.
 *
 * WHAT IT IS NOT
 * --------------
 * **Not a redaction tool, and `focus` is not a redaction mechanism.** Blurring is a
 * post-process on an image that already exists: the unblurred original is still on disk,
 * the blur is applied to whatever happened to be in the frame rather than to values
 * identified as sensitive, and a mild blur can be partially reversed. lib/redact.js covers
 * the sensitive pixels in the live DOM so they are never captured at all, and that is the
 * only thing in this repo that should be relied on for PII. `focus` exists to direct a
 * reader's eye, nothing more.
 *
 * It also does not fabricate UI states. The tool this was drawn from could swap the text in
 * a field to make a screenshot show a value the application never displayed. That is left
 * behind deliberately: this repo's whole position is that a capture is evidence of what the
 * application did, and it needed matching font metrics to look right, which it never did.
 *
 * TEXT WIDTH IS ESTIMATED
 * -----------------------
 * Callout bubbles are sized from a per-character width table, not from real font metrics,
 * because measuring text properly needs a font stack this module deliberately does not
 * load. The estimate is deliberately generous and the bubble is clamped inside the canvas,
 * so the failure mode is a bubble slightly wider than it needs to be rather than text
 * overflowing its box or a bubble rendered off-canvas where SVG silently clips it.
 */
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

let _sharp;
function sharp() { return _sharp || (_sharp = require('sharp')); }

/** Thrown for any invalid geometry or unreadable input. Never downgraded to a warning. */
class AnnotateError extends Error {
  constructor(message, detail = {}) {
    super(`annotate failed: ${message}`);
    this.name = 'AnnotateError';
    this.detail = detail;
  }
}

function style() {
  return { ...(config().annotate || {}) };
}

/**
 * Approximate rendered width of one line at a given font size.
 *
 * A flat "8px per character" estimate, which is what this replaced, is wrong in both
 * directions by a factor of three: "WWWW" is roughly 4x the width of "iiii". Overflowing
 * text is the visible failure, so the classes below round up.
 */
const NARROW = new Set([...'iljItf.,;:\'"`|!()[]{}-']);
const WIDE = new Set([...'WMQ@%&mw']);
function estimateTextWidth(text, fontSize) {
  let units = 0;
  for (const ch of String(text)) {
    if (NARROW.has(ch)) units += 0.34;
    else if (WIDE.has(ch)) units += 0.92;
    else if (ch === ' ') units += 0.30;
    else if (ch >= 'A' && ch <= 'Z') units += 0.70;
    else units += 0.58;
  }
  // Bold text is wider than regular at the same size, and callout labels are bold.
  return Math.ceil(units * fontSize * 1.08);
}

/** "x,y,w,h" -> {x,y,width,height}. Throws rather than yielding NaN. */
function parseRect(str, flag = 'rect') {
  const parts = String(str).split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new AnnotateError(`${flag} needs four numbers "x,y,width,height", got "${str}"`);
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) throw new AnnotateError(`${flag} has non-positive size: ${width}x${height}`);
  return { x, y, width, height };
}

/** "x1,y1,x2,y2" -> {x1,y1,x2,y2}. */
function parseArrow(str) {
  const parts = String(str).split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new AnnotateError(`--arrow needs four numbers "x1,y1,x2,y2", got "${str}"`);
  }
  const [x1, y1, x2, y2] = parts;
  if (x1 === x2 && y1 === y2) throw new AnnotateError('--arrow start and end are the same point, so it has no direction');
  return { x1, y1, x2, y2 };
}

/** "x,y,text" -> {x,y,text}. Commas after the third field belong to the text. */
function parseCallout(str) {
  const s = String(str);
  const first = s.indexOf(',');
  const second = s.indexOf(',', first + 1);
  if (first < 0 || second < 0) throw new AnnotateError(`--callout needs "x,y,text", got "${s}"`);
  const x = Number(s.slice(0, first).trim());
  const y = Number(s.slice(first + 1, second).trim());
  const text = s.slice(second + 1);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new AnnotateError(`--callout x,y are not numbers in "${s}"`);
  if (!text.trim()) throw new AnnotateError(`--callout has empty text in "${s}"`);
  return { x, y, text };
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Reject geometry that falls outside the image.
 *
 * The version this came from validated nothing. sharp clips a composite that runs off the
 * edge and SVG clips silently, so an off-image highlight produced a clean-looking annotated
 * screenshot with no box on it and no error anywhere — you found out by looking, if you
 * looked. Named coordinates and the actual dimensions go in the message so the fix is
 * obvious.
 */
function assertInside(what, box, width, height) {
  const over = [];
  if (box.x < 0) over.push(`x ${box.x} < 0`);
  if (box.y < 0) over.push(`y ${box.y} < 0`);
  if (box.x + box.width > width) over.push(`right edge ${box.x + box.width} > width ${width}`);
  if (box.y + box.height > height) over.push(`bottom edge ${box.y + box.height} > height ${height}`);
  if (over.length) {
    throw new AnnotateError(`${what} falls outside the ${width}x${height} image: ${over.join(', ')}`,
      { what, box, width, height });
  }
}

function assertPointInside(what, x, y, width, height) {
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new AnnotateError(`${what} point (${x},${y}) is outside the ${width}x${height} image`, { what, x, y });
  }
}

function highlightSvg(rect, s) {
  return `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" `
    + `fill="none" stroke="${s.accent}" stroke-width="${s.strokeWidth}" rx="2" ry="2" />`;
}

function arrowSvg(a, s) {
  const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const headLen = Math.max(10, s.strokeWidth * 4.5);
  const spread = Math.PI / 6;
  const ax = a.x2 - headLen * Math.cos(angle - spread);
  const ay = a.y2 - headLen * Math.sin(angle - spread);
  const bx = a.x2 - headLen * Math.cos(angle + spread);
  const by = a.y2 - headLen * Math.sin(angle + spread);
  // Stop the shaft short of the tip so the line does not show through the arrowhead.
  const sx = a.x2 - headLen * 0.75 * Math.cos(angle);
  const sy = a.y2 - headLen * 0.75 * Math.sin(angle);
  return `<line x1="${a.x1}" y1="${a.y1}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" `
    + `stroke="${s.accent}" stroke-width="${s.strokeWidth}" stroke-linecap="round" />`
    + `<polygon points="${a.x2},${a.y2} ${ax.toFixed(1)},${ay.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}" fill="${s.accent}" />`;
}

/**
 * A callout bubble with a tail pointing at (x, y).
 *
 * Placed above the point when there is room and flipped below when there is not. The
 * version this came from always subtracted the bubble height from y, so a callout on
 * anything in the top ~45 pixels of the image — a toolbar button, a tab, a menu, which is
 * most of what gets called out — was drawn at a negative y and clipped away to nothing.
 * Horizontally the bubble is clamped into the canvas for the same reason.
 */
function calloutSvg(c, s, width, height) {
  const pad = 10, tail = 8;
  const lines = String(c.text).split('\n');
  const boxWidth = Math.max(...lines.map((l) => estimateTextWidth(l, s.fontSize))) + pad * 2;
  const lineHeight = Math.round(s.fontSize * 1.35);
  const boxHeight = lines.length * lineHeight + pad * 2 - (lineHeight - s.fontSize);

  const roomAbove = c.y - boxHeight - tail >= 0;
  const by = roomAbove ? c.y - boxHeight - tail : c.y + tail;
  let bx = c.x - boxWidth / 2;
  bx = Math.max(2, Math.min(bx, width - boxWidth - 2));

  // The tail stays attached to the point even after the box is clamped sideways, but it must
  // not slide past the box's own rounded corners.
  const tx = Math.max(bx + 8, Math.min(c.x, bx + boxWidth - 8));
  const tailY = roomAbove ? by + boxHeight : by;
  const tip = roomAbove ? tailY + tail : tailY - tail;

  const text = lines.map((line, i) => {
    const ty = by + pad + s.fontSize * 0.85 + i * lineHeight;
    return `<text x="${bx + boxWidth / 2}" y="${ty.toFixed(1)}" text-anchor="middle" `
      + `font-family="${escapeXml(s.fontFamily)}" font-size="${s.fontSize}" font-weight="bold" `
      + `fill="${s.calloutText}">${escapeXml(line)}</text>`;
  }).join('');

  return `<rect x="${bx.toFixed(1)}" y="${by}" width="${boxWidth}" height="${boxHeight}" `
    + `fill="${s.calloutBg}" stroke="${s.calloutBorder}" stroke-width="2" rx="4" ry="4" filter="url(#shadow)" />`
    + `<polygon points="${tx - 6},${tailY} ${c.x},${tip} ${tx + 6},${tailY}" `
    + `fill="${s.calloutBg}" stroke="${s.calloutBorder}" stroke-width="1" />`
    + text;
}

function overlaySvg(width, height, marks, s) {
  const els = [
    ...marks.highlights.map((r) => highlightSvg(r, s)),
    ...marks.arrows.map((a) => arrowSvg(a, s)),
    ...marks.callouts.map((c) => calloutSvg(c, s, width, height)),
  ];
  if (!els.length) return null;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + '<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
    + '<feDropShadow dx="1" dy="2" stdDeviation="2" flood-opacity="0.35" /></filter></defs>'
    + els.join('') + '</svg>');
}

/** Post-crop dimensions, so a caller can measure coordinates against the right frame. */
async function describe(source, crop = null) {
  if (!fs.existsSync(source)) throw new AnnotateError(`no such file: ${source}`);
  if (fs.statSync(source).size === 0) throw new AnnotateError(`zero-byte file: ${path.basename(source)}`);
  let meta;
  try {
    meta = await sharp()(source).metadata();
  } catch (err) {
    throw new AnnotateError(`cannot decode ${path.basename(source)}`, { cause: err.message });
  }
  if (!meta.width || !meta.height) throw new AnnotateError(`${path.basename(source)} reports no dimensions`);
  if (!crop) return { width: meta.width, height: meta.height, cropped: false, sourceWidth: meta.width, sourceHeight: meta.height };
  assertInside('--crop', crop, meta.width, meta.height);
  return { width: crop.width, height: crop.height, cropped: true, sourceWidth: meta.width, sourceHeight: meta.height };
}

/**
 * Annotate one image.
 *
 * @param {string} source input PNG/JPEG
 * @param {string} outPath output PNG. Refused if it resolves to `source`.
 * @param {object} [ops] crop {x,y,width,height}, focus {x,y,width,height},
 *   highlights [], arrows [], callouts [], styleOverrides {}
 * @returns {Promise<object>} { outPath, width, height, marks: {highlights, arrows, callouts}, cropped, focused }
 */
async function annotate(source, outPath, ops = {}) {
  if (!outPath) throw new AnnotateError('no output path given');
  if (path.resolve(source) === path.resolve(outPath)) {
    // Overwriting in place destroys the only copy of the unannotated capture, and there is
    // no way to un-annotate. Re-cropping a cropped file also compounds silently.
    throw new AnnotateError('refusing to write over the source image; choose a different --out');
  }
  const s = { ...style(), ...(ops.styleOverrides || {}) };
  const crop = ops.crop || null;
  const dims = await describe(source, crop);
  const { width, height } = dims;

  const marks = {
    highlights: ops.highlights || [],
    arrows: ops.arrows || [],
    callouts: ops.callouts || [],
  };
  marks.highlights.forEach((r, i) => assertInside(`--highlight #${i + 1}`, r, width, height));
  marks.arrows.forEach((a, i) => {
    assertPointInside(`--arrow #${i + 1} start`, a.x1, a.y1, width, height);
    assertPointInside(`--arrow #${i + 1} end`, a.x2, a.y2, width, height);
  });
  marks.callouts.forEach((c, i) => assertPointInside(`--callout #${i + 1}`, c.x, c.y, width, height));
  if (ops.focus) assertInside('--focus', ops.focus, width, height);

  let img = sharp()(source);
  if (crop) img = img.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });

  let base = await img.png().toBuffer();

  if (ops.focus) {
    // Blur the whole frame, then paste the sharp focus region back over it. Blurring a
    // region in isolation and compositing it leaves a visible seam at the boundary.
    const sharpRegion = await sharp()(base)
      .extract({ left: ops.focus.x, top: ops.focus.y, width: ops.focus.width, height: ops.focus.height })
      .png().toBuffer();
    base = await sharp()(base)
      .blur(s.blurSigma)
      .composite([{ input: sharpRegion, left: ops.focus.x, top: ops.focus.y }])
      .png().toBuffer();
  }

  const svg = overlaySvg(width, height, marks, s);
  if (svg) base = await sharp()(base).composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, base);

  return {
    outPath,
    width, height,
    sourceWidth: dims.sourceWidth, sourceHeight: dims.sourceHeight,
    cropped: Boolean(crop),
    focused: Boolean(ops.focus),
    marks: {
      highlights: marks.highlights.length,
      arrows: marks.arrows.length,
      callouts: marks.callouts.length,
    },
  };
}

module.exports = {
  annotate, describe, parseRect, parseArrow, parseCallout,
  estimateTextWidth, escapeXml, AnnotateError,
};
