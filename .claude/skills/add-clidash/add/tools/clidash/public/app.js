// clidash frontend — vanilla JS, no build step.
//
// Layout: a left sidebar with top-level items (Overview, Activity) and grouped
// sections (one per CLI — ncl, docker — and a Files section for on-disk docs).
// Each page shows the exact command that produced it. Tables auto-derive from
// `ncl <resource> list --json`; rows drill into their `get` detail.
//
// Refresh UX: on first load every resource of every CLI is prefetched so nav is
// instant. 60s auto-refresh + a manual button. Background refreshes diff-and-
// inject (the data DOM rebuilds only when the data signature changes).

import { mdToHtml } from './md.js';

const $ = (id) => document.getElementById(id);

const state = {
  clis: [],
  docCollections: [],
  activeView: 'overview',   // 'overview' | 'activity' | 'r:<cli>:<resource>' | 'doc:<collection>'
  paused: false,
  refreshSeconds: 60,
  lastUpdated: null,
  refreshing: false,
  snapshots: new Map(),     // "cli/resource" -> { rows, fetchedAt, command }
  errors: new Map(),
  activity: null,           // { sessions, series }
  activityConfigured: false,
  activityCommand: null,
  logs: [],                 // [{ name, label }]
  logCache: new Map(),      // name -> { text, command }
  activeDocPath: null,
  openDocGroups: new Set(), // which doc groups (e.g. agents) are expanded
  docCache: new Map(),
  configCache: new Map(),   // groupId -> container config (for the overview page)
  helpCache: new Map(),     // "cli/resource" -> help text | null (prefetched each cycle)
  detail: null,
  sidebarOpen: false,
  renderedSig: null,
};

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

// Lucide-style inline icons (static trusted markup) — crisp, themeable via currentColor.
const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  activity: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3"/><path d="M13 15h4"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  logs: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M8 13h8"/><path d="M8 17h5"/>',
};
function icon(name) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] ?? '';
  return s;
}

