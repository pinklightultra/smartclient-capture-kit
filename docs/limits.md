# Limits

- **Navigation is SmartClient-specific.** `lib/isc.js` and `lib/isc-nav.js` call `window.isc`. The guard, the redactor, `safeShot()`, diff, and annotate run on the plain page the smoke test builds.
- **Chromium only.** Trusted input and the overlay check assume it.
- **Shell geometry is per application.** `navigation.tabBarY` (shipped as `95`) and `navigation.adminMenuItemPixel` (shipped as `[1090, 97]`) are measurements of one chrome. They are config so they are not constants in `lib/`. They still have to be measured on yours. `modules/admin.js` finds tabs with its own band, `y` greater than 78 and less than 100, separate from `tabBarY`.
- **Redaction follows one layout.** A field value is the leaf to the right of its label. A grid value is the cell under its header. Column matching in `findLabeledColumnValueBoxes()` stays inside the header's `.listGrid` when the header has one. A layout that breaks that defeats discovery. `requireBoxes` is what turns "found nothing" into a failed run.
- **The shipped vocabularies are English,** in `guard.forbiddenTerms` and the redaction lists.
- **The guard matches a label, on pointer and mouse events.** It inspects the clicked element and up to four ancestors, and it trusts `innerText` only when the element is under 260 by 80 CSS pixels, so the word Save inside a large panel does not block the panel. A keyboard shortcut, a form that submits on Enter, and a label the list omits all reach the application. Capture against a non-production environment.
- **OCR and templates need your setup.** See [Configuration](configuration.md). The vision tier uploads a screenshot once you enable it.
- **Saved sessions are credentials.** `.auth/` and `storageState*.json` hold live cookies. Both are gitignored. Deleting the file later leaves it in git history. Revoke the session if one was ever committed.
- **`diff-runs.js` counts pixels.** The HTML page uses the same counts and a stronger label.

## Where this came from

Built while running documentation for a healthcare SaaS platform. Captures ran against shared non-production environments that held realistic data. The comments in `lib/isc.js`, `lib/reference-stop.js`, `lib/guard.js`, `lib/redact.js`, and `lib/nav.js` describe the failures in [Three ways a finished run is still wrong](when-a-run-is-wrong.md) as ones that had already happened: a click the framework never received, a run that continued onto the wrong screen, a PNG written when the cover had not been verified. The checks in this repo are each tied to one of those outcomes.
