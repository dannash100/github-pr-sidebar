// NODE_PATH=~/dev/<a checkout with playwright>/node_modules node screenshots.cjs
const { chromium } = require('playwright');
const path = require('path');

const REPO = __dirname;
const OUT = REPO;
const PANEL = `file://${REPO}/panel.html`;

const now = Date.now();
const ago = (h) => new Date(now - h * 3600000).toISOString();
const url = (repo, n) => `https://github.com/acme/${repo}/pull/${n}`;

const CI_PASS = { state: 'pass', failed: [] };
const CI_FAIL = { state: 'fail', failed: ['build / unit'] };
const CI_PEND = { state: 'pending', failed: [] };

const pr = (o) => ({
  draft: false,
  comments: 0,
  baseRef: 'main',
  headRef: null,
  conflicts: false,
  additions: 0,
  deletions: 0,
  ci: null,
  queue: null,
  review: null,
  approvals: [],
  blockedBy: null,
  tracked: false,
  author: null,
  avatar: null,
  collab: false,
  group: null,
  note: null,
  qaDoc: null,
  later: false,
  ...o,
  html_url: url(o.repo, o.number),
  repo: `acme/${o.repo}`,
});

const ACTIVE = url('webapp', 441);

const PRS = [
  pr({ repo: 'webapp', number: 412, title: 'feat(checkout): new payment flow', updated_at: ago(13), additions: 4820, deletions: 963, comments: 4, ci: CI_FAIL, headRef: 'checkout/payments', group: 'c-checkout' }),
  pr({ repo: 'webapp', number: 428, title: 'feat(checkout): address form validation', updated_at: ago(5), additions: 312, deletions: 96, comments: 2, ci: CI_PASS, baseRef: 'checkout/payments', headRef: 'checkout/address-form', group: 'c-checkout' }),
  pr({ repo: 'webapp', number: 433, title: 'feat(checkout): saved cards list', updated_at: ago(2), additions: 244, deletions: 18, ci: CI_PEND, baseRef: 'checkout/address-form', headRef: 'checkout/saved-cards', group: 'c-checkout' }),

  pr({ repo: 'api', number: 390, title: 'refactor(search): move ranking to the API', updated_at: ago(24), additions: 1904, deletions: 1288, comments: 11, ci: CI_PASS, headRef: 'search/ranking', group: 'c-search' }),
  pr({ repo: 'api', number: 398, title: 'refactor(search): drop the legacy ranker', updated_at: ago(30), additions: 88, deletions: 940, ci: CI_FAIL, group: 'c-search' }),
  pr({ repo: 'api', number: 401, title: 'feat(search): synonyms in the index', updated_at: ago(34), additions: 402, deletions: 61, ci: CI_PASS, conflicts: true, group: 'c-search' }),

  pr({ repo: 'cli', number: 118, title: 'feat: honour the config timeout', updated_at: ago(1), additions: 96, deletions: 12, comments: 1, ci: CI_PASS, review: 'APPROVED', approvals: ['octocat'] }),
  pr({ repo: 'webapp', number: 441, title: 'fix(editor): stop swallowing pasted markdown', updated_at: ago(4), additions: 41, deletions: 9, ci: CI_PASS, note: 'waiting on a design call', qaDoc: 'https://example.com/qa/editor-paste' }),
  pr({ repo: 'webapp', number: 444, title: 'fix(sessions): keep cursors after a failed retry', updated_at: ago(6), additions: 120, deletions: 44, ci: CI_PASS }),
  pr({ repo: 'webapp', number: 445, title: 'fix(sessions): keep cursors after a failed retry (HOTFIX 2.7)', updated_at: ago(7), additions: 118, deletions: 44, ci: CI_FAIL }),
  pr({ repo: 'webapp', number: 446, title: 'fix(sessions): keep cursors after a failed retry (HOTFIX 2.8)', updated_at: ago(7), additions: 118, deletions: 44, ci: CI_PASS }),
  pr({ repo: 'webapp', number: 447, title: 'feat(reports): batch the export queue', updated_at: ago(8), additions: 512, deletions: 61, comments: 6, ci: CI_PASS, author: 'octocat', collab: true }),
  pr({ repo: 'webapp', number: 436, title: 'chore(deps): bump the pinned node image', updated_at: ago(9), additions: 4, deletions: 4, ci: CI_PASS, draft: true, blockedBy: { repo: 'acme/api', number: 390, state: 'open', title: 'refactor(search): move ranking to the API', html_url: url('api', 390) } }),

  pr({ repo: 'webapp', number: 402, title: 'chore: drop the legacy avatar proxy', updated_at: ago(26), additions: 12, deletions: 388, ci: CI_PASS, later: true }),
  pr({ repo: 'cli', number: 121, title: 'docs: flag deprecations in help output', updated_at: ago(28), additions: 64, deletions: 8, ci: CI_PASS, later: true }),
  pr({ repo: 'api', number: 357, title: 'refactor(api): split the webhook worker', updated_at: ago(50), additions: 730, deletions: 512, ci: CI_FAIL, later: true, group: 'c-cleanup' }),
  pr({ repo: 'cli', number: 129, title: 'chore(ci): cache the toolchain between runs', updated_at: ago(52), additions: 31, deletions: 5, ci: CI_PASS, later: true, group: 'c-cleanup' }),
];