// ---------------------------------------------------------------- helpers

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// Local wall time "YYYY-MM-DD HH:mm" — the raw ISO string is UTC; slicing it
// would display UTC wall time with no marker, masquerading as local.
function absTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const s = Math.round(ms / 1000);
  if (s < 0) return new Date(iso).toLocaleString();
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function coarseAgo(date) {
  const s = (Date.now() - date.getTime()) / 1000;
  if (s < 60) return 'less than a minute ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

function staleness(lastActive) {
  if (!lastActive) return 'gray';
  const min = (Date.now() - new Date(lastActive).getTime()) / 60000;
  if (Number.isNaN(min)) return 'gray';
  return min < 15 ? 'green' : min < 120 ? 'amber' : 'red';
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtValue(value) {
  if (value === null || value === undefined) return { text: 'null', cls: 'null' };
  if (typeof value === 'string' && ISO_RE.test(value)) return { iso: value };
  return { text: typeof value === 'object' ? JSON.stringify(value) : String(value) };
}

function cellFor(value) {
  const f = fmtValue(value);
  if (f.cls === 'null') return el('td', { class: 'null' }, 'null');
  if (f.iso) {
    return el('td', {}, el('span', { class: 'reltime', title: f.iso }, [
      relTime(f.iso), el('span', { class: 'abs' }, absTime(f.iso)),
    ]));
  }
  if (f.text.length > 42) {
    const span = el('span', { class: 'trunc', title: f.text }, f.text.slice(0, 39) + '…');
    span.addEventListener('click', (e) => { e.stopPropagation(); span.textContent = f.text; span.classList.remove('trunc'); });
    return el('td', {}, span);
  }
  return el('td', {}, f.text);
}

function kvRows(obj) {
  return Object.entries(obj ?? {}).map(([k, v]) => {
    let valEl;
    if (v && typeof v === 'object') valEl = el('pre', { class: 'kv-json' }, JSON.stringify(v, null, 2));
    else if (typeof v === 'string' && ISO_RE.test(v)) valEl = el('span', { class: 'reltime', title: v }, `${relTime(v)}  (${absTime(v)})`);
    else if (v === null || v === undefined) valEl = el('span', { class: 'null' }, 'null');
    else valEl = el('span', {}, String(v));
    return el('div', { class: 'kv-row' }, [el('span', { class: 'kv-key' }, k), valEl]);
  });
}

function resolveRef(cliName, ref, id) {
  const snap = state.snapshots.get(`${cliName}/${ref.ref}`);
  const row = snap?.rows?.find((r) => String(r.id) === String(id));
  return row ? (row[ref.label] ?? null) : null;
}

function badgeChip(value, colorMap) {
  const color = colorMap[String(value).toLowerCase()] ?? 'gray';
  return el('span', { class: `badge-status ${color}` }, [el('span', { class: `dot ${color}` }), String(value)]);
}

function buildCell(value, column, ctx) {
  if (ctx.badges?.[column] && value != null && typeof value !== 'object') {
    return el('td', {}, badgeChip(value, ctx.badges[column]));
  }
  if (ctx.enrich?.[column] && value != null) {
    const name = resolveRef(ctx.cliName, ctx.enrich[column], value);
    if (name != null) {
      return el('td', { class: 'enriched', title: String(value) }, [
        el('span', {}, String(name)), el('span', { class: 'raw-id' }, String(value)),
      ]);
    }
  }
  return cellFor(value);
}

function summaryBar(resource, rows, col, cli) {
  let label = resource.replace(/-/g, ' ');
  if (rows.length === 1 && label.endsWith('s')) label = label.slice(0, -1);
  const bits = [el('span', { class: 'sum-count' }, `${rows.length} ${label}`)];
  if (col && rows.some((r) => col in r)) {
    const counts = new Map();
    for (const r of rows) { const v = r[col] ?? '—'; counts.set(v, (counts.get(v) ?? 0) + 1); }
    const colorMap = cli.badges?.[col];
    for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      bits.push(el('span', { class: 'sum-sep' }, '·'));
      const c = colorMap?.[String(v).toLowerCase()] ?? null;
      bits.push(c
        ? el('span', { class: `badge-status ${c}` }, [el('span', { class: `dot ${c}` }), `${v} ×${n}`])
        : el('span', { class: 'sum-chip' }, `${v} ×${n}`));
    }
  }
  return el('div', { class: 'summary-bar' }, bits);
}

// ---------------------------------------------------------------- views

const nclCli = () => state.clis.find((c) => c.name === 'ncl') ?? state.clis[0];
function currentView() {
  const v = state.activeView;
  if (v === 'overview' || v === 'activity') return { type: v };
  const m = v.match(/^r:([^:]+):(.+)$/);
  if (m) return { type: 'resource', cli: m[1], resource: m[2] };
  if (v.startsWith('doc:')) return { type: 'doc', collection: v.slice(4) };
  if (v.startsWith('log:')) return { type: 'log', name: v.slice(4) };
  return { type: 'overview' };
}
const activeCollection = () => {
  const v = currentView();
  return v.type === 'doc' ? state.docCollections.find((c) => c.name === v.collection) : null;
};

// ---------------------------------------------------------------- fetching

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json().catch(() => ({ ok: false, error: `Bad response from ${url}` }));
}

