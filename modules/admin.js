const CaptureModule = require('../lib/module-base');
const { dismissOverlay } = require('../lib/login');
const { openAdmin } = require('../lib/nav');

class AdminModule extends CaptureModule {
  static get moduleName() { return 'admin'; }
  static get description() { return 'Admin section: tab navigation, Main/Access/UM/Compliance/CM views'; }
  static get prerequisites() { return ['login']; }

  steps() {
    return [
      { label: 'Open Menu > Admin', action: () => this.openAdmin() },
      { label: 'Capture Admin landing', action: () => this.captureLanding() },
      { label: 'Capture each admin tab', action: () => this.captureTabs() },
    ];
  }

  // Delegates to nav.openAdmin rather than repeating it. This method used to hardcode
  // `text=Menu`, the pixel (1090, 97), and a blind 8-second wait -- a worse copy of the
  // same three steps, with the menu label and the pixel duplicated out of
  // capture.config.json and no post-condition.
  //
  // The post-condition is the part that matters. A blind wait returns whether or not the
  // section opened, so a failure here produced a full run of plausible-looking captures of
  // the home dashboard. nav.openAdmin waits on `navigation.adminPostCondition`, an element
  // that only exists on the destination.
  // The bare `openAdmin` below is the imported one. A class method does not create a
  // binding in the surrounding scope, so this is not recursion.
  async openAdmin() {
    await openAdmin(this.page);   // already ends in dismissOverlay
  }

  async captureLanding() {
    return this.snap('landing');
  }

  async captureTabs() {
    const tabs = await this.page.evaluate(() => {
      const items = [];
      document.querySelectorAll('div, td, span').forEach(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || '').trim();
        if (rect.y > 78 && rect.y < 100 && text && text.length < 20 && !text.includes('\n') && rect.height > 8 && rect.height < 30) {
          items.push({ text, x: Math.round(rect.x), y: Math.round(rect.y) });
        }
      });
      const seen = new Set();
      return items.filter(i => {
        const k = `${i.text}-${i.x}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => a.x - b.x);
    });

    const shots = [];
    for (const tab of tabs) {
      await this.page.mouse.click(tab.x + 30, tab.y + 5);
      await this.page.waitForTimeout(3000);
      await dismissOverlay(this.page);
      const name = tab.text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      shots.push(await this.snap(`tab-${name}`));
    }
    return shots;
  }
}

module.exports = AdminModule;
