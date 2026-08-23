#!/usr/bin/env node
/**
 * Local-only smoke test for the capture kit.
 *
 * Verifies:
 * - bundled Chromium launches
 * - CDP attachment works
 * - the read-only guard blocks mutating controls but allows ordinary controls
 * - screenshot redaction finds PHI/PII and writes a PNG
 * - safeShot(), the capture front door, covers a configured column's values
 * - safeShot() writes NO FILE when a configured column is on screen but uncoverable
 * - lib/diff.js measures a known change exactly, pads instead of scaling, and THROWS
 *   on an unreadable image rather than reporting it as unchanged
 * - lib/annotate.js draws where it was asked to, keeps a callout on the canvas instead of
 *   clipping it away, and refuses geometry that falls outside the image
 *
 * No application environment or credentials are used. Everything runs against a
 * synthetic page built by setContent below, so this is safe to run anywhere.
 */

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { installClickGuard } = require('../lib/guard');
const { redact, RedactionError } = require('../lib/redact');
const { safeShot, environmentColumns } = require('../lib/capture-safe');

process.env.CAPTURE_READONLY = '1';
process.env.CAPTURE_NO_SUBMIT = '1';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function connectOverCdpWithRetry(port) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

/**
 * lib/diff.js checks. No browser, no credentials, so these run first: a diff bug should
 * fail in a second rather than after a Chromium launch.
 *
 * Every expected value here is arithmetic done by hand, not a figure captured from a
 * previous run. A golden number recorded from the code under test only proves the code
 * still does what it did, which is not the same as doing the right thing.
 */
