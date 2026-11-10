# What the smoke test checks

`scripts/smoke-test.js` is the smoke test. CI runs it and nothing else.

`.github/workflows/ci.yml` runs on push and pull request to `main` and `master`, and on `workflow_dispatch`. The `smoke` job uses `ubuntu-24.04`, `windows-latest`, and `macos-latest`, Node 20, `npm ci`, `npx playwright install chromium`, and `npm run smoke`.

There is no second test runner and no coverage figure in the repo. The click-strategy timings in `lib/nav.js` are not part of this smoke test. The diff assertions below use values computed from the images the test creates (a 20 by 20 square is 400 pixels of a 200 by 150 image, which is 1.33%; the grown page is 42.86%), not numbers recorded from an earlier run of the code under test.

The smoke test asserts:

- Identical images differ by 0. The 400-pixel square is reported as 1.33%, and the pair is not marked padded.
- The 300 by 200 against 300 by 350 pair is 42.86% and is marked padded.
- A corrupt file, a zero-byte file, and a missing file throw `DiffError`. In a directory compare, that pair is a failure and is absent from the unchanged list. Changed, unchanged, and failed counts add up to the number of pairs. Names only on one side come back as `onlyInA` and `onlyInB`.
- A highlight's ink lands on the rectangle it was given, within 3 pixels, measured by differencing against the unmarked image.
- A callout at `y=10` on a 300-pixel-tall image extends below that point. The same callout at `y=200` sits above it. Callouts at `x=2` and at `x=398` keep their ink inside the frame, and each draws at least 85% of the ink of the centred callout.
- A highlight, arrow, callout, focus box, or crop that falls outside the image throws `AnnotateError`, and the output path is not created. Annotating a file onto itself throws.
- `--focus` leaves the pixels inside the focus box byte-identical to the source, and changes more than half of the pixels in the 400 by 300 fixture.
- `parseCallout('12,34,Save, then close')` keeps the comma inside the text.
- The width estimate treats `WWWW` as more than twice `iiii` at the same size, and scales a word up with the font size.
- Chromium launches. Connecting over CDP returns a context.
- With the guard installed, a click on Save leaves that button's counter at 0, a click on View increments, and the blocked click is recorded on `window.__captureBlocked`.
- `redact()` finds at least two regions on a fixture that contains `Member Name: Example Person`, `ID:operator`, and `01/02/2026`, and writes a non-empty PNG.
- `safeShot()` covers the first `redaction.columnLabels` header when a value sits under it, and refuses the header-only page without writing a file.
