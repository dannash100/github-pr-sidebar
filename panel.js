const api = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);
const list = $('list');
const statusEl = $('status');
const setup = $('setup');
const emptyEl = $('empty');
const laterBtn = $('later');
const shelfDrop = $('shelfdrop');
const looseDrop = $('loosedrop');

let viewLater = false; // showing the For later shelf instead of the live list
let activeTabUrl = null; // URL of the currently focused browser tab
let cachedLogin = null; // GitHub login, fetched once; cleared when the token changes
const detailCache = new Map(); // html_url -> { baseRef, headRef, conflicts, additions, deletions, updated_at, detailAt }
const ciCache = new Map(); // html_url -> { ci, at, updated_at }
const DETAIL_TTL = 300000;
const CI_TTL = 60000;
let prMeta = {}; // html_url -> { group, blockedBy, note, later }, user-set via the row editor
let categories = []; // [{ id, name, emoji, color, epic, collapsed }], render order
let collapsedNodes = new Set(); // html_urls whose stacked children are folded away
let filterText = '';
const blockerCache = new Map(); // owner/repo#n -> { repo, number, state, title, html_url, fetchedAt }
let editorOpen = null; // key whose editor is open; load/renderList bail so a poll can't wipe typing

const newId = () => `c${Math.random().toString(36).slice(2, 9)}`;
const catById = (id) => categories.find((c) => c.id === id) ?? null;
const saveCats = () => api.storage.local.set({ categories });
const saveMeta = () => api.storage.local.set({ prMeta });

async function getToken() {
  const { token } = await api.storage.local.get('token');
  return token;
}

// Optional search qualifiers (org:foo, repo:owner/name). Empty = all your PRs.
async function getScope() {
  const { scope } = await api.storage.local.get('scope');
  return scope || '';
}

async function getInvolvement() {
  const { involvement } = await api.storage.local.get('involvement');
  return involvement === 'mine' ? 'mine' : 'involved';
}

async function loadState() {
  const s = await api.storage.local.get([
    'prMeta',
    'categories',
    'groupStyles',
    'collapsedGroups',
    'collapsedNodes',
  ]);
  prMeta = s.prMeta ?? {};
  collapsedNodes = new Set(s.collapsedNodes ?? []);
  if (s.categories) {
    categories = s.categories;
    return;
  }
  // Groups used to be plain names on each PR with styles in a side map; carry
  // those over to id-keyed category records.
  const names = [...new Set(Object.values(prMeta).map((m) => m.group).filter(Boolean))].sort();
  categories = names.map((name) => ({
    id: newId(),
    name,
    emoji: s.groupStyles?.[name]?.emoji ?? '📌',
    color: s.groupStyles?.[name]?.color ?? '',
    epic: null,
    collapsed: (s.collapsedGroups ?? []).includes(name),
  }));
  const byName = new Map(categories.map((c) => [c.name, c.id]));
  for (const m of Object.values(prMeta)) if (byName.has(m.group)) m.group = byName.get(m.group);
  await api.storage.local.set({ categories, prMeta });
}

// 401/403 mean the token; 5xx/429/etc. are GitHub having a moment, say so
// instead of telling the user to re-paste a token that's actually fine.
function statusMsg(code) {
  if (code === 401 || code === 403) return `Token rejected (${code}). Re-paste a valid token via ⚙.`;
  return `GitHub unavailable (${code}), retrying…`;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [label, secs] of units) {
    const n = Math.floor(seconds / secs);
    if (n >= 1) return `${n}${label} ago`;
  }
  return 'just now';
}

const CI_BAD = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

// A rerun adds a whole new check suite, and GitHub's own PR page counts only
// the newest suite per workflow and trigger. Counting them all keeps a
// superseded failure on screen for as long as the branch head lives.
function rollupCi(commit) {
  const newest = new Map();
  for (const suite of commit?.checkSuites?.nodes ?? []) {
    if (!suite) continue;
    // Apps that register a suite on the PR and never post a run sit at QUEUED
    // for the life of the branch, which would read as CI still going.
    if (!suite.workflowRun && suite.status === 'QUEUED') continue;
    const workflow = suite.workflowRun?.workflow?.id ?? `app:${suite.app?.id}`;
    const key = `${workflow}|${suite.workflowRun?.event ?? ''}`;
    const prev = newest.get(key);
    if (!prev || (suite.createdAt ?? '') >= (prev.createdAt ?? '')) newest.set(key, suite);
  }
  if (!newest.size) return null;
  const suites = [...newest.values()];
  const bad = suites.filter((s) => CI_BAD.has(s.conclusion));
  let state;
  if (suites.some((s) => s.status !== 'COMPLETED')) state = 'pending';
  else if (bad.length) state = 'fail';
  else state = 'pass';
  return { state, failed: bad.flatMap((s) => s.bad?.nodes?.map((n) => n.name) ?? []) };
}

async function graphql(token, query, ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
  const nodes = [];
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { ids: chunk } }),
        });
        if (!res.ok) return;
        nodes.push(...((await res.json())?.data?.nodes ?? []));
      } catch {
        // chunk missing → those PRs keep their last known state this poll
      }
    }),
  );
  return nodes;
}

// Review decision and merge-queue position: neither is in the REST search
// results, and both come back in a fraction of the time the check suites take.
const EXTRAS_QUERY =
  'query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{id reviewDecision mergeQueueEntry{state position}}}}';

async function fetchPrExtras(token, items) {
  const map = new Map();
  for (const node of await graphql(token, EXTRAS_QUERY, items.map((i) => i.node_id).filter(Boolean))) {
    if (node?.id) map.set(node.id, { queue: node.mergeQueueEntry ?? null, review: node.reviewDecision ?? null });
  }
  return map;
}

// Walking the check suites is by far the slowest thing this panel asks for, so
// it runs behind the render and only for PRs whose state could have moved.
const CI_QUERY = `query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{
id commits(last:1){nodes{commit{checkSuites(last:30){nodes{
status conclusion createdAt app{id} workflowRun{event workflow{id}}
bad:checkRuns(first:3,filterBy:{conclusions:[FAILURE,TIMED_OUT,CANCELLED,ACTION_REQUIRED,STARTUP_FAILURE]}){nodes{name}}
}}}}}}}}`;

async function fetchCiMap(token, items) {
  const map = new Map();
  for (const node of await graphql(token, CI_QUERY, items.map((i) => i.node_id).filter(Boolean))) {
    if (node?.id) map.set(node.id, rollupCi(node.commits?.nodes?.[0]?.commit));
  }
  return map;
}

const codedCache = new Map(); // html_url -> { updated_at, coded }

// Search has no "I committed to this" qualifier, so ask GraphQL who wrote the
// commits: a PR you were only mentioned on or commented on isn't work you did.
async function fetchCoded(token, items, login) {
  const out = new Map();
  const pending = [];
  for (const item of items) {
    const cached = codedCache.get(item.html_url);
    if (cached && cached.updated_at === item.updated_at) out.set(item.html_url, cached.coded);
    else if (item.node_id) pending.push(item);
    else out.set(item.html_url, true);
  }
  const query =
    'query($ids:[ID!]!){nodes(ids:$ids){... on PullRequest{url commits(last:60){nodes{commit{' +
    'author{user{login}} authors(first:5){nodes{user{login}}}}}}}}}';
  const chunks = [];
  for (let i = 0; i < pending.length; i += 10) chunks.push(pending.slice(i, i + 10));
  await Promise.all(
    chunks.map(async (chunk) => {
      let byUrl = null;
      try {
        const res = await fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { ids: chunk.map((c) => c.node_id) } }),
        });
        if (res.ok) {
          byUrl = new Map();
          for (const node of (await res.json())?.data?.nodes ?? []) {
            if (!node?.url) continue;
            const logins = new Set();
            for (const c of node.commits?.nodes ?? []) {
              if (c.commit?.author?.user?.login) logins.add(c.commit.author.user.login);
              for (const co of c.commit?.authors?.nodes ?? []) if (co?.user?.login) logins.add(co.user.login);
            }
            byUrl.set(node.url, logins.has(login));
          }
        }
      } catch {
        byUrl = null; // keep the PR rather than hiding it on a network blip
      }
      for (const item of chunk) {
        const coded = byUrl?.has(item.html_url) ? byUrl.get(item.html_url) : true;
        out.set(item.html_url, coded);
        if (byUrl) codedCache.set(item.html_url, { updated_at: item.updated_at, coded });
      }
    }),
  );
  return out;
}

async function searchPrs(token, q) {
  const url =
    'https://api.github.com/search/issues?q=' + encodeURIComponent(q) + '&sort=updated&order=desc&per_page=50';
  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) return { ok: false, status: res.status, items: [] };
    return { ok: true, status: 200, items: (await res.json()).items ?? [] };
  } catch {
    return { ok: false, status: 0, items: [] };
  }
}