async function refresh(force = false) {
  state.refreshing = true;
  if (force) renderControls();

  const [cliList, docList, logList] = await Promise.all([
    fetchJson('/api/clis').catch(() => null),
    fetchJson('/api/docs').catch(() => null),
    fetchJson('/api/logs').catch(() => null),
  ]);
  if (cliList?.clis) {
    state.clis = cliList.clis;
    state.refreshSeconds = cliList.clis[0]?.refreshSeconds ?? state.refreshSeconds;
  }
  if (docList?.collections) state.docCollections = docList.collections;
  if (logList?.files) state.logs = logList.files;

  render(); // paint sidebar + active view's loading state immediately

  const jobs = [];
  jobs.push(fetchJson('/api/activity').then((body) => {
    if (body.ok && body.configured) {
      state.activity = { sessions: body.sessions, series: body.series };
      state.activityConfigured = true; state.activityCommand = body.command ?? null;
    } else state.activityConfigured = false;
    render();
  }));
  for (const lg of state.logs) {
    jobs.push(fetchJson(`/api/log/${encodeURIComponent(lg.name)}`).then((body) => {
      if (body.ok) state.logCache.set(lg.name, { text: body.text, command: body.command });
      render();
    }));
  }
  for (const c of state.clis) {
    for (const r of c.resources ?? []) {
      const key = `${c.name}/${r.name}`;
      jobs.push(fetchJson(`/api/r/${c.name}/${encodeURIComponent(r.name)}`).then((body) => {
        if (body.ok) { state.snapshots.set(key, { rows: body.rows, fetchedAt: body.fetchedAt, command: body.command }); state.errors.set(key, null); }
        else state.errors.set(key, body.raw ? `${body.error}\n\n${body.raw}` : body.error);
        render();
      }));
      if (c.help) {
        jobs.push(fetchJson(`/api/help/${c.name}/${encodeURIComponent(r.name)}`).then((body) => {
          state.helpCache.set(key, body.ok ? body.text : null);
          render();
        }));
      }
    }
  }
  await Promise.all(jobs);

  // per-group container config (for the Overview page) — small, refetched each cycle
  const groups = state.snapshots.get('ncl/groups')?.rows ?? [];
  await Promise.all(groups.map(async (g) => {
    const c = await fetchJson(`/api/cmd/ncl/config-get?id=${encodeURIComponent(g.id)}`);
    if (c.ok) state.configCache.set(g.id, c.data);
  }));

  state.lastUpdated = new Date();
  state.refreshing = false;
  render();
}

async function openDoc(collectionName, path) {
  state.activeDocPath = path;
  const key = `${collectionName}\0${path}`;
  if (!state.docCache.has(key)) {
    const body = await fetchJson(`/api/doc?c=${encodeURIComponent(collectionName)}&p=${encodeURIComponent(path)}`);
    state.docCache.set(key, body.ok ? { lang: body.lang, content: body.content } : { lang: 'error', content: body.error || 'Failed to load' });
  }
  state.renderedSig = null;
  render();
}

async function openDetail(cliName, resource, id) {
  state.detail = { cli: cliName, resource, id, loading: true };
  state.renderedSig = null;
  render();
  const rec = await fetchJson(`/api/cmd/${cliName}/get?resource=${encodeURIComponent(resource)}&id=${encodeURIComponent(id)}`);
  let config = null;
  if (resource === 'groups') {
    const cg = await fetchJson(`/api/cmd/${cliName}/config-get?id=${encodeURIComponent(id)}`);
    if (cg.ok) config = cg.data;
  }
  if (!state.detail || state.detail.id !== id) return;
  state.detail = { cli: cliName, resource, id, record: rec.ok ? rec.data : null, error: rec.ok ? null : rec.error, config };
  state.renderedSig = null;
  render();
}

function closeDetail() { state.detail = null; state.renderedSig = null; render(); }

// Help panel: the description (first paragraph) is always visible; the verbs +
// fields (everything after the first blank line) sit behind a collapse.
function helpPanel(text) {
  if (text === null) return null; // explicitly no help
  if (text === undefined) return el('div', { class: 'help-panel' }, el('div', { class: 'help-head dim' }, 'loading help…'));
  const idx = text.indexOf('\n\n');
  const head = (idx >= 0 ? text.slice(0, idx) : text).trim();
  const body = idx >= 0 ? text.slice(idx + 2).trim() : '';
  return el('div', { class: 'help-panel' }, [
    el('div', { class: 'help-head' }, head),
    body ? el('details', { class: 'help-more' }, [
      el('summary', {}, 'verbs & fields'),
      el('pre', { class: 'help-text' }, body),
    ]) : null,
  ]);
}

function go(view) {
  state.activeView = view;
  state.detail = null;
  state.sidebarOpen = false;
  state.renderedSig = null;
  const v = currentView();
  if (v.type === 'doc') {
    const coll = state.docCollections.find((c) => c.name === v.collection);
    const first = coll && (coll.name === 'conversations' ? coll.files.at(-1) : coll.files[0]); // newest conversation
    state.activeDocPath = state.activeDocPath && coll?.files.some((f) => f.path === state.activeDocPath)
      ? state.activeDocPath : (first?.path ?? null);
    // expand only the group holding the active doc; the user picks the rest
    const activeFile = coll?.files.find((f) => f.path === state.activeDocPath);
    state.openDocGroups = new Set(activeFile ? [activeFile.group] : []);
    render();
    if (state.activeDocPath) openDoc(coll.name, state.activeDocPath);
    return;
  }
  render();
}

