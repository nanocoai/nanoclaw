import { execFileSync } from 'node:child_process';

export const CONTRIB_DIR = '.nanoclaw-contrib';

export const DEFAULTS = {
  upstreamRef: 'upstream/main',
  ledger: `${CONTRIB_DIR}/ledger.md`,
  status: `${CONTRIB_DIR}/status.md`,
  denylist: `${CONTRIB_DIR}/scrub-denylist.txt`,
  divergences: `${CONTRIB_DIR}/divergences.md`,
} as const;

export function flagValue(argv: readonly string[], name: string, fallback: string): string {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
}

export function flagValues(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]] : []));
}

export function resolveForkOwner(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const explicit = flagValue(argv, '--owner', env.CONTRIB_FORK_OWNER ?? '');
  if (explicit) {
    return explicit;
  }
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}
