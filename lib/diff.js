/**
 * lib/diff.js - pixel diff between two capture runs.
 *
 * WHAT THIS IS
 * ------------
 * Point it at two directories of screenshots taken by this kit at different times, on
 * different releases, or against different environments. It pairs images by filename,
 * reports what share of pixels differ, and optionally writes a
 * [ before | diff | after ] strip so you can see where.
 *
 * The use it was written for: a release lands, you re-run a capture module, and you want
 * the list of screens that actually changed rather than re-reviewing forty images.
 *
 * WHAT IT IS NOT
 * --------------
 * NOT a visual-regression judge. It counts differing pixels; it has no idea which
 * differences matter. A changed timestamp, a different row count in a grid, a scrollbar,
 * a re-rendered chart, or an antialiasing shift all register as change. Treat the output
 * as a worklist, not a verdict, and read `diffPercent` as "how much of this screen moved",
 * never as "this screen is broken".
 *
 * It is also not a redaction check. Two captures can both be fully redacted and differ
 * wildly, or be pixel-identical and both leak. See lib/redact.js for that job.
 *
 * IT DOES NOT SCALE IMAGES, ON PURPOSE
 * ------------------------------------
 * When two captures differ in size this pads both to the union size anchored at the
 * TOP-LEFT. It never resizes to fit.
 *
 * The version this was extracted from resized both images to the larger dimensions with
 * sharp's `fit: 'contain'`, which scales and then CENTRES the letterbox. Full-page
 * screenshots of the same screen routinely differ in height because content differs, so a
 * page that grew shifted the shorter capture DOWN by half the difference, and content that
 * had not moved on screen read as changed.
 *
 * Measured on a 300x200 capture against a 300x350 one whose extra 150px is new grid rows
 * and whose top 200px is byte-identical: ground truth is 42.86% of pixels differing,
 * top-left padding reports exactly 42.86%, and resize-with-contain reports 64.29%. It
 * overstates by 1.5x on that pair, and it overstates more the taller the page.
 *
 * FAIL LOUD
 * ---------
 * compareImages THROWS DiffError when it cannot read an image. The version this came from
 * caught the error and returned `{ diffPercent: null }`, and every caller then asked
 * `diffPercent > threshold`. `null > 0.5` is false, so an unreadable, truncated or
 * zero-byte capture was reported as UNCHANGED - the one answer that stops you looking.
 * diffRuns() catches per pair so one bad file cannot abandon the run, but it counts every
 * failure and the CLI exits non-zero when the count is not zero.
 */
const fs = require('fs');
const path = require('path');

// Lazily required, matching lib/resolvers.js: both are native or heavy, and a caller that
// only wants listPairs() should not pay for libvips.
let _sharp, _pixelmatch;
function sharp() { return _sharp || (_sharp = require('sharp')); }
function pixelmatch() { return _pixelmatch || (_pixelmatch = require('pixelmatch')); }

