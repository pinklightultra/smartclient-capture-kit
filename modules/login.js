const CaptureModule = require('../lib/module-base');
const { dismissOverlay } = require('../lib/login');
const { config } = require('../lib/config');

class LoginModule extends CaptureModule {
  static get moduleName() { return 'login'; }
  static get description() { return 'Login flow: auth page, credentials entry, post-login landing'; }
  static get prerequisites() { return []; }

  steps() {
    return [
      { label: 'Navigate to login page', action: () => this.navigateToLogin() },
      { label: 'Capture empty login form', action: () => this.captureLoginForm() },
      { label: 'Enter credentials', action: () => this.enterCredentials() },
      { label: 'Submit and wait for app load', action: () => this.submitAndWait() },
      { label: 'Capture post-login home', action: () => this.captureHome() },
    ];
  }

  // Paths and selectors come from the "app" block of capture.config.json. They were once
  // literals here, which meant this module only ever worked against one deployment.
  app() {
    return config().app || {};
  }

  async navigateToLogin() {
    const app = this.app();
    const service = encodeURIComponent(this.baseUrl + (app.loginServicePath || '/app/index.html'));
    const loginUrl = `${this.baseUrl}${app.loginPath || '/cas/login'}?service=${service}`;
    await this.page.goto(loginUrl);
    await this.page.waitForSelector(app.usernameSelector || '#username', { state: 'visible' });
  }

  async captureLoginForm() {
    return this.snap('login-page');
  }

  async enterCredentials() {
    const app = this.app();
    await this.page.fill(app.usernameSelector || '#username', this.creds.user);
    await this.page.fill(app.passwordSelector || '#password', this.creds.pass);
    return this.snap('credentials-entered');
  }

  async submitAndWait() {
    await this.page.click(this.app().submitSelector || 'input[type="submit"]');
    await this.page.waitForLoadState('networkidle');
    await this.page.waitForFunction(
      () => typeof window.isc !== 'undefined' && window.isc.Page && window.isc.Page.isLoaded(),
      { timeout: 30000 }
    );
    await this.page.waitForTimeout(5000);
    await dismissOverlay(this.page);
  }

  async captureHome() {
    return this.snap('post-login-home');
  }
}

module.exports = LoginModule;