// ---------------------------------------------------------------- rendering

function dataSignature() {
  const v = currentView();
  const key = v.type === 'resource' ? `${v.cli}/${v.resource}` : null;
  const coll = activeCollection();
  return JSON.stringify({
    view: state.activeView, clis: state.clis.map((c) => `${c.name}:${(c.resources || []).length}`),
    activityConfigured: state.activityConfigured,
    rows: key ? state.snapshots.get(key)?.rows ?? null : null,
    rowsError: key ? state.errors.get(key) ?? null : null,
    command: key ? state.snapshots.get(key)?.command ?? null : null,
    help: key ? state.helpCache.get(key) ?? null : null,
    overview: v.type === 'overview' ? {
      groups: state.snapshots.get('ncl/groups')?.rows ?? null,
      sessions: state.snapshots.get('ncl/sessions')?.rows ?? null,
      configs: [...state.configCache.entries()],
      activity: state.activity?.sessions ?? null,
    } : null,
    activity: v.type === 'activity' ? state.activity : null,
    log: v.type === 'log' ? state.logCache.get(v.name)?.text ?? null : null,
    docFiles: coll ? coll.files.map((f) => f.path) : null,
    docPath: state.activeDocPath,
    docGroupsOpen: coll ? [...state.openDocGroups] : null,
    docContent: coll ? state.docCache.get(`${coll.name}\0${state.activeDocPath}`)?.content ?? null : null,
    detail: state.detail, paused: state.paused, sidebarOpen: state.sidebarOpen,
  });
}

function renderControls() {
  $('updated').textContent = state.lastUpdated
    ? `updated ${coarseAgo(state.lastUpdated)}${state.paused ? ' · paused' : ''}` : '';
  $('refresh').classList.toggle('spinning', state.refreshing);
}

function render() {
  renderControls();
  const sig = dataSignature();
  if (sig === state.renderedSig) return;
  state.renderedSig = sig;

  $('sidebar').classList.toggle('open', state.sidebarOpen);
  $('scrim').hidden = !state.sidebarOpen;

  renderNav();

  const v = currentView();
  const banner = $('banner');
  const tabError = v.type === 'resource' ? state.errors.get(`${v.cli}/${v.resource}`) : null;
  const cli = v.type === 'resource' ? state.clis.find((c) => c.name === v.cli) : null;
  const bannerMsg = cli?.error ? `Discovery failed for ${v.cli}: ${cli.error}`
    : (tabError ? `CLI unreachable — showing last good snapshot. ${tabError.split('\n')[0]}` : null);
  banner.hidden = !bannerMsg;
  banner.textContent = bannerMsg ?? '';

  renderCmdline(v);
  if (v.type === 'overview') renderOverviewPage();
  else if (v.type === 'activity') renderActivity();
  else if (v.type === 'doc') renderDocs();
  else if (v.type === 'log') renderLogPage(v.name);
  else renderTable(v.cli, v.resource);
  renderDetail();
}

function navItem(label, view, cls = '', iconName = null) {
  return el('button', {
    class: `nav-item ${cls}` + (state.activeView === view ? ' active' : ''),
    onclick: () => go(view),
  }, [iconName ? icon(iconName) : null, el('span', {}, label)]);
}