async function diffChecks() {
  const sharp = require('sharp');
  const { compareImages, listPairs, diffRuns, DiffError } = require('../lib/diff');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-kit-diff-'));
  const solid = (w, h, c) => sharp({ create: { width: w, height: h, channels: 4, background: c } }).png();
  const BLUE = { r: 20, g: 90, b: 170, alpha: 1 };
  const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
  const p = (n) => path.join(dir, n);

  try {
    // 1. Identical images differ by nothing. Anything above 0 here means the pipeline is
    //    introducing noise of its own, and every other number is then untrustworthy.
    await solid(200, 150, BLUE).toFile(p('a.png'));
    await solid(200, 150, BLUE).toFile(p('b.png'));
    const same = await compareImages(p('a.png'), p('b.png'));
    assert.equal(same.diffPercent, 0, `identical images reported ${same.diffPercent}% different`);
    assert.equal(same.padded, false, 'same-size images were reported as padded');

    // 2. A 20x20 square on a 200x150 image is 400 of 30000 pixels, which is 1.33%.
    const square = await solid(20, 20, { r: 255, g: 0, b: 0, alpha: 1 }).toBuffer();
    await sharp(p('a.png')).composite([{ input: square, left: 0, top: 0 }]).png().toFile(p('c.png'));
    const small = await compareImages(p('a.png'), p('c.png'));
    assert.equal(small.diffPixels, 400, `expected exactly 400 changed pixels, got ${small.diffPixels}`);
    assert.equal(small.diffPercent, 1.33, `expected 1.33%, got ${small.diffPercent}%`);

    // 3. THE PADDING CHECK. A 300x200 capture against a 300x350 one whose top 200px is
    //    byte-identical and whose extra 150px is new content. Only the new region differs:
    //    300*150 / 300*350 = 42.86%. Scaling to fit would centre the letterbox, shift the
    //    identical header down by 75px, and overstate this.
    const header = await solid(300, 200, BLUE).toBuffer();
    const rows = await solid(300, 150, { r: 240, g: 240, b: 120, alpha: 1 }).toBuffer();
    await sharp({ create: { width: 300, height: 200, channels: 4, background: WHITE } })
      .composite([{ input: header, left: 0, top: 0 }]).png().toFile(p('short.png'));
    await sharp({ create: { width: 300, height: 350, channels: 4, background: WHITE } })
      .composite([{ input: header, left: 0, top: 0 }, { input: rows, left: 0, top: 200 }])
      .png().toFile(p('tall.png'));
    const grew = await compareImages(p('short.png'), p('tall.png'));
    assert.equal(grew.diffPercent, 42.86, `expected 42.86% for the grown region, got ${grew.diffPercent}%`);
    assert.equal(grew.padded, true, 'a size difference was not reported as padded');
    assert.equal(grew.sizeA, '300x200');
    assert.equal(grew.sizeB, '300x350');

    // 4. An unreadable image THROWS. This is the check that matters most: the version this
    //    was extracted from returned { diffPercent: null }, and `null > threshold` is false,
    //    so a truncated capture was reported as unchanged. Assert the throw, not a value.
    fs.writeFileSync(p('corrupt.png'), 'this is not a png');
    await assert.rejects(() => compareImages(p('a.png'), p('corrupt.png')),
      (e) => e instanceof DiffError, 'an undecodable image did not throw DiffError');
    fs.writeFileSync(p('empty.png'), '');
    await assert.rejects(() => compareImages(p('a.png'), p('empty.png')),
      (e) => e instanceof DiffError, 'a zero-byte image did not throw DiffError');
    await assert.rejects(() => compareImages(p('a.png'), p('does-not-exist.png')),
      (e) => e instanceof DiffError, 'a missing image did not throw DiffError');

    // 5. diffRuns records a failure as a failure. If a bad pair ever lands in `unchanged`
    //    the whole tool becomes a machine for overlooking broken captures.
    const runA = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-runA-'));
    const runB = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-runB-'));
    try {
      fs.copyFileSync(p('a.png'), path.join(runA, 'same.png'));
      fs.copyFileSync(p('b.png'), path.join(runB, 'same.png'));
      fs.copyFileSync(p('a.png'), path.join(runA, 'moved.png'));
      fs.copyFileSync(p('c.png'), path.join(runB, 'moved.png'));
      fs.copyFileSync(p('a.png'), path.join(runA, 'broken.png'));
      fs.writeFileSync(path.join(runB, 'broken.png'), 'not a png');
      fs.copyFileSync(p('a.png'), path.join(runA, 'gone.png'));
      fs.copyFileSync(p('a.png'), path.join(runB, 'added.png'));

      const r = await diffRuns(runA, runB, { changedAt: 0.5 });
      assert.equal(r.compared, 3, `expected 3 paired files, got ${r.compared}`);
      assert.equal(r.failures.length, 1, `expected 1 failure, got ${r.failures.length}`);
      assert.equal(r.changed.length, 1, `expected 1 changed, got ${r.changed.length}`);
      assert.equal(r.unchanged.length, 1, `expected 1 unchanged, got ${r.unchanged.length}`);
      assert.ok(!r.unchanged.some((u) => u.name === 'broken.png'), 'a failed comparison was filed as unchanged');
      assert.deepEqual(r.onlyInA, ['gone.png']);
      assert.deepEqual(r.onlyInB, ['added.png']);
      // The counts must account for every paired file, or the summary is a partial answer
      // presented as a total.
      assert.equal(r.changed.length + r.unchanged.length + r.failures.length, r.compared,
        'changed + unchanged + failures does not equal the number of pairs compared');
      assert.equal(listPairs(runA, runB).pairs.length, 3);
    } finally {
      fs.rmSync(runA, { recursive: true, force: true });
      fs.rmSync(runB, { recursive: true, force: true });
    }

    console.log('PASS diff measures a 400-pixel change as exactly 1.33%');
    console.log('PASS diff pads instead of scaling (42.86% on a grown page, not more)');
    console.log('PASS diff throws on corrupt, zero-byte and missing images');
    console.log('PASS diffRuns counts a failed pair as a failure, never as unchanged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * lib/annotate.js checks. Also browser-free, so they run alongside the diff checks.
 *
 * Every assertion here is about WHERE THE INK LANDED, measured by differencing the output
 * against the un-annotated base. A mark drawn off-canvas is clipped silently by both SVG and
 * sharp, so "the file was written and it is the right size" proves nothing at all: the bug
 * this module was extracted to fix produced a perfectly valid PNG with the callout missing.
 */
async function annotateChecks() {
  const sharp = require('sharp');
  const {
    annotate, describe, parseCallout, parseRect, estimateTextWidth, AnnotateError,
  } = require('../lib/annotate');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-kit-annotate-'));
  const p = (n) => path.join(dir, n);
  const W = 400, H = 300;

  // Bounding box and count of pixels that differ between two same-size images.
  const inkBox = async (baseFile, outFile) => {
    const load = async (f) => {
      const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    };
    const a = await load(baseFile), b = await load(outFile);
    assert.equal(`${a.w}x${a.h}`, `${b.w}x${b.h}`, 'annotate changed the image dimensions');
    let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const i = (y * a.w + x) * 4;
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
          n++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    return { n, x0, y0, x1, y1 };
  };

  try {
    // A detailed base, not a flat colour: blurring flat colour is a no-op, so a flat fixture
    // would let a focus blur that does nothing at all pass the focus check below.
    const buf = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const on = ((x >> 2) + (y >> 2)) % 2 === 0;
        buf[i] = on ? 30 : 230;
        buf[i + 1] = on ? 60 : 210;
        buf[i + 2] = on ? 200 : 40;
        buf[i + 3] = 255;
      }
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(p('base.png'));

    // 1. describe() reports the frame the coordinates are measured against, which is the
    //    cropped one. Getting this backwards silently shifts every mark by the crop offset.
    const whole = await describe(p('base.png'));
    assert.deepEqual([whole.width, whole.height, whole.cropped], [W, H, false]);
    const cropped = await describe(p('base.png'), parseRect('10,20,100,80'));
    assert.deepEqual([cropped.width, cropped.height, cropped.cropped], [100, 80, true]);
    assert.deepEqual([cropped.sourceWidth, cropped.sourceHeight], [W, H]);

    // 2. A highlight lands on the rectangle it was given. The stroke is centred on the path,
    //    so a 3px stroke reaches ~1.5px outside the box; 3px of slack absorbs antialiasing
    //    without absorbing a mark drawn somewhere else entirely.
    const box = { x: 40, y: 50, width: 120, height: 30 };
    await annotate(p('base.png'), p('hl.png'), { highlights: [box] });
    const hl = await inkBox(p('base.png'), p('hl.png'));
    assert.ok(Math.abs(hl.x0 - box.x) <= 3 && Math.abs(hl.y0 - box.y) <= 3,
      `highlight ink starts at ${hl.x0},${hl.y0}, expected near ${box.x},${box.y}`);
    assert.ok(Math.abs(hl.x1 - (box.x + box.width)) <= 3 && Math.abs(hl.y1 - (box.y + box.height)) <= 3,
      `highlight ink ends at ${hl.x1},${hl.y1}, expected near ${box.x + box.width},${box.y + box.height}`);

    // 3. THE CALLOUT FLIP. The version this came from always placed the bubble above the
    //    point, so a callout on anything in the top ~45px was drawn at a negative y and
    //    clipped to a sliver. Compare a callout with room above against the same text with
    //    none: the flipped one must sit BELOW its point and must contain essentially all of
    //    the same ink. Restore the always-above placement and the count assertion fails,
    //    which is the only reason to believe it is testing anything.
    const text = 'Click Assign';
    await annotate(p('base.png'), p('below.png'), { callouts: [{ x: 200, y: 200, text }] });
    await annotate(p('base.png'), p('flipped.png'), { callouts: [{ x: 200, y: 10, text }] });
    const roomy = await inkBox(p('base.png'), p('below.png'));
    const tight = await inkBox(p('base.png'), p('flipped.png'));
    assert.ok(roomy.y1 <= 201 && roomy.y0 < 200,
      `with room above, the bubble should sit above y=200; ink spans y ${roomy.y0}..${roomy.y1}`);
    assert.ok(tight.y1 > 30,
      `with no room above, the bubble should flip below y=10; ink only reaches y ${tight.y1}`);
    assert.ok(tight.n >= roomy.n * 0.9,
      `the flipped callout drew ${tight.n} pixels against ${roomy.n} with room above, so most of it was clipped`);

    // 4. Horizontal clamping, same failure mode sideways. A bubble centred on a point near
    //    an edge hangs off the canvas and loses that half.
    await annotate(p('base.png'), p('left.png'), { callouts: [{ x: 2, y: 200, text }] });
    await annotate(p('base.png'), p('right.png'), { callouts: [{ x: W - 2, y: 200, text }] });
    const left = await inkBox(p('base.png'), p('left.png'));
    const right = await inkBox(p('base.png'), p('right.png'));
    assert.ok(left.x0 >= 0 && left.x1 <= W - 1, `left-edge callout ink spans x ${left.x0}..${left.x1}`);
    assert.ok(right.x0 >= 0 && right.x1 <= W - 1, `right-edge callout ink spans x ${right.x0}..${right.x1}`);
    assert.ok(left.n >= roomy.n * 0.85 && right.n >= roomy.n * 0.85,
      `edge callouts drew ${left.n} and ${right.n} pixels against ${roomy.n} centred`);

    // 5. Geometry outside the image is refused rather than clipped. Named coordinates in the
    //    message, because "it didn't work" is not a diagnosis.
    for (const [what, ops] of [
      ['highlight past the right edge', { highlights: [{ x: 350, y: 10, width: 100, height: 10 }] }],
      ['highlight at a negative y', { highlights: [{ x: 10, y: -5, width: 10, height: 10 }] }],
      ['arrow ending off-canvas', { arrows: [{ x1: 10, y1: 10, x2: W + 1, y2: 10 }] }],
      ['callout anchored off-canvas', { callouts: [{ x: 10, y: H + 1, text: 'x' }] }],
      ['focus box larger than the image', { focus: { x: 0, y: 0, width: W + 10, height: H } }],
      ['crop larger than the image', { crop: { x: 0, y: 0, width: W, height: H + 1 } }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => annotate(p('base.png'), p('never.png'), ops),
        (e) => e instanceof AnnotateError, `${what} did not throw AnnotateError`);
    }
    assert.ok(!fs.existsSync(p('never.png')), 'a rejected annotation still wrote a file');

    // 6. Refusing to overwrite the source. There is no un-annotate, and the capture is the
    //    only copy of what the application actually showed.
    await assert.rejects(() => annotate(p('base.png'), p('base.png'), { highlights: [box] }),
      (e) => e instanceof AnnotateError, 'annotating over the source image was allowed');

    // 7. Focus blur keeps the focus region byte-identical. Blurring the frame and pasting the
    //    region back must not bleed into it; anything above 0 here means it did.
    const focus = { x: 100, y: 80, width: 150, height: 120 };
    await annotate(p('base.png'), p('focus.png'), { focus });
    const region = { left: focus.x, top: focus.y, width: focus.width, height: focus.height };
    const before = await sharp(p('base.png')).extract(region).raw().toBuffer();
    const after = await sharp(p('focus.png')).extract(region).raw().toBuffer();
    assert.ok(before.equals(after), 'the focus region was altered by the surrounding blur');
    const blurred = await inkBox(p('base.png'), p('focus.png'));
    assert.ok(blurred.n > W * H * 0.5, `focus blur changed only ${blurred.n} pixels, so it barely blurred anything`);

    // 8. Callout text may contain commas; only the first two fields are coordinates.
    assert.deepEqual(parseCallout('12,34,Save, then close'), { x: 12, y: 34, text: 'Save, then close' });

    // 9. The width estimate is per-character, not a flat multiplier. A flat estimate is what
    //    this replaced and it is wrong by ~3x at both extremes.
    assert.ok(estimateTextWidth('WWWW', 14) > estimateTextWidth('iiii', 14) * 2,
      'the text width estimate does not distinguish wide characters from narrow ones');
    assert.ok(estimateTextWidth('Assign', 28) > estimateTextWidth('Assign', 14) * 1.8,
      'the text width estimate does not scale with font size');

    console.log('PASS annotate draws a highlight on the rectangle it was given');
    console.log('PASS annotate flips a callout below its point instead of clipping it off-canvas');
    console.log('PASS annotate refuses geometry outside the image and writes no file');
    console.log('PASS annotate focus blur leaves the focus region byte-identical');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await diffChecks();
  await annotateChecks();
  const port = await getFreePort();
  const output = path.join(os.tmpdir(), `capture-kit-smoke-${process.pid}.png`);
  // safeShot() takes a directory, not a path, so it gets its own scratch dir under the OS
  // temp dir. Never the repo: an intermediate of a page that has not been redacted yet must
  // not land anywhere a `git add .` could pick it up.
  const safeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-kit-safeshot-'));
  let browser;
  let cdpBrowser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });

    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    await page.setContent(`
      <style>
        body { font: 16px sans-serif; }
        .row { display: flex; gap: 12px; margin: 20px; }
      </style>
      <button id="save" onclick="window.saved = (window.saved || 0) + 1">Save</button>
      <button id="view" onclick="window.viewed = (window.viewed || 0) + 1">View</button>
      <div class="row"><span>Member Name:</span><span>Example Person</span></div>
      <div>ID:operator</div>
      <div>01/02/2026</div>
    `);
    // Assert the guard actually installed. installClickGuard returns false rather than
    // throwing when writes have been allowed, so a broken override would otherwise show up
    // as "Save click was not blocked" -- a real failure, but pointing at the wrong cause.
    const armed = await installClickGuard(page);
    assert.equal(
      armed, true,
      'Click guard did not install: CAPTURE_READONLY=1 no longer forces guardEnabled() true',
    );

    await page.click('#save');
    await page.click('#view');

    const clickState = await page.evaluate(() => ({
      saved: window.saved || 0,
      viewed: window.viewed || 0,
      blocked: (window.__captureBlocked || []).length,
    }));
    assert.equal(clickState.saved, 0, 'Save click was not blocked');
    assert.equal(clickState.viewed, 1, 'Ordinary View click was blocked');
    assert.ok(clickState.blocked >= 1, 'Blocked click was not recorded');

    const redaction = await redact(page, output);
    assert.ok(redaction.boxes >= 2, 'Expected PHI/PII regions were not detected');
    assert.ok(fs.statSync(output).size > 0, 'Redacted screenshot was not written');

    cdpBrowser = await connectOverCdpWithRetry(port);
    assert.ok(cdpBrowser.contexts().length >= 1, 'CDP attachment returned no contexts');

    // safeShot() is the only path any capture entry point is allowed to take, so it needs
    // its own coverage. redact() passing does not prove safeShot() is reachable or correct:
    // lib/capture-safe.js described itself as "the capture front door" for the whole life of
    // this kit while being imported by nothing, and redact() was green the entire time.
    //
    // The viewport here is 1440x900 to match capture.crop in capture.config.json. safeShot
    // falls back to that crop when none is passed (`opts.crop || defaultCrop()`), and a crop
    // larger than the page is not a meaningful test of anything.
    const safePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const columnLabel = environmentColumns()[0];
    assert.ok(columnLabel, 'redaction.columnLabels is empty, so this check proves nothing');

    // Happy path: the configured column has a value under it, so it can be covered.
    await safePage.setContent(`
      <style>body { font: 16px sans-serif; } td, th { padding: 6px 10px; }</style>
      <table>
        <tr><th>${columnLabel}</th><th>Notes</th></tr>
        <tr><td>Example Person</td><td>ordinary text</td></tr>
      </table>
    `);
    const covered = await safeShot(safePage, safeDir, 'safeshot-covered');
    const coveredPath = path.join(safeDir, 'safeshot-covered.png');
    assert.ok(fs.existsSync(coveredPath), 'safeShot did not write a PNG on the happy path');
    assert.ok(covered.boxes >= 1, `safeShot covered no regions under "${columnLabel}"`);

    // Fail-closed path: the same column header with no values beneath it. This is the case
    // that used to yield an empty box list, indistinguishable from "this screen has no such
    // column", and produced a clean-looking unredacted capture. The correct outcome is an
    // exception AND no file, because a missing capture is recoverable and a leaked one is not.
    await safePage.setContent(`
      <style>body { font: 16px sans-serif; } td, th { padding: 6px 10px; }</style>
      <table><tr><th>${columnLabel}</th></tr></table>
    `);
    const strandedPath = path.join(safeDir, 'safeshot-stranded.png');
    await assert.rejects(
      () => safeShot(safePage, safeDir, 'safeshot-stranded'),
      (error) => error instanceof RedactionError &&
        error.message.includes(columnLabel.toLowerCase()),
      `safeShot did not refuse a screen where "${columnLabel}" was present but uncoverable`,
    );
    assert.ok(
      !fs.existsSync(strandedPath),
      'safeShot threw but still left a PNG on disk, which is the leak it exists to prevent',
    );

    console.log('PASS Chromium launch');
    console.log('PASS CDP attachment');
    console.log('PASS read-only click guard');
    console.log(`PASS redaction (${redaction.boxes} regions)`);
    console.log(`PASS safeShot covers "${columnLabel}" (${covered.boxes} regions)`);
    console.log(`PASS safeShot refuses an uncoverable "${columnLabel}" and writes no file`);
  } finally {
    if (cdpBrowser?.isConnected()) await cdpBrowser.close().catch(() => {});
    if (browser?.isConnected()) await browser.close().catch(() => {});
    if (fs.existsSync(output)) fs.unlinkSync(output);
    fs.rmSync(safeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exit(1);
});
