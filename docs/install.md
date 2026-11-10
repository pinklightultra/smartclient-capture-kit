# Install

`npm run setup` runs `node setup.js`. Pass its flags through npm after `--`.

Node 20.9 or newer. That floor is `engines` in `package.json`, and it is sharp's requirement.

```bash
git clone https://github.com/pinklightultra/smartclient-capture-kit
cd smartclient-capture-kit
npm install
npx playwright install chromium
npm run smoke
```

`npm run smoke` runs `node scripts/smoke-test.js`. The smoke test uses no application, no credentials, and no network. It builds its own page. The assertions are listed in [What the smoke test checks](smoke-test.md).

Point it at an environment after that. Credentials go in `.env`, which is gitignored. Hosts go in `capture.config.json`. `lib/` does not contain a URL.

```bash
node setup.js                 # writes .env as CAPTURE_USER and CAPTURE_PASS
node setup.js --add-env       # adds a named host under environments
node setup.js --test staging  # logs in with the guard forced on and confirms the app loads
```

The same three calls through npm are `npm run setup`, `npm run setup -- --add-env`, and `npm run setup -- --test staging`.

`setup.js` writes the `environments` block of `capture.config.json`, the file `lib/config.js` reads. The missing-credentials error mentions `.env.example`. That file is not in the repo. `setup.js` is what creates `.env`.
