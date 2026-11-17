import fs from 'node:fs';

// Shared by setup (which writes the file) and the host provider (which reads it)
// so both accept exactly the same entries. Keep it free of NanoClaw imports:
// setup loads it from the skill's payload before the provider is installed.

const HOST = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function bareHost(candidate: string): string {
  const host = candidate.trim().toLowerCase();
  return HOST.test(host) ? host : '';
}

function useBare(host: string): string {
  return host ? `use the bare host name "${host}"` : 'use a bare host name such as api.example.com';
}

/** Why an entry cannot be an allowed host, with the fix, or null when it can. */
export function allowedHostProblem(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  if (HOST.test(host)) return null;
  if (!host) return 'the entry is empty; remove it';
  if (host.includes('://')) {
    let hostname = '';
    try {
      hostname = bareHost(new URL(host).hostname);
    } catch {
      // Unparseable URL: fall back to the generic hint.
    }
    return `allowed hosts are host names, not URLs; ${useBare(hostname)}`;
  }
  const slash = host.indexOf('/');
  if (slash >= 0)
    return `allowed hosts cannot contain a path; ${useBare(bareHost(host.slice(0, slash).split(':')[0]))}`;
  const port = /^(.*):\d+$/.exec(host);
  if (port) return `Iron only reaches HTTPS on 443; ${useBare(bareHost(port[1]))}`;
  return 'use a host name such as api.example.com or *.example.com';
}

/** Normalizes an entry the operator is adding, or rejects it with the fix. */
export function validateAllowedHost(raw: string): string {
  const problem = allowedHostProblem(raw);
  if (problem) throw new Error(`Invalid allowed host "${raw}": ${problem}`);
  return raw.trim().toLowerCase();
}

/**
 * Reads the allowed-hosts file. An invalid entry is skipped with one warning
 * naming the file, the entry and the fix: dropping an entry only narrows
 * egress, and the front proxy could never match it anyway. A file that is not
 * a JSON array still fails, because then no entry can be trusted.
 */
export function readAllowedHostsFile(
  file: string,
  warn: (message: string) => void = (message) => console.warn(message),
): string[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Iron Proxy allowed-hosts file must be a JSON array of host names: ${file}`);
  }
  const hosts = new Set<string>();
  for (const entry of value) {
    const problem = typeof entry === 'string' ? allowedHostProblem(entry) : 'entries must be strings';
    if (problem) {
      warn(`Iron Proxy: skipping allowed host ${JSON.stringify(entry)} in ${file}: ${problem}.`);
      continue;
    }
    hosts.add((entry as string).trim().toLowerCase());
  }
  return [...hosts].sort();
}
