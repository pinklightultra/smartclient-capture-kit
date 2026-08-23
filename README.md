# smartclient-capture-kit

Playwright screenshot capture for Isomorphic SmartClient applications, built for the case
where the environment you are capturing is one other people are using and the screens
contain data you must not publish.

Two things make it different from a folder of Playwright scripts:

- **Mutating clicks are blocked by default.** Save, Submit, Confirm, Apply, Delete and
  Upload are cancelled in the DOM before the application's own handler sees them. You opt
  out deliberately, not in.
- **Redaction happens before the shutter.** Sensitive regions are covered with opaque
  overlays in the live DOM, the overlays are verified as painted, and only then is the PNG
  written. There is no blur pass to forget and no original to leak.

```
$ node run-modules.js --env staging --modules login,admin
🛡️  READ-ONLY guard active (Save/Submit/Confirm/Apply/Delete clicks blocked)

  login    5 steps   5 captured
  admin   11 steps  11 captured
  [read-only guard] blocked click on "Save" (matched "Save")

screenshots/staging/2026-08-22/
```

## Why this exists

I was capturing several hundred documentation screenshots per release from a SmartClient
application. Three failures kept recurring, and none of them announced itself:

**A click that reports success and does nothing.** When SmartClient raises a modal it also
raises a click mask, and that mask eats a click as a silent no-op. Nothing throws, nothing
logs, no navigation happens. Three identical clicks produce three identical screenshots,
and you cannot tell that apart from a page that ignored you, not from the DOM and not from
the image.

**A folder of confident screenshots of the wrong screens.** A step names a field or menu
option the resolver cannot actually find, the run continues, and you review 200 images
before noticing. Nothing failed, so nothing told you.

**A screenshot that shipped a real person's name.** The pixels are in the file the moment
you take it. A redaction step that runs afterward is a step you can forget.

The kit is the answer to those three. `lib/isc.js` asks the framework instead of guessing.
`lib/reference-stop.js` halts the run rather than guessing. `lib/capture-safe.js` is the
only door to a PNG, so redaction is not a call a script can omit.

## Install

```bash
git clone https://github.com/pinklightultra/smartclient-capture-kit
cd smartclient-capture-kit
npm install
npx playwright install chromium
node scripts/smoke-test.js
```

The smoke test needs no application, no credentials and no network. It builds a synthetic
page, asserts the guard blocks a Save click and allows an ordinary one, asserts the
redactor finds and covers regions, and asserts CDP attachment works.

Then point it at something:

```bash
node setup.js                      # writes .env, then optionally adds an environment
node setup.js --add-env            # adds an environment to capture.config.json
node setup.js --test staging       # logs in read-only and confirms the app loads
```

Node 20.9 or newer, which is sharp's floor rather than this kit's.

## Use

```bash
node run-modules.js --list                              # available modules
node run-modules.js --list-envs                         # configured environments
node run-modules.js --env staging --modules login,admin
node runner.js --url https://staging.example.com --script scripts/example-screens.js
node scripts/probe-isc-state.js --env staging           # what is actually on screen
node scripts/bench-interaction.js --env staging         # re-measure click strategies
node repl.js --env staging                              # one live session, many attempts
node watch.js -- node run-modules.js --env staging --modules login
```

Prefer `--env` over `--url`, and prefer `.env` or `CAPTURE_USER`/`CAPTURE_PASS` over
`--user`/`--pass`. Arguments are visible in the process list to every other user on the
machine; the environment name keeps the hostname out of your shell history.

### repl.js, for the part that takes the longest

Writing a selector or a navigation path takes ten or twenty attempts, and a cold launch plus
a login costs 15-20 seconds each time. `repl.js` holds one authenticated context open so you
pay that once:

```bash
CAPTURE_READONLY=1 node repl.js --env staging
capture> await nav.goto(page, 'Admin > Users')
capture> reload('./lib/nav')          # after editing lib/nav.js
capture> await shot('users')          # ./repl-shots/users.png
capture> await relogin()              # cookies went stale; rebinds page and context
```

`page`, `context`, `browser`, your libs, and `reload`/`shot`/`relogin` are preloaded.
Credentials are optional only when a saved session exists for that host, since resuming one
never touches the login form.

Two things worth knowing. `shot()` is **not** `safeShot`: it writes an unredacted picture of a
live application, which is correct for looking at what you just did and wrong for anything you
keep, so `repl-shots/` is gitignored. And `relogin()` closes the old context and rebinds `page`,
rather than only re-priming the saved state, because re-priming alone writes fresh cookies to
disk while the browser in front of you stays logged out.

### watch.js, for a run that fails in the middle

`watch.js` wraps a capture, watches for `FAILURE-*.json`, and hands each one to the CLI
configured under `agentHandoff`. The wrapped command keeps its own stdout.

```bash
node watch.js -- node run-modules.js --env staging --modules login,home,admin
```