// "Blocked by" accepts a PR URL, owner/repo#12, or #12 (same repo as the PR).
function parseBlocker(spec, ownRepo) {
  let m = spec.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (!m) m = spec.match(/^([^/\s#]+\/[^/\s#]+)#(\d+)$/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = spec.match(/^#?(\d+)$/);
  return m ? { repo: ownRepo, number: Number(m[1]) } : null;
}

// Merged/closed blockers are terminal and cached for the session; open ones
// re-fetch on a ~60s TTL so the badge flips soon after the blocker lands.
async function fetchBlocker(token, spec, ownRepo) {
  const parsed = parseBlocker(spec, ownRepo);
  if (!parsed) return null;
  const key = `${parsed.repo}#${parsed.number}`;
  const cached = blockerCache.get(key);
  if (cached && (cached.state !== 'open' || Date.now() - cached.fetchedAt < 55000)) return cached;
  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.repo}/pulls/${parsed.number}`, {
      headers: authHeaders(token),
    });
    if (!res.ok) return cached ?? { ...parsed, state: 'open' };
    const d = await res.json();
    const info = {
      ...parsed,
      state: d.merged ? 'merged' : d.state,
      title: d.title,
      html_url: d.html_url,
      fetchedAt: Date.now(),
    };
    blockerCache.set(key, info);
    return info;
  } catch {
    return cached ?? { ...parsed, state: 'open' };
  }
}

// Tracked PRs are ones the search never returns. Fetch each and shape it like a
// search result so the rest of the pipeline treats it as any other PR.
async function getTracked() {
  const { tracked } = await api.storage.local.get('tracked');
  return tracked ?? [];
}

async function fetchTracked(token) {
  const specs = await getTracked();
  const results = await Promise.all(
    specs.map(async (spec) => {
      const parsed = parseBlocker(spec, '');
      if (!parsed?.repo) return null;
      try {
        const res = await fetch(`https://api.github.com/repos/${parsed.repo}/pulls/${parsed.number}`, {
          headers: authHeaders(token),
        });
        if (!res.ok) return null;
        const d = await res.json();
        if (d.state !== 'open') return null;
        // This response already carries everything the per-PR detail fetch would,
        // so seed the cache rather than asking for the same PR twice per poll.
        if (detailCache.get(d.html_url)?.updated_at !== d.updated_at) {
          detailCache.set(d.html_url, {
            baseRef: d.base?.ref ?? null,
            headRef: d.head?.ref ?? null,
            conflicts: d.mergeable_state === 'dirty',
            additions: d.additions ?? null,
            deletions: d.deletions ?? null,
            ci: detailCache.get(d.html_url)?.ci ?? null,
            updated_at: d.updated_at,
            detailAt: Date.now(),
          });
        }
        return {
          number: d.number,
          node_id: d.node_id,
          html_url: d.html_url,
          title: d.title,
          draft: d.draft,
          updated_at: d.updated_at,
          comments: d.comments ?? 0,
          repository_url: `https://api.github.com/repos/${parsed.repo}`,
          pull_request: { url: d.url },
          tracked: true,
          user: d.user ?? null,
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

// Check the PR is readable and open before storing it, so a typo or a repo the
// token can't see says so instead of adding a row that never appears.
async function addTracked(spec) {
  const parsed = parseBlocker(spec, '');
  if (!parsed?.repo) {
    statusEl.textContent = 'Not a pull request URL.';
    return false;
  }
  const key = `${parsed.repo}#${parsed.number}`;
  const token = await getToken();
  const res = await fetch(`https://api.github.com/repos/${parsed.repo}/pulls/${parsed.number}`, {
    headers: authHeaders(token),
  }).catch(() => null);
  if (!res?.ok) {
    statusEl.textContent = `Can't read ${key}${res ? ` (${res.status})` : ''}.`;
    return false;
  }
  if ((await res.json()).state !== 'open') {
    statusEl.textContent = `${key} is already closed.`;
    return false;
  }
  const specs = await getTracked();
  if (!specs.includes(key)) await api.storage.local.set({ tracked: [...specs, key] });
  return true;
}

async function removeTracked(repo, number) {
  const specs = await getTracked();
  await api.storage.local.set({ tracked: specs.filter((s) => s !== `${repo}#${number}`) });
}

function tabMatches(tabUrl, prUrl) {
  return Boolean(tabUrl) && tabUrl.split('#')[0].startsWith(prUrl);
}

// Hotfix PRs ("… (HOTFIX 2.52)") collapse into one group per base title, under
// the main PR when one shares that title, else under a synthetic header row.
// The matched part is stripped from the title to find the group; override in ⚙.
const DEFAULT_HOTFIX_RE = /\s*\(HOTFIX[^)]*\)$/i;
let HOTFIX_RE = DEFAULT_HOTFIX_RE;

async function getHotfixRe() {
  const { hotfixPattern } = await api.storage.local.get('hotfixPattern');
  try {
    return hotfixPattern ? new RegExp(hotfixPattern, 'i') : DEFAULT_HOTFIX_RE;
  } catch {
    return DEFAULT_HOTFIX_RE; // bad regex → default rather than a broken list
  }
}
const expandedGroups = new Set(); // hotfix groupKeys the user opened; survives re-renders
let lastPrs = []; // flat list from the last load; feeds re-renders and the blocked-by dropdown

function groupHotfixes(roots) {
  const groups = new Map();
  const mains = new Set();
  for (const pr of roots) {
    if (HOTFIX_RE.test(pr.title)) {
      const key = `${pr.repo}@${pr.title.replace(HOTFIX_RE, '')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pr);
    } else {
      mains.add(`${pr.repo}@${pr.title}`);
    }
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  }
  const out = [];
  const done = new Set();
  for (const pr of roots) {
    const isHotfix = HOTFIX_RE.test(pr.title);
    const key = `${pr.repo}@${pr.title.replace(HOTFIX_RE, '')}`;
    if (!isHotfix) {
      const g = groups.get(key);
      if (g) {
        pr.hotfixes = g;
        pr.groupKey = key;
        done.add(key);
      }
      out.push(pr);
    } else if (!done.has(key) && !mains.has(key)) {
      done.add(key);
      const g = groups.get(key);
      if (g.length === 1) out.push(pr); // lone hotfix, nothing to fold
      else out.push({ synthetic: true, title: pr.title.replace(HOTFIX_RE, ''), hotfixes: g, groupKey: key });
    }
  }
  return out;
}

function flattenNodes(nodes, out = []) {
  for (const n of nodes) {
    if (!n.synthetic) out.push(n);
    flattenNodes(n.children ?? [], out);
    flattenNodes(n.hotfixes ?? [], out);
  }
  return out;
}

function forestHas(nodes, tabUrl) {
  return flattenNodes(nodes).some((n) => tabMatches(tabUrl, n.html_url));
}

// Pull one PR out of the forest wherever it sits, promoting its children into
// the hole it leaves, so an epic can be lifted into its category header.
function extractNode(roots, url) {
  const walk = (arr) => {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i];
      if (!n.synthetic && n.html_url === url) {
        arr.splice(i, 1, ...(n.children ?? []));
        n.children = [];
        return n;
      }
      const found = walk(n.children ?? []) || walk(n.hotfixes ?? []);
      if (found) return found;
    }
    return null;
  };
  return walk(roots);
}

// Build a forest: a PR is a child of another when its base branch is that PR's
// head branch in the same repo (i.e. it's stacked on top of it). Blocked-by
// only affects badges and sort order, never nesting: siblings sharing a base
// stay siblings even when one blocks another.
function buildForest(prs) {
  const byHead = new Map();
  for (const pr of prs) {
    pr.children = [];
    pr.hotfixes = null;
    pr.groupKey = null;
    // Only index known heads. A failed detail fetch leaves refs null, and a
    // `repo@null` key would collide every ref-less PR into one bogus stack.
    if (pr.headRef) byHead.set(`${pr.repo}@${pr.headRef}`, pr);
  }
  const roots = [];
  for (const pr of prs) {
    const parent = pr.baseRef ? byHead.get(`${pr.repo}@${pr.baseRef}`) : null;
    if (parent && parent !== pr) parent.children.push(pr);
    else roots.push(pr);
  }
  for (const pr of prs) pr.children = blockedLast(pr.children);
  return roots;
}

const isBlocked = (pr) => pr.blockedBy?.state === 'open';
// Blocked PRs sink below actionable ones; blocked drafts sink below blocked open PRs.
const sinkRank = (pr) => (isBlocked(pr) ? (pr.draft ? 2 : 1) : 0);
const blockedLast = (roots) => [...roots].sort((a, b) => sinkRank(a) - sinkRank(b));

function prMatches(pr, q) {
  return `${pr.title} ${pr.repo} #${pr.number} ${pr.author ?? ''}`.toLowerCase().includes(q);
}

// The shelf is one flat list rather than a second set of categories: it's a
// holding pen, and a PR keeps whatever category it had for when it comes back.
function buildModel(prs) {
  const q = filterText.trim().toLowerCase();
  const shelved = prs.filter((p) => Boolean(p.later) === viewLater);
  const items = q ? shelved.filter((p) => prMatches(p, q)) : shelved;
  if (viewLater) {
    return { sections: [], roots: blockedLast(groupHotfixes(buildForest(items))), shown: items.length, all: shelved.length };
  }
  const known = new Set(categories.map((c) => c.id));
  const byCat = new Map();
  const loose = [];
  for (const pr of items) {
    const cat = pr.group && known.has(pr.group) ? pr.group : null;
    if (!cat) loose.push(pr);
    else {
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(pr);
    }
  }

  const sections = categories
    .map((c) => {
      const members = byCat.get(c.id) ?? [];
      const forest = buildForest(members);
      const epicNode = c.epic ? extractNode(forest, c.epic) : null;
      return { ...c, epicNode, roots: blockedLast(groupHotfixes(forest)), total: members.length };
    })
    .filter((s) => !q || s.total);

  return { sections, roots: blockedLast(groupHotfixes(buildForest(loose))), shown: items.length, all: shelved.length };
}

// Expand whatever is hiding the active tab's PR: its category, the hotfix fold,
// and any collapsed stack above it. Remembers the URL it expanded for, so
// collapsing by hand sticks until the user moves tabs.
let autoExpanded = '';
function autoExpandActive(model) {
  if (!activeTabUrl || activeTabUrl === autoExpanded) return false;
  let changed = false;
  const allRoots = [...model.sections.flatMap((s) => s.roots), ...model.roots];
  for (const pr of flattenNodes(allRoots)) {
    if (pr.hotfixes && !expandedGroups.has(pr.groupKey) && forestHas(pr.hotfixes, activeTabUrl)) {
      expandedGroups.add(pr.groupKey);
      changed = true;
    }
    if (collapsedNodes.has(pr.html_url) && forestHas(pr.children ?? [], activeTabUrl)) {
      collapsedNodes.delete(pr.html_url);
      api.storage.local.set({ collapsedNodes: [...collapsedNodes] });
      changed = true;
    }
  }
  for (const s of model.sections) {
    if (s.collapsed && forestHas(s.roots, activeTabUrl)) {
      const cat = catById(s.id);
      if (cat) cat.collapsed = false;
      s.collapsed = false;
      saveCats();
      changed = true;
    }
  }
  if (changed) autoExpanded = activeTabUrl;
  return changed;
}

function hotfixToggleText(pr) {
  const fails = pr.hotfixes.filter((h) => h.ci?.state === 'fail').length;
  const arrow = expandedGroups.has(pr.groupKey) ? '▾' : '▸';
  return `${arrow} 🔥 ${pr.hotfixes.length} hotfixes${fails ? ` (${fails} ✗)` : ''}`;
}

function chip(text, cls, tip) {
  const el = document.createElement('span');
  el.className = `badge${cls ? ` ${cls}` : ''}`;
  el.textContent = text;
  if (tip) el.dataset.tip = tip;
  return el;
}

function initialBubble(login) {
  const b = document.createElement('span');
  b.className = 'initial';
  b.textContent = (login[0] ?? '?').toUpperCase();
  let h = 0;
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) % 360;
  b.style.setProperty('--tone', `hsl(${h} 42% 44%)`);
  return b;
}

function authorChip(pr) {
  const wrap = document.createElement('span');
  wrap.className = 'who';
  wrap.dataset.tip = `Opened by @${pr.author}`;
  if (pr.avatar) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = pr.avatar;
    img.alt = '';
    img.addEventListener('error', () => img.replaceWith(initialBubble(pr.author)));
    wrap.appendChild(img);
  } else {
    wrap.appendChild(initialBubble(pr.author));
  }
  wrap.append(`@${pr.author}`);
  return wrap;
}

function buildMeta(pr) {
  const metaEl = document.createElement('div');
  metaEl.className = 'meta';
  const shortRepo = pr.repo.split('/')[1] ?? pr.repo;
  metaEl.append(document.createTextNode(`${shortRepo} #${pr.number} · ${relativeTime(pr.updated_at)}`));

  if (pr.collab && pr.author) metaEl.appendChild(authorChip(pr));
  if (pr.additions != null) {
    const adds = document.createElement('span');
    adds.className = 'adds';
    adds.textContent = `+${pr.additions}`;
    const dels = document.createElement('span');
    dels.className = 'dels';
    dels.textContent = `−${pr.deletions}`;
    metaEl.append(adds, dels);
  }
  if (pr.comments) {
    // A span, not a bare text node: adjacent text nodes merge into one anonymous
    // flex item, so the meta row's gap wouldn't separate this from the time.
    const c = document.createElement('span');
    c.textContent = `💬 ${pr.comments}`;
    metaEl.appendChild(c);
  }
  if (pr.ci) {
    const ci = document.createElement('span');
    ci.className = `ci ci-${pr.ci.state}`;
    ci.textContent = pr.ci.state === 'pass' ? '✓ CI' : pr.ci.state === 'fail' ? '✗ CI' : '• CI';
    if (pr.ci.state === 'fail' && pr.ci.failed.length) ci.dataset.tip = `Failed:\n${pr.ci.failed.join('\n')}`;
    metaEl.appendChild(ci);
  }
  if (pr.queue) {
    metaEl.appendChild(
      chip(pr.queue.position != null ? `⏳ queue #${pr.queue.position}` : '⏳ in queue', 'tint-purple'),
    );
  }
  if (pr.review === 'APPROVED') metaEl.appendChild(chip('✓ approved', 'tint-green'));
  else if (pr.review === 'CHANGES_REQUESTED') metaEl.appendChild(chip('± changes requested', 'tint-red'));
  if (pr.conflicts) metaEl.appendChild(chip('⚠ conflicts', 'tint-red'));
  if (pr.blockedBy) {
    const bl = pr.blockedBy;
    const label = bl.repo
      ? bl.repo === pr.repo
        ? `#${bl.number}`
        : `${bl.repo.split('/')[1] ?? bl.repo}#${bl.number}`
      : bl.spec;
    const done = bl.state === 'merged' || bl.state === 'closed';
    const b = chip(
      done ? `✓ ${label} ${bl.state}` : `⛔ ${label}`,
      done ? 'tint-green unblocked' : 'tint-red blocked',
      `${done ? `Blocker ${bl.state}` : 'Blocked by'} ${label}${bl.title ? `: ${bl.title}` : ''}`,
    );
    if (bl.html_url) b.dataset.href = bl.html_url;
    metaEl.appendChild(b);
  }
  if (pr.note) metaEl.appendChild(chip('📝', 'note', pr.note));
  if (pr.draft) metaEl.appendChild(chip('draft', ''));
  if (pr.children?.length && collapsedNodes.has(pr.html_url)) {
    const s = document.createElement('span');
    s.className = 'stack-toggle';
    s.dataset.twist = pr.html_url;
    s.textContent = `▸ ${flattenNodes(pr.children).length} stacked`;
    metaEl.appendChild(s);
  }
  if (pr.hotfixes) {
    const t = document.createElement('span');
    t.className = 'hf-toggle';
    t.dataset.group = pr.groupKey;
    t.textContent = hotfixToggleText(pr);
    metaEl.appendChild(t);
  }
  return metaEl;
}

function buildRow(pr, opts = {}) {
  const a = document.createElement('a');
  a.href = pr.html_url;
  a.setAttribute('draggable', 'false');

  const titleEl = document.createElement('div');
  titleEl.className = 'title';
  if (pr.children?.length) {
    const tw = document.createElement('span');
    tw.className = 'twist';
    tw.dataset.twist = pr.html_url;
    tw.textContent = collapsedNodes.has(pr.html_url) ? '▸' : '▾';
    titleEl.appendChild(tw);
  }
  const text = document.createElement('span');
  text.className = 'title-text';
  text.textContent = pr.title;
  titleEl.appendChild(text);

  if (opts.epic) {
    const kicker = document.createElement('div');
    kicker.className = 'epic-kicker';
    kicker.textContent = '⭐ Epic';
    a.appendChild(kicker);
  }
  a.append(titleEl, buildMeta(pr));
  return a;
}

function editButton(url) {
  const edit = document.createElement('button');
  edit.className = 'edit-btn';
  edit.dataset.edit = url;
  edit.title = 'Category · epic · blocked by · note';
  edit.textContent = '⋯';
  return edit;
}

let renderTarget = list; // renderNode appends here; a category swaps in its own <ul>

function renderNode(pr, depth) {
  const li = document.createElement('li');
  li.className = 'pr';
  li.style.marginLeft = depth ? `${depth * 13}px` : '';

  if (pr.synthetic) {
    li.classList.add('group');
    li.dataset.url = pr.groupKey;
    const a = document.createElement('a');
    a.dataset.group = pr.groupKey;
    const titleEl = document.createElement('div');
    titleEl.className = 'title';
    const text = document.createElement('span');
    text.className = 'title-text';
    text.textContent = pr.title;
    titleEl.appendChild(text);
    const metaEl = document.createElement('div');
    metaEl.className = 'meta';
    const t = document.createElement('span');
    t.className = 'hf-toggle';
    t.textContent = hotfixToggleText(pr);
    metaEl.appendChild(t);
    a.append(titleEl, metaEl);
    li.appendChild(a);
    renderTarget.appendChild(li);
    if (expandedGroups.has(pr.groupKey)) for (const h of pr.hotfixes) renderNode(h, depth + 1);
    return;
  }

  if (pr.draft) li.classList.add('draft');
  if (depth > 0) li.classList.add('child');
  if (tabMatches(activeTabUrl, pr.html_url)) li.classList.add('active');
  li.dataset.url = pr.html_url;
  li.dataset.dragPr = pr.html_url;
  li.append(buildRow(pr), editButton(pr.html_url));
  renderTarget.appendChild(li);

  if (!collapsedNodes.has(pr.html_url)) for (const child of pr.children) renderNode(child, depth + 1);
  if (pr.hotfixes && expandedGroups.has(pr.groupKey)) {
    for (const h of pr.hotfixes) renderNode(h, depth + 1);
  }
}

function statChips(sec) {
  const all = flattenNodes(sec.roots).concat(sec.epicNode ? [sec.epicNode] : []);
  const out = [];
  const fails = all.filter((p) => p.ci?.state === 'fail').length;
  const conflicts = all.filter((p) => p.conflicts).length;
  const approved = all.filter((p) => p.review === 'APPROVED').length;
  if (fails) out.push(chip(`✗ ${fails}`, 'tint-red', `${fails} with failing CI`));
  if (conflicts) out.push(chip(`⚠ ${conflicts}`, 'tint-red', `${conflicts} with conflicts`));
  if (approved) out.push(chip(`✓ ${approved}`, 'tint-green', `${approved} approved`));
  return out;
}

function renderSection(sec) {
  const li = document.createElement('li');
  li.className = 'section';
  li.dataset.url = `cat:${sec.id}`;
  li.dataset.cat = sec.id;
  // Resting fill is a lighter cut of the stored colour; the stored value is the
  // hover, handed down via --sec-hover so row hovers inside match.
  const rgb = sec.color?.match(/[\d.]+,\s*[\d.]+,\s*[\d.]+/)?.[0];
  if (rgb) {
    li.style.setProperty('--sec-bg', `rgba(${rgb}, 0.06)`);
    li.style.setProperty('--sec-hover', sec.color);
    li.style.setProperty('--sec-active', `rgba(${rgb}, 0.18)`);
    li.style.setProperty('--sec-accent', `rgb(${rgb})`);
  }

  const head = document.createElement('div');
  head.className = 'sec-head';
  head.dataset.sectoggle = sec.id;
  head.dataset.dragCat = sec.id;
  const tw = document.createElement('span');
  tw.className = 'twist';
  tw.textContent = sec.collapsed ? '▸' : '▾';
  const name = document.createElement('span');
  name.className = 'sec-name';
  name.textContent = `${sec.emoji || '📌'} ${sec.name}`;
  const count = document.createElement('span');
  count.className = 'sec-count';
  count.textContent = sec.total;
  head.append(tw, name, count);
  if (sec.collapsed) {
    const stats = document.createElement('span');
    stats.className = 'sec-stats';
    for (const c of statChips(sec)) stats.appendChild(c);
    if (stats.childElementCount) head.appendChild(stats);
  }
  const slot = document.createElement('span');
  slot.className = 'epic-slot';
  slot.dataset.epicSlot = sec.id;
  slot.textContent = '⭐ epic';
  head.appendChild(slot);
  li.appendChild(head);

  const cfg = document.createElement('button');
  cfg.className = 'edit-btn';
  cfg.dataset.editcat = sec.id;
  cfg.title = 'Rename · emoji · colour · delete';
  cfg.textContent = '⋯';
  li.appendChild(cfg);

  if (sec.epicNode) {
    const pr = sec.epicNode;
    const epic = document.createElement('li');
    epic.className = 'pr epic';
    if (pr.draft) epic.classList.add('draft');
    if (tabMatches(activeTabUrl, pr.html_url)) epic.classList.add('active');
    epic.dataset.url = pr.html_url;
    epic.dataset.dragPr = pr.html_url;
    epic.append(buildRow(pr, { epic: true }), editButton(pr.html_url));
    li.appendChild(epic);
  }

  if (!sec.collapsed) {
    if (sec.roots.length) {
      const inner = document.createElement('ul');
      inner.className = 'sec-list';
      li.appendChild(inner);
      renderTarget = inner;
      for (const root of sec.roots) renderNode(root, 0);
      renderTarget = list;
    } else {
      const hint = document.createElement('div');
      hint.className = 'sec-empty';
      hint.textContent = 'Drag PRs here';
      li.appendChild(hint);
    }
  }
  return li;
}

function updateActiveHighlight() {
  for (const li of list.querySelectorAll('li')) {
    li.classList.toggle('active', tabMatches(activeTabUrl, li.dataset.url));
  }
}

// Re-render the list in place, FLIP-animating rows that moved and fading in new
// ones, so a poll swaps content underneath without a flash.
function renderList(model) {
  if (editorOpen) return;
  autoExpandActive(model);
  const before = new Map();
  for (const li of list.children) before.set(li.dataset.url, li.getBoundingClientRect().top);

  list.textContent = '';
  renderTarget = list;
  for (const sec of model.sections) list.appendChild(renderSection(sec));
  for (const root of model.roots) renderNode(root, 0);

  const nothing = !model.sections.length && !model.roots.length;
  emptyEl.style.display = nothing ? '' : 'none';
  if (nothing) {
    emptyEl.textContent = '';
    const b = document.createElement('b');
    const p = document.createElement('div');
    if (filterText) {
      b.textContent = 'Nothing matches';
      p.textContent = 'Clear the filter to see everything.';
    } else if (viewLater) {
      b.textContent = 'Nothing here for later';
      p.textContent = 'Drag a PR up to the top of the panel to park it, or use ⋯ on its row.';
    } else {
      b.textContent = 'No open PRs';
      p.textContent = 'Open one, or track someone else’s from ＋.';
    }
    emptyEl.append(b, p);
  }
  syncHeader(model);

  for (const li of list.children) {
    const oldTop = before.get(li.dataset.url);
    if (oldTop == null) {
      li.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], {
        duration: 240,
        easing: 'cubic-bezier(.2,.9,.3,1.1)',
      });
    } else {
      const delta = oldTop - li.getBoundingClientRect().top;
      if (delta) {
        li.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
          { duration: 340, easing: 'cubic-bezier(.22,1.1,.36,1)' },
        );
      }
    }
  }
  if (justDropped) {
    for (const el of list.querySelectorAll(`[data-drag-pr="${justDropped}"]`)) {
      el.animate(
        [{ transform: 'scale(0.95)', opacity: 0.5 }, { transform: 'none', opacity: 1 }],
        { duration: 300, easing: 'cubic-bezier(.22,1.2,.36,1)' },
      );
    }
    justDropped = null;
  }
  if (dnd?.active) markDragSource();
}

