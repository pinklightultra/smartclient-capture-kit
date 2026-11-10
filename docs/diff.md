# Review what moved

`npm run diff` runs `node diff-runs.js`. Pass the same flags after `npm run diff --`.

Re-run a module after a release and you have a new directory of the same filenames. `diff-runs.js` pairs by filename and sorts by the share of pixels that differ.

```bash
node diff-runs.js --before ./shots/4.2 --after ./shots/4.3 --strips ./diffs
```

`--strips` writes a `[ before | diff | after ]` image per changed screen, under `./diffs` in that example. `diffs/` is gitignored because a strip contains both captures. `--changed-at` is the percentage above which a screen is listed (default `0.5`). `--threshold` is pixelmatch's per-pixel colour tolerance (default `0.1`). Both libraries are already dependencies.

A timestamp, one extra grid row, a scrollbar, or a re-rendered chart all count. Read the list as the order to re-review. Two images can differ and both be covered, or match and both leak. Redaction is [Three ways a finished run is still wrong](when-a-run-is-wrong.md).

Three behaviours are deliberate, and the smoke test locks the first two in with images it creates itself:

- **Size differences are padded from the top-left.** Full-page captures of the same screen differ in height. Resizing to fit centres the shorter image, so content that did not move reads as changed. On a 300 by 200 image against a 300 by 350 image whose top 200 rows match, the new region is 300 by 150 pixels out of 300 by 350, which is 42.86%. The smoke test asserts that padded result. `lib/diff.js` records that resize-with-contain reports 64.29% on that same pair.
- **An unreadable image throws `DiffError`.** A truncated, zero-byte, or missing file used to come back as a null difference. A null does not exceed a threshold, so the broken file was filed under unchanged. `diffRuns` counts that pair as a failure. The changed, unchanged, and failed counts add up to the number of pairs compared.
- **A file that exists on only one side is listed and not compared.** A renamed screen is one removal and one addition. The summary says so. "12 changed" is a complete answer only when every file was paired.

Exit codes: `0` when every pair compared and nothing exceeded the threshold, `3` when comparisons succeeded and at least one screen changed, `1` when a directory is missing, an argument is bad, or any comparison failed. A wrapper should fail on `1`. `3` means the tool measured a change. `--help` exits `0`. Running it with no arguments exits `1`, because a run that compared nothing is not a clean result.

`--html report.html` writes a single page after a run that had zero failed comparisons. The page is a filterable table of the paired screens: name, changed or under the threshold, the percentage, and whether the pair was padded. The heading on that page says "Clean Matches" for pairs under the threshold. That means under `--changed-at`. It does not mean safe to publish. Unpaired files are not rows in the table. A run with a failed comparison exits `1` before the file is written. The terminal output is the one that lists failures and unpaired names.