function renderNav() {
  const nav = $('nav');
  const items = [navItem('Overview', 'overview', '', 'overview')];
  if (state.activityConfigured) items.push(navItem('Activity', 'activity', '', 'activity'));

  for (const cli of state.clis) {
    items.push(el('div', { class: 'nav-section' }, [icon(cli.name === 'docker' ? 'box' : 'terminal'), el('span', {}, cli.name)]));
    for (const r of cli.resources ?? []) {
      items.push(navItem(r.name, `r:${cli.name}:${r.name}`, 'nav-sub'));
    }
  }
  if (state.docCollections.length) {
    items.push(el('div', { class: 'nav-section' }, [icon('folder'), el('span', {}, 'Files')]));
    for (const coll of state.docCollections) {
      items.push(navItem(coll.label, `doc:${coll.name}`, 'nav-sub'));
    }
  }
  if (state.logs.length) {
    items.push(el('div', { class: 'nav-section' }, [icon('logs'), el('span', {}, 'Logs')]));
    for (const lg of state.logs) {
      items.push(navItem(lg.label, `log:${lg.name}`, 'nav-sub'));
    }
  }
  nav.replaceChildren(...items);
}

function renderCmdline(v) {
  const bar = $('cmdline');
  let cmd = null;
  if (v.type === 'resource') cmd = state.snapshots.get(`${v.cli}/${v.resource}`)?.command;
  else if (v.type === 'activity') cmd = state.activityCommand;
  else if (v.type === 'doc') cmd = state.activeDocPath ? `file · ${state.activeDocPath}` : null;
  else if (v.type === 'log') cmd = state.logCache.get(v.name)?.command ?? null;
  else if (v.type === 'overview') cmd = 'derived · ncl groups/sessions/messaging-groups/wirings + config-get + activity';
  bar.hidden = !cmd;
  bar.textContent = cmd ? `$ ${cmd}` : '';
}

// ---- Overview page (rich agent cards) ----

function renderOverviewPage() {
  const content = $('content');
  const groups = state.snapshots.get('ncl/groups')?.rows;
  if (!groups) { content.replaceChildren(el('div', { class: 'empty' }, 'Loading…')); return; }
  const sessions = state.snapshots.get('ncl/sessions')?.rows ?? [];
  const wirings = state.snapshots.get('ncl/wirings')?.rows ?? [];
  const mgs = state.snapshots.get('ncl/messaging-groups')?.rows ?? [];
  const act = state.activity?.sessions ?? [];
  const mgName = (id) => mgs.find((m) => m.id === id)?.name ?? mgs.find((m) => m.id === id)?.platform_id ?? id;

  const field = (k, v, cls = '') => el('div', { class: 'ov-field' }, [el('span', { class: 'k' }, k), el('span', { class: `v ${cls}` }, v)]);

  const cards = groups.map((g) => {
    const gs = sessions.filter((s) => s.agent_group_id === g.id);
    const lastActive = gs.map((s) => s.last_active).filter(Boolean).sort().at(-1) ?? null;
    const container = gs.some((s) => s.container_status === 'running') ? 'running' : (gs[0]?.container_status ?? 'none');
    const ga = act.filter((a) => a.agent_group_id === g.id);
    const msgIn = ga.reduce((a, s) => a + s.in, 0), msgOut = ga.reduce((a, s) => a + s.out, 0);
    const cfg = state.configCache.get(g.id);
    const chans = wirings.filter((w) => w.agent_group_id === g.id).map((w) => `${mgs.find((m) => m.id === w.messaging_group_id)?.channel_type ?? '?'}: ${mgName(w.messaging_group_id)}`);
    const status = staleness(lastActive);
    const containerColor = container === 'running' ? 'green' : container === 'idle' ? 'green' : container === 'none' ? 'gray' : 'gray';

    const fields = [
      el('div', { class: 'ov-field' }, [el('span', { class: 'k' }, 'container'), badgeChip(container, { running: 'green', idle: 'green', stopped: 'gray', none: 'gray' })]),
      field('sessions', String(gs.length)),
      field('messages', `${msgIn} in · ${msgOut} out`),
      field('last active', lastActive ? relTime(lastActive) : '—', lastActive ? '' : 'dim'),
    ];
    if (cfg) {
      fields.push(field('provider / model', `${cfg.provider ?? 'claude'} / ${cfg.model ?? 'default'}`));
      fields.push(el('div', { class: 'ov-field' }, [el('span', { class: 'k' }, 'cli scope'), badgeChip(cfg.cli_scope ?? 'group', { global: 'amber', group: 'green', disabled: 'gray' })]));
      const pkgs = (cfg.packages_apt?.length ?? 0) + (cfg.packages_npm?.length ?? 0);
      const mcp = Object.keys(cfg.mcp_servers ?? {}).length;
      if (pkgs || mcp) fields.push(field('extras', `${pkgs} pkgs · ${mcp} mcp`));
    }

    return el('div', { class: 'ov-card' }, [
      el('div', { class: 'ov-head' }, [
        el('span', { class: `dot ${status}` }),
        el('span', { class: 'ov-name' }, g.name),
        el('span', { class: 'ov-folder' }, g.folder),
      ]),
      el('div', { class: 'ov-fields' }, fields),
      el('div', { class: 'ov-chans' }, chans.map((c) => el('span', { class: 'badge' }, c))),
    ]);
  });

  content.replaceChildren(
    el('h2', { class: 'page-title' }, 'Agents overview'),
    el('div', { class: 'ov-cards' }, cards),
  );
}