const rerender = () => renderList(buildModel(lastPrs));

// Firefox rebuilds the panel every time the sidebar opens, so the last list is
// kept in storage and painted before the first request goes out. children and
// hotfixes are rebuilt on every render, and holding them here would serialise
// the same PR objects several times over.
const SNAPSHOT_FIELDS = [
  'number', 'repo', 'html_url', 'title', 'draft', 'updated_at', 'comments',
  'baseRef', 'headRef', 'conflicts', 'additions', 'deletions', 'ci', 'queue',
  'review', 'blockedBy', 'tracked', 'author', 'avatar', 'collab', 'group', 'note', 'later',
];
let savedSnapshot = '';

function showSkeleton() {
  list.textContent = '';
  for (let i = 0; i < 4; i++) {
    const li = document.createElement('li');
    li.className = 'sk';
    const title = document.createElement('div');
    title.className = 'sk-bar sk-title';
    const meta = document.createElement('div');
    meta.className = 'sk-bar sk-meta';
    li.append(title, meta);
    list.appendChild(li);
  }
}

function saveSnapshot(prs) {
  const json = JSON.stringify(prs.map((pr) => Object.fromEntries(SNAPSHOT_FIELDS.map((k) => [k, pr[k]]))));
  if (json === savedSnapshot) return;
  savedSnapshot = json;
  api.storage.local.set({ snapshot: json });
}

