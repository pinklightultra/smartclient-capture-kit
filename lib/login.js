/**
 * lib/login.js - authenticate, then clear the loading overlays the shell leaves behind.
 *
 * Every selector and path here comes from capture.config.json (`app`), because the login
 * form and the post-login landing path are the two things that differ most between
 * deployments of the same framework.
 */
const { config, resolveCreds } = require('./config');

function appConfig() {
  return config().app || {};
}

/** Build the login URL for an environment, including the post-auth service redirect. */
function loginUrl(baseUrl) {
  const app = appConfig();
  const origin = new URL(baseUrl).origin;
  const service = origin + (app.loginServicePath || app.appPath || '/');
  const path = app.loginPath || '/';
  return `${origin}${path}?service=${encodeURIComponent(service)}`;
}

/** The authenticated landing URL for an environment. */
function appUrl(baseUrl) {
  const origin = new URL(baseUrl).origin;
  return origin + (appConfig().appPath || '/');
}

async function login(page, baseUrl, creds) {
  const app = appConfig();
  if (!creds) creds = resolveCreds([]);

  await page.goto(loginUrl(baseUrl), { timeout: 60000 });
  await page.waitForSelector(app.usernameSelector, { state: 'visible', timeout: 60000 });
  await page.fill(app.usernameSelector, creds.user);
  await page.fill(app.passwordSelector, creds.pass);

  // The app keeps background requests open after authentication, so `networkidle` never
  // fires. Wait for the redirect away from the login path and then for the app DOM.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith(app.loginPath || '/'), { timeout: 60000 }),
    page.click(app.submitSelector),
  ]);
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });

  await page.waitForFunction(
    () => typeof window.isc !== 'undefined' && window.isc.Page && window.isc.Page.isLoaded(),
    { timeout: 30000 },
  );
  await page.waitForTimeout(5000);
  await dismissOverlay(page);
}

/**
 * Hide the shell's loading curtain and any modal mask left over from a transition.
 *
 * The second sweep is a size/z-index heuristic rather than a class match: this framework
 * paints its click mask as an unclassed absolutely-positioned div at a very high z-index,
 * and the class names it does use change between point releases.
 */
async function dismissOverlay(page) {
  const app = appConfig();
  await page.evaluate(({ loadingText, classFragments, minWidth }) => {
    document.querySelectorAll('div').forEach((d) => {
      if (loadingText && (d.innerText || '').includes(loadingText)) d.style.display = 'none';
      const cls = typeof d.className === 'string' ? d.className : '';
      if (classFragments.some((fragment) => cls.includes(fragment))) d.style.display = 'none';
    });
    document.querySelectorAll('div').forEach((d) => {
      const style = getComputedStyle(d);
      const z = parseInt(style.zIndex, 10) || 0;
      if (z >= 800000 && style.position === 'absolute' && d.offsetWidth >= minWidth) {
        d.style.display = 'none';
      }
    });
  }, {
    loadingText: app.loadingOverlayText || null,
    classFragments: app.overlayClassFragments || [],
    minWidth: Math.max(200, ((config().viewport || {}).width || 1440) - 40),
  });
  await page.waitForTimeout(1000);
}

async function waitForLoad(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await dismissOverlay(page);
}

module.exports = { login, dismissOverlay, waitForLoad, loginUrl, appUrl };