// ---- Activity ----

function renderActivity() {
  const content = $('content');
  const data = state.activity;
  if (!data) { content.replaceChildren(el('div', { class: 'empty' }, 'Loading…')); return; }
  const { series, sessions } = data;
  const totalIn = series.reduce((a, d) => a + d.in, 0);
  const totalOut = series.reduce((a, d) => a + d.out, 0);

  const W = 720, H = 220, padL = 34, padB = 28, padT = 10;
  const max = Math.max(1, ...series.map((d) => Math.max(d.in, d.out)));
  const slot = (W - padL) / series.length;
  const bw = Math.max(3, slot / 2 - 2);
  const yOf = (vv) => padT + (H - padT - padB) * (1 - vv / max);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'activity-chart', preserveAspectRatio: 'none' });
  for (const frac of [0, 0.5, 1]) {
    const y = yOf(max * frac);
    chart.append(svg('line', { x1: padL, y1: y, x2: W, y2: y, class: 'grid' }));
    chart.append(svg('text', { x: padL - 6, y: y + 3, class: 'axis', 'text-anchor': 'end' }, String(Math.round(max * frac))));
  }
  series.forEach((d, i) => {
    const x = padL + i * slot;
    chart.append(svg('rect', { x: x + 1, y: yOf(d.in), width: bw, height: yOf(0) - yOf(d.in), class: 'bar-in' }, [svg('title', {}, `${d.date}: ${d.in} in`)]));
    chart.append(svg('rect', { x: x + 1 + bw, y: yOf(d.out), width: bw, height: yOf(0) - yOf(d.out), class: 'bar-out' }, [svg('title', {}, `${d.date}: ${d.out} out`)]));
    if (i % 2 === 0) chart.append(svg('text', { x: x + bw, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, d.date.slice(5)));
  });
  const legend = el('div', { class: 'activity-legend' }, [
    el('span', {}, [el('span', { class: 'lg in' }), `inbound (${totalIn})`]),
    el('span', {}, [el('span', { class: 'lg out' }), `outbound (${totalOut})`]),
    el('span', { class: 'dim' }, `last ${series.length} days`),
  ]);
  const sessRows = [...sessions].sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '')).map((s) => {
    const groupName = resolveRef('ncl', { ref: 'groups', label: 'name' }, s.agent_group_id) ?? s.agent_group_id;
    return el('tr', {}, [
      el('td', {}, groupName),
      el('td', {}, el('span', { class: 'trunc', title: s.session_id }, s.session_id.slice(0, 22) + '…')),
      el('td', { class: 'num' }, String(s.in)),
      el('td', { class: 'num' }, String(s.out)),
      el('td', {}, s.lastActivity ? el('span', { class: 'reltime', title: s.lastActivity }, relTime(s.lastActivity)) : el('span', { class: 'null' }, '—')),
    ]);
  });
  content.replaceChildren(
    el('h2', { class: 'page-title' }, 'Message activity'),
    el('div', { class: 'activity-wrap' }, [
      legend,
      el('div', { class: 'chart-box' }, chart),
      el('div', { class: 'table-wrap' }, el('table', { class: 'activity-table' }, [
        el('thead', {}, el('tr', {}, ['agent', 'session', 'in', 'out', 'last activity'].map((h) => el('th', {}, h)))),
        el('tbody', {}, sessRows),
      ])),
    ]),
  );
}