function syncHeader(model) {
  const parked = lastPrs.filter((p) => p.later).length;
  document.body.classList.toggle('later', viewLater);
  laterBtn.classList.toggle('has', parked > 0);
  laterBtn.classList.toggle('on', viewLater);
  laterBtn.title = viewLater ? 'Back to the list' : 'For later';
  shelfDrop.querySelector('span').textContent = viewLater ? 'Back to the list' : 'Save for later';
  $('latercount').textContent = parked;
  if (filterText && model.shown !== model.all) statusEl.textContent = `${model.shown} of ${model.all} shown`;
  else statusEl.textContent = viewLater ? `${model.all} for later` : `${model.all} open`;
}

function setLater(urls, on) {
  for (const url of urls) {
    const m = prMeta[url] ?? {};
    if (on) m.later = true;
    else delete m.later;
    if (Object.keys(m).length) prMeta[url] = m;
    else delete prMeta[url];
    const pr = lastPrs.find((p) => p.html_url === url);
    if (pr) pr.later = on;
  }
  saveMeta();
}

// One search result plus its GraphQL extras into the shape the list renders.
// The detail fetch is the only per-PR request; it holds branch refs, diff size
// and the conflict flag, and the base branch moving conflicts a PR without
// touching updated_at, so it expires on age as well. Parked PRs sit still.
// Everything a row needs that the search result already carries, so the list can
// paint before the per-PR detail and CI have landed.
function shellPr(item, login) {
  const meta = prMeta[item.html_url] ?? {};
  const author = item.user?.login ?? null;
  return {
    number: item.number,
    repo: item.repository_url.split('/repos/')[1] ?? '',
    html_url: item.html_url,
    title: item.title,
    draft: item.draft,
    updated_at: item.updated_at,
    comments: item.comments ?? 0,
    baseRef: null,
    headRef: null,
    conflicts: false,
    additions: null,
    deletions: null,
    ci: null,
    queue: null,
    review: null,
    blockedBy: null,
    tracked: item.tracked ?? false,
    author,
    avatar: item.user?.avatar_url
      ? `${item.user.avatar_url}${item.user.avatar_url.includes('?') ? '&' : '?'}s=48`
      : null,
    collab: Boolean(author) && author !== login,
    group: meta.group ?? null,
    note: meta.note ?? null,
    later: meta.later === true,
  };
}

