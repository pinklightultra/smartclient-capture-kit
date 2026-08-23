/**
 * Base class for a capture module.
 *
 * Each area of the application under test is a module: login, home, admin, and so on.
 * A module declares its prerequisites, defines its steps, and produces named screenshots.
 * Steps are data, so a runner can list them, skip them, or resume a batch part-way.
 *
 * Usage:
 *   const LoginModule = require('./modules/login');
 *   const mod = new LoginModule({ page, baseUrl, screenshotDir, screenshot });
 *   await mod.run();
 */

class CaptureModule {
  constructor({ page, baseUrl, screenshotDir, screenshot, creds }) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.screenshotDir = screenshotDir;
    this.screenshot = screenshot;
    this.creds = creds || {};
    this.results = [];
  }

  static get name() { return 'base'; }
  static get description() { return ''; }
  static get prerequisites() { return []; }

  async run() {
    console.log(`\n[${this.constructor.name}] Starting...`);
    const steps = this.steps();
    for (const step of steps) {
      console.log(`  → ${step.label}`);
      const shots = await step.action();
      if (shots) {
        const arr = Array.isArray(shots) ? shots : [shots];
        this.results.push(...arr.map(s => ({ module: this.constructor.name, step: step.label, file: s })));
      }
    }
    console.log(`[${this.constructor.name}] Done. ${this.results.length} screenshots captured.`);
    return this.results;
  }

  steps() {
    return [];
  }

  async snap(name) {
    return this.screenshot(this.page, `${this.constructor.moduleName}-${name}`);
  }
}

module.exports = CaptureModule;
