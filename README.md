# smartclient-capture-kit

Capture kit for documentation screenshots of an Isomorphic SmartClient application. It is for the writer producing the UI figures for a release, against an environment other people are using, where the screens contain data that must not be published.

Two controls ship on.

**Mutating clicks are cancelled in the page.** A capture-phase listener in `lib/guard.js` blocks Save, Submit, Confirm, Apply, Delete, Remove, and Upload before the application's own handler runs. `CAPTURE_ALLOW_WRITES=1` is what disarms it.

**A PNG is written only after the cover is verified.** `run-modules.js` and `runner.js` take screenshots through `safeShot()` in `lib/capture-safe.js`. That calls `lib/redact.js`, which covers the regions you declared, checks that the overlays are painted at the requested geometry, takes the screenshot, checks that the overlays are still there, and only then writes the file. A failure throws `RedactionError` and leaves no file.

```bash
node run-modules.js --env staging --modules login,home,admin
```

Output goes to `screenshots/<environment>/<YYYY-MM-DD>/`, plus a `capture-manifest.json` of every file written. The folder name is the key from `environments` when the host matches one. Otherwise it is the first DNS label, or the IP address with dots replaced by hyphens.

Install, confirm the kit, and the checks behind these claims are in [Install](#install) and [What is checked](#what-is-checked).

## Install

Node 20.9 or newer. That floor is `engines` in `package.json`, and it is sharp's requirement.

```bash
git clone https://github.com/pinklightultra/smartclient-capture-kit
cd smartclient-capture-kit
npm install
npx playwright install chromium
npm run smoke
```

`npm run smoke` runs `node scripts/smoke-test.js`. The test uses no application, no credentials, and no network. It builds its own page. The assertions are listed under [What is checked](#what-is-checked).

Point it at an environment after that. Credentials go in `.env`, which is gitignored. Hosts go in `capture.config.json`. `lib/` does not contain a URL.

```bash
node setup.js                 # writes .env as CAPTURE_USER and CAPTURE_PASS
node setup.js --add-env       # adds a named host under environments
node setup.js --test staging  # logs in with the guard forced on and confirms the app loads
```

`setup.js` writes the `environments` block of `capture.config.json`, the file `lib/config.js` reads. The missing-credentials error mentions `.env.example`. That file is not in the repo. `setup.js` is what creates `.env`.

## Capture a release

```bash
node run-modules.js --list
node run-modules.js --list-envs
node run-modules.js --env staging --modules login,home,admin
node run-modules.js --env staging --modules admin --headed
node run-modules.js --env staging --modules login --out /path/to/captures
```

Prefer `--env` to `--url`, so the hostname stays out of shell history. Prefer `.env`, or `CAPTURE_USER` and `CAPTURE_PASS` together, to `--user` and `--pass`. Arguments are visible in the process list. When both are present, `--user` and `--pass` win. `lib/config.js` checks them first, then the environment, then `.env`.

| Module | What it captures | Requires |
| --- | --- | --- |
| `login` | Empty login form, credentials filled, post-login home | |
| `home` | My Cases overview. A toolbar file is attempted when a navbar is visible | `login` |
| `admin` | Admin landing, then each tab found in the tab strip | `login` |

`run-modules.js` pulls prerequisites in first, so `--modules admin` runs `login` before `admin`.

The toolbar step in `modules/home.js` passes the navbar box as `{ x, y, width, height }`. `redact()` reads `left` and `top`. Those properties are missing, so the crop arithmetic is `NaN`, and the bounds check does not raise `RedactionError` because a comparison with `NaN` is false. The overview file from the step before it uses the default crop and is unaffected. Do not treat `home-toolbar.png` as a figure the module produces.

When the guard installs, the runner prints this line and continues:

```text
🛡️  READ-ONLY guard active (Save/Submit/Confirm/Apply/Delete clicks blocked)
```

The line is printed only after `installClickGuard()` returns true. If the guard was required and did not install, the browser closes and the run throws. The terms that actually match are `guard.forbiddenTerms`. The shipped list also includes Remove and Upload. The banner names the five you meet most often.

The login form can still be submitted. `lib/guard.js` skips submit, password, and text fields when the path contains `app.authPathFragment` (shipped as `/cas/`) or the username and password fields are on the page. That exemption is authentication. It is not a pass for an in-app Save.

Each figure is logged as `📸 <module>-<name>.png (N region(s) covered)`. A `RedactionError` aborts the run. One screen that cannot be covered is a reason to stop, because the same miss will recur on the next screen.

For a single walkthrough instead of a module:

```bash
node runner.js --url https://staging.example.com --script scripts/example-screens.js
```

A screen script exports one async function. `runner.js` calls it with `{ page, baseUrl, screenshotDir, screenshot }` and closes the browser afterwards. Call `screenshot`. It is `safeShot()`. `page.screenshot()` writes the page as it is, and nothing later rejects that file. `runner.js` does not log in. `scripts/example-screens.js` is the contract, including the login call.

`node scripts/probe-isc-state.js --env staging` logs in under the guard, prints whether a click mask is up, and writes `probe/isc_state_<env>.json`. Reach for it when a click reports success and the screen stays put.

## Three ways a finished run is still wrong

Each of these looks like a successful run: no exception, a full folder, and figures you still cannot publish. What follows is the code that stands in the way, and the result is only as strong as that code.

### The click lands and the screen does not change

When SmartClient raises a modal it also raises a click mask. The mask consumes the click. Nothing is logged, and the next screenshot matches the last one. You cannot separate that from a control that ignored you by looking at the DOM or at the image.

`lib/isc.js` reads the framework. `clickMaskUp()` and `iscState()` report whether a mask is up. The probe script in the previous section prints that flag and saves the widget list. `locateCell()` matches a field value against the grid widget's data, `scrollToRow()` calls `scrollRecordIntoView()`, and the widget returns `getCellPageRect()`. Grids are virtualized: the row you want may not be in the DOM until it is scrolled into view, so a DOM sweep, OCR, and a vision pass all miss it. These functions return geometry. The caller issues the mouse action, so `lib/guard.js` still sees it.

The click has to be a trusted event. SmartClient's event manager ignores `element.click()` inside `page.evaluate`. Playwright's mouse API goes through CDP `Input.dispatchMouseEvent`, which the browser marks trusted. `lib/nav.js` records the benchmark this is based on, from `scripts/bench-interaction.js`: `domClick` verified 0 of 8, a text locator and a DOM-center mouse click verified on every correctly specified target, and a fixed pixel was reliable only for a control that does not move. Polling `isc.Page.isLoaded()` matched a fixed wait on that run and returned faster, 1.7 seconds a step against 7.1, about four times. Those figures are one run against one application. `bench-results.json` is gitignored because it names screens. The fixed wait cannot beat 6 seconds: `waitFixed` defaults to 6000 ms and then dismisses overlays. Re-measure with `node scripts/bench-interaction.js --env <name>` before treating the times as a property of your shell.

`clickLabel()` in `lib/nav.js` is the click a script should make. An unbanded label goes to a Playwright text locator, then a DOM-center mouse click, then the visual tiers in `lib/resolvers.js` (`ocr`, then `template`, then `vision` if you put it in `resolvers.tiers`). A vertical band (`ymin` / `ymax`) or a substring match goes straight to the mouse click. A text locator cannot express either, and a band is how a label that appears twice gets disambiguated. The visual tier returns a point and does not click. `clickLabel()` clicks with `locator.click()` or `page.mouse.click()`, both of which dispatch a DOM event, so the capture-phase guard still runs.

`waitForIsc()` polls `isc.Page.isLoaded()` and, when the caller passes `expect`, an element that exists on the destination. The load signal can be true for the page you are leaving. `openAdmin()` waits on `navigation.adminPostCondition` for that reason. The wait is bounded by its budget. A post-condition that never appears does not throw inside `waitForIsc()`.

**Result.** A step can name the screen it expects, and it can ask the framework whether a mask is up. Arrival is that named element becoming present. The mask stays up until something dismisses it. `clickMaskUp()` is a probe you call, from the probe script or from the REPL (`isc.clickMaskUp(page)`).

### The folder fills with the wrong screens

A step names a field or a menu item nothing can find. The run continues. The images look finished.

`lib/reference-stop.js` is the hard stop, and it is off until you set `CAPTURE_REFERENCE_STOP=1` (or pass `referenceStop` on the call). When it is on, `clickLabel()` writes `UNKNOWN-<term>.json` after every tier misses, runs `referenceLookup.command` if you configured one, and throws. With no lookup command, the report and the throw still happen. The report holds the URL and up to 60 visible labels when a page was passed. `UNKNOWN-*.json` is gitignored because that snapshot is from an authenticated application. Hot loops that expect a miss leave the variable unset and get `{ ok: false }` instead of a throw. `openAdmin()` opts out on its own menu click, so a missing Admin label falls through to `navigation.adminMenuItemPixel` rather than stopping the run.

`lib/beat-runner.js` is that stop for a scripted walkthrough, and it is on for every beat you run through it. Each beat carries a declarative assertion (`{ "type": "textVisible", "text": "Modify Roles" }`). The action and the assertion retry together. On the last failure it writes `FAILURE-<label>.json` and the visible labels, writes a screenshot when redaction succeeds, and throws. The modules under `modules/` do not call `runBeat()`. Use the beat runner for a walkthrough that has to stop on a missed post-condition.

`lib/isc-nav.js` `navigatePath()` walks an `Admin > A > B > C` path. A tab, a dropdown item, and a section header confirm arrival differently. A section header keeps its text when it opens, so "the label is still there" proves nothing. Pass `expectPerSeg` with an element that exists only once that section is open. The function returns `{ ok, reached, failedAt }`.

**Result.** With `CAPTURE_REFERENCE_STOP=1`, an unresolved label stops `clickLabel()` and leaves a report. With the beat runner, a failed assertion stops the walkthrough and leaves `FAILURE-*.json`. A module run, by itself, does neither. `admin` waits on its post-condition for the budget in `openAdmin()`, then captures whatever is on screen.

### The figure contains data you cannot publish

The pixels are in the file the moment the screenshot is taken. A redaction pass afterwards is a pass you can skip, and the original is already on disk.

`lib/redact.js` covers three things, all from the `redaction` block:

1. The operator badge: leaf text matching `identityPrefix` (shipped as `ID:`) in the top 80 CSS pixels.
2. Leaf text matching `valuePatterns`. The shipped expressions match a US Social Security number, a 10-digit phone or fax number, an email address, a numeric date, an IPv4 address, an `http(s)` URL, and an uppercase alphanumeric identifier of seven characters or more.
3. The value beside a label in `labelPatterns`, or in the column under a header matched the same way. The label stays readable. `safeShot()` also covers values under `redaction.columnLabels`, found by header text rather than by a fixed coordinate.

`requireBoxes` ships as `1`. The redactor treats zero regions on an authenticated screen as a detection failure, because this shell's screens carry the operator badge. `allowUnredacted: true` bypasses that floor. It is an argument on the `safeShot()` or `redact()` call, so the script that opted out shows it. It does not bypass the column check below.

`safeShot()` throws before `redact()` runs when a `columnLabels` header is visible and no value under it can be located. An empty box list used to look the same as a screen with no such column, and the capture came out clean.

These conditions throw `RedactionError`. The file is not written first.

| Condition | Where |
| --- | --- |
| The captured region's size cannot be determined | `captureBounds()` |
| A region lies entirely outside the capture | `clampOrThrow()` |
| A region would be only partly covered | `clampOrThrow()` |
| Fewer regions than `requireBoxes`, and the call did not pass `allowUnredacted` | `redact()` |
| An overlay is disconnected, drifted more than 1px, or is not painted | `redact()`, from `applyOverlays()` |
| Overlays are gone after `page.screenshot()` returns | `redact()` |
| The configured crop does not fit the capture | `redact()` |
| A configured column header is visible and none of its values were located | `safeShot()` |

The overlay check is what used to be missing. Appending a div and screenshotting on the next line writes a clean PNG when the injection did nothing: a re-render dropped the nodes, a content-security policy refused the style, or the evaluate ran against a document that had already navigated.

**Result.** A capture that cannot cover what you declared does not produce a file. `scripts/smoke-test.js` builds a page whose only header is the first `redaction.columnLabels` entry and whose table has no cells under it, asserts that `safeShot()` throws `RedactionError` naming that header, and asserts that the PNG path does not exist afterwards.

This covers the three configured mechanisms. It does not implement a named de-identification standard. Free text, a notes field, an avatar, a barcode, a signature, a name that matches no pattern and sits under no labelled column, text drawn into a canvas, and anything scrolled out of the capture are not detected. Read the `redaction` block and change it for the application you are shooting. The shipped patterns and labels come from one product's screens.

## Review what moved

Re-run a module after a release and you have a new directory of the same filenames. `diff-runs.js` pairs by filename and sorts by the share of pixels that differ.

```bash
node diff-runs.js --before ./shots/4.2 --after ./shots/4.3 --strips ./diffs
```

`--strips` writes a `[ before | diff | after ]` image per changed screen, under `./diffs` in that example. `diffs/` is gitignored because a strip contains both captures. `--changed-at` is the percentage above which a screen is listed (default `0.5`). `--threshold` is pixelmatch's per-pixel colour tolerance (default `0.1`). Both libraries are already dependencies.

A timestamp, one extra grid row, a scrollbar, or a re-rendered chart all count. Read the list as the order to re-review. Two images can differ and both be covered, or match and both leak. Redaction is the previous section.

Three behaviours are deliberate, and the smoke test locks the first two in with images it creates itself:

- **Size differences are padded from the top-left.** Full-page captures of the same screen differ in height. Resizing to fit centres the shorter image, so content that did not move reads as changed. On a 300 by 200 image against a 300 by 350 image whose top 200 rows match, the new region is 300 by 150 pixels out of 300 by 350, which is 42.86%. The smoke test asserts that padded result. `lib/diff.js` records that resize-with-contain reports 64.29% on that same pair.
- **An unreadable image throws `DiffError`.** A truncated, zero-byte, or missing file used to come back as a null difference. A null does not exceed a threshold, so the broken file was filed under unchanged. `diffRuns` counts that pair as a failure. The changed, unchanged, and failed counts add up to the number of pairs compared.
- **A file that exists on only one side is listed and not compared.** A renamed screen is one removal and one addition. The summary says so. "12 changed" is a complete answer only when every file was paired.

Exit codes: `0` when every pair compared and nothing exceeded the threshold, `3` when comparisons succeeded and at least one screen changed, `1` when a directory is missing, an argument is bad, or any comparison failed. A wrapper should fail on `1`. `3` means the tool measured a change. `--help` exits `0`. Running it with no arguments exits `1`, because a run that compared nothing is not a clean result.

`--html report.html` writes a single page after a run that had zero failed comparisons. The page is a filterable table of the paired screens: name, changed or under the threshold, the percentage, and whether the pair was padded. The heading on that page says "Clean Matches" for pairs under the threshold. That means under `--changed-at`. It does not mean safe to publish. Unpaired files are not rows in the table. A run with a failed comparison exits `1` before the file is written. The terminal output is the one that lists failures and unpaired names.

## Mark up the figure

The image in the doc is the capture cropped to the panel, with a box on the control and a numbered bubble.

```bash
node annotate.js --in screenshots/staging/users.png --out doc/users.png \
  --crop 0,56,1440,844 --highlight 120,200,300,48 --callout '270,190,1'
```

`--highlight`, `--arrow`, and `--callout` repeat. Boxes draw first, then arrows, then callouts. Colours, stroke, and type size come from the `annotate` block. `--accent` and `--font-size` override one run.

Every coordinate is measured after `--crop`. The crop is applied first, and every mark is relative to that frame's top-left. `--describe` prints the frame and writes nothing:

```bash
node annotate.js --in screenshots/staging/users.png --crop 0,56,1440,844 --describe
```

```text
<file> is <source width>x<source height>
after --crop you are working in <width>x<height>, origin at the crop's top-left
```

A capture at the shipped viewport is 1440 by 900. The shipped crop is 1440 by 844 at (0, 56). Passing that crop to `--describe` prints a working frame of 1440 by 844. Those numbers are `viewport` and `capture.crop` in `capture.config.json`.

`--focus x,y,w,h` blurs the pixels outside the box so the eye lands inside it. Publish a figure only after `safeShot()` has already covered the sensitive regions. A blur on a finished file covers whatever happened to be in the crop, can be partly reversed, and leaves the source PNG as it was. The smoke test asserts that the pixels inside the focus box stay byte-identical to the source.

A mark that falls outside the frame exits `1` and writes no file. SVG and sharp both clip without an error, so an off-image highlight used to produce an annotated PNG with no box on it. A callout whose point has no room above is drawn below the point. One near a side edge is shifted inward so the bubble stays on the canvas. The smoke test checks both by differencing the output against the unmarked image and measuring where the ink landed, on a 400 by 300 fixture. Bubble width is a per-character estimate, rounded up. Measuring the text would need a font this module does not load, so the bubble runs slightly wide of its text.

`annotate.js` draws on the capture. It does not change the text in a control. The figure is a record of what the application showed. Refusing to overwrite the source is tested: annotating a file onto itself throws `AnnotateError`.

## Find a screen before you script it

`lib/session.js` saves the authenticated browser state so a later context can skip the form. The comment there puts a cold launch plus a form login at about 15 to 20 seconds. `repl.js` is the only entry point that uses that saved state. It holds one context open while you try the path:

```bash
CAPTURE_READONLY=1 node repl.js --env staging
```

```text
capture> await iscNav.navigatePath(page, 'Admin > Users')
capture> reload('./lib/nav')
capture> await shot('users')
capture> await relogin()
```

`page`, `context`, `browser`, `nav`, `isc`, `iscNav`, `redact`, `guard`, `session`, `config`, `reload`, `shot`, and `relogin` are already bound. Top-level await works. Credentials are optional only when a saved session file exists for that host. If those cookies have expired, login still needs `CAPTURE_USER` and `CAPTURE_PASS`.

The guard follows `lib/guard.js` here too: on, unless this process has `CAPTURE_ALLOW_WRITES=1`. Set `CAPTURE_READONLY=1` when a parent shell may have allowed writes. An exploratory session is where a stray click hits Save.

`shot()` writes `./repl-shots/<name>.png` through `page.screenshot()`. Nothing is covered. `repl-shots/` is gitignored. Use it to see the screen you just reached. Anything you will publish goes through `safeShot()`.

`relogin()` closes the old context, deletes the saved state, logs in again, and rebinds `page` and `context`. Re-priming the state file alone writes new cookies while the browser in front of you stays on the old context.

`watch.js` polls for `FAILURE-*.json` and hands each new file to `agentHandoff.command`. The wrapped command keeps its own stdout. The watcher exits immediately when that command is null, and it does not read `CAPTURE_AGENT_HANDOFF`. That variable is what `runBeat()` checks before it hands a report off itself.

```bash
node watch.js --watch-dir ./failures -- node your-walkthrough.js
```

`FAILURE-*.json` is written by `captureFailure()` in `lib/beat-runner.js`, into the `failDir` you pass to `runBeat()`. The default watch directory is the repo root. `run-modules.js` never calls `runBeat()`, so wrapping a module run polls for reports the module runner does not write. A redaction failure from `safeShot()` is a thrown error and a non-zero exit, not a `FAILURE-*.json`.

The child process is started with `CAPTURE_READONLY=1` and `CAPTURE_NO_SUBMIT=1`, so the guard stays on even if the parent shell allowed writes. `--rerun` passes `allowRerun` into the handoff. Leave it off while a capture session is still authenticated against the same environment. The agent's CLI exit code is recorded as `exitedCleanly`. That is the subprocess, not a repaired beat. The agent can edit the repo through whatever CLI you configured. Read the diff. `watch.js` exits with the wrapped command's code, unless a poll could not read the watch directory, in which case it exits `1`.

`node scripts/synthetic-phi.js [count]` prints an HTML table of invented member rows (default 5). It is a local fixture. The smoke test does not load it. The Social Security field it emits is already masked (`***-**-####`), and the phone numbers are not 10 digits, so a redaction hit on this table is not evidence that those two `valuePatterns` matched.

## Configuration

Environment-specific values live in `capture.config.json`. Credentials do not.

| Block | What it holds |
| --- | --- |
| `environments` | Named hosts. Scripts take `--env`. |
| `app` | Login path, service path, field selectors, loading-overlay text, mask class fragments, `authPathFragment`. |
| `viewport`, `capture` | Window size, output directory, default crop. Shipped viewport is 1440 by 900. Shipped crop is `{ "left": 0, "top": 56, "width": 1440, "height": 844 }`. |
| `redaction` | `identityPrefix`, `columnLabels`, `labelPatterns`, `valuePatterns`, `requireBoxes`. |
| `guard` | `forbiddenTerms`. |
| `navigation` | Menu labels, `adminMenuItemPixel`, `adminPostCondition`, `tabBarY`, tab labels, named routes. |
| `resolvers` | Cascade order. Shipped tiers are `dom`, `ocr`, `template`. Tesseract candidate paths. Template directory. Optional vision command. |
| `referenceLookup` | Optional command run before a hard stop. The term is appended to `args` unless an arg contains `{term}`. |
| `agentHandoff` | Optional CLI that receives a failure report. Placeholders: `{root}`, `{out}`, `{image}`, `{report}`. |
| `annotate` | Mark-up colours, stroke, font, `blurSigma`. |

`resolvers.vision.command` ships as `null`, and `vlm` is not in the shipped `tiers` list. Setting a command and adding `vlm` to `tiers` sends a screenshot to that command. Leave both as shipped and no capture is uploaded.

`resolvers.templateDir` is `assets/templates`. No crops ship with the kit. A template crop is a screenshot of your application, and that directory is gitignored. `TESSERACT_BIN` is checked before `resolvers.tesseractCandidates`. Tesseract is often installed off `PATH`.

### Environment variables

| Variable | Effect |
| --- | --- |
| `CAPTURE_USER`, `CAPTURE_PASS` | Credentials. Both have to be set. Used when `--user` and `--pass` were not both passed. |
| `CAPTURE_CONFIG` | Config file other than `capture.config.json`. |
| `CAPTURE_ALLOW_WRITES=1` | Disarms the click guard. |
| `CAPTURE_READONLY=1`, `CAPTURE_NO_SUBMIT=1` | Force the guard on. Either one wins over `CAPTURE_ALLOW_WRITES`. |
| `CAPTURE_REFERENCE_STOP=1` | After every resolver tier misses, run `referenceLookup` if configured, write `UNKNOWN-*.json`, and throw. |
| `CAPTURE_AGENT_HANDOFF=1` | `runBeat()` hands its failure report to `agentHandoff`. `watch.js` does not read this variable. |
| `CAPTURE_AGENT_RERUN=1` | Let that agent launch its own run. |
| `TESSERACT_BIN` | Tesseract binary. |

The guard is armed when `CAPTURE_ALLOW_WRITES` is unset. It used to be opt-in through `CAPTURE_READONLY`, which left it off on a first run against a shared environment. `CAPTURE_READONLY` and `CAPTURE_NO_SUBMIT` remain because `setup.js`, the smoke test, `scripts/probe-isc-state.js`, `scripts/bench-interaction.js`, and the child processes in `lib/agent-handoff.js` and `lib/resolvers.js` set them on purpose. They used to lose to a parent `CAPTURE_ALLOW_WRITES=1`, so a child that had asked to be read-only ran with the guard off.

## What is checked

`scripts/smoke-test.js` is the test. CI runs it and nothing else.

`.github/workflows/ci.yml` runs on push and pull request to `main` and `master`, and on `workflow_dispatch`. The `smoke` job uses `ubuntu-latest`, `windows-latest`, and `macos-latest`, Node 20, `npm ci`, `npx playwright install chromium`, and `npm run smoke`.

There is no second test runner and no coverage figure in the repo. The click-strategy timings in `lib/nav.js` are not part of this test. The diff assertions below use values computed from the images the test creates (a 20 by 20 square is 400 pixels of a 200 by 150 image, which is 1.33%; the grown page is 42.86%), not numbers recorded from an earlier run of the code under test.

The test asserts:

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

## Limits

- **Navigation is SmartClient-specific.** `lib/isc.js` and `lib/isc-nav.js` call `window.isc`. The guard, the redactor, `safeShot()`, diff, and annotate run on the plain page the smoke test builds.
- **Chromium only.** Trusted input and the overlay check assume it.
- **Shell geometry is per application.** `navigation.tabBarY` (shipped as `95`) and `navigation.adminMenuItemPixel` (shipped as `[1090, 97]`) are measurements of one chrome. They are config so they are not constants in `lib/`. They still have to be measured on yours. `modules/admin.js` finds tabs with its own band, `y` greater than 78 and less than 100, separate from `tabBarY`.
- **Redaction follows one layout.** A field value is the leaf to the right of its label. A grid value is the cell under its header. Column matching in `findLabeledColumnValueBoxes()` stays inside the header's `.listGrid` when the header has one. A layout that breaks that defeats discovery. `requireBoxes` is what turns "found nothing" into a failed run.
- **The shipped vocabularies are English,** in `guard.forbiddenTerms` and the redaction lists.
- **The guard matches a label, on pointer and mouse events.** It inspects the clicked element and up to four ancestors, and it trusts `innerText` only when the element is under 260 by 80 CSS pixels, so the word Save inside a large panel does not block the panel. A keyboard shortcut, a form that submits on Enter, and a label the list omits all reach the application. Capture against a non-production environment.
- **OCR and templates need your setup.** See Configuration. The vision tier uploads a screenshot once you enable it.
- **Saved sessions are credentials.** `.auth/` and `storageState*.json` hold live cookies. Both are gitignored. Deleting the file later leaves it in git history. Revoke the session if one was ever committed.
- **`diff-runs.js` counts pixels.** The HTML page uses the same counts and a stronger label.

## Where this came from

Built while running documentation for a healthcare SaaS platform. Captures ran against shared non-production environments that held realistic data. The comments in `lib/isc.js`, `lib/reference-stop.js`, `lib/guard.js`, `lib/redact.js`, and `lib/nav.js` describe the failures above as ones that had already happened: a click the framework never received, a run that continued onto the wrong screen, a PNG written when the cover had not been verified. The checks in this repo are each tied to one of those outcomes.

## License

MIT. See [LICENSE](LICENSE).