async function hydrate(token, item, extras, login) {
  const meta = prMeta[item.html_url] ?? {};
  const parked = meta.later === true;
  const pr = shellPr(item, login);
  const repo = pr.repo;

  const now = Date.now();
  const cached = detailCache.get(item.html_url);
  const usable =
    cached && cached.updated_at === item.updated_at && (parked || now - cached.detailAt < DETAIL_TTL);
  if (usable) {
    const { detailAt, ...detail } = cached;
    Object.assign(pr, detail);
  } else {
    try {
      const detail = await (await fetch(item.pull_request.url, { headers: authHeaders(token) })).json();
      pr.baseRef = detail.base?.ref ?? null;
      pr.headRef = detail.head?.ref ?? null;
      pr.conflicts = detail.mergeable_state === 'dirty';
      pr.additions = detail.additions ?? null;
      pr.deletions = detail.deletions ?? null;
    } catch {
      // leave defaults → treated as a root with no conflict info
    }
  }
  // Awaited here rather than up front so the detail request above runs while the
  // review and queue call is still in flight.
  const extra = (await extras).get(item.node_id) ?? {};
  pr.queue = extra.queue ?? null;
  pr.review = extra.review ?? null;
  pr.ci = ciCache.get(item.html_url)?.ci ?? null; // settleCi fills this in behind the render
  const { baseRef, headRef, conflicts, additions, deletions, updated_at } = pr;
  detailCache.set(item.html_url, {
    baseRef, headRef, conflicts, additions, deletions, updated_at,
    detailAt: usable ? cached.detailAt : now,
  });

  pr.blockedBy = meta.blockedBy
    ? ((await fetchBlocker(token, meta.blockedBy, repo)) ?? { spec: meta.blockedBy, state: 'open' })
    : null;
  return pr;
}

// CI settles after the list is on screen. A PR is due when nothing is known
// about it, when it has changed, or when its last answer has aged out; a rerun
// on the same commit moves nothing else, which is what the age covers.
async function settleCi(token, items, prs, manual) {
  const now = Date.now();
  const due = items.filter((item) => {
    if (manual) return true;
    const c = ciCache.get(item.html_url);
    return !c || c.updated_at !== item.updated_at || now - c.at > CI_TTL;
  });
  if (!due.length) return;
  const map = await fetchCiMap(token, due);
  let changed = false;
  for (const item of due) {
    if (!map.has(item.node_id)) continue;
    const ci = map.get(item.node_id);
    ciCache.set(item.html_url, { ci, at: Date.now(), updated_at: item.updated_at });
    const pr = prs.find((p) => p.html_url === item.html_url);
    if (pr && JSON.stringify(pr.ci) !== JSON.stringify(ci)) {
      pr.ci = ci;
      changed = true;
    }
  }
  if (changed && lastPrs === prs) {
    rerender();
    saveSnapshot(prs);
  }
}

// Polls and a click can overlap, and the CI pass keeps a load alive after the
// list is drawn, so every load carries a number and an older one stops short
// rather than painting over a newer one.
let loadSeq = 0;
let loading = false;

async function load(manual) {
  if (editorOpen) return;
  const seq = ++loadSeq;
  loading = true;
  const token = await getToken();
  if (!token) {
    setup.style.display = 'block';
    statusEl.textContent = 'Add a token to get started.';
    return;
  }
  const cold = !lastPrs.length;
  if (cold && !list.children.length && emptyEl.style.display === 'none') showSkeleton();
  if (manual || cold) $('refresh').classList.add('spin');

  try {
    // Whoami once, then cache it: the login only feeds the search query below, so
    // re-fetching /user every 10s poll just adds a request that can flake.
    if (!cachedLogin) {
      const userRes = await fetch('https://api.github.com/user', { headers: authHeaders(token) });
      if (!userRes.ok) {
        statusEl.textContent = statusMsg(userRes.status);
        return;
      }
      cachedLogin = (await userRes.json()).login;
    }
    const login = cachedLogin;
    const [scope, mode] = await Promise.all([getScope(), getInvolvement(), loadState()]);
    HOTFIX_RE = await getHotfixRe();

    const who = mode === 'mine' ? `author:${login}` : `involves:${login}`;
    const [found, tracked] = await Promise.all([
      searchPrs(token, `is:open is:pr archived:false ${scope} ${who}`),
      fetchTracked(token),
    ]);
    if (!found.ok) {
      statusEl.textContent = statusMsg(found.status);
      return;
    }
    const seen = new Set();
    let items = [...found.items, ...tracked].filter((i) => {
      if (seen.has(i.html_url)) return false;
      seen.add(i.html_url);
      return true;
    });
    const mine = (i) => (i.user?.login ?? null) === login || i.tracked;
    // Your own PRs can't be filtered out by the commit check below, so on a cold
    // start they go up now rather than after two more round trips.
    if (cold && seq === loadSeq) {
      const own = items.filter(mine).map((item) => shellPr(item, login));
      if (own.length) {
        lastPrs = own;
        rerender();
      }
    }
    // Two independent GraphQL calls: the commit check that thins the list, and
    // the CI/review/queue read. Starting both here costs one extra id in the
    // second when a PR turns out to be someone else's, and saves a round trip.
    const others = items.filter((i) => !mine(i));
    const extras = fetchPrExtras(token, items);
    if (others.length) {
      const coded = await fetchCoded(token, others, login);
      items = items.filter((i) => mine(i) || coded.get(i.html_url) !== false);
    }
    if (!items.length) {
      lastPrs = [];
      rerender();
      saveSnapshot([]);
      return;
    }

    const prs = await Promise.all(items.map((item) => hydrate(token, item, extras, login)));
    if (seq !== loadSeq) return;

    lastPrs = prs;
    renderList(buildModel(prs));
    saveSnapshot(prs);
    $('refresh').classList.remove('spin');
    await settleCi(token, items, prs, manual);
  } catch (e) {
    statusEl.textContent = `Network error: ${e.message}`;
  } finally {
    if (seq === loadSeq) {
      loading = false;
      $('refresh').classList.remove('spin');
      if (!lastPrs.length && list.querySelector('li.sk')) list.textContent = '';
    }
  }
}

// Lightweight custom tooltip (the native title is slow + ugly).
const tip = document.createElement('div');
tip.id = 'tip';
document.body.appendChild(tip);

function showTip(target) {
  const text = target.dataset.tip;
  if (!text || dnd?.active) return;
  tip.textContent = text;
  tip.style.visibility = 'hidden';
  tip.classList.add('show');
  const r = target.getBoundingClientRect();
  const left = Math.max(6, Math.min(r.left, window.innerWidth - tip.offsetWidth - 6));
  const above = r.top - tip.offsetHeight - 6;
  tip.style.left = `${left}px`;
  tip.style.top = `${above < 6 ? r.bottom + 6 : above}px`;
  tip.style.visibility = 'visible';
}
function hideTip() {
  tip.classList.remove('show');
}
list.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t) showTip(t);
});
list.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]')) hideTip();
});

function closeEditor() {
  document.querySelector('.row-editor')?.remove();
  editorOpen = null;
}

// Every base emoji the engine knows; Emoji_Presentation skips unassigned
// codepoints and text-default glyphs that would render as tofu.
const GROUP_EMOJIS = ['📌'];
for (const [lo, hi] of [
  [0x1f300, 0x1f5ff],
  [0x1f600, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x2600, 0x27bf],
]) {
  for (let cp = lo; cp <= hi; cp++) {
    const ch = String.fromCodePoint(cp);
    if (ch !== '📌' && /\p{Emoji_Presentation}/u.test(ch)) GROUP_EMOJIS.push(ch);
  }
}
const GROUP_COLORS = [
  ['no colour', ''],
  ['grey', 'rgba(128, 128, 128, 0.1)'],
  ['red', 'rgba(248, 81, 73, 0.1)'],
  ['orange', 'rgba(240, 136, 62, 0.1)'],
  ['yellow', 'rgba(210, 153, 34, 0.1)'],
  ['green', 'rgba(63, 185, 80, 0.1)'],
  ['teal', 'rgba(57, 197, 187, 0.1)'],
  ['blue', 'rgba(56, 139, 253, 0.1)'],
  ['purple', 'rgba(163, 113, 247, 0.1)'],
  ['pink', 'rgba(219, 97, 162, 0.1)'],
];

function makeStylePicker(initial) {
  let emoji = initial?.emoji || '📌';
  const emojiBtn = document.createElement('button');
  emojiBtn.className = 'emoji-btn';
  emojiBtn.textContent = emoji;
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  grid.style.display = 'none';
  emojiBtn.addEventListener('click', () => {
    // 1140 cells; built on first open so the editor itself stays instant.
    if (!grid.childElementCount) {
      for (const ch of GROUP_EMOJIS) {
        const cell = document.createElement('button');
        cell.className = 'emoji-cell';
        cell.textContent = ch;
        grid.appendChild(cell);
      }
    }
    grid.style.display = grid.style.display === 'none' ? '' : 'none';
  });
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.emoji-cell');
    if (!cell) return;
    emoji = cell.textContent;
    emojiBtn.textContent = emoji;
    grid.style.display = 'none';
  });

  // macOS draws native <select> popups and ignores option CSS, so colours are
  // swatch buttons showing stronger cuts of the stored hue.
  let color = initial?.color ?? '';
  const colorRow = document.createElement('div');
  colorRow.className = 'color-row';
  const setColor = (value) => {
    color = value;
    for (const b of colorRow.children) b.classList.toggle('sel', b.dataset.color === value);
  };
  for (const [label, value] of GROUP_COLORS) {
    const b = document.createElement('button');
    b.className = 'color-cell';
    b.dataset.color = value;
    b.title = label;
    const t = value.match(/[\d.]+,\s*[\d.]+,\s*[\d.]+/)?.[0];
    if (t) {
      b.style.setProperty('--cell', `rgba(${t}, 0.35)`);
      b.style.setProperty('--cell-strong', `rgba(${t}, 0.65)`);
      b.style.setProperty('--ring', `rgb(${t})`);
    }
    b.addEventListener('click', () => setColor(value));
    colorRow.appendChild(b);
  }
  setColor(color);

  const row = document.createElement('div');
  row.className = 'row';
  row.append(emojiBtn, colorRow);
  const wrap = document.createElement('div');
  wrap.className = 'style-picker';
  wrap.append(row, grid);
  return { getEmoji: () => emoji, getColor: () => color, row: wrap };
}

