/**
 * scripts/lib/onecli-vault-helpers.ts — minimal OneCLI vault
 * introspection used by `/install-plugin --source` (private-repo
 * pre-check) and `/setup-private-plugins` (idempotency).
 *
 * The vault never returns secret values to the host (by design; values
 * only leave the gateway via header injection at request time). We
 * only read METADATA: name, hostPattern, headerName, valueFormat.
 */
import { execFileSync } from 'child_process';

export interface OneCliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
  pathPattern: string | null;
  injectionConfig?: {
    headerName?: string;
    valueFormat?: string;
    paramName?: string;
    paramFormat?: string;
  };
}

/**
 * List all OneCLI vault secrets visible to the current OneCLI agent.
 * Returns an empty array if onecli isn't installed or the gateway isn't
 * reachable — callers should treat absence-of-secret as
 * not-yet-configured, not as a hard error.
 */
export function listOneCliSecrets(): OneCliSecret[] {
  let stdout: string;
  try {
    stdout = execFileSync('onecli', ['secrets', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(stdout);
    const data = parsed?.data;
    if (!Array.isArray(data)) return [];
    return data.filter((s) => s && typeof s === 'object') as OneCliSecret[];
  } catch {
    return [];
  }
}

/**
 * Return the first secret whose `hostPattern` matches the given host.
 * Pattern is matched as a regex if it contains regex metacharacters,
 * otherwise as an exact-equals check. (OneCLI itself accepts either
 * form per gateway docs; we only care here about identifying when a
 * secret is wired.)
 *
 * Returns `null` if no matching secret exists.
 */
export function findSecretForHost(host: string, secrets?: OneCliSecret[]): OneCliSecret | null {
  const list = secrets ?? listOneCliSecrets();
  for (const s of list) {
    if (!s.hostPattern) continue;
    if (matchesHost(s.hostPattern, host)) return s;
  }
  return null;
}

function matchesHost(pattern: string, host: string): boolean {
  // Exact match first (most common case).
  if (pattern === host) return true;
  // Treat as regex if it has anchor or class metacharacters.
  if (/[$^*+?()[\]{}|\\]/.test(pattern)) {
    try {
      return new RegExp(pattern).test(host);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if a github.com secret is configured for git smart-HTTP auth
 * (the format `/setup-private-plugins` writes). Used by
 * `/install-plugin --source` to decide whether private-github clones
 * will likely succeed before warning the operator.
 *
 * Returns the matching secret if present, else null.
 */
export function findGithubGitSecret(secrets?: OneCliSecret[]): OneCliSecret | null {
  const list = secrets ?? listOneCliSecrets();
  for (const s of list) {
    if (!s.hostPattern) continue;
    // We're looking for a github.com (NOT api.github.com) entry with
    // Authorization: Basic format — that's what /setup-private-plugins
    // installs, and what github's git smart-HTTP requires.
    if (!matchesHost(s.hostPattern, 'github.com')) continue;
    const cfg = s.injectionConfig;
    if (cfg?.headerName?.toLowerCase() === 'authorization' && cfg.valueFormat?.startsWith('Basic ')) {
      return s;
    }
  }
  return null;
}
