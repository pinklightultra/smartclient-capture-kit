#!/usr/bin/env node
/**
 * Run safeShot against the fictional local fixtures.
 *
 *   node scripts/demo-capture.js <output-dir>
 *
 * fixtures/demo-member-roster.html is a static page of made-up member ids,
 * names, and dates of birth. safeShot writes <output-dir>/roster.png only
 * after the cover is verified.
 *
 * fixtures/demo-cover-unverifiable.html is the same roster with a stylesheet
 * that forces [data-capture-redaction] to opacity 0. The verifier must reject
 * that cover. This script expects RedactionError and expects no PNG.
 *
 * <output-dir>/before.png is a page.screenshot of the roster, cropped the
 * same way as the capture. The kit does not write that file. The recording
 * uses it as the "before" frame. It is not a capture.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { installClickGuard } = require('../lib/guard');
const { safeShot } = require('../lib/capture-safe');
const { findLabeledColumnValueBoxes, RedactionError } = require('../lib/redact');

const ROOT = path.join(__dirname, '..');
const ROSTER = path.join(ROOT, 'fixtures', 'demo-member-roster.html');
const UNVERIFIABLE = path.join(ROOT, 'fixtures', 'demo-cover-unverifiable.html');
const VIEWPORT = { width: 780, height: 236 };
const CROP = { left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height };

function fileUrl(file) {
  return 'file://' + path.resolve(file);
}

async function mean(file, box) {
  const region = {
    left: Math.max(0, Math.round(box.left)),
    top: Math.max(0, Math.round(box.top)),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  };
  const { data, info } = await sharp(file)
    .extract(region)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n += 1;
  }
  return { r: r / n, g: g / n, b: b / n };
}

function isWhite(sample) {
  return sample.r > 250 && sample.g > 250 && sample.b > 250;
}

async function textBox(page, exact) {
  return page.evaluate((wanted) => {
    const leaves = Array.from(document.querySelectorAll('td, div, span, th, p, header'));
    for (const el of leaves) {
      if (el.children.length) continue;
      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text !== wanted) continue;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }
    return null;
  }, exact);
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'capture-kit-demo'));
  fs.mkdirSync(outDir, { recursive: true });
  const beforePath = path.join(outDir, 'before.png');
  const rosterPath = path.join(outDir, 'roster.png');
  const refusedPath = path.join(outDir, 'cover-unverifiable.png');
  for (const file of [beforePath, rosterPath, refusedPath]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const guarded = await installClickGuard(page);
    console.log(`Read-only guard: ${guarded ? 'ENABLED' : 'disabled'}`);

    await page.goto(fileUrl(ROSTER), { waitUntil: 'load' });
    const columns = await findLabeledColumnValueBoxes(page, ['Client']);
    const nameBox = columns.boxes[0];
    const noteBox = await textBox(page, 'Synthetic row');
    if (!nameBox) throw new Error('Client column values were not found on the fictional roster');
    if (!noteBox) throw new Error('Note cell was not found on the fictional roster');

    const raw = await page.screenshot({ fullPage: false });
    await sharp(raw).extract(CROP).png().toFile(beforePath);
    console.log('before.png: page screenshot for this demo, not a kit capture');

    const covered = await safeShot(page, outDir, 'roster', { crop: CROP });
    const rosterBytes = fs.statSync(rosterPath).size;
    console.log(`roster.png: ${covered.verified}/${covered.requested} regions covered, ${rosterBytes} bytes`);

    const nameBefore = await mean(beforePath, nameBox);
    const nameAfter = await mean(rosterPath, nameBox);
    const noteAfter = await mean(rosterPath, noteBox);
    if (isWhite(nameBefore)) {
      throw new Error('Client value was already white in the page screenshot, so the cover would be invisible');
    }
    if (!isWhite(nameAfter)) {
      throw new Error(`Client value was not covered in roster.png (mean ${Math.round(nameAfter.r)},${Math.round(nameAfter.g)},${Math.round(nameAfter.b)})`);
    }
    if (isWhite(noteAfter)) {
      throw new Error('Note cell was covered; the capture hid a cell that should stay readable');
    }
    console.log('Client value covered in roster.png; Note cell still readable');

    await page.goto(fileUrl(UNVERIFIABLE), { waitUntil: 'load' });
    const heading = await page.locator('header').innerText();
    console.log(`fixture: ${path.relative(ROOT, UNVERIFIABLE)}`);
    console.log(`heading: ${heading.replace(/\s+/g, ' ').trim()}`);
    try {
      await safeShot(page, outDir, 'cover-unverifiable', { crop: CROP });
      console.error('safeShot wrote a file even though the cover cannot be verified');
      process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof RedactionError)) throw error;
      console.log(error.message);
      const written = fs.existsSync(refusedPath);
      console.log(`cover-unverifiable.png: ${written ? 'WRITTEN' : 'not written'}`);
      if (written || !/verified/.test(error.message)) process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