function assignCategory(url, catId) {
  const m = prMeta[url] ?? {};
  if (catId) m.group = catId;
  else delete m.group;
  if (Object.keys(m).length) prMeta[url] = m;
  else delete prMeta[url];
  for (const c of categories) if (c.epic === url && c.id !== catId) c.epic = null;
  const pr = lastPrs.find((p) => p.html_url === url);
  if (pr) pr.group = catId || null;
  saveMeta();
  saveCats();
}

// A PR and everything stacked on top of it move as one unit.
function withDescendants(url) {
  const start = lastPrs.find((p) => p.html_url === url);
  if (!start) return [url];
  const out = [start];
  for (let i = 0; i < out.length; i++) {
    for (const p of lastPrs) {
      if (p.repo === out[i].repo && out[i].headRef && p.baseRef === out[i].headRef && !out.includes(p)) out.push(p);
    }
  }
  return out.map((p) => p.html_url);
}

function openEditor(li, url) {
  const wasOpen = editorOpen === url;
  closeEditor();
  if (wasOpen) return;
  editorOpen = url;
  const meta = prMeta[url] ?? {};
  const form = document.createElement('div');
  form.className = 'row-editor';

  const NEW_CAT = ' new';
  const catSel = document.createElement('select');
  catSel.appendChild(new Option('no category', ''));
  for (const c of categories) catSel.appendChild(new Option(`${c.emoji || '📌'} ${c.name}`, c.id));
  catSel.appendChild(new Option('+ new category…', NEW_CAT));
  catSel.value = catById(meta.group) ? meta.group : '';

  const newCatIn = document.createElement('input');
  newCatIn.placeholder = 'new category name';
  newCatIn.style.display = 'none';

  const style = makeStylePicker(null);
  style.row.style.display = 'none';

  const epicWrap = document.createElement('label');
  epicWrap.className = 'check';
  const epicBox = document.createElement('input');
  epicBox.type = 'checkbox';
  epicBox.checked = categories.some((c) => c.epic === url);
  epicWrap.append(epicBox, document.createTextNode('⭐ Epic (pin to the header)'));
  const syncEpic = () => {
    epicWrap.style.display = catSel.value ? '' : 'none';
  };
  catSel.addEventListener('change', () => {
    const isNew = catSel.value === NEW_CAT;
    newCatIn.style.display = isNew ? '' : 'none';
    style.row.style.display = isNew ? '' : 'none';
    if (isNew) newCatIn.focus();
    syncEpic();
  });
  syncEpic();

  const blockedIn = document.createElement('select');
  blockedIn.appendChild(new Option('blocked by: none', ''));
  for (const p of lastPrs) {
    if (p.html_url === url) continue;
    const short = p.repo.split('/')[1] ?? p.repo;
    blockedIn.appendChild(new Option(`${short}#${p.number} · ${p.title}`, p.html_url));
  }
  // A stored blocker that isn't in the list (merged since, or set as free text
  // in an older version) still needs an option, or editing would drop it.
  if (meta.blockedBy && ![...blockedIn.options].some((o) => o.value === meta.blockedBy)) {
    blockedIn.appendChild(new Option(meta.blockedBy, meta.blockedBy));
  }
  blockedIn.value = meta.blockedBy ?? '';

  const noteIn = document.createElement('textarea');
  noteIn.rows = 2;
  noteIn.placeholder = 'note (shows on hover)';
  noteIn.value = meta.note ?? '';

  const parked = Boolean(meta.later);
  const shelve = document.createElement('button');
  shelve.className = 'wide';
  shelve.textContent = parked ? 'Move back to the list' : 'Save for later';
  shelve.addEventListener('click', () => {
    setLater(withDescendants(url), !parked);
    closeEditor();
    rerender();
  });

  const save = document.createElement('button');
  save.textContent = 'Save';
  save.className = 'primary';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const row = document.createElement('div');
  row.className = 'row';
  row.append(cancel, save);

  const self = lastPrs.find((p) => p.html_url === url);
  if (self?.tracked) {
    const untrack = document.createElement('button');
    untrack.textContent = 'Untrack';
    untrack.className = 'left';
    untrack.addEventListener('click', async () => {
      await removeTracked(self.repo, self.number);
      closeEditor();
      lastPrs = lastPrs.filter((p) => p.html_url !== url);
      rerender();
      load();
    });
    row.prepend(untrack);
  }

  save.addEventListener('click', async () => {
    let catId = catSel.value;
    if (catId === NEW_CAT) {
      const name = newCatIn.value.trim();
      if (!name) {
        newCatIn.focus();
        return;
      }
      catId = newId();
      categories.push({ id: catId, name, emoji: style.getEmoji(), color: style.getColor(), epic: null, collapsed: false });
    }
    const m = { group: catId, blockedBy: blockedIn.value.trim(), note: noteIn.value.trim(), later: meta.later };
    for (const k of Object.keys(m)) if (!m[k]) delete m[k];
    if (Object.keys(m).length) prMeta[url] = m;
    else delete prMeta[url];
    for (const c of categories) {
      if (c.epic === url && (c.id !== catId || !epicBox.checked)) c.epic = null;
    }
    if (catId && epicBox.checked) {
      const c = catById(catId);
      if (c) c.epic = url;
    }
    await api.storage.local.set({ prMeta, categories });
    closeEditor();
    // Re-render from the PRs we already have so the edit shows immediately;
    // load() then confirms blocker state in the background.
    const pr = lastPrs.find((p) => p.html_url === url);
    if (pr) {
      pr.group = catId || null;
      pr.note = m.note ?? null;
      if (!m.blockedBy) pr.blockedBy = null;
      else {
        const target = lastPrs.find((p) => p.html_url === m.blockedBy);
        pr.blockedBy = target
          ? { repo: target.repo, number: target.number, state: 'open', title: target.title, html_url: target.html_url }
          : { ...(parseBlocker(m.blockedBy, pr.repo) ?? { spec: m.blockedBy }), state: 'open' };
      }
      rerender();
    }
    load();
  });
  cancel.addEventListener('click', closeEditor);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    else if (e.key === 'Enter' && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) save.click();
  });

  form.append(catSel, newCatIn, style.row, epicWrap, blockedIn, noteIn, shelve, row);
  li.appendChild(form);
  catSel.focus();
}

function openCatEditor(li, id) {
  const key = `cat:${id}`;
  const wasOpen = editorOpen === key;
  closeEditor();
  if (wasOpen) return;
  const cat = catById(id);
  if (!cat) return;
  editorOpen = key;
  const form = document.createElement('div');
  form.className = 'row-editor';

  const nameIn = document.createElement('input');
  nameIn.placeholder = 'category name';
  nameIn.value = cat.name;

  const style = makeStylePicker(cat);

  const save = document.createElement('button');
  save.textContent = 'Save';
  save.className = 'primary';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.className = 'danger';
  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.append(del, cancel, save);

  const rows = [nameIn, style.row];
  if (cat.epic) {
    const clearEpic = document.createElement('button');
    clearEpic.textContent = '⭐ Clear epic';
    clearEpic.className = 'wide';
    clearEpic.addEventListener('click', async () => {
      (catById(id) ?? cat).epic = null;
      await saveCats();
      closeEditor();
      rerender();
    });
    rows.push(clearEpic);
  }

  save.addEventListener('click', async () => {
    const c = catById(id) ?? cat;
    c.name = nameIn.value.trim() || c.name;
    c.emoji = style.getEmoji();
    c.color = style.getColor();
    await saveCats();
    closeEditor();
    rerender();
  });
  del.addEventListener('click', async () => {
    categories = categories.filter((c) => c.id !== id);
    for (const [url, m] of Object.entries(prMeta)) {
      if (m.group === id) {
        delete m.group;
        if (!Object.keys(m).length) delete prMeta[url];
      }
    }
    for (const p of lastPrs) if (p.group === id) p.group = null;
    await api.storage.local.set({ categories, prMeta });
    closeEditor();
    rerender();
  });
  cancel.addEventListener('click', closeEditor);
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') save.click();
  });

  form.append(...rows, btnRow);
  li.insertBefore(form, li.querySelector('.sec-head').nextSibling);
  nameIn.focus();
  nameIn.select();
}

async function openUrl(url) {
  const tabs = await api.tabs.query({});
  const existing = tabs.find((t) => tabMatches(t.url, url));
  if (existing) {
    await api.tabs.update(existing.id, { active: true });
    await api.windows.update(existing.windowId, { focused: true });
  } else {
    await api.tabs.create({ url });
  }
}

// Drag and drop is pointer-driven rather than HTML5: a card follows the cursor,
// drop targets light up, and the ghost says what releasing will do.
let dnd = null;
let suppressClick = false;
let justDropped = null;
const HOVER_EXPAND_MS = 600;

function markDragSource() {
  for (const el of list.querySelectorAll('.drag-source')) el.classList.remove('drag-source');
  if (dnd?.kind !== 'pr') return;
  for (const el of list.querySelectorAll(`[data-drag-pr="${dnd.id}"]`)) el.classList.add('drag-source');
}

function clearZones() {
  for (const el of list.querySelectorAll('.dnd-over, .dnd-before, .dnd-after, .dnd-hot')) {
    el.classList.remove('dnd-over', 'dnd-before', 'dnd-after', 'dnd-hot');
  }
  laterBtn.classList.remove('dnd-over');
  shelfDrop.classList.remove('dnd-over');
  looseDrop.classList.remove('dnd-over');
}

function zoneAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el?.closest) return { kind: 'none' };
  if (dnd.kind === 'cat') {
    const sec = el.closest('li.section[data-cat]');
    if (!sec || sec.dataset.cat === dnd.id) return { kind: 'none' };
    const r = sec.getBoundingClientRect();
    return { kind: 'reorder', el: sec, id: sec.dataset.cat, before: y < r.top + r.height / 2 };
  }
  // The whole header takes the drop, so a flick to the top edge lands it.
  if (el.closest('header')) return { kind: 'later', el: shelfDrop, id: null };
  if (viewLater) return { kind: 'none' }; // the shelf is a holding pen; only the button moves a PR
  const slot = el.closest('[data-epic-slot]');
  if (slot) return { kind: 'epic', el: slot, id: slot.dataset.epicSlot };
  const sec = el.closest('li.section[data-cat]');
  if (sec) return { kind: 'cat', el: sec, id: sec.dataset.cat };
  return el.closest('main') ? { kind: 'loose', id: null } : { kind: 'none' };
}

function zoneLabel(zone) {
  const cat = zone.id ? catById(zone.id) : null;
  if (zone.kind === 'later') return viewLater ? 'Back to the list' : 'Save for later';
  if (zone.kind === 'epic') return `⭐ Epic of ${cat?.name ?? ''}`;
  if (zone.kind === 'cat') return `→ ${cat?.emoji ?? ''} ${cat?.name ?? ''}`;
  if (zone.kind === 'reorder') return `Move ${zone.before ? 'above' : 'below'} ${cat?.name ?? ''}`;
  if (zone.kind === 'loose') {
    const pr = lastPrs.find((p) => p.html_url === dnd.id);
    return pr?.group ? 'Remove from category' : 'Keep in list';
  }
  return 'Release to cancel';
}

function applyZone(zone) {
  clearZones();
  if (zone.kind === 'cat' || zone.kind === 'epic' || zone.kind === 'later') {
    zone.el.classList.add(zone.kind === 'epic' ? 'dnd-hot' : 'dnd-over');
  }
  if (zone.kind === 'epic') zone.el.closest('li.section')?.classList.add('dnd-over');
  if (zone.kind === 'reorder') zone.el.classList.add(zone.before ? 'dnd-before' : 'dnd-after');
  const pr = lastPrs.find((p) => p.html_url === dnd.id);
  if (zone.kind === 'loose' && pr?.group) looseDrop.classList.add('dnd-over');

  const label = zoneLabel(zone);
  dnd.action.textContent = label;
  dnd.action.classList.toggle('off', zone.kind === 'none' || label === 'Keep in list');
  // Over the header the band says what will happen, and the card would only
  // cover it, so it drops out of sight for as long as the cursor is up there.
  dnd.ghost.style.opacity = zone.kind === 'later' ? '0' : '1';

  // Hovering a folded category opens it, so you can drop into what's inside.
  const hoverId = zone.kind === 'cat' ? zone.id : null;
  if (hoverId !== dnd.hoverId) {
    clearTimeout(dnd.hoverTimer);
    dnd.hoverId = hoverId;
    const cat = hoverId ? catById(hoverId) : null;
    if (cat?.collapsed) {
      dnd.hoverTimer = setTimeout(() => {
        cat.collapsed = false;
        saveCats();
        rerender();
      }, HOVER_EXPAND_MS);
    }
  }
  dnd.zone = zone;
}

function buildGhost() {
  const ghost = document.createElement('div');
  ghost.id = 'ghost';
  const title = document.createElement('div');
  title.className = 'ghost-title';
  title.textContent = dnd.title;
  const action = document.createElement('div');
  action.className = 'ghost-action';
  ghost.append(title, action);
  document.body.appendChild(ghost);
  dnd.ghost = ghost;
  dnd.action = action;
  dnd.gx = dnd.px;
  dnd.gy = dnd.py;
  placeGhost();
  ghost.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -118%) scale(0.9)' },
      { opacity: 1, transform: 'translate(-50%, -118%) scale(1)' },
    ],
    { duration: 150, easing: 'cubic-bezier(.2,.9,.3,1.3)' },
  );
  dnd.raf = requestAnimationFrame(ghostTick);
}

// The card trails the cursor and tips into the turn, so a drag reads as
// picking something up rather than teleporting it.
function placeGhost() {
  const half = dnd.ghost.offsetWidth / 2;
  const x = Math.max(half + 6, Math.min(dnd.gx, window.innerWidth - half - 6));
  const tilt = Math.max(-6, Math.min(6, (dnd.px - dnd.gx) * 0.35));
  // The card rides above the cursor, which would put it off-screen and over the
  // drop band once you reach the header, so up there it hangs below instead.
  const under = dnd.gy < dnd.ghost.offsetHeight * 1.18 + 6;
  dnd.ghost.style.left = `${x}px`;
  dnd.ghost.style.top = `${Math.max(dnd.gy, 4)}px`;
  dnd.ghost.style.transformOrigin = under ? '50% -20%' : '50% 120%';
  dnd.ghost.style.transform = `translate(-50%, ${under ? '26%' : '-118%'}) rotate(${tilt}deg)`;
}

function ghostTick() {
  if (!dnd?.active) return;
  dnd.gx += (dnd.px - dnd.gx) * 0.3;
  dnd.gy += (dnd.py - dnd.gy) * 0.3;
  placeGhost();
  dnd.raf = requestAnimationFrame(ghostTick);
}

// Links and avatars are natively draggable, and Firefox's own drag image fights
// the card, so no element in the panel starts a native drag.
document.addEventListener('dragstart', (e) => e.preventDefault());

list.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.edit-btn, .row-editor, .twist, .stack-toggle, .hf-toggle, [data-href], [data-group]')) return;
  const head = e.target.closest('[data-drag-cat]');
  const row = head ? null : e.target.closest('[data-drag-pr]');
  const src = head ?? row;
  if (!src) return;
  dnd = {
    kind: head ? 'cat' : 'pr',
    id: head ? head.dataset.dragCat : row.dataset.dragPr,
    title: (head ? src.querySelector('.sec-name') : src.querySelector('.title-text'))?.textContent ?? '',
    x: e.clientX,
    y: e.clientY,
    px: e.clientX,
    py: e.clientY,
    active: false,
    zone: { kind: 'none' },
    hoverId: null,
  };
  document.addEventListener('mousemove', onDndMove);
  document.addEventListener('mouseup', onDndUp);
});

// A release outside the sidebar never reaches this document, so the drag would
// hang with its card on screen. Anything that says the button is no longer down
// drops it.
function cancelDnd() {
  const d = dnd;
  if (!d) return;
  dnd = null;
  document.removeEventListener('mousemove', onDndMove);
  document.removeEventListener('mouseup', onDndUp);
  clearTimeout(d.hoverTimer);
  cancelAnimationFrame(d.raf);
  d.ghost?.remove();
  document.body.classList.remove('dnd', 'dnd-pr', 'dnd-grouped');
  clearZones();
  markDragSource();
}
window.addEventListener('blur', cancelDnd);

function onDndMove(e) {
  if (!dnd) return;
  if (!e.buttons) {
    cancelDnd();
    return;
  }
  dnd.px = e.clientX;
  dnd.py = e.clientY;
  if (!dnd.active) {
    if (Math.abs(e.clientX - dnd.x) + Math.abs(e.clientY - dnd.y) < 5) return;
    dnd.active = true;
    document.body.classList.add('dnd');
    if (dnd.kind === 'pr') {
      document.body.classList.add('dnd-pr');
      // Somewhere to aim for when every PR sits in a category and the list has
      // no loose rows to drop beside.
      const src = lastPrs.find((p) => p.html_url === dnd.id);
      if (!viewLater && src?.group) document.body.classList.add('dnd-grouped');
    }
    hideTip();
    closeEditor();
    buildGhost();
    markDragSource();
  }
  e.preventDefault();
  applyZone(zoneAt(e.clientX, e.clientY));
}

async function onDndUp() {
  document.removeEventListener('mousemove', onDndMove);
  document.removeEventListener('mouseup', onDndUp);
  const d = dnd;
  dnd = null;
  if (!d) return;
  clearTimeout(d.hoverTimer);
  if (!d.active) return;
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  }, 0);
  cancelAnimationFrame(d.raf);
  const ghost = d.ghost;
  if (ghost && d.zone.kind === 'later') {
    ghost.remove();
  } else if (ghost) {
    const anim = ghost.animate(
      [
        { opacity: 1, transform: ghost.style.transform },
        { opacity: 0, transform: `${ghost.style.transform} scale(0.86)` },
      ],
      { duration: 130, easing: 'ease-in' },
    );
    anim.finished.then(() => ghost.remove(), () => ghost.remove());
  }
  document.body.classList.remove('dnd', 'dnd-pr', 'dnd-grouped');
  clearZones();
  markDragSource();

  const zone = d.zone;
  if (d.kind === 'cat') {
    if (zone.kind !== 'reorder') return;
    const from = categories.findIndex((c) => c.id === d.id);
    const moved = categories.splice(from, 1)[0];
    let to = categories.findIndex((c) => c.id === zone.id);
    if (!zone.before) to += 1;
    categories.splice(to, 0, moved);
    await saveCats();
  } else if (zone.kind === 'later') {
    setLater(withDescendants(d.id), !viewLater);
    justDropped = d.id;
  } else {
    if (zone.kind === 'none') return;
    const target = zone.kind === 'loose' ? null : zone.id;
    for (const url of withDescendants(d.id)) assignCategory(url, target);
    if (zone.kind === 'epic') {
      const cat = catById(target);
      if (cat) cat.epic = d.id;
      await saveCats();
    }
    justDropped = d.id;
  }
  rerender();
}

