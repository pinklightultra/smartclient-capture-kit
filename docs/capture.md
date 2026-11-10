# Capture

`npm run capture` runs `node run-modules.js`. Pass the same flags after `npm run capture --`.

Two controls ship on.

**Mutating clicks are cancelled in the page.** A capture-phase listener in `lib/guard.js` blocks Save, Submit, Confirm, Apply, Delete, Remove, and Upload before the application's own handler runs. `CAPTURE_ALLOW_WRITES=1` is what disarms it.

**A PNG is written only after the cover is verified.** `run-modules.js` and `runner.js` take screenshots through `safeShot()` in `lib/capture-safe.js`. That calls `lib/redact.js`, which covers the regions you declared, checks that the overlays are painted at the requested geometry, takes the screenshot, checks that the overlays are still there, and only then writes the file. A failure throws `RedactionError` and leaves no file.

```bash
node run-modules.js --env staging --modules login,home,admin
```

Output goes to `screenshots/<environment>/<YYYY-MM-DD>/`, plus a `capture-manifest.json` of every file written. The folder name is the key from `environments` when the host matches one. Otherwise it is the first DNS label, or the IP address with dots replaced by hyphens.

Install, confirm the kit, and the checks behind these claims are in [Install](install.md) and [What the smoke test checks](smoke-test.md).

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