It does not verify a fix. It collects an agent's diagnosis and says so; nothing here re-runs
the failed beat or confirms anything was repaired. `--rerun` lets the agent drive its own
browser, which is off by default because your capture session may still be open against the
same environment. The agent gets write access to the repo through whatever CLI you configured,
and nothing gates or rolls back an edit, so read the diff.

## Configuration

Everything environment-specific lives in `capture.config.json`. Nothing is hardcoded in
`lib/`. The blocks are:

| Block | What it holds |
|---|---|
| `environments` | named hosts, so scripts never embed a URL |
| `app` | login path, service path, field selectors, loading-overlay text, mask class fragments |
| `viewport`, `capture` | window size, output directory, crop box |
| `redaction` | the identity badge prefix, column labels, label patterns, value regexes, and `requireBoxes` |
| `guard` | the forbidden control labels |
| `navigation` | the shell's menu labels, tab strip geometry, and named `A > B > C` routes |
| `resolvers` | the resolution cascade order, Tesseract paths, template directory, optional vision command |
| `referenceLookup` | optional command run when a target cannot be resolved |
| `agentHandoff` | optional coding-agent CLI handed a failure report for diagnosis |

Credentials never go in this file.

### Environment variables

Nine, and this is all of them:

| Variable | Effect |
|---|---|
| `CAPTURE_USER`, `CAPTURE_PASS` | credentials. Both must be set to be used. Preferred over `--user`/`--pass`, which are visible in the process list |
| `CAPTURE_CONFIG` | path to a config file other than `capture.config.json` |
| `CAPTURE_ALLOW_WRITES=1` | **disarms the read-only click guard.** Nothing else does |
| `CAPTURE_READONLY=1`, `CAPTURE_NO_SUBMIT=1` | force the guard on, overriding `CAPTURE_ALLOW_WRITES` |
| `CAPTURE_REFERENCE_STOP=1` | on an unresolvable target, run the configured `referenceLookup` command and hard-stop instead of continuing |
| `CAPTURE_AGENT_HANDOFF=1` | hand a beat's failure report to the configured `agentHandoff` CLI for diagnosis |
| `CAPTURE_AGENT_RERUN=1` | additionally let that agent launch its own run. Off by default because the capture browser is still open and authenticated when the handoff fires |
| `TESSERACT_BIN` | path to the Tesseract binary, checked before `resolvers.tesseractCandidates` |

The guard is armed unless you set `CAPTURE_ALLOW_WRITES=1`. That default matters more than
it looks: the protection was originally opt-in, which meant it was absent in exactly the
case it was written for, someone running the kit for the first time against a shared
environment without having read `lib/guard.js`. Forgetting a variable should cost you a
blocked click, not a saved record.

`CAPTURE_READONLY` and `CAPTURE_NO_SUBMIT` are redundant with the default and kept because
six entry points set them deliberately. They win over `CAPTURE_ALLOW_WRITES` rather than
losing to it, so exporting the override in a shell for one purpose cannot silently disarm a
script that asked to be read-only.

## How a control gets clicked

`lib/nav.js` is built on a measured benchmark rather than on preference, and
`scripts/bench-interaction.js` is the benchmark. It runs four targets of increasing
difficulty (a unique tab label, an ambiguous label that appears in two places, an
async-loaded grid section, and a genuinely fixed-position control) against each applicable
click strategy under both wait strategies. Four targets times two waits is eight trials per
strategy, which is where the denominator below comes from:

| Strategy | Verified | Note |
|---|---|---|
| `element.click()` inside `page.evaluate` | **0 of 8** | not flaky. It never works |
| `page.locator('text=...')` | 100% of correctly-specified targets | most layout-robust |
| `page.mouse.click` on DOM-center coords | 100% of correctly-specified targets | needed when a label repeats |
| fixed pixel coordinates | reliable only for a genuinely fixed target | a coin flip everywhere else |

The zero is the useful result. SmartClient runs its own event manager and reacts only to
**trusted** input events. A synthetic DOM click is not trusted, so the framework never sees
it. Playwright's mouse API dispatches through CDP, which the browser marks trusted, which
is the only reason the coordinate paths work.

On waiting: polling `isc.Page.isLoaded()` was as reliable as a blind `waitForTimeout` and
about four times faster, 1.7 seconds per step against 7.1. Those two numbers are from one
run against one application, and the run output is not in the repo (`bench-results.json` is
gitignored, because it names screens). The ratio is the part worth trusting, and it follows
from how the two waits are built: the fixed wait is a hardcoded 6 s (`waitFixed`, default
`ms = 6000`) plus overlay dismissal, so it cannot go faster than 6 s no matter how quickly
the page settles, while the signal wait returns as soon as `isc.Page.isLoaded()` is true.
Re-measure on your own application with `node scripts/bench-interaction.js --env <name>`
rather than taking these figures as a specification.