list.addEventListener('click', async (e) => {
  if (suppressClick) return;
  const twist = e.target.closest('[data-twist]');
  if (twist) {
    e.preventDefault();
    const url = twist.dataset.twist;
    collapsedNodes.has(url) ? collapsedNodes.delete(url) : collapsedNodes.add(url);
    api.storage.local.set({ collapsedNodes: [...collapsedNodes] });
    closeEditor();
    rerender();
    return;
  }
  const ccfg = e.target.closest('[data-editcat]');
  if (ccfg) {
    e.preventDefault();
    openCatEditor(ccfg.closest('li'), ccfg.dataset.editcat);
    return;
  }
  const edit = e.target.closest('.edit-btn');
  if (edit) {
    e.preventDefault();
    openEditor(edit.closest('li'), edit.dataset.edit);
    return;
  }
  if (e.target.closest('.row-editor')) return;
  const sec = e.target.closest('[data-sectoggle]');
  if (sec) {
    e.preventDefault();
    const cat = catById(sec.dataset.sectoggle);
    if (cat) {
      cat.collapsed = !cat.collapsed;
      saveCats();
    }
    closeEditor();
    rerender();
    return;
  }
  const toggle = e.target.closest('[data-group]');
  if (toggle) {
    e.preventDefault();
    const key = toggle.dataset.group;
    expandedGroups.has(key) ? expandedGroups.delete(key) : expandedGroups.add(key);
    closeEditor();
    rerender();
    return;
  }
  const ext = e.target.closest('[data-href]');
  if (ext) {
    e.preventDefault();
    openUrl(ext.dataset.href);
    return;
  }
  const a = e.target.closest('a');
  if (!a || !a.getAttribute('href')) return;
  e.preventDefault();
  openUrl(a.getAttribute('href'));
});

// Keep the active-tab highlight in sync as the user moves around.
async function refreshActiveTab() {
  try {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabUrl = tab?.url ?? null;
    const model = buildModel(lastPrs);
    if (autoExpandActive(model)) renderList(model);
    else updateActiveHighlight();
  } catch {
    /* tabs permission missing or no tab */
  }
}
api.tabs.onActivated.addListener(refreshActiveTab);
api.tabs.onUpdated.addListener(refreshActiveTab);

$('refresh').addEventListener('click', () => {
  closeEditor();
  load(true);
});

function setView(later) {
  viewLater = later;
  closeEditor();
  toggleTrackbox(false);
  window.scrollTo({ top: 0 });
  rerender();
}
laterBtn.addEventListener('click', () => setView(!viewLater));
$('shelfback').addEventListener('click', () => setView(false));

async function newCategory() {
  closeEditor();
  const cat = { id: newId(), name: `Category ${categories.length + 1}`, emoji: '📌', color: '', epic: null, collapsed: false };
  categories.push(cat);
  await saveCats();
  rerender();
  const li = list.querySelector(`li.section[data-cat="${cat.id}"]`);
  if (li) {
    li.scrollIntoView({ block: 'nearest' });
    openCatEditor(li, cat.id);
  }
}

const menu = $('menu');
function toggleMenu(show) {
  menu.classList.toggle('show', show);
  $('plus').classList.toggle('on', show);
}
$('plus').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu(!menu.classList.contains('show'));
});
menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  toggleMenu(false);
  if (act === 'cat') newCategory();
  else if (act === 'track') toggleTrackbox(true);
});
document.addEventListener('click', () => toggleMenu(false));

const searchRow = $('searchrow');
const filterIn = $('filter');
function setFilter(value) {
  filterText = value;
  filterIn.value = value;
  searchRow.classList.toggle('filled', Boolean(value));
  rerender();
}
$('filterclear').addEventListener('click', () => {
  setFilter('');
  filterIn.focus();
});
filterIn.addEventListener('input', () => setFilter(filterIn.value));
filterIn.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (filterText) setFilter('');
  else filterIn.blur();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleMenu(false);
  if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    filterIn.focus();
    filterIn.select();
  }
});

const trackbox = $('trackbox');
function toggleTrackbox(show) {
  trackbox.style.display = show ? 'block' : 'none';
  if (show) {
    setup.style.display = 'none';
    $('settings').classList.remove('on');
    $('trackurl').focus();
  } else {
    $('trackurl').value = '';
  }
}
$('trackcancel').addEventListener('click', () => toggleTrackbox(false));
$('trackadd').addEventListener('click', async () => {
  closeEditor();
  const spec = $('trackurl').value.trim();
  if (!spec || !(await addTracked(spec))) return;
  toggleTrackbox(false);
  load();
});
$('trackurl').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('trackadd').click();
  else if (e.key === 'Escape') toggleTrackbox(false);
});

const SCOPE_CUSTOM = ' custom';
let cachedOrgs = null;

function fillScopeOptions(orgs, current) {
  const sel = $('scope');
  sel.textContent = '';
  sel.appendChild(new Option('everywhere', ''));
  const logins = new Set(orgs);
  if (current.startsWith('org:')) logins.add(current.slice(4));
  for (const login of logins) sel.appendChild(new Option(`org:${login}`, `org:${login}`));
  sel.appendChild(new Option('one repo…', SCOPE_CUSTOM));
  const preset = [...sel.options].some((o) => o.value === current);
  sel.value = preset ? current : SCOPE_CUSTOM;
  return preset;
}

async function populateScopeSelect() {
  const custom = $('scopecustom');
  const current = await getScope();
  const preset = fillScopeOptions(cachedOrgs ?? [], current);
  custom.value = preset ? '' : current;
  custom.style.display = preset ? 'none' : '';
  if (cachedOrgs) return;
  const token = await getToken();
  if (!token) return;
  try {
    const res = await fetch('https://api.github.com/user/orgs?per_page=100', { headers: authHeaders(token) });
    if (!res.ok) return;
    cachedOrgs = (await res.json()).map((o) => o.login);
    // Re-read the select rather than `current`: the list may have been changed
    // by hand while the orgs were in flight.
    const sel = $('scope');
    fillScopeOptions(cachedOrgs, sel.value === SCOPE_CUSTOM ? custom.value.trim() : sel.value);
  } catch {
    /* offline or token lacks read:org, the custom option still covers it */
  }
}
$('scope').addEventListener('change', () => {
  const isCustom = $('scope').value === SCOPE_CUSTOM;
  $('scopecustom').style.display = isCustom ? '' : 'none';
  if (isCustom) $('scopecustom').focus();
});

const seg = $('involvement');
let involvement = 'involved';
function syncSeg() {
  for (const b of seg.children) b.classList.toggle('sel', b.dataset.v === involvement);
}
seg.addEventListener('click', (e) => {
  const v = e.target.closest('[data-v]')?.dataset.v;
  if (!v) return;
  involvement = v;
  syncSeg();
});
setup.addEventListener('click', (e) => {
  const href = e.target.closest('[data-open]')?.dataset.open;
  if (href) openUrl(href);
});

// The panel opens on the click; the org list is a network call and fills in
// behind it rather than holding the whole thing back.
$('settings').addEventListener('click', async () => {
  toggleTrackbox(false);
  const show = setup.style.display !== 'block';
  setup.style.display = show ? 'block' : 'none';
  $('settings').classList.toggle('on', show);
  if (!show) return;
  const { hotfixPattern, involvement: saved } = await api.storage.local.get(['hotfixPattern', 'involvement']);
  $('hotfixre').value = hotfixPattern ?? '';
  involvement = saved === 'mine' ? 'mine' : 'involved';
  syncSeg();
  populateScopeSelect();
});
$('save').addEventListener('click', async () => {
  closeEditor();
  const token = $('token').value.trim();
  const scope = $('scope').value === SCOPE_CUSTOM ? $('scopecustom').value.trim() : $('scope').value;
  if (token) {
    cachedLogin = null; // new token may be a different account
    await api.storage.local.set({ token });
  }
  await api.storage.local.set({ scope, involvement });
  const hotfixPattern = $('hotfixre').value.trim();
  if (hotfixPattern) await api.storage.local.set({ hotfixPattern });
  else await api.storage.local.remove('hotfixPattern');
  $('token').value = '';
  setup.style.display = 'none';
  $('settings').classList.remove('on');
  load();
});
$('clear').addEventListener('click', async () => {
  closeEditor();
  await api.storage.local.remove('token');
  cachedLogin = null;
  lastPrs = [];
  list.textContent = '';
  statusEl.textContent = 'Token cleared.';
  setup.style.display = 'block';
});

// Poll while the sidebar is visible; refresh on regaining focus.
// GitHub has no push for "my PRs", so a 10s poll is the swap trigger.
setInterval(() => {
  if (!document.hidden && !dnd && !loading) load();
}, 10000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelDnd();
  else load();
});

async function boot() {
  syncSeg();
  const { token, snapshot } = await api.storage.local.get(['token', 'snapshot']);
  if (token && snapshot) {
    try {
      await loadState();
      HOTFIX_RE = await getHotfixRe();
      lastPrs = JSON.parse(snapshot);
      savedSnapshot = snapshot;
      // Seed as already stale: the badge shows straight away and still gets
      // re-read on the first poll.
      for (const pr of lastPrs) {
        if (pr.ci) ciCache.set(pr.html_url, { ci: pr.ci, at: 0, updated_at: pr.updated_at });
      }
      rerender();
    } catch {
      lastPrs = []; // unreadable snapshot, the load below fills the list instead
    }
  }
  refreshActiveTab();
  load();
}

boot();
