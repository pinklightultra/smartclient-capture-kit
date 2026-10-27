#!/usr/bin/env node
/**
 * diff-runs.js - compare two directories of captures and print what changed.
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

  const htmlPath = get('--html');
  if (htmlPath) {
    const fs = require('fs');
    const items = r.changed.concat(r.unchanged);
    const rows = items.map((item) => {
      const isChanged = item.diffPercent >= r.changedAt;
      const statusClass = isChanged ? 'status-changed' : 'status-clean';
      const statusLabel = isChanged ? 'CHANGED' : 'MATCH';
      return `
      <tr class="diff-row ${statusClass}" data-name="${item.name.toLowerCase()}">
        <td class="col-name"><code>${item.name}</code></td>
        <td class="col-status"><span class="badge ${statusClass}">${statusLabel}</span></td>
        <td class="col-pct"><strong class="${isChanged ? 'text-red' : 'text-green'}">${item.diffPercent}%</strong></td>
        <td class="col-dim">${item.padded ? `Padded (${item.sizeA} &rarr; ${item.sizeB})` : 'Exact Size'}</td>
      </tr>`;
    }).join('');

    const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SmartClient Visual Regression Diff Dashboard</title>
  <style>
    :root {
      --bg-canvas: #090d16;
      --bg-surface: #121722;
      --bg-surface-elevated: #1a202e;
      --border: #283042;
      --text-main: #e2e8f0;
      --text-muted: #8492a6;
      --accent-cyan: #38bdf8;
      --accent-green: #34d399;
      --accent-red: #f87171;
      --accent-amber: #fbbf24;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg-canvas);
      color: var(--text-main);
      padding: 2rem;
      min-height: 100vh;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    .brand h1 {
      font-size: 1.5rem;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #fff;
    }
    .brand p {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }
    .stat-card .label {
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .stat-card .val {
      font-size: 1.8rem;
      font-weight: 800;
      margin-top: 6px;
      color: #fff;
    }
    .stat-card.changed .val { color: var(--accent-red); }
    .stat-card.clean .val { color: var(--accent-green); }
    .stat-card.threshold .val { color: var(--accent-amber); }
    
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .filter-group {
      display: flex;
      gap: 0.5rem;
    }
    .btn-filter {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-filter:hover {
      border-color: var(--accent-cyan);
    }
    .btn-filter.active {
      background: var(--accent-cyan);
      color: #000;
      border-color: var(--accent-cyan);
    }
    .search-input {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fff;
      padding: 8px 14px;
      font-size: 0.85rem;
      width: 280px;
      outline: none;
      transition: border 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--accent-cyan);
    }

    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: var(--bg-surface-elevated);
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 12px 16px;
      font-size: 0.9rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }
    code {
      font-family: "SF Mono", Consolas, Monaco, monospace;
      font-size: 0.85rem;
      color: #93c5fd;
    }
    .badge {
      font-size: 0.7rem;
      font-weight: 800;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .badge.status-changed {
      background: rgba(248, 113, 113, 0.15);
      color: var(--accent-red);
      border: 1px solid rgba(248, 113, 113, 0.3);
    }
    .badge.status-clean {
      background: rgba(52, 211, 153, 0.15);
      color: var(--accent-green);
      border: 1px solid rgba(52, 211, 153, 0.3);
    }
    .text-red { color: var(--accent-red); font-weight: 700; }
    .text-green { color: var(--accent-green); font-weight: 700; }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand">
      <h1>SmartClient Visual Regression Diff Dashboard</h1>
      <p>Automated pixelmatch diff inspection comparing baseline vs release captures</p>
    </div>
  </div>

  <div class="stat-grid">
    <div class="stat-card">
      <div class="label">Total Screens</div>
      <div class="val">${r.compared}</div>
    </div>
    <div class="stat-card changed">
      <div class="label">Changed Above Threshold</div>
      <div class="val">${r.changed.length}</div>
    </div>
    <div class="stat-card clean">
      <div class="label">Clean Matches</div>
      <div class="val">${r.unchanged.length}</div>
    </div>
    <div class="stat-card threshold">
      <div class="label">Delta Threshold</div>
      <div class="val">${r.changedAt}%</div>
    </div>
  </div>

  <div class="toolbar">
    <div class="filter-group">
      <button class="btn-filter active" onclick="setFilter('all', this)">All (${items.length})</button>
      <button class="btn-filter" onclick="setFilter('status-changed', this)">Changed (${r.changed.length})</button>
      <button class="btn-filter" onclick="setFilter('status-clean', this)">Clean (${r.unchanged.length})</button>
    </div>
    <input type="text" class="search-input" id="search-input" placeholder="Search screens..." onkeyup="applyFilters()">
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>Screen Name</th>
          <th>Status</th>
          <th>Pixel Delta %</th>
          <th>Dimensions</th>
        </tr>
      </thead>
      <tbody id="diff-tbody">
        ${rows}
      </tbody>
    </table>
  </div>

  <script>
    let activeFilter = 'all';
    function setFilter(filter, btn) {
      activeFilter = filter;
      document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }
    function applyFilters() {
      const q = document.getElementById('search-input').value.toLowerCase();
      document.querySelectorAll('.diff-row').forEach(row => {
        const matchesFilter = (activeFilter === 'all') || row.classList.contains(activeFilter);
        const matchesSearch = row.dataset.name.includes(q);
        row.style.display = (matchesFilter && matchesSearch) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
    fs.writeFileSync(htmlPath, htmlReport, 'utf8');
    console.log(`Visual HTML report written: ${htmlPath}`);
  }

  console.log('A high percentage means pixels moved, not that anything is wrong. Look at the strips.');
  process.exit(r.changed.length ? 3 : 0);
})();

