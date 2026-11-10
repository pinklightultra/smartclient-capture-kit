# Configuration

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

## Environment variables

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
