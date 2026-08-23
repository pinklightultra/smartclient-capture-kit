#!/usr/bin/env node
/**
 * diff-runs.js — compare two directories of captures and print what changed.
 *
 *   node diff-runs.js --before ./screenshots/4.2 --after ./screenshots/4.3
 *   node diff-runs.js --before ./old --after ./new --strips ./diffs --changed-at 1
 *
 * Prints a table sorted by how much of each screen moved, then a summary. Writes nothing
 * unless you pass --strips.
 *
 * EXIT CODES
 *   0  every pair compared, nothing over the threshold
 *   1  a comparison FAILED (unreadable image), or a directory was missing
 *   3  comparisons all succeeded and at least one pair changed
 *
 * 3 rather than 1 for "found changes" because a found change is the tool working. 1 is
 * reserved for "this run did not measure what it claims to have measured", which is the
 * only outcome that should ever break a script that wraps this one.
 */
const path = require('path');
const { diffRuns, DiffError } = require('./lib/diff');

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const before = get('--before');
const after = get('--after');
const askedForHelp = args.includes('--help') || args.includes('-h');
if (!before || !after || askedForHelp) {
  console.error('Usage: node diff-runs.js --before <dir> --after <dir> [--strips <dir>]');
  console.error('                        [--changed-at <percent>] [--threshold <0..1>] [--include-aa]');
  console.error('');
  console.error('  --changed-at  percent of pixels above which a screen counts as changed (default 0.5)');
  console.error('  --threshold   per-pixel colour tolerance passed to pixelmatch (default 0.1)');
  console.error('  --include-aa  count antialiasing-only differences too (off by default)');
  // Only an explicit --help is a success. Bare `node diff-runs.js` is a caller that forgot
  // its arguments, and exiting 0 on that hands a wrapper script a clean result for a run
  // that compared nothing at all.
  process.exit(askedForHelp ? 0 : 1);
}

const changedAt = Number(get('--changed-at', '0.5'));
const threshold = Number(get('--threshold', '0.1'));
if (!Number.isFinite(changedAt) || changedAt < 0) {
  console.error(`--changed-at must be a non-negative number, got ${get('--changed-at')}`);
  process.exit(1);
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(`--threshold must be between 0 and 1, got ${get('--threshold')}`);
  process.exit(1);
}

(async () => {
  let r;
  try {
    r = await diffRuns(before, after, {
      changedAt,
      threshold,
      includeAA: args.includes('--include-aa'),
      stripDir: get('--strips'),
      onProgress: (name) => process.stderr.write(`\r[diff] ${name.slice(0, 60).padEnd(62)}`),
    });
  } catch (err) {
    process.stderr.write('\r'.padEnd(70) + '\r');
    console.error(err instanceof DiffError ? err.message : `unexpected: ${err.stack}`);
    process.exit(1);
  }
  process.stderr.write('\r'.padEnd(70) + '\r');

  if (r.changed.length) {
    console.log(`\nChanged (over ${r.changedAt}% of pixels), most moved first:\n`);
    for (const c of r.changed) {
      const size = c.padded ? `  [size differs: ${c.sizeA} vs ${c.sizeB}]` : '';
      console.log(`  ${String(c.diffPercent).padStart(6)}%  ${c.name}${size}`);
      if (c.strip) console.log(`           strip: ${path.relative(process.cwd(), c.strip)}`);
    }
  }

  console.log(`\n${r.compared} pair${r.compared === 1 ? '' : 's'} compared: ${r.changed.length} changed, ${r.unchanged.length} within threshold.`);
  if (r.onlyInA.length) console.log(`${r.onlyInA.length} only in --before (not compared): ${r.onlyInA.slice(0, 6).join(', ')}${r.onlyInA.length > 6 ? ', ...' : ''}`);
  if (r.onlyInB.length) console.log(`${r.onlyInB.length} only in --after (not compared): ${r.onlyInB.slice(0, 6).join(', ')}${r.onlyInB.length > 6 ? ', ...' : ''}`);

  // Said plainly, because "12 changed" reads like a complete answer and is not one when
  // three files never got compared at all.
  if (r.onlyInA.length || r.onlyInB.length) {
    console.log('Unpaired files were NOT compared. A screen that was renamed looks like one removed and one added.');
  }

  if (r.failures.length) {
    console.log(`\n${r.failures.length} comparison${r.failures.length === 1 ? '' : 's'} FAILED and are counted as neither changed nor unchanged:`);
    for (const f of r.failures) console.log(`  ${f.name}: ${f.error}`);
    console.log('Treat the changed count above as a floor, not a total.');
    process.exit(1);
  }

  console.log('A high percentage means pixels moved, not that anything is wrong. Look at the strips.');
  process.exit(r.changed.length ? 3 : 0);
})();