// ---- Logs (tail of a log file) ----

function renderLogPage(name) {
  const content = $('content');
  const label = state.logs.find((l) => l.name === name)?.label ?? name;
  const cached = state.logCache.get(name);
  if (!cached) { content.replaceChildren(el('h2', { class: 'page-title' }, label), el('div', { class: 'empty' }, 'Loading…')); return; }
  const view = el('div', { class: 'log-view' });
  for (const line of cached.text.split('\n')) {
    const lvl = /\bERROR\b/i.test(line) ? 'err' : /\bWARN(ING)?\b/i.test(line) ? 'warn' : '';
    view.append(el('div', { class: `log-line ${lvl}` }, line || ' '));
  }
  content.replaceChildren(el('h2', { class: 'page-title' }, label), el('div', { class: 'log-box' }, view));
  // follow the tail — scroll to the newest line
  requestAnimationFrame(() => { const b = content.querySelector('.log-box'); if (b) b.scrollTop = b.scrollHeight; });
}

// ---- Files (doc viewer) ----

function renderDocs() {
  const coll = activeCollection();
  const content = $('content');
  if (!coll) { content.replaceChildren(el('div', { class: 'empty' }, 'No documents.')); return; }
  if (!coll.files.length) { content.replaceChildren(el('div', { class: 'empty' }, `No ${coll.label.toLowerCase()}.`)); return; }
  // display name: drop the group prefix, the `/SKILL.md` tail (show the skill
  // dir), and the .md extension — leaving e.g. "meeting-tagger" or "2026-06-13-…"
  const itemName = (label) => {
    let n = label.includes('/') ? label.split('/').slice(1).join('/').trim() : label;
    return n.replace(/\/SKILL\.md$/, '').replace(/\.md$/, '') || label;
  };
  const newestFirst = coll.name === 'conversations';
  const groups = new Map();
  for (const f of coll.files) { if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); }
  const toggleGroup = (g) => {
    state.openDocGroups.has(g) ? state.openDocGroups.delete(g) : state.openDocGroups.add(g);
    state.renderedSig = null; render();
  };
  const list = el('div', { class: 'doc-list' });
  for (const [group, files] of groups) {
    const open = state.openDocGroups.has(group);
    list.append(el('button', { class: 'doc-group-toggle' + (open ? ' open' : ''), onclick: () => toggleGroup(group) }, [
      el('span', { class: 'chev' }, open ? '▾' : '▸'),
      el('span', { class: 'g-name' }, group || '—'),
      el('span', { class: 'g-count' }, String(files.length)),
    ]));
    if (open) {
      const ordered = newestFirst ? [...files].reverse() : files;
      for (const f of ordered) {
        list.append(el('button', { class: 'doc-item' + (f.path === state.activeDocPath ? ' active' : ''), title: f.path, onclick: () => openDoc(coll.name, f.path) }, itemName(f.label) || f.path));
      }
    }
  }
  const pane = el('div', { class: 'doc-content' });
  const cached = state.activeDocPath ? state.docCache.get(`${coll.name}\0${state.activeDocPath}`) : null;
  if (!state.activeDocPath) pane.append(el('div', { class: 'empty' }, 'Select a document.'));
  else if (!cached) pane.append(el('div', { class: 'empty' }, 'Loading…'));
  else if (cached.lang === 'error') pane.append(el('div', { class: 'tab-error' }, cached.content));
  else if (cached.lang === 'json') {
    let pretty = cached.content;
    try { pretty = JSON.stringify(JSON.parse(cached.content), null, 2); } catch { /* keep raw */ }
    pane.append(el('pre', { class: 'code json' }, pretty));
  } else if (cached.lang === 'markdown') {
    const md = el('div', { class: 'markdown' }); md.innerHTML = mdToHtml(cached.content); pane.append(md);
  } else pane.append(el('pre', { class: 'code' }, cached.content));
  content.replaceChildren(el('h2', { class: 'page-title' }, coll.label), el('div', { class: 'doc-viewer' }, [list, pane]));
}

