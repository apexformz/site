/*
 * Frontend-only UI smoke checks. Start Next on port 3000 before running:
 *   node scripts/ui-smoke.cjs
 * All API requests are fulfilled with fixtures; no backend data is changed.
 * Set UI_BASE_URL or PLAYWRIGHT_MODULE if the local runtime differs.
 * Set UI_CHECK_FILTER to run matching check names and save a separate report.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(
      os.homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error(
    'Playwright is required. Install it locally or set PLAYWRIGHT_MODULE to its installed module path.',
  );
}
const { chromium } = loadPlaywright();

const BASE = process.env.UI_BASE_URL || 'http://127.0.0.1:3000';
const OUTPUT = path.resolve(__dirname, '../outputs/ui-review-v4');
const THEME_KEY = 'apexformz-theme';
const CHECK_FILTER = (process.env.UI_CHECK_FILTER || '').trim();
const REPORT_FILE = CHECK_FILTER
  ? 'smoke-targeted-report.json'
  : 'smoke-report.json';
const report = {
  baseURL: BASE,
  mockedAPI: true,
  checkFilter: CHECK_FILTER || null,
  checks: [],
  pageErrors: [],
  screenshots: [],
  themeSamples: [],
  requests: [],
};
const initialUser = {
  id: 'athlete-preview',
  name: 'Alex Morgan',
  email: 'alex@example.com',
  avatar_url: null,
  preferred_sport: 'taekwondo',
  created_at: '2026-10-01T08:00:00Z',
  stats: {
    user_id: 'athlete-preview',
    xp: 620,
    level: 4,
    streak: 5,
    total_sessions: 12,
    best_score: 94,
  },
  achievements: [
    {
      id: 'achievement-preview',
      user_id: 'athlete-preview',
      type: 'first_session',
      earned_at: '2026-10-01T08:00:00Z',
    },
  ],
  enhanced_streak: {
    current_streak: 5,
    longest_streak: 7,
    risk_score: 12,
    save_tokens: 2,
    identity_tier: 'consistent',
  },
  circle_members: [],
};
const session = {
  id: 'session-preview',
  user_id: initialUser.id,
  sport: 'taekwondo',
  duration_s: 420,
  score: 87,
  xp_earned: 85,
  created_at: '2026-10-26T08:00:00Z',
  feedback_summary:
    'Technical Summary:\nKeep your supporting knee soft and your guard raised.\n\nDetailed Form Analysis:\nPhase: CHAMBER\nCorrection: Lift your knee before extending your kick.',
  frames: [],
};
const circle = {
  id: 'preview-circle',
  name: 'The Early Risers',
  shared_streak: 4,
  circle_health: 82,
  created_at: '2026-10-01T08:00:00Z',
  activities: [],
  members: [
    {
      id: 'member-preview',
      user_id: initialUser.id,
      circle_id: 'preview-circle',
      role: 'anchor_user',
      joined_at: '2026-10-01T08:00:00Z',
      user: initialUser,
    },
  ],
};
const state = {
  user: structuredClone(initialUser),
  authError: false,
  empty: false,
  failResult: false,
  lastRegistration: null,
  lastCircleName: null,
  lastJoinCode: null,
};
function addCircleMembership() {
  state.user.circle_members = [
    {
      role: 'anchor_user',
      circle: {
        id: circle.id,
        name: circle.name,
        shared_streak: circle.shared_streak,
        circle_health: circle.circle_health,
      },
    },
  ];
}

function matchesCheckFilter(name) {
  return (
    !CHECK_FILTER || name.toLowerCase().includes(CHECK_FILTER.toLowerCase())
  );
}

async function check(name, fn) {
  if (!matchesCheckFilter(name)) return;
  try {
    await fn();
    report.checks.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({
      name,
      status: 'failed',
      error: String(error.message || error),
    });
    console.error(`FAIL ${name}: ${error.message || error}`);
  }
}

async function installFixtures(
  context,
  { authenticated = true, initialTheme } = {},
) {
  // Exercise the camera-off/permission-denied UI without opening a device,
  // downloading an inference model, or connecting to a live coach service.
  await context.route(
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/holistic@/,
    (route) => route.abort('blockedbyclient'),
  );
  await context.routeWebSocket(/\/socket\.io\//, (socket) =>
    socket.close({ code: 1000, reason: 'UI smoke: coach service offline' }),
  );
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace(/^.*\/api/, '');
    const method = request.method();
    const headers = {
      'content-type': 'application/json',
      'access-control-allow-origin': BASE,
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    };
    if (method === 'OPTIONS')
      return route.fulfill({ status: 204, headers, body: '' });
    let body;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }
    // Do not persist auth payloads or password values in the report.
    report.requests.push({ endpoint, method });
    let data;
    let status = 200;
    let error;
    if (endpoint.startsWith('/auth/')) {
      if (endpoint === '/auth/register')
        state.lastRegistration = {
          name: body?.name,
          email: body?.email,
          preferred_sport: body?.preferred_sport,
        };
      if (state.authError) {
        status = 400;
        error = 'Preview: check your details and try again.';
      } else
        data = {
          access_token: 'ui-smoke-access',
          refresh_token: 'ui-smoke-refresh',
          expires_in: 3600,
        };
    } else if (endpoint === '/users/me') {
      if (method === 'PATCH') state.user = { ...state.user, ...body };
      data = state.empty
        ? {
            ...state.user,
            stats: {
              ...state.user.stats,
              xp: 0,
              level: 1,
              streak: 0,
              total_sessions: 0,
              best_score: 0,
            },
            achievements: [],
            circle_members: [],
          }
        : state.user;
    } else if (endpoint === '/sessions') {
      data =
        method === 'POST'
          ? session
          : state.empty
            ? []
            : [
                session,
                {
                  ...session,
                  id: 'session-yoga',
                  sport: 'yoga',
                  score: 82,
                  duration_s: 300,
                  created_at: '2026-10-25T08:00:00Z',
                },
              ];
    } else if (endpoint.startsWith('/sessions/')) {
      if (state.failResult) {
        status = 500;
        error = 'Preview: session could not be loaded.';
      } else data = session;
    } else if (
      endpoint === '/circles' ||
      endpoint === '/circles/join' ||
      endpoint.startsWith('/circles/')
    ) {
      if (method === 'POST' && endpoint === '/circles') {
        state.lastCircleName = body?.name;
        addCircleMembership();
      }
      if (method === 'POST' && endpoint === '/circles/join') {
        state.lastJoinCode = body?.circleId;
        addCircleMembership();
      }
      data = circle;
    } else if (endpoint.includes('achievements')) {
      data = initialUser.achievements;
    } else {
      status = 404;
      error = `No smoke fixture for ${method} ${endpoint}`;
    }
    await route.fulfill({
      status,
      headers,
      body: JSON.stringify(
        error ? { success: false, error } : { success: true, data },
      ),
    });
  });
  await context.addInitScript(
    ({ authenticated, initialTheme }) => {
      // Seed only a new context. Never overwrite a theme selected by the user
      // during navigation, reload, or the storage synchronization checks.
      if (initialTheme && !localStorage.getItem('apexformz-theme'))
        localStorage.setItem('apexformz-theme', initialTheme);
      if (authenticated) {
        localStorage.setItem('access_token', 'ui-smoke-access');
        localStorage.setItem('refresh_token', 'ui-smoke-refresh');
      } else {
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
      }
      window.__uiSmokeMediaRequests = 0;
      const mediaDevices = navigator.mediaDevices || {};
      if (!navigator.mediaDevices)
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: mediaDevices,
        });
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          window.__uiSmokeMediaRequests += 1;
          throw new DOMException(
            'UI smoke: camera permission denied',
            'NotAllowedError',
          );
        },
      });
    },
    { authenticated, initialTheme },
  );
}

async function navigate(page, pathname) {
  const response = await page.goto(`${BASE}${pathname}`, {
    waitUntil: 'load',
    timeout: 60000,
  });
  assert(
    response && response.status() < 400,
    `${pathname} HTTP ${response?.status()}`,
  );
  await page
    .locator('h1:visible, h2:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  // SSR headings can appear before React has hydrated their controls. Wait
  // through script loading and the initial API/effect work before clicking.
  // A reconnecting studio may never become idle, so keep that wait bounded.
  await page
    .waitForLoadState('networkidle', { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(350);
}

async function noOverflow(page) {
  const size = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert(
    size.document <= size.viewport + 1 && size.body <= size.viewport + 1,
    `Horizontal overflow: viewport=${size.viewport}, document=${size.document}, body=${size.body}`,
  );
}

async function screenshot(page, name) {
  const filename = `${name}.png`;
  // Motion uses requestAnimationFrame rather than CSS animations. Let its
  // entrance opacity/position settle before Playwright captures the page.
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(OUTPUT, filename),
    fullPage: true,
    animations: 'disabled',
    timeout: 30000,
  });
  report.screenshots.push(filename);
}

async function waitForTheme(page, theme) {
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.theme === expected,
    theme,
    { timeout: 10000 },
  );
  assert.equal(
    await page
      .locator('html')
      .evaluate((element) => getComputedStyle(element).colorScheme),
    theme,
    'Native form controls should use the selected color scheme',
  );
}

async function setTheme(page, theme) {
  const current = await page.locator('html').getAttribute('data-theme');
  if (current !== theme) {
    const label =
      theme === 'dark' ? 'Switch to night theme' : 'Switch to day theme';
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await waitForTheme(page, theme);
  await page
    .getByRole('button', {
      name: theme === 'dark' ? 'Switch to day theme' : 'Switch to night theme',
      exact: true,
    })
    .waitFor();
  // Wait for color transitions before sampling the actual rendered palette.
  await page.waitForTimeout(350);
}

async function sculptureLoaded(page) {
  await page.locator('.performance-model-stage').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const model = document.querySelector(
        '.performance-model [data-render-state]',
      );
      return (
        model && ['ready', 'unavailable'].includes(model.dataset.renderState)
      );
    },
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

async function visualRoute(
  page,
  name,
  route,
  label,
  viewport,
  theme = 'light',
) {
  await navigate(page, route);
  await waitForTheme(page, theme);
  if (name === 'landing') await sculptureLoaded(page);
  if (name === 'dashboard')
    await page.getByRole('heading', { name: /Welcome back/i }).waitFor();
  if (name === 'unsupported-sport')
    await page
      .getByRole('heading', { name: /Discipline unavailable/i })
      .waitFor();
  if (name === 'setup' && viewport.width <= 390) {
    const action = await page
      .getByRole('button', { name: 'Start training', exact: true })
      .boundingBox();
    assert(
      action && action.y >= 0 && action.y + action.height <= viewport.height,
      'Mobile training action must stay in the viewport',
    );
  }
  if (name === 'training-camera-off') {
    await page.getByRole('heading', { name: 'Set up your camera' }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__uiSmokeMediaRequests),
      0,
      'Camera should stay off until enabled',
    );
    assert(
      await page
        .getByRole('button', { name: 'Start session', exact: true })
        .isDisabled(),
    );
  }
  await screenshot(page, `${label}-${name}`);
  await noOverflow(page);
}

async function themeSurfaceSample(page, selectors) {
  // Chrome can update a non-front tab's theme variables while deferring its
  // resolved paint colors. Sample the tab after it is presented, as a user
  // would see it; an arbitrary timeout alone does not flush that work.
  await page.bringToFront();
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  return page.evaluate((selectors) => {
    const sample = {};
    for (const [name, selector] of Object.entries(selectors)) {
      const element = document.querySelector(selector);
      if (!element)
        throw new Error(`Theme surface missing: ${name} (${selector})`);
      const css = getComputedStyle(element);
      sample[name] = {
        backgroundColor: css.backgroundColor,
        backgroundImage: css.backgroundImage,
        color: css.color,
        borderColor: css.borderColor,
        boxShadow: css.boxShadow,
      };
    }
    return sample;
  }, selectors);
}

function assertThemeSurfacesChange(light, dark, route) {
  for (const name of Object.keys(light)) {
    assert.notDeepEqual(
      [light[name].backgroundColor, light[name].backgroundImage],
      [dark[name].backgroundColor, dark[name].backgroundImage],
      `${route}: ${name} background did not change between day and night`,
    );
    assert.notEqual(
      light[name].color,
      dark[name].color,
      `${route}: ${name} foreground did not change between day and night`,
    );
  }
  const brightness = (color) => {
    const channels = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map(Number);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  assert(
    brightness(light.body.backgroundColor) >
      brightness(dark.body.backgroundColor) + 80,
    `${route}: day and night body surfaces must have visibly different luminance`,
  );
}

async function selectOption(page, name) {
  const tab = page.getByRole('tab', { name, exact: true });
  const target = (await tab.count())
    ? tab
    : page.getByRole('button', { name, exact: true });
  await target.click();
  return target;
}

async function formValid(page) {
  return page.locator('form').evaluate((form) => form.checkValidity());
}

async function sportCardsEqual(page, expected) {
  try {
    await page.waitForFunction(
      (expected) => {
        const actual = [...document.querySelectorAll('button h3')]
          .map((node) => node.textContent.trim())
          .sort();
        return JSON.stringify(actual) === JSON.stringify([...expected].sort());
      },
      expected,
      { timeout: 8000 },
    );
  } catch {
    const actual = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('button h3')].map((node) =>
        node.textContent.trim(),
      ),
      category: [
        ...document.querySelectorAll('button[aria-pressed="true"]'),
      ].map((node) => node.textContent.trim()),
      query:
        document.querySelector('input[aria-label="Search sports"]')?.value ||
        '',
    }));
    throw new Error(
      `Sports catalog mismatch. Expected ${JSON.stringify(expected)}; actual ${JSON.stringify(actual.cards)}; selected category ${JSON.stringify(actual.category)}; search ${JSON.stringify(actual.query)}`,
    );
  }
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const routes = [
      ['landing', '/'],
      ['login', '/login'],
      ['register', '/register'],
      ['sports', '/sports'],
      ['technology', '/technology'],
      ['dashboard', '/dashboard'],
      ['profile', '/profile'],
      ['circles-empty', '/circles'],
      ['circle', '/circle/preview-circle'],
      ['results', '/results/session-preview'],
      ['setup', '/train/taekwondo/setup'],
      ['squash-setup', '/train/squash/setup'],
      ['squash-studio', '/train/squash?pose=ready_stance'],
      ['unsupported-sport', '/train/pickleball/setup'],
      ['training-camera-off', '/train/yoga?pose=warrior_2'],
    ];
    for (const [label, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
      ['narrow', { width: 320, height: 720 }],
    ]) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
      });
      await installFixtures(context);
      const page = await context.newPage();
      page.on('pageerror', (error) =>
        report.pageErrors.push({
          viewport: label,
          url: page.url(),
          message: error.message,
        }),
      );
      const viewportRoutes = routes;
      for (const [name, route] of viewportRoutes) {
        await check(
          `${label}: ${name} renders without horizontal overflow`,
          async () => {
            await visualRoute(page, name, route, label, viewport);
          },
        );
      }
      await check(
        `${label}: populated circles list links to team details`,
        async () => {
          addCircleMembership();
          try {
            await navigate(page, '/circles');
            await page
              .getByRole('heading', { name: circle.name, exact: true })
              .waitFor();
            await screenshot(page, `${label}-circles-populated`);
            await noOverflow(page);
            await page
              .getByRole('link')
              .filter({
                has: page.getByRole('heading', {
                  name: circle.name,
                  exact: true,
                }),
              })
              .click();
            await page.waitForURL('**/circle/preview-circle');
            await page
              .getByRole('heading', { name: circle.name, exact: true })
              .waitFor();
          } finally {
            state.user.circle_members = [];
          }
        },
      );
      if (label !== 'narrow') {
        await check(
          `${label}: denied camera access displays recovery guidance`,
          async () => {
            await navigate(page, '/train/yoga?pose=warrior_2');
            await page
              .getByRole('button', { name: 'Enable camera', exact: true })
              .click();
            await page
              .getByRole('alert')
              .filter({ hasText: 'Camera access was blocked.' })
              .waitFor();
            assert.equal(
              await page.evaluate(() => window.__uiSmokeMediaRequests),
              1,
              'Expected one mocked camera request',
            );
            assert(
              await page
                .getByRole('button', { name: 'Start session', exact: true })
                .isDisabled(),
            );
            await screenshot(page, `${label}-training-camera-denied`);
            await noOverflow(page);
          },
        );
      }
      await context.close();
    }

    // Separate browser contexts exercise persisted night mode from the first
    // render, rather than relying on a screenshot-only CSS override.
    for (const [label, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const darkContext = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
      });
      await installFixtures(darkContext, { initialTheme: 'dark' });
      const darkPage = await darkContext.newPage();
      darkPage.on('pageerror', (error) =>
        report.pageErrors.push({
          viewport: `${label}-night`,
          url: darkPage.url(),
          message: error.message,
        }),
      );
      for (const [name, route] of routes) {
        await check(
          `${label} night: ${name} renders without horizontal overflow`,
          async () => {
            await visualRoute(
              darkPage,
              name,
              route,
              `${label}-night`,
              viewport,
              'dark',
            );
          },
        );
      }
      await check(
        `${label} night: populated circles retain readable themed surfaces`,
        async () => {
          addCircleMembership();
          try {
            await navigate(darkPage, '/circles');
            await waitForTheme(darkPage, 'dark');
            await darkPage
              .getByRole('heading', { name: circle.name, exact: true })
              .waitFor();
            await screenshot(darkPage, `${label}-night-circles-populated`);
            await noOverflow(darkPage);
          } finally {
            state.user.circle_members = [];
          }
        },
      );
      await darkContext.close();
    }

    for (const [label, viewport] of [
      ['desktop', { width: 1440, height: 1000 }],
      ['mobile', { width: 390, height: 844 }],
      ['narrow', { width: 320, height: 720 }],
    ]) {
      const publicContext = await browser.newContext({
        viewport,
        reducedMotion: 'reduce',
      });
      await installFixtures(publicContext, { authenticated: false });
      const publicPage = await publicContext.newPage();
      publicPage.on('pageerror', (error) =>
        report.pageErrors.push({
          viewport: `${label}-public`,
          url: publicPage.url(),
          message: error.message,
        }),
      );
      await check(
        `${label}: public home, sports, and technology are distinct working routes`,
        async () => {
          const firstRequest = report.requests.length;
          await navigate(publicPage, '/');
          const homeTitle = await publicPage.locator('h1').innerText();
          await publicPage
            .getByRole('link', { name: 'Explore sports', exact: true })
            .click();
          await publicPage.waitForURL('**/sports');
          await publicPage
            .getByRole('heading', {
              name: 'Choose your discipline.',
              exact: true,
            })
            .waitFor();
          assert.notEqual(
            await publicPage.locator('h1').innerText(),
            homeTitle,
          );
          await sportCardsEqual(publicPage, [
            'Cricket',
            'Tennis',
            'Yoga',
            'Running',
            'Boxing',
            'Taekwondo',
            'Squash',
          ]);
          await screenshot(publicPage, `${label}-sports-public`);
          await noOverflow(publicPage);
          assert.equal(
            report.requests
              .slice(firstRequest)
              .filter((request) => request.endpoint === '/users/me').length,
            0,
            'Public sports browsing must not request an athlete profile',
          );
          await publicPage
            .locator('nav:visible')
            .getByRole('link', { name: 'Technology', exact: true })
            .click();
          await publicPage.waitForURL('**/technology');
          await publicPage
            .getByRole('heading', { name: /Intelligence.*Every movement/i })
            .waitFor();
          await publicPage
            .locator('nav:visible')
            .getByRole('link', { name: 'Home', exact: true })
            .click();
          await publicPage.waitForURL(BASE + '/');
          assert.equal(await publicPage.locator('h1').innerText(), homeTitle);
        },
      );
      await publicContext.close();
    }

    const themeContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    });
    await installFixtures(themeContext);
    const themePage = await themeContext.newPage();
    themePage.on('pageerror', (error) =>
      report.pageErrors.push({
        viewport: 'theme-interactions',
        url: themePage.url(),
        message: error.message,
      }),
    );
    await check(
      'Day theme is the default even when the browser prefers dark',
      async () => {
        await navigate(themePage, '/');
        await waitForTheme(themePage, 'light');
        assert.equal(
          await themePage.evaluate(
            (key) => localStorage.getItem(key),
            THEME_KEY,
          ),
          null,
        );
        await themePage
          .getByRole('button', { name: 'Switch to night theme', exact: true })
          .waitFor();
      },
    );
    for (const [name, route, selectors] of [
      [
        'home',
        '/',
        { body: 'body', header: '.app-header', card: '.feature-card' },
      ],
      [
        'sports',
        '/sports',
        {
          body: 'body',
          header: '.app-header',
          card: 'main button:has(h3)',
          input: 'input[aria-label="Search sports"]',
        },
      ],
      [
        'dashboard',
        '/dashboard',
        {
          body: 'body',
          header: '.app-header',
          card: 'section[aria-label="Training statistics"] .glass-card',
        },
      ],
    ]) {
      await check(
        `${name}: day/night switch changes actual surface and text colors`,
        async () => {
          await navigate(themePage, route);
          await setTheme(themePage, 'light');
          const light = await themeSurfaceSample(themePage, selectors);
          await setTheme(themePage, 'dark');
          const dark = await themeSurfaceSample(themePage, selectors);
          report.themeSamples.push({ route, light, dark });
          assertThemeSurfacesChange(light, dark, route);
        },
      );
    }
    await check(
      'Theme selection persists across client navigation and full reloads',
      async () => {
        await navigate(themePage, '/dashboard');
        await setTheme(themePage, 'dark');
        assert.equal(
          await themePage.evaluate(
            (key) => localStorage.getItem(key),
            THEME_KEY,
          ),
          'dark',
        );
        await themePage
          .getByRole('navigation', { name: 'Main navigation', exact: true })
          .getByRole('link', { name: 'Sports', exact: true })
          .click();
        await themePage.waitForURL('**/sports');
        await waitForTheme(themePage, 'dark');
        await themePage.reload({ waitUntil: 'load' });
        await themePage
          .waitForLoadState('networkidle', { timeout: 10000 })
          .catch(() => {});
        await waitForTheme(themePage, 'dark');
        await themePage
          .getByRole('button', { name: 'Switch to day theme', exact: true })
          .waitFor();
        await themePage.waitForTimeout(350);
        await setTheme(themePage, 'light');
        await themePage
          .getByRole('navigation', { name: 'Main navigation', exact: true })
          .getByRole('link', { name: 'Overview', exact: true })
          .click();
        await themePage.waitForURL('**/dashboard');
        await waitForTheme(themePage, 'light');
        await themePage.reload({ waitUntil: 'load' });
        await themePage
          .waitForLoadState('networkidle', { timeout: 10000 })
          .catch(() => {});
        await waitForTheme(themePage, 'light');
        assert.equal(
          await themePage.evaluate(
            (key) => localStorage.getItem(key),
            THEME_KEY,
          ),
          'light',
        );
        await themePage
          .getByRole('button', { name: 'Switch to night theme', exact: true })
          .waitFor();
      },
    );
    await check(
      'Theme changes synchronize between open tabs through storage events',
      async () => {
        await navigate(themePage, '/dashboard');
        await setTheme(themePage, 'light');
        const secondTab = await themeContext.newPage();
        secondTab.on('pageerror', (error) =>
          report.pageErrors.push({
            viewport: 'theme-second-tab',
            url: secondTab.url(),
            message: error.message,
          }),
        );
        try {
          await navigate(secondTab, '/sports');
          await waitForTheme(secondTab, 'light');
          await setTheme(themePage, 'dark');
          await waitForTheme(secondTab, 'dark');
          await secondTab
            .getByRole('button', { name: 'Switch to day theme', exact: true })
            .waitFor();
          const firstDark = await themeSurfaceSample(themePage, {
            body: 'body',
          });
          const secondDark = await themeSurfaceSample(secondTab, {
            body: 'body',
          });
          assert.deepEqual(
            firstDark,
            secondDark,
            'Both tabs must render the same night palette',
          );
          await setTheme(secondTab, 'light');
          await waitForTheme(themePage, 'light');
          await themePage
            .getByRole('button', { name: 'Switch to night theme', exact: true })
            .waitFor();
          assert.equal(
            await themePage.evaluate(
              (key) => localStorage.getItem(key),
              THEME_KEY,
            ),
            'light',
          );
          const firstLight = await themeSurfaceSample(themePage, {
            body: 'body',
          });
          const secondLight = await themeSurfaceSample(secondTab, {
            body: 'body',
          });
          assert.deepEqual(
            firstLight,
            secondLight,
            'Both tabs must render the same day palette',
          );
          assert.notEqual(
            firstLight.body.backgroundColor,
            firstDark.body.backgroundColor,
          );
          assert.notEqual(firstLight.body.color, firstDark.body.color);
          report.themeSamples.push({
            route: 'cross-tab synchronization',
            light: firstLight,
            dark: firstDark,
            secondLight,
            secondDark,
          });
        } finally {
          await secondTab.close();
        }
      },
    );
    await themeContext.close();

    const mobileThemeContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    await installFixtures(mobileThemeContext, { authenticated: false });
    const mobileThemePage = await mobileThemeContext.newPage();
    mobileThemePage.on('pageerror', (error) =>
      report.pageErrors.push({
        viewport: 'mobile-theme-interactions',
        url: mobileThemePage.url(),
        message: error.message,
      }),
    );
    await check(
      'Compact mobile theme control switches and persists the selected palette',
      async () => {
        await navigate(mobileThemePage, '/sports');
        const light = await themeSurfaceSample(mobileThemePage, {
          body: 'body',
          input: 'input[aria-label="Search sports"]',
        });
        await setTheme(mobileThemePage, 'dark');
        const dark = await themeSurfaceSample(mobileThemePage, {
          body: 'body',
          input: 'input[aria-label="Search sports"]',
        });
        assertThemeSurfacesChange(light, dark, '/sports (mobile)');
        await mobileThemePage
          .locator('nav:visible')
          .getByRole('link', { name: 'Home', exact: true })
          .click();
        await mobileThemePage.waitForURL(BASE + '/');
        await waitForTheme(mobileThemePage, 'dark');
        await mobileThemePage.reload({ waitUntil: 'load' });
        await mobileThemePage
          .waitForLoadState('networkidle', { timeout: 10000 })
          .catch(() => {});
        await waitForTheme(mobileThemePage, 'dark');
        await noOverflow(mobileThemePage);
      },
    );
    await mobileThemeContext.close();

    const motionContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'no-preference',
    });
    await installFixtures(motionContext);
    const motionPage = await motionContext.newPage();
    motionPage.on('pageerror', (error) =>
      report.pageErrors.push({
        viewport: 'desktop-normal-motion',
        url: motionPage.url(),
        message: error.message,
      }),
    );
    await check('Desktop normal-motion landing settles visibly', async () => {
      await navigate(motionPage, '/');
      await sculptureLoaded(motionPage);
      await screenshot(motionPage, 'desktop-landing-normal-motion');
      const opacity = await motionPage.locator('h1').evaluate((element) => {
        let current = element;
        let effective = 1;
        while (current) {
          effective *= Number(getComputedStyle(current).opacity);
          current = current.parentElement;
        }
        return effective;
      });
      assert(
        opacity >= 0.99,
        `Hero entrance has not settled: opacity ${opacity}`,
      );
      await noOverflow(motionPage);
    });
    await check(
      'Reference athlete renders in WebGL with its caption below the model',
      async () => {
        await navigate(motionPage, '/');
        await sculptureLoaded(motionPage);
        assert.equal(
          await motionPage
            .locator('.performance-model [data-render-state]')
            .getAttribute('data-render-state'),
          'ready',
        );
        assert.equal(
          await motionPage.locator('.performance-model canvas').count(),
          1,
        );
        const stage = await motionPage
          .locator('.performance-model-stage')
          .boundingBox();
        const caption = await motionPage
          .locator('.scene-caption')
          .boundingBox();
        assert(
          caption.y >= stage.y + stage.height,
          'Caption must be outside the model viewport',
        );
        await motionPage
          .getByRole('button', { name: 'Pause athlete animation' })
          .click();
        await motionPage
          .getByRole('button', { name: 'Play athlete animation' })
          .waitFor();
        await motionPage
          .getByRole('button', { name: 'Play athlete animation' })
          .click();
      },
    );
    await motionContext.close();

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: 'reduce',
    });
    await installFixtures(context);
    const page = await context.newPage();
    page.on('pageerror', (error) =>
      report.pageErrors.push({
        viewport: 'interactions',
        url: page.url(),
        message: error.message,
      }),
    );

    await check(
      'Expanded marketing explains the product with working feature tabs and FAQs',
      async () => {
        await navigate(page, '/');
        await page
          .getByText('Your personal sports coach', { exact: true })
          .waitFor();
        assert((await page.locator('main section').count()) >= 7);
        await page
          .getByRole('tab', { name: 'Follow your progress', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Give every session a place to land.' })
          .waitFor();
        await page
          .getByRole('tab', { name: 'Follow your progress', exact: true })
          .press('ArrowRight');
        assert.equal(
          await page
            .getByRole('tab', { name: 'Find your people', exact: true })
            .getAttribute('aria-selected'),
          'true',
        );
        await page
          .getByRole('heading', {
            name: 'A routine feels better with company.',
          })
          .waitFor();
        const question = page.getByRole('button', {
          name: 'What can experimental Squash coaching do?',
          exact: true,
        });
        await question.click();
        assert.equal(await question.getAttribute('aria-expanded'), 'true');
        await page
          .getByRole('region', {
            name: 'What can experimental Squash coaching do?',
          })
          .getByText(/does not track the ball/)
          .waitFor();
        await question.click();
        assert.equal(await question.getAttribute('aria-expanded'), 'false');
        await navigate(page, '/technology');
        await page
          .getByRole('button', { name: 'Your landmarks', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Turn movement into landmarks.' })
          .waitFor();
        await page
          .getByRole('button', { name: 'Your feedback', exact: true })
          .click();
        await page
          .getByRole('heading', {
            name: 'Bring the next adjustment into focus.',
          })
          .waitFor();
      },
    );

    await check(
      'Experimental Squash is first and its three drills open the actual training studio',
      async () => {
        await navigate(page, '/sports');
        const order = await page.locator('button h3').allTextContents();
        assert.deepEqual(order.map((text) => text.trim()).slice(0, 3), [
          'Squash',
          'Taekwondo',
          'Yoga',
        ]);
        assert(!order.includes('Football'));
        await page
          .getByRole('button')
          .filter({
            has: page.getByRole('heading', { name: 'Squash', exact: true }),
          })
          .click();
        await page.waitForURL('**/train/squash/setup');
        await page
          .getByRole('region', { name: 'Experimental Squash coaching' })
          .waitFor();
        assert.deepEqual(await page.locator('button h3').allTextContents(), [
          'Ready stance',
          'Forehand volley preparation',
          'Backhand volley preparation',
        ]);
        await page
          .getByRole('button')
          .filter({
            has: page.getByRole('heading', {
              name: 'Backhand volley preparation',
              exact: true,
            }),
          })
          .click();
        await page
          .getByRole('button', { name: 'Start training', exact: true })
          .click();
        await page.waitForURL(
          '**/train/squash?pose=backhand_volley_preparation',
        );
        await page
          .getByRole('heading', { name: 'Set up your camera' })
          .waitFor();
        assert.equal(
          await page.evaluate(() => window.__uiSmokeMediaRequests),
          0,
        );
        await noOverflow(page);
      },
    );

    await check(
      'Dashboard navigation opens dedicated sports and circles pages',
      async () => {
        await navigate(page, '/dashboard');
        await page.getByRole('heading', { name: /Welcome back/i }).waitFor();
        await page
          .getByRole('link', { name: 'All sports', exact: true })
          .click();
        await page.waitForURL('**/sports');
        await page
          .getByRole('heading', {
            name: 'Choose your discipline.',
            exact: true,
          })
          .waitFor();
        const nav = page.getByRole('navigation', {
          name: 'Main navigation',
          exact: true,
        });
        assert.equal(
          await nav
            .getByRole('link', { name: 'Sports', exact: true })
            .getAttribute('aria-current'),
          'page',
        );
        await nav.getByRole('link', { name: 'Circles', exact: true }).click();
        await page.waitForURL('**/circles');
        await page
          .getByRole('heading', { name: 'Your training circles.', exact: true })
          .waitFor();
        assert.equal(
          await nav
            .getByRole('link', { name: 'Circles', exact: true })
            .getAttribute('aria-current'),
          'page',
        );
        await nav.getByRole('link', { name: 'Overview', exact: true }).click();
        await page.waitForURL('**/dashboard');
        await page
          .getByRole('link', { name: 'Find your circle', exact: true })
          .click();
        await page.waitForURL('**/circles');
      },
    );

    await check(
      'Sports search and categories filter the actual catalog, then open training',
      async () => {
        await navigate(page, '/sports');
        await sportCardsEqual(page, [
          'Cricket',
          'Tennis',
          'Yoga',
          'Running',
          'Boxing',
          'Taekwondo',
          'Squash',
        ]);
        await selectOption(page, 'Combat');
        await sportCardsEqual(page, ['Boxing', 'Taekwondo']);
        await page
          .getByRole('searchbox', { name: 'Search sports' })
          .fill('boxing');
        await sportCardsEqual(page, ['Boxing']);
        await page.getByRole('button', { name: 'Clear sport search' }).click();
        await sportCardsEqual(page, ['Boxing', 'Taekwondo']);
        await selectOption(page, 'Movement');
        await sportCardsEqual(page, ['Yoga', 'Running']);
        await selectOption(page, 'All sports');
        await page
          .getByRole('searchbox', { name: 'Search sports' })
          .fill('serve');
        await sportCardsEqual(page, ['Tennis']);
        await page
          .getByRole('searchbox', { name: 'Search sports' })
          .fill('no-such-sport');
        await sportCardsEqual(page, []);
        await page
          .getByRole('button', { name: 'Reset filters', exact: true })
          .click();
        await sportCardsEqual(page, [
          'Cricket',
          'Tennis',
          'Yoga',
          'Running',
          'Boxing',
          'Taekwondo',
          'Squash',
        ]);
        const card = page.getByRole('button').filter({
          has: page.getByRole('heading', { name: 'Taekwondo', exact: true }),
        });
        await card.click();
        await page.waitForURL('**/train/taekwondo/setup');
        await page
          .getByRole('heading', { name: 'Select your movement', exact: true })
          .waitFor();
      },
    );

    await check(
      'Achievement dialog opens, traps focus, and closes with Escape',
      async () => {
        await navigate(page, '/dashboard');
        await page
          .getByRole('button', { name: /View all achievements/i })
          .click();
        const dialog = page.getByRole('dialog', {
          name: 'Athlete achievements',
          exact: true,
        });
        await dialog.waitFor();
        await page.keyboard.press('Tab');
        assert(
          await dialog.evaluate((el) => el.contains(document.activeElement)),
          'Focus escaped the achievement dialog',
        );
        await screenshot(page, 'desktop-achievements-dialog');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      },
    );

    await check(
      'Circle dialog switches between join/create and creates a fixture circle',
      async () => {
        await navigate(page, '/circles');
        await page
          .getByRole('button', { name: 'Join or create a circle', exact: true })
          .click();
        const dialog = page.locator('dialog[open]');
        await dialog.getByLabel('Invite code', { exact: true }).waitFor();
        await dialog
          .getByRole('button', { name: 'Create a circle', exact: true })
          .click();
        await dialog
          .getByLabel('Circle name', { exact: true })
          .fill('The Early Risers');
        await screenshot(page, 'desktop-circle-dialog');
        await dialog
          .getByRole('button', { name: 'Create circle', exact: true })
          .click();
        await dialog
          .getByRole('heading', { name: 'Circle created', exact: true })
          .waitFor();
        assert.equal(
          state.lastCircleName,
          'The Early Risers',
          'Create request must contain the entered circle name',
        );
        await dialog.getByRole('button', { name: 'Done', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page
          .getByRole('heading', { name: circle.name, exact: true })
          .waitFor();
      },
    );

    await check(
      'Circle join submits the invite code and refreshes memberships',
      async () => {
        state.user.circle_members = [];
        await navigate(page, '/circles');
        await page
          .getByRole('button', { name: 'Find your circle', exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: 'Training circle',
          exact: true,
        });
        await dialog.getByLabel('Invite code', { exact: true }).fill(circle.id);
        await dialog
          .getByRole('button', { name: 'Join circle', exact: true })
          .click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(state.lastJoinCode, circle.id);
        await page
          .getByRole('heading', { name: circle.name, exact: true })
          .waitFor();
      },
    );

    await check(
      'Login validates fields, reports failure, and signs in with mocked success',
      async () => {
        await navigate(page, '/login');
        assert.equal(
          await formValid(page),
          false,
          'Empty login should be invalid',
        );
        await page
          .getByLabel('Email address', { exact: true })
          .fill('not-an-email');
        await page
          .getByLabel('Password', { exact: true })
          .fill('PreviewPass123!');
        assert.equal(
          await formValid(page),
          false,
          'Invalid email should fail browser validation',
        );
        await page
          .getByLabel('Email address', { exact: true })
          .fill('alex@example.com');
        await page
          .getByRole('button', { name: 'Show password', exact: true })
          .click();
        assert.equal(
          await page
            .getByLabel('Password', { exact: true })
            .getAttribute('type'),
          'text',
        );
        state.authError = true;
        await page.locator('form button[type="submit"]').click();
        await page.getByRole('alert').filter({ hasText: 'Preview:' }).waitFor();
        state.authError = false;
        await page.locator('form button[type="submit"]').click();
        await page.waitForURL('**/dashboard');
        assert.equal(
          await page.evaluate(() => localStorage.getItem('access_token')),
          'ui-smoke-access',
        );
      },
    );

    await check(
      'Registration validates password, selects a sport, and submits success/error states',
      async () => {
        await navigate(page, '/register');
        assert.equal(await formValid(page), false);
        await page.getByLabel('Your name', { exact: true }).fill('Alex Morgan');
        await page
          .getByLabel('Email address', { exact: true })
          .fill('alex@example.com');
        await page.getByLabel('Password', { exact: true }).fill('short');
        assert.equal(
          await formValid(page),
          false,
          'Short password should fail validation',
        );
        await page
          .getByLabel('Password', { exact: true })
          .fill('PreviewPass123!');
        await page.getByRole('button', { name: /^taekwondo$/i }).click();
        await page.getByRole('button', { name: /^squash$/i }).click();
        assert.equal(
          await page
            .getByRole('button', { name: /^squash$/i })
            .getAttribute('aria-pressed'),
          'true',
        );
        state.authError = true;
        await page.locator('form button[type="submit"]').click();
        await page.getByRole('alert').filter({ hasText: 'Preview:' }).waitFor();
        state.authError = false;
        await page.locator('form button[type="submit"]').click();
        await page.waitForURL('**/dashboard');
        assert.deepEqual(
          state.lastRegistration,
          {
            name: 'Alex Morgan',
            email: 'alex@example.com',
            preferred_sport: 'squash',
          },
          'Registration must submit the selected sport with the entered identity',
        );
      },
    );

    await check(
      'Movement search and selection update the training focus',
      async () => {
        await navigate(page, '/train/taekwondo/setup');
        await page
          .getByRole('textbox', { name: 'Search movements' })
          .fill('no-such-movement');
        await page.getByRole('button', { name: 'Clear search' }).click();
        const movements = page.locator('button[aria-pressed]');
        assert(
          (await movements.count()) > 1,
          'Expected multiple training movements',
        );
        const movementName = await movements.nth(1).locator('h3').innerText();
        await movements.nth(1).click();
        assert.equal(
          await movements.nth(1).getAttribute('aria-pressed'),
          'true',
        );
        await page
          .getByRole('heading', { name: movementName, level: 2, exact: true })
          .waitFor();
        await noOverflow(page);
        await page
          .getByRole('button', { name: 'Start training', exact: true })
          .click();
        await page.waitForURL(
          (url) =>
            url.pathname === '/train/taekwondo' &&
            Boolean(url.searchParams.get('pose')),
        );
        assert.equal(
          new URL(page.url()).searchParams.get('pose'),
          'dollyo_chagi_roundhouse_kick',
          'Selected roundhouse must be carried into the training URL',
        );
      },
    );

    if (matchesCheckFilter('Profile edits persist through mocked PATCH')) {
      await navigate(page, '/profile');
      const edit = page.getByRole('button', { name: /Edit profile/i });
      if (await edit.count()) {
        await check('Profile edits persist through mocked PATCH', async () => {
          await edit.click();
          await page
            .getByLabel(/Your name|Full name|Display name|^Name$/i)
            .fill('Alex Rivera');
          await page
            .getByRole('button', { name: /Save changes|Save profile/i })
            .click();
          await page
            .getByRole('heading', { name: 'Alex Rivera', exact: true })
            .waitFor();
          assert.equal(state.user.name, 'Alex Rivera');
        });
      } else {
        report.checks.push({
          name: 'Profile edit/save',
          status: 'skipped',
          reason: 'Profile editing is not an existing feature.',
        });
        console.log('SKIP Profile edit/save: not an existing feature');
      }
    }

    await check('Dashboard handles an athlete with no sessions', async () => {
      state.empty = true;
      try {
        await navigate(page, '/dashboard');
        await page.getByRole('heading', { name: /Welcome back/i }).waitFor();
        await page
          .getByText('No sessions recorded yet.', { exact: true })
          .waitFor();
        assert.equal(
          await page.locator('a[href^="/results/"]').count(),
          0,
          'Old session remains in empty state',
        );
        await screenshot(page, 'desktop-dashboard-empty');
        await noOverflow(page);
      } finally {
        state.empty = false;
      }
    });

    await check(
      'Results failure displays a recovery action instead of an endless loader',
      async () => {
        state.failResult = true;
        try {
          await page.goto(`${BASE}/results/session-preview`, {
            waitUntil: 'domcontentloaded',
          });
          await page
            .getByText(/could not|couldn.t|unable to|try again|not found/i)
            .first()
            .waitFor();
          const recovery = page
            .getByRole('link', { name: /dashboard|training|back|home/i })
            .or(
              page.getByRole('button', {
                name: /retry|try again|dashboard|back/i,
              }),
            );
          assert((await recovery.count()) > 0, 'Expected a recovery action');
          await screenshot(page, 'desktop-results-error');
          state.failResult = false;
          await page
            .getByRole('button', { name: 'Try again', exact: true })
            .click();
          await page
            .getByRole('heading', { name: 'Session analysis', exact: true })
            .waitFor();
        } finally {
          state.failResult = false;
        }
      },
    );

    await check('Sign out clears both stored auth tokens', async () => {
      await navigate(page, '/profile');
      await page
        .getByRole('button', { name: /Sign out of your account/i })
        .click();
      await page.waitForURL('**/login');
      assert.equal(
        await page.evaluate(() => localStorage.getItem('access_token')),
        null,
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem('refresh_token')),
        null,
      );
    });
    await context.close();
    await check('No uncaught page errors', async () =>
      assert.deepEqual(report.pageErrors, []),
    );
  } finally {
    await browser.close();
    await fs.writeFile(
      path.join(OUTPUT, REPORT_FILE),
      JSON.stringify(report, null, 2),
    );
  }
  const failures = report.checks.filter((item) => item.status === 'failed');
  if (CHECK_FILTER && !report.checks.length)
    throw new Error(
      `No smoke checks matched UI_CHECK_FILTER=${JSON.stringify(CHECK_FILTER)}`,
    );
  const passed = report.checks.filter(
    (item) => item.status === 'passed',
  ).length;
  const skipped = report.checks.filter(
    (item) => item.status === 'skipped',
  ).length;
  console.log(
    `${passed}/${report.checks.length - skipped} passed; ${skipped} skipped. Screenshots and report: ${OUTPUT}`,
  );
  if (failures.length) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  report.fatalError = String(error.stack || error);
  await fs.mkdir(OUTPUT, { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT, REPORT_FILE),
    JSON.stringify(report, null, 2),
  );
  process.exitCode = 1;
});
