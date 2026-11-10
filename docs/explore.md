# Find a screen before you script it

`npm run repl` runs `node repl.js`. Pass its flags after `npm run repl --`. `watch.js` and `scripts/synthetic-phi.js` are invoked with `node`. Neither is an npm script.

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
