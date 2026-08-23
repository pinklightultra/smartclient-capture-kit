#!/usr/bin/env node
/**
 * annotate.js — crop and mark up a captured screenshot for documentation.
 *
 *   node annotate.js --in shots/users.png --out doc/users.png \
 *     --crop 0,56,1440,844 --highlight 120,200,300,48 --callout 270,200,"1"
 *
 *   node annotate.js --in shots/queue.png --out doc/queue.png \
 *     --arrow 400,120,520,180 --callout 400,110,"Click Assign" --focus 300,80,600,300
 *
 * Repeat --highlight, --arrow and --callout as many times as you need. Marks are drawn in
 * that order: boxes, then arrows, then callouts on top.
 *
 * COORDINATES ARE POST-CROP. --crop is applied first and everything else is measured
 * against the cropped frame. `--describe` prints the dimensions you are working in without
 * writing anything.
 *
 * --focus blurs everything outside a box to direct the eye. It is NOT redaction: see
 * lib/redact.js, which covers sensitive values in the live DOM before the pixels are ever
 * captured. Blur applied afterwards leaves the original on disk and can be partly undone.
 *
 * EXIT CODES
 *   0  wrote the file
 *   1  bad arguments, unreadable input, or geometry outside the image
 */
const path = require('path');
const {
  annotate, describe, parseRect, parseArrow, parseCallout, AnnotateError,
} = require('./lib/annotate');

const args = process.argv.slice(2);
const one = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const many = (flag) => args.reduce((acc, a, i) => {
  if (a === flag && args[i + 1] !== undefined) acc.push(args[i + 1]);
  return acc;
}, []);

function usage(code) {
  const out = code === 0 ? console.log : console.error;
  out('Usage: node annotate.js --in <image> --out <image> [marks]');
  out('');
  out('  --crop x,y,w,h        crop first; all other coordinates are post-crop');
  out('  --highlight x,y,w,h   box around a control (repeatable)');
  out('  --arrow x1,y1,x2,y2   arrow pointing at something (repeatable)');
  out('  --callout x,y,text    labelled bubble with a tail at x,y (repeatable)');
  out('  --focus x,y,w,h       blur everything outside this box. NOT redaction');
  out('  --accent #RRGGBB      override the box/arrow colour for this run');
  out('  --font-size N         callout text size (default from config)');
  out('  --describe            print the post-crop dimensions and exit, writing nothing');
  out('');
  out('Colours and sizes default to the `annotate` section of capture.config.json.');
  process.exit(code);
}

if (args.includes('--help') || args.includes('-h')) usage(0);

const input = one('--in');
if (!input) {
  console.error('--in is required.');
  usage(1);
}

(async () => {
  try {
    const crop = one('--crop') ? parseRect(one('--crop'), '--crop') : null;

    if (args.includes('--describe')) {
      const d = await describe(input, crop);
      console.log(`${path.basename(input)} is ${d.sourceWidth}x${d.sourceHeight}`);
      if (d.cropped) console.log(`after --crop you are working in ${d.width}x${d.height}, origin at the crop's top-left`);
      else console.log('no --crop given, so coordinates are relative to the whole image');
      process.exit(0);
    }

    const out = one('--out');
    if (!out) {
      console.error('--out is required (or pass --describe to inspect without writing).');
      usage(1);
    }

    const styleOverrides = {};
    if (one('--accent')) styleOverrides.accent = one('--accent');
    if (one('--font-size')) {
      const n = Number(one('--font-size'));
      if (!Number.isFinite(n) || n <= 0) throw new AnnotateError(`--font-size must be a positive number, got "${one('--font-size')}"`);
      styleOverrides.fontSize = n;
    }

    const ops = {
      crop,
      focus: one('--focus') ? parseRect(one('--focus'), '--focus') : null,
      highlights: many('--highlight').map((v) => parseRect(v, '--highlight')),
      arrows: many('--arrow').map(parseArrow),
      callouts: many('--callout').map(parseCallout),
      styleOverrides,
    };

    const total = ops.highlights.length + ops.arrows.length + ops.callouts.length + (ops.focus ? 1 : 0) + (crop ? 1 : 0);
    if (total === 0) {
      // Copying the file unchanged and printing a success line would be the wrong answer to
      // "annotate this": nothing was asked for, so nothing was done, and saying "wrote
      // out.png" would imply otherwise.
      console.error('Nothing to do: no --crop, --highlight, --arrow, --callout or --focus given.');
      usage(1);
    }

    const r = await annotate(input, out, ops);
    const bits = [];
    if (r.cropped) bits.push(`cropped to ${r.width}x${r.height} from ${r.sourceWidth}x${r.sourceHeight}`);
    if (r.focused) bits.push('focus blur');
    if (r.marks.highlights) bits.push(`${r.marks.highlights} highlight${r.marks.highlights === 1 ? '' : 's'}`);
    if (r.marks.arrows) bits.push(`${r.marks.arrows} arrow${r.marks.arrows === 1 ? '' : 's'}`);
    if (r.marks.callouts) bits.push(`${r.marks.callouts} callout${r.marks.callouts === 1 ? '' : 's'}`);
    console.log(`Wrote ${r.outPath} (${bits.join(', ')})`);
    if (r.focused) console.log('Focus blur directs the eye. It is not redaction, and the unblurred source is still on disk.');
  } catch (err) {
    console.error(err instanceof AnnotateError ? err.message : `unexpected: ${err.stack}`);
    process.exit(1);
  }
})();
