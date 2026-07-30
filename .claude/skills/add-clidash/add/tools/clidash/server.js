// clidash — CLI-agnostic read-only web dashboard.
// Node built-ins only. All per-CLI knowledge lives in clidash.config.json;
// the only per-CLI code is optional view plugins (views/) and discovery
// parsers (parsers.js).
//
// Security model: the server can only exec the configured argv templates.
// `{resource}` is the sole substitution and is validated against the
// discovered/static resource set before exec. execFile, never a shell.

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoveryParsers, parseOutput, unwrapPath } from './parsers.js';
import { globFiles, describeFile, resolveDoc } from './docs.js';
import { collectActivity } from './activity.js';
import { tailFile } from './logs.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_DOC_BYTES = 2 * 1024 * 1024; // cap a single served document at 2 MB

const DEFAULTS = {
  bind: '127.0.0.1',
  port: 4690,
  refreshSeconds: 60,
  execTimeoutMs: 10_000,
  discoveryTtlMs: 60_000,
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function createApp(userConfig) {
  const config = { ...DEFAULTS, ...userConfig };
  const publicDir = resolve(config.publicDir ?? join(MODULE_DIR, 'public'));
  const viewsDir = resolve(config.viewsDir ?? join(MODULE_DIR, 'views'));

  // Human-readable form of a command, for display in the UI ("the command run").
  const displayCmd = (bin, args) => `${basename(bin)} ${args.join(' ')}`;

  // ---- exec --------------------------------------------------------------

  function execCli(cliCfg, args, label) {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(cliCfg.bin, args, {
        cwd: cliCfg.cwd,
        timeout: config.execTimeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...cliCfg.env },
      }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed || error.signal === 'SIGTERM';
          const detail = stderr.trim() || error.message;
          const msg = timedOut
            ? `${label} timed out after ${config.execTimeoutMs}ms`
            : `${label} failed: ${detail}`;
          rejectPromise(new Error(msg));
          return;
        }
        resolvePromise(stdout);
      });
    });
  }

  // ---- resource discovery (cached, coalesced, keeps last good) -----------

  const discoveryCache = new Map(); // cli -> { at, resources }
  const discoveryInflight = new Map(); // cli -> Promise

  async function discoverResources(cliName) {
    const cliCfg = config.clis[cliName];
    if (cliCfg.resources) {
      return cliCfg.resources.map((name) =>
        typeof name === 'string' ? { name, description: '' } : name,
      );
    }
    const cached = discoveryCache.get(cliName);
    if (cached && Date.now() - cached.at < config.discoveryTtlMs) return cached.resources;
    if (discoveryInflight.has(cliName)) return discoveryInflight.get(cliName);

    const parser = discoveryParsers[cliCfg.discover.parser];
    if (!parser) throw new Error(`Unknown discovery parser: ${cliCfg.discover.parser}`);
    const promise = execCli(cliCfg, cliCfg.discover.args, `${cliName} discovery`)
      .then((stdout) => {
        const resources = parser(stdout);
        discoveryCache.set(cliName, { at: Date.now(), resources });
        return resources;
      })
      .finally(() => discoveryInflight.delete(cliName));
    discoveryInflight.set(cliName, promise);
    return promise;
  }

  // ---- row fetching (coalesced per cli+resource) --------------------------

  const listInflight = new Map(); // "cli\0resource" -> Promise

  async function fetchRows(cliName, resourceName) {
    const cliCfg = config.clis[cliName];
    const resources = await discoverResources(cliName);
    if (!resources.some((r) => r.name === resourceName)) {
      const err = new Error(`Unknown resource "${resourceName}" for CLI "${cliName}"`);
      err.statusCode = 404;
      throw err;
    }
    const key = `${cliName}\0${resourceName}`;
    if (listInflight.has(key)) return listInflight.get(key);

    // {resource} may appear as a whole arg or inside one (e.g. an ssh remote
    // command). Safe either way — the value is allowlist-validated above.
    const args = cliCfg.list.map((a) => a.replaceAll('{resource}', resourceName));
    const promise = execCli(cliCfg, args, `${cliName} ${resourceName} list`)
      .then((stdout) => {
        const parsed = parseOutput(stdout, cliCfg.output ?? 'json');
        const rows = unwrapPath(parsed, cliCfg.unwrap);
        if (!Array.isArray(rows)) {
          const err = new Error(`${cliName} ${resourceName}: expected an array of rows`);
          err.raw = stdout;
          throw err;
        }
        return rows;
      })
      .finally(() => listInflight.delete(key));
    listInflight.set(key, promise);
    return promise;
  }

  // ---- detail commands (drill-down: get, config-get, …) -------------------

  const cmdInflight = new Map();
  const ID_RE = /^[A-Za-z0-9:_.-]+$/; // ncl ids / uuids; no shell metas (and execFile never shells)

  async function runCommand(cliName, cmdName, resourceName, id) {
    const cliCfg = config.clis[cliName];
    const template = cliCfg.commands?.[cmdName];
    if (!template) {
      const err = new Error(`Unknown command "${cmdName}"`);
      err.statusCode = 404;
      throw err;
    }
    const needsResource = template.includes('{resource}');
    if (needsResource) {
      const resources = await discoverResources(cliName);
      if (!resources.some((r) => r.name === resourceName)) {
        const err = new Error(`Unknown resource "${resourceName}"`);
        err.statusCode = 404;
        throw err;
      }
    }
    if (template.includes('{id}') && !ID_RE.test(id ?? '')) {
      const err = new Error('Invalid id');
      err.statusCode = 400;
      throw err;
    }
    const key = `${cliName}\0${cmdName}\0${resourceName}\0${id}`;
    if (cmdInflight.has(key)) return cmdInflight.get(key);
    const args = template.map((a) => a.replaceAll('{resource}', resourceName ?? '').replaceAll('{id}', id ?? ''));
    const promise = execCli(cliCfg, args, `${cliName} ${cmdName}`)
      .then((stdout) => unwrapPath(parseOutput(stdout, cliCfg.output ?? 'json'), cliCfg.unwrap))
      .finally(() => cmdInflight.delete(key));
    cmdInflight.set(key, promise);
    return promise;
  }

  // ---- per-resource help (raw text from `<cli> <resource> help`) -----------

  const helpInflight = new Map();
  async function runHelp(cliName, resourceName) {
    const cliCfg = config.clis[cliName];
    if (!cliCfg.help) { const e = new Error(`No help for "${cliName}"`); e.statusCode = 404; throw e; }
    const resources = await discoverResources(cliName);
    if (!resources.some((r) => r.name === resourceName)) {
      const e = new Error(`Unknown resource "${resourceName}"`); e.statusCode = 404; throw e;
    }
    const key = `${cliName}\0${resourceName}`;
    if (helpInflight.has(key)) return helpInflight.get(key);
    const args = cliCfg.help.map((a) => a.replaceAll('{resource}', resourceName));
    const promise = execCli(cliCfg, args, `${cliName} ${resourceName} help`).finally(() => helpInflight.delete(key));
    helpInflight.set(key, promise);
    return promise;
  }

  // ---- view plugins --------------------------------------------------------

  async function listViews(cliName) {
    try {
      const files = await readdir(viewsDir);
      return files
        .filter((f) => f.startsWith(`${cliName}-`) && f.endsWith('.js'))
        .map((f) => f.slice(cliName.length + 1, -3));
    } catch {
      return [];
    }
  }

  async function runView(cliName, viewName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(viewName)) {
      const err = new Error(`Invalid view name`);
      err.statusCode = 404;
      throw err;
    }
    const file = join(viewsDir, `${cliName}-${viewName}.js`);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') {
        const err = new Error(`No view "${viewName}" for CLI "${cliName}"`);
        err.statusCode = 404;
        throw err;
      }
      throw e;
    }
    return mod.default({ fetch: (resource) => fetchRows(cliName, resource) });
  }

  // ---- http ----------------------------------------------------------------

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  function sendError(res, err) {
    const status = err.statusCode ?? 502;
    const body = { ok: false, error: err.message };
    if (err.raw !== undefined) body.raw = String(err.raw).slice(0, 64 * 1024);
    sendJson(res, status, body);
  }

  async function serveStatic(res, urlPath) {
    const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
    const file = resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(publicDir + sep)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }
    try {
      const content = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      // always revalidate so a redeploy is picked up immediately (no stale JS/CSS)
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(content);
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not found' });
    }
  }

  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'Read-only dashboard: GET only' });
        return;
      }
      const urlPath = req.url.split('?')[0];
      const segments = urlPath.split('/').map((s) => decodeURIComponent(s));

      if (urlPath === '/api/clis') {
        const clis = await Promise.all(Object.keys(config.clis).map(async (name) => {
          const entry = {
            name,
            refreshSeconds: config.refreshSeconds,
            views: await listViews(name),
            commands: Object.keys(config.clis[name].commands ?? {}),
            enrich: config.clis[name].enrich ?? null,
            badges: config.clis[name].badges ?? null,
            summary: config.clis[name].summary ?? null,
            help: !!config.clis[name].help,
          };
          try {
            entry.resources = await discoverResources(name);
          } catch (e) {
            // keep last good discovery (≤TTL old) if we have one; always surface the error
            entry.resources = discoveryCache.get(name)?.resources ?? [];
            entry.error = e.message;
          }
          return entry;
        }));
        sendJson(res, 200, { clis });
        return;
      }

      if (segments[1] === 'api' && segments[2] === 'r' && segments.length === 5) {
        const [, , , cliName, resourceName] = segments;
        if (!config.clis[cliName]) {
          sendJson(res, 404, { ok: false, error: `Unknown CLI "${cliName}"` });
          return;
        }
        const rows = await fetchRows(cliName, resourceName);
        const cliCfg = config.clis[cliName];
        const command = displayCmd(cliCfg.bin, cliCfg.list.map((a) => a.replaceAll('{resource}', resourceName)));
        sendJson(res, 200, { ok: true, rows, command, fetchedAt: new Date().toISOString() });
        return;
      }

      if (segments[1] === 'api' && segments[2] === 'cmd' && segments.length === 5) {
        const [, , , cliName, cmdName] = segments;
        if (!config.clis[cliName]) {
          sendJson(res, 404, { ok: false, error: `Unknown CLI "${cliName}"` });
          return;
        }
        const q = new URL(req.url, 'http://localhost').searchParams;
        const data = await runCommand(cliName, cmdName, q.get('resource'), q.get('id'));
        const tmpl = config.clis[cliName].commands?.[cmdName] ?? [];
        const command = displayCmd(config.clis[cliName].bin,
          tmpl.map((a) => a.replaceAll('{resource}', q.get('resource') ?? '').replaceAll('{id}', q.get('id') ?? '')));
        sendJson(res, 200, { ok: true, data, command, fetchedAt: new Date().toISOString() });
        return;
      }

      if (segments[1] === 'api' && segments[2] === 'help' && segments.length === 5) {
        const [, , , cliName, resourceName] = segments;
        if (!config.clis[cliName]) {
          sendJson(res, 404, { ok: false, error: `Unknown CLI "${cliName}"` });
          return;
        }
        const text = await runHelp(cliName, resourceName);
        sendJson(res, 200, { ok: true, text });
        return;
      }

      if (segments[1] === 'api' && segments[2] === 'view' && segments.length === 5) {
        const [, , , cliName, viewName] = segments;
        if (!config.clis[cliName]) {
          sendJson(res, 404, { ok: false, error: `Unknown CLI "${cliName}"` });
          return;
        }
        const result = await runView(cliName, viewName);
        sendJson(res, 200, { ok: true, result, fetchedAt: new Date().toISOString() });
        return;
      }

      // Log tails (allowlisted files under logs.dir).
      if (urlPath === '/api/logs') {
        sendJson(res, 200, { files: (config.logs?.files ?? []).map((f) => ({ name: f.name, label: f.label ?? f.name })) });
        return;
      }
      if (segments[1] === 'api' && segments[2] === 'log' && segments.length === 4) {
        const name = segments[3];
        const file = config.logs?.files?.find((f) => f.name === name);
        if (!file) { sendJson(res, 404, { ok: false, error: `Unknown log "${name}"` }); return; }
        const lines = config.logs.tailLines ?? 400;
        const { text } = await tailFile(join(config.logs.dir, name), lines);
        sendJson(res, 200, { ok: true, text, command: `tail -n ${lines} ${join(config.logs.dir, name)}`, fetchedAt: new Date().toISOString() });
        return;
      }

      // Message activity (read per-session DBs; ncl has no messages resource).
      if (urlPath === '/api/activity') {
        if (!config.activity) { sendJson(res, 200, { ok: true, configured: false }); return; }
        const days = config.activity.days ?? 14;
        const { sessions, series } = collectActivity(config.activity.sessionsRoot, days, new Date());
        const command = `node:sqlite · ${config.activity.sessionsRoot}/*/*/{inbound,outbound}.db (last ${days}d)`;
        sendJson(res, 200, { ok: true, configured: true, sessions, series, command, fetchedAt: new Date().toISOString() });
        return;
      }

      // Read-only file viewer (skills, CLAUDE.md, profiles, conversations).
      if (urlPath === '/api/docs') {
        const docs = config.docs;
        const collections = (docs?.collections ?? []).map((coll) => ({
          name: coll.name,
          label: coll.label ?? coll.name,
          lang: coll.lang ?? 'text',
          files: globFiles(docs.root, coll.patterns, docs.deny ?? []).map((path) => ({
            path,
            ...describeFile(path),
          })),
        }));
        sendJson(res, 200, { collections });
        return;
      }

      if (urlPath === '/api/doc') {
        const docs = config.docs;
        const query = new URL(req.url, 'http://localhost').searchParams;
        const collName = query.get('c');
        const relPath = query.get('p') ?? '';
        const collection = docs?.collections?.find((c) => c.name === collName);
        if (!collection) {
          sendJson(res, 404, { ok: false, error: `Unknown collection "${collName}"` });
          return;
        }
        let abs;
        try {
          abs = resolveDoc(docs.root, collection, relPath, docs.deny ?? []);
        } catch {
          sendJson(res, 404, { ok: false, error: 'Not found' });
          return;
        }
        const content = await readFile(abs, 'utf8');
        sendJson(res, 200, {
          ok: true,
          path: relPath,
          lang: collection.lang ?? 'text',
          content: content.length > MAX_DOC_BYTES ? content.slice(0, MAX_DOC_BYTES) : content,
        });
        return;
      }

      if (urlPath.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, error: 'Not found' });
        return;
      }

      await serveStatic(res, urlPath);
    } catch (err) {
      sendError(res, err);
    }
  });
}

// ---- standalone entry point ------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const configPath = process.env.CLIDASH_CONFIG ?? join(MODULE_DIR, 'clidash.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (process.env.PORT) config.port = Number(process.env.PORT);
  if (process.env.BIND) config.bind = process.env.BIND;
  const finalConfig = { ...DEFAULTS, ...config };
  const server = createApp(finalConfig);
  server.listen(finalConfig.port, finalConfig.bind, () => {
    console.log(`clidash listening on http://${finalConfig.bind}:${finalConfig.port}`);
  });
}
