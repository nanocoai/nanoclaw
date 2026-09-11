import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const PING_PATH = '/api/v4/system/ping';

function normalize(value) {
  try {
    const url = new URL(value?.trim() || '');
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (!/^\/(?:[A-Za-z0-9._~%+-]+\/)*[A-Za-z0-9._~%+-]*$/.test(url.pathname)) return '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

async function configuredUrl() {
  if (process.env.MATTERMOST_BASE_URL) return normalize(process.env.MATTERMOST_BASE_URL);
  try {
    const text = await readFile('.env', 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*MATTERMOST_BASE_URL\s*=\s*(.*?)\s*$/);
      if (match?.[1]) return normalize(match[1].replace(/^(['"])(.*)\1$/, '$2'));
    }
  } catch {
    // Any .env read failure means no configured URL; discovery must still
    // resolve so the operator fallback prompt is offered.
  }
  return '';
}

async function isMattermost(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}${PING_PATH}`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === 'OK';
  } catch {
    return false;
  }
}

function commandWorks(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function localConfigAccess(baseUrl) {
  let hostname = '';
  let port = '';
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname;
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  } catch {
    return { config_access: 'unavailable', mattermost_container: 'none' };
  }
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    // A canonical DNS name does not prove that an arbitrary host socket or
    // container belongs to this server. Prefer manual authenticated guidance
    // over risking a configuration change against the wrong local instance.
    return { config_access: 'unavailable', mattermost_container: 'none' };
  }

  if (commandWorks('mmctl', ['config', 'get', 'ServiceSettings.SiteURL', '--local'])) {
    return { config_access: 'host', mattermost_container: 'none' };
  }

  try {
    const names = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    for (const row of names.split(/\r?\n/)) {
      const [name, image = '', ports = ''] = row.split('\t');
      if (!name || !/mattermost/i.test(`${name} ${image}`)) continue;
      if (!ports.split(',').some((mapping) => mapping.includes(`:${port}->`))) continue;
      if (commandWorks('docker', ['exec', name, 'mmctl', 'config', 'get', 'ServiceSettings.SiteURL', '--local'])) {
        return { config_access: 'docker', mattermost_container: name };
      }
    }
  } catch {
    // Docker is optional. Lack of access is handled by operator guidance.
  }

  return { config_access: 'unavailable', mattermost_container: 'none' };
}

try {
  const candidates = [...new Set([await configuredUrl(), 'http://localhost:8065', 'http://127.0.0.1:8065'])].filter(
    Boolean,
  );

  for (const baseUrl of candidates) {
    if (await isMattermost(baseUrl)) {
      process.stdout.write(
        `${JSON.stringify({ discovery: 'found', base_url: baseUrl, ...localConfigAccess(baseUrl) })}\n`,
      );
      process.exit(0);
    }
  }
} catch {
  // Fall through to the not-found result below.
}

process.stdout.write(
  `${JSON.stringify({ discovery: 'none', base_url: 'none', config_access: 'unavailable', mattermost_container: 'none' })}\n`,
);