// ---- resource table ----

function renderTable(cliName, resource) {
  const content = $('content');
  const cli = state.clis.find((c) => c.name === cliName);
  if (!cli) { content.replaceChildren(el('div', { class: 'empty' }, 'No such CLI.')); return; }
  const key = `${cliName}/${resource}`;
  const snapshot = state.snapshots.get(key);
  const error = state.errors.get(key);
  const canDrill = (cli.commands || []).includes('get');
  const parts = [el('h2', { class: 'page-title' }, resource)];
  if (cli.help) parts.push(helpPanel(state.helpCache.get(key)));
  if (error && snapshot) parts.push(el('div', { class: 'stale-note' }, `⚠ live fetch failing — snapshot from ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`));
  if (!snapshot) {
    parts.push(error ? el('div', { class: 'tab-error' }, [`Failed to load ${resource}.`, el('pre', {}, error)]) : el('div', { class: 'empty' }, 'Loading…'));
    content.replaceChildren(...parts); return;
  }
  const rows = snapshot.rows;
  parts.push(summaryBar(resource, rows, cli.summary?.[resource], cli));
  if (rows.length === 0) { parts.push(el('div', { class: 'empty' }, `No ${resource}.`)); content.replaceChildren(...parts); return; }
  const columns = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const ctx = { cliName, enrich: cli.enrich?.[resource], badges: cli.badges };
  const body = rows.map((row) => {
    const id = row.id; const canRow = canDrill && id != null;
    return el('tr', { class: canRow ? 'drillable' : '', ...(canRow ? { onclick: () => openDetail(cliName, resource, String(id)) } : {}) },
      columns.map((c) => buildCell(row[c], c, ctx)));
  });
  parts.push(el('div', { class: 'table-wrap' }, el('table', {}, [
    el('thead', {}, el('tr', {}, columns.map((c) => el('th', {}, c)))),
    el('tbody', {}, body),
  ])));
  content.replaceChildren(...parts);
}

// ---- drill-down detail overlay ----

function renderDetail() {
  const overlay = $('detail');
  if (!state.detail) { overlay.hidden = true; overlay.replaceChildren(); return; }
  overlay.hidden = false;
  const d = state.detail;
  const panel = el('div', { class: 'detail-panel' });
  panel.append(el('div', { class: 'detail-head' }, [
    el('div', {}, [el('span', { class: 'detail-res' }, d.resource), ' ', el('span', { class: 'detail-id' }, d.id)]),
    el('button', { class: 'detail-close', onclick: closeDetail, title: 'Close' }, '✕'),
  ]));
  const sub = el('div', { class: 'detail-body' });
  if (d.loading) sub.append(el('div', { class: 'empty' }, 'Loading…'));
  else if (d.error) sub.append(el('div', { class: 'tab-error' }, d.error));
  else if (d.record) sub.append(el('div', { class: 'kv' }, kvRows(d.record)));
  if (d.config) {
    sub.append(el('div', { class: 'detail-section' }, 'Container config'));
    sub.append(el('div', { class: 'kv' }, kvRows(d.config)));
  }
  panel.append(sub);
  overlay.replaceChildren(panel);
}

// ---------------------------------------------------------------- boot

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? '▶ resume' : '⏸ pause';
  $('pause').classList.toggle('paused', state.paused);
  state.renderedSig = null; render();
});
$('refresh').addEventListener('click', () => { if (!state.refreshing) refresh(true); });
$('hamburger').addEventListener('click', () => { state.sidebarOpen = !state.sidebarOpen; state.renderedSig = null; render(); });
$('scrim').addEventListener('click', () => { state.sidebarOpen = false; state.renderedSig = null; render(); });
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) closeDetail(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.detail) closeDetail(); else if (state.sidebarOpen) { state.sidebarOpen = false; state.renderedSig = null; render(); } } });

async function tick() {
  if (!state.paused) { try { await refresh(); } catch { /* keep snapshots; retry next tick */ } }
  else renderControls();
  setTimeout(tick, state.refreshSeconds * 1000);
}
tick();
