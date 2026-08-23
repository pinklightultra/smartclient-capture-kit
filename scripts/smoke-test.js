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

async function main() {
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
