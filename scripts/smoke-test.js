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

async function main() {
  await diffChecks();
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