So the canonical order is locator, then a positionally-banded DOM-center mouse click, then
the visual cascade. A band (`ymin`/`ymax`) is what disambiguates a label that appears twice,
and a locator cannot express one.

## Finding a grid row

Worth its own section because it was the largest single source of wrong captures. SmartClient
renders grids into generic divs with volatile ids **and virtualizes the rows**, so the row
you want may not be in the DOM at all until it is scrolled into view. Indexing rows by
on-screen position is therefore meaningless, and DOM sweeps, OCR and vision all miss.

`lib/isc.js` resolves a row by matching a field value against the grid widget's own backing
data, calls `scrollRecordIntoView()`, then asks the widget for its real page rect. No
coordinate guessing and no dependence on which rows happen to be painted.

## What the redactor is not

It is not a compliance control and it does not implement any named de-identification
standard. It covers exactly what you declare in the `redaction` block: the operator badge,
leaf text matching your `valuePatterns`, and values adjacent to labels or under grid columns
you name in `labelPatterns` and `columnLabels`.

The shipped patterns match US Social Security numbers, 10-digit phone and fax numbers, email
addresses, numeric dates, IPv4 addresses, URLs, and uppercase alphanumeric identifiers of
seven characters or more. That list reflects one application's screens. **Read it and change
it before you trust it on yours.**

`requireBoxes` is the safety net worth understanding: set it to the minimum number of
regions a capture must find and verify, and a capture that finds fewer aborts instead of
writing a file. A redactor that silently finds nothing is indistinguishable from a screen
with nothing to redact, and only one of those is safe.

## Redaction fails closed

There are eight places where a capture is abandoned rather than written: seven in
`lib/redact.js` and one in `lib/capture-safe.js`. Each throws `RedactionError`, and none of
them writes a PNG first.

| Condition | Why it is fatal |
| --- | --- |
| The captured region's size cannot be determined | Overlay bounds cannot be checked against anything |
| A region to cover lies entirely outside the capture | It would be absent from the image with no visible sign |
| A region extends past the capture and would be partly covered | A partly covered value is a legible value |
| Fewer regions were found than `requireBoxes` | The discovery selectors may have stopped matching this screen |
| Overlays did not attach in the DOM | The cover exists in the plan and not on the page |
| Overlays vanished between attaching and the shot | The application re-rendered mid-capture, so the image is not the page that was verified |
| The configured crop does not fit the capture | Cropping is geometry, not redaction, and a bad crop shifts every box |
| A configured column is visible but none of its values could be located | Indistinguishable from a screen with no such column, which is the case that produces a clean-looking unredacted capture |

The last one is the interesting failure. `scripts/smoke-test.js` covers it directly: it
builds a page with a `redaction.columnLabels` header and no values beneath it, asserts
`safeShot()` throws, and asserts that **no file exists afterwards**. Delete the check in
`capture-safe.js` and the smoke test goes red, which is the only reason to trust the
paragraph above.

`allowUnredacted: true` is the deliberate override for a screen that genuinely has nothing
to cover. It is a per-call argument rather than a config key or an environment variable so
that turning it on is visible in the script that did it.

## Limitations

- **Isomorphic SmartClient specific.** `lib/isc.js` and `lib/isc-nav.js` talk to
  `window.isc` directly. Against any other framework they are dead weight, though the
  guard, the redactor and `capture-safe.js` are framework-agnostic.
- **Chromium only.** The CDP trusted-input path and the redaction verification assume it.
- **The `navigation` geometry is per-shell.** `tabBarY` and `adminMenuItemPixel` are
  measured pixel values for one application's chrome. They are config keys rather than
  constants for that reason, but they still have to be measured.
- **The redactor depends on an authoring convention.** It identifies a field's value by
  adjacency to its label, and a grid value by the column it sits under. An unusual layout
  defeats it, which is what `requireBoxes` is there to catch.
- **English label vocabulary** in the shipped `guard.forbiddenTerms` and redaction lists.
- **The OCR and template tiers need setup you must do.** Tesseract is frequently installed
  without being on `PATH`, hence `tesseractCandidates`. No template crops ship with the
  kit, because template crops are screenshots of your application.
- **The vision tier sends an image to whatever you configure.** It is `null` by default and
  absent from the default `tiers` list. Leaving it that way guarantees no capture leaves the
  machine. Turning it on is a decision about where your screenshots go.
- **The guard matches control labels, not intent.** It blocks a button reading "Save". It
  cannot block a keyboard shortcut, a form that submits on Enter, or a button labelled
  something the list does not name. It reduces the risk of mutating a shared environment;
  it does not remove it. Capture against a non-production environment.

## Background

Built while running documentation for a healthcare SaaS platform, where it captured
release screenshots against shared non-production environments containing realistic data.
The three failure modes in "Why this exists" are all things that actually happened, and
most of the odd-looking defensiveness in this codebase is a specific scar.

## License

MIT. See [LICENSE](LICENSE).
