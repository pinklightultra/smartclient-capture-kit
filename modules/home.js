const CaptureModule = require('../lib/module-base');
const { dismissOverlay } = require('../lib/login');
const { safeShot } = require('../lib/capture-safe');

class HomeModule extends CaptureModule {
  static get moduleName() { return 'home'; }
  static get description() { return 'My Cases home screen: portlets, queue counts, toolbar'; }
  static get prerequisites() { return ['login']; }

  steps() {
    return [
      { label: 'Wait for portlet data', action: () => this.waitForPortlets() },
      { label: 'Capture My Cases overview', action: () => this.captureOverview() },
      { label: 'Capture toolbar/nav bar', action: () => this.captureToolbar() },
    ];
  }

  async waitForPortlets() {
    await this.page.waitForTimeout(8000);
    await dismissOverlay(this.page);
  }

  async captureOverview() {
    return this.snap('my-cases-overview');
  }

  async captureToolbar() {
    const toolbar = await this.page.locator('.navBar, [eventproxy*="toolbar"]').first();
    if (await toolbar.isVisible().catch(() => false)) {
      const box = await toolbar.boundingBox();
      if (box) {
        const file = `${this.constructor.moduleName}-toolbar`;
        // Cropping is not redacting. The toolbar band is where the operator badge sits,
        // so this goes through safeShot() with the clip passed as the crop rather than
        // calling page.screenshot() directly, which is what it used to do.
        const result = await safeShot(this.page, this.screenshotDir, file, {
          crop: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 80) },
        });
        console.log(`    Clipped: ${file}.png (${result.verified} region(s) covered)`);
        return file;
      }
    }
    return this.snap('toolbar-fallback');
  }
}

module.exports = HomeModule;
