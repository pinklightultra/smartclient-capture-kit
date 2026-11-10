# Three ways a finished run is still wrong

Each of these looks like a successful run: no exception, a full folder, and figures you still cannot publish. What follows is the code that stands in the way, and the result is only as strong as that code.

## The click lands and the screen does not change

When SmartClient raises a modal it also raises a click mask. The mask consumes the click. Nothing is logged, and the next screenshot matches the last one. You cannot separate that from a control that ignored you by looking at the DOM or at the image.

`lib/isc.js` reads the framework. `clickMaskUp()` and `iscState()` report whether a mask is up. The probe script in [Capture](capture.md) prints that flag and saves the widget list. `locateCell()` matches a field value against the grid widget's data, `scrollToRow()` calls `scrollRecordIntoView()`, and the widget returns `getCellPageRect()`. Grids are virtualized: the row you want may not be in the DOM until it is scrolled into view, so a DOM sweep, OCR, and a vision pass all miss it. These functions return geometry. The caller issues the mouse action, so `lib/guard.js` still sees it.

The click has to be a trusted event. SmartClient's event manager ignores `element.click()` inside `page.evaluate`. Playwright's mouse API goes through CDP `Input.dispatchMouseEvent`, which the browser marks trusted. `lib/nav.js` records the benchmark this is based on, from `scripts/bench-interaction.js`: `domClick` verified 0 of 8, a text locator and a DOM-center mouse click verified on every correctly specified target, and a fixed pixel was reliable only for a control that does not move. Polling `isc.Page.isLoaded()` matched a fixed wait on that run and returned faster, 1.7 seconds a step against 7.1, about four times. Those figures are one run against one application. `bench-results.json` is gitignored because it names screens. The fixed wait cannot beat 6 seconds: `waitFixed` defaults to 6000 ms and then dismisses overlays. Re-measure with `node scripts/bench-interaction.js --env <name>` before treating the times as a property of your shell.

`clickLabel()` in `lib/nav.js` is the click a script should make. An unbanded label goes to a Playwright text locator, then a DOM-center mouse click, then the visual tiers in `lib/resolvers.js` (`ocr`, then `template`, then `vision` if you put it in `resolvers.tiers`). A vertical band (`ymin` / `ymax`) or a substring match goes straight to the mouse click. A text locator cannot express either, and a band is how a label that appears twice gets disambiguated. The visual tier returns a point and does not click. `clickLabel()` clicks with `locator.click()` or `page.mouse.click()`, both of which dispatch a DOM event, so the capture-phase guard still runs.

`waitForIsc()` polls `isc.Page.isLoaded()` and, when the caller passes `expect`, an element that exists on the destination. The load signal can be true for the page you are leaving. `openAdmin()` waits on `navigation.adminPostCondition` for that reason. The wait is bounded by its budget. A post-condition that never appears does not throw inside `waitForIsc()`.

**Result.** A step can name the screen it expects, and it can ask the framework whether a mask is up. Arrival is that named element becoming present. The mask stays up until something dismisses it. `clickMaskUp()` is a probe you call, from the probe script or from the REPL (`isc.clickMaskUp(page)`).

## The folder fills with the wrong screens

A step names a field or a menu item nothing can find. The run continues. The images look finished.

`lib/reference-stop.js` is the hard stop, and it is off until you set `CAPTURE_REFERENCE_STOP=1` (or pass `referenceStop` on the call). When it is on, `clickLabel()` writes `UNKNOWN-<term>.json` after every tier misses, runs `referenceLookup.command` if you configured one, and throws. With no lookup command, the report and the throw still happen. The report holds the URL and up to 60 visible labels when a page was passed. `UNKNOWN-*.json` is gitignored because that snapshot is from an authenticated application. Hot loops that expect a miss leave the variable unset and get `{ ok: false }` instead of a throw. `openAdmin()` opts out on its own menu click, so a missing Admin label falls through to `navigation.adminMenuItemPixel` rather than stopping the run.

`lib/beat-runner.js` is that stop for a scripted walkthrough, and it is on for every beat you run through it. Each beat carries a declarative assertion (`{ "type": "textVisible", "text": "Modify Roles" }`). The action and the assertion retry together. On the last failure it writes `FAILURE-<label>.json` and the visible labels, writes a screenshot when redaction succeeds, and throws. The modules under `modules/` do not call `runBeat()`. Use the beat runner for a walkthrough that has to stop on a missed post-condition.

`lib/isc-nav.js` `navigatePath()` walks an `Admin > A > B > C` path. A tab, a dropdown item, and a section header confirm arrival differently. A section header keeps its text when it opens, so "the label is still there" proves nothing. Pass `expectPerSeg` with an element that exists only once that section is open. The function returns `{ ok, reached, failedAt }`.

**Result.** With `CAPTURE_REFERENCE_STOP=1`, an unresolved label stops `clickLabel()` and leaves a report. With the beat runner, a failed assertion stops the walkthrough and leaves `FAILURE-*.json`. A module run, by itself, does neither. `admin` waits on its post-condition for the budget in `openAdmin()`, then captures whatever is on screen.

## The figure contains data you cannot publish

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