const CATEGORIES = [
  { id: 'c-checkout', name: 'Checkout redesign', emoji: '🛒', color: 'rgba(56, 139, 253, 0.1)', pattern: 'dots', epic: url('webapp', 412), collapsed: false, qaDoc: 'https://example.com/qa/checkout' },
  { id: 'c-search', name: 'Search rework', emoji: '🧭', color: 'rgba(163, 113, 247, 0.1)', pattern: 'stripes', epic: url('api', 390), collapsed: true },
  { id: 'c-cleanup', name: 'Q3 cleanups', emoji: '🧹', color: 'rgba(52, 211, 153, 0.1)', pattern: 'checks', epic: null, collapsed: false, later: true },
];

const prMeta = Object.fromEntries(
  PRS.filter((p) => p.group || p.note || p.qaDoc || p.later || p.blockedBy).map((p) => [
    p.html_url,
    {
      ...(p.group ? { group: p.group } : {}),
      ...(p.note ? { note: p.note } : {}),
      ...(p.qaDoc ? { qaDoc: p.qaDoc } : {}),
      ...(p.later ? { later: true } : {}),
    },
  ]),
);

const STORE = {
  token: 'ghp_screenshot',
  snapshot: JSON.stringify(PRS),
  categories: CATEGORIES,
  prMeta,
  collapsedNodes: [],
  scope: '',
  involvement: 'involved',
};

function initScript({ store, activeUrl }) {
  const state = JSON.parse(JSON.stringify(store));
  const pick = (keys) => {
    if (typeof keys === 'string') return { [keys]: state[keys] };
    const out = {};
    for (const k of keys ?? Object.keys(state)) out[k] = state[k];
    return out;
  };
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (obj) => Object.assign(state, obj),
        remove: async (k) => {
          for (const key of [].concat(k)) delete state[key];
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, windowId: 1, url: activeUrl }],
      update: async () => {},
      create: async () => {},
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: { update: async () => {} },
  };
  window.fetch = () => new Promise(() => {});
}

const settle = async (page) => {
  await page.waitForSelector('#list li');
  await page.evaluate(() => {
    document.getElementById('refresh').classList.remove('spin');
  });
  await page.waitForTimeout(400);
};

async function shot(browser, name, { dark = false, later = false, drag = null } = {}) {
  const context = await browser.newContext({
    viewport: { width: 420, height: 730 },
    deviceScaleFactor: 2,
    colorScheme: dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  await page.addInitScript(initScript, { store: STORE, activeUrl: ACTIVE });
  await page.goto(PANEL);
  await settle(page);
  if (later) {
    await page.click('#later');
    await page.waitForTimeout(300);
  }
  if (drag) {
    const from = await page.locator(drag.from).first().boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (const [dx, dy] of [[0, -20], [0, -80]]) {
      await page.mouse.move(from.x + from.width / 2 + dx, from.y + from.height / 2 + dy, { steps: 5 });
    }
    const to = await page.locator(drag.to).first().boundingBox();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 1, { steps: 3 });
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: path.join(OUT, name) });
  await context.close();
  console.log(name);
}

(async () => {
  const browser = await chromium.launch();
  await shot(browser, 'screenshot-light.png');
  await shot(browser, 'screenshot-dark.png', { dark: true });
  await shot(browser, 'screenshot-drag.png', {
    from: undefined,
    drag: { from: '[data-drag-pr="' + url('webapp', 447) + '"] .title-text', to: '[data-drag-cat="c-checkout"]' },
  });
  await shot(browser, 'screenshot-later-light.png', { later: true });
  await shot(browser, 'screenshot-later-dark.png', { later: true, dark: true });
  await shot(browser, 'screenshot-later-drag.png', {
    drag: { from: '[data-drag-pr="' + url('cli', 118) + '"] .title-text', to: '#shelfdrop' },
  });
  await browser.close();
})();