/** Thrown when an image cannot be read or decoded. Never converted into a diff result. */
class DiffError extends Error {
  constructor(message, detail = {}) {
    super(`diff failed: ${message}`);
    this.name = 'DiffError';
    this.detail = detail;
  }
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

/** White, fully opaque. Padding colour, and the letterbox colour of the captures themselves. */
const PAD = { r: 255, g: 255, b: 255, alpha: 1 };

/**
 * Read one image as top-left-padded raw RGBA at exactly width x height.
 * @returns {Promise<Buffer>} length is always width * height * 4.
 */
async function rawPadded(file, width, height) {
  let meta;
  try {
    meta = await sharp()(file).metadata();
  } catch (err) {
    throw new DiffError(`cannot decode ${path.basename(file)}`, { file, cause: err.message });
  }
  const right = width - (meta.width || 0);
  const bottom = height - (meta.height || 0);
  let img = sharp()(file).ensureAlpha();
  if (right > 0 || bottom > 0) {
    img = img.extend({ top: 0, left: 0, right: Math.max(0, right), bottom: Math.max(0, bottom), background: PAD });
  }
  const buf = await img.raw().toBuffer();
  const expected = width * height * 4;
  if (buf.length !== expected) {
    // Guards against a sharp version whose extend/channel behaviour differs from what this
    // assumes. pixelmatch would otherwise read past the end of one buffer or silently
    // compare misaligned rows, which looks like a real diff.
    throw new DiffError(`padded ${path.basename(file)} to ${buf.length} bytes, expected ${expected}`, { file });
  }
  return buf;
}

/**
 * Compare two images pixel for pixel.
 *
 * @param {string} pathA "before"
 * @param {string} pathB "after"
 * @param {object} [opts]
 *   threshold {number} pixelmatch per-pixel colour tolerance, 0..1. Default 0.1. This is
 *             NOT the "did this screen change" threshold; that one is the caller's.
 *   includeAA {boolean} count antialiasing-only differences. Default false.
 * @returns {Promise<object>} { pathA, pathB, diffPercent, diffPixels, comparedPixels,
 *   width, height, padded, sizeA, sizeB, diffRaw }. diffRaw is RGBA and is what
 *   generateDiffStrip needs, so pass this whole object to it rather than its parts.
 * @throws {DiffError} if either image is missing or undecodable.
 */
async function compareImages(pathA, pathB, opts = {}) {
  for (const f of [pathA, pathB]) {
    if (!fs.existsSync(f)) throw new DiffError(`missing ${f}`, { file: f });
    if (fs.statSync(f).size === 0) throw new DiffError(`zero-byte ${path.basename(f)}`, { file: f });
  }

  const metaA = await sharp()(pathA).metadata().catch((e) => { throw new DiffError(`cannot read ${path.basename(pathA)}`, { cause: e.message }); });
  const metaB = await sharp()(pathB).metadata().catch((e) => { throw new DiffError(`cannot read ${path.basename(pathB)}`, { cause: e.message }); });

  const width = Math.max(metaA.width || 0, metaB.width || 0);
  const height = Math.max(metaA.height || 0, metaB.height || 0);
  if (!width || !height) throw new DiffError('one image reports zero dimensions', { sizeA: metaA.width, sizeB: metaB.width });

  const [bufA, bufB] = await Promise.all([rawPadded(pathA, width, height), rawPadded(pathB, width, height)]);

  const diffRaw = Buffer.alloc(width * height * 4);
  const diffPixels = pixelmatch()(
    new Uint8Array(bufA), new Uint8Array(bufB), new Uint8Array(diffRaw),
    width, height,
    { threshold: opts.threshold ?? 0.1, includeAA: opts.includeAA === true },
  );

  const comparedPixels = width * height;
  const sizeA = `${metaA.width}x${metaA.height}`;
  const sizeB = `${metaB.width}x${metaB.height}`;
  return {
    pathA, pathB,
    diffPixels,
    comparedPixels,
    // Rounded for display only. diffPixels is the number to compute with.
    diffPercent: Math.round((diffPixels / comparedPixels) * 10000) / 100,
    width, height,
    padded: sizeA !== sizeB,
    sizeA, sizeB,
    diffRaw,
  };
}

/**
 * Write a [ before | diff | after ] strip.
 *
 * Takes the whole result from compareImages rather than loose width/height/buffer
 * arguments. The version this came from took them separately and was called right after a
 * comparison that could have failed, so on failure it was invoked with three undefined
 * values. Passing the object makes that unrepresentable.
 *
 * @param {object} result from compareImages
 * @param {string} outPath .png
 */
async function generateDiffStrip(result, outPath) {
  if (!result || !result.diffRaw) throw new DiffError('generateDiffStrip needs the object compareImages returned');
  const { width, height, diffRaw, pathA, pathB } = result;
  const gap = 4;

  const [a, b, d] = await Promise.all([
    padTo(pathA, width, height),
    padTo(pathB, width, height),
    sharp()(diffRaw, { raw: { width, height, channels: 4 } }).png().toBuffer(),
  ]);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp()({
    create: { width: width * 3 + gap * 2, height, channels: 4, background: { r: 190, g: 190, b: 190, alpha: 1 } },
  })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: d, left: width + gap, top: 0 },
      { input: b, left: (width + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(outPath);
  return outPath;
}

/** Top-left pad one file to width x height and return a PNG buffer. */
async function padTo(file, width, height) {
  const meta = await sharp()(file).metadata();
  let img = sharp()(file).ensureAlpha();
  const right = width - (meta.width || 0);
  const bottom = height - (meta.height || 0);
  if (right > 0 || bottom > 0) {
    img = img.extend({ top: 0, left: 0, right: Math.max(0, right), bottom: Math.max(0, bottom), background: PAD });
  }
  return img.png().toBuffer();
}

/**
 * Pair image files between two directories by filename.
 * Non-recursive and case-insensitive on the extension only, not the stem, because on a
 * case-insensitive filesystem two stems differing in case are the same file anyway.
 * @returns {{pairs: Array<{name:string,a:string,b:string}>, onlyInA: string[], onlyInB: string[]}}
 */
function listPairs(dirA, dirB) {
  const read = (d) => {
    if (!fs.existsSync(d)) throw new DiffError(`no such directory: ${d}`, { dir: d });
    return fs.readdirSync(d).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  };
  const a = read(dirA), b = read(dirB);
  const setB = new Set(b);
  const pairs = a.filter((f) => setB.has(f)).sort()
    .map((name) => ({ name, a: path.join(dirA, name), b: path.join(dirB, name) }));
  const setA = new Set(a);
  return { pairs, onlyInA: a.filter((f) => !setB.has(f)).sort(), onlyInB: b.filter((f) => !setA.has(f)).sort() };
}

/**
 * Compare every image present in both directories.
 *
 * @param {string} dirA @param {string} dirB
 * @param {object} [opts] threshold, includeAA, changedAt (percent above which a pair counts
 *   as changed, default 0.5), stripDir (write strips for changed pairs), onProgress(name)
 * @returns {Promise<object>} { changed, unchanged, failures, onlyInA, onlyInB, compared }
 *   `failures` is an array, never folded into unchanged. Check it.
 */
async function diffRuns(dirA, dirB, opts = {}) {
  const { pairs, onlyInA, onlyInB } = listPairs(dirA, dirB);
  const changedAt = opts.changedAt ?? 0.5;
  const changed = [], unchanged = [], failures = [];

  for (const pair of pairs) {
    if (opts.onProgress) opts.onProgress(pair.name);
    let result;
    try {
      result = await compareImages(pair.a, pair.b, opts);
    } catch (err) {
      // Recorded, not rethrown: one corrupt file should not abandon thirty-nine good
      // comparisons. It is NOT counted as unchanged, and the CLI exits non-zero on it.
      failures.push({ name: pair.name, error: err.message });
      continue;
    }
    const row = {
      name: pair.name, diffPercent: result.diffPercent, diffPixels: result.diffPixels,
      padded: result.padded, sizeA: result.sizeA, sizeB: result.sizeB,
    };
    if (result.diffPercent > changedAt) {
      if (opts.stripDir) {
        row.strip = await generateDiffStrip(result, path.join(opts.stripDir, `${path.parse(pair.name).name}.diff.png`));
      }
      changed.push(row);
    } else {
      unchanged.push(row);
    }
  }

  changed.sort((x, y) => y.diffPercent - x.diffPercent);
  return { changed, unchanged, failures, onlyInA, onlyInB, compared: pairs.length, changedAt };
}

module.exports = { compareImages, generateDiffStrip, listPairs, diffRuns, DiffError };

