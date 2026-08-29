/**
 * scripts/setup-private-plugins.ts — one-time-per-host: register a
 * GitHub PAT in the OneCLI vault with the host pattern + auth format
 * required for git smart-HTTP clones (NOT the same format as github
 * REST API access — github's git protocol only accepts HTTP Basic).
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-private-plugins.ts [--token <pat>]
 *
 * Without --token, attempts to read the token from `gh auth token`
 * (the user's existing github CLI auth, if installed).
 *
 * This adds an entry that:
 *   - hostPattern: github.com  (separate from any existing api.github.com entry)
 *   - headerName:  Authorization
 *   - valueFormat: Basic {value}
 *   - value:       base64("x-access-token:<PAT>")
 *
 * After this, agent containers running under OneCLI gateway can clone
 * private github repos via the SDK's plugin install path. Verified
 * empirically; see docs/internal/plugin-install-empirical-test.md (in
 * fork-internal docs).
 *
 * Idempotent: if a github.com Authorization-Basic secret is already
 * registered, prompts whether to overwrite (or skip when --force not
 * passed).
 */
import { execFileSync, spawnSync } from 'child_process';

import { findGithubGitSecret } from './lib/onecli-vault-helpers.js';

interface Args {
  token?: string;
  force: boolean;
  name: string;
}

function parseArgs(): Args {
  const args: Args = { force: false, name: 'GitHub Git Clone' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--token' && i + 1 < argv.length) {
      args.token = argv[++i];
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--name' && i + 1 < argv.length) {
      args.name = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/setup-private-plugins.ts [--token <pat>] [--name <secret-name>] [--force]',
      );
      process.exit(0);
    }
  }
  return args;
}

function getGhToken(): string | null {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t = out.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function main(): void {
  const args = parseArgs();

  // Check for existing github.com git secret. Idempotency.
  const existing = findGithubGitSecret();
  if (existing && !args.force) {
    console.log(
      `A OneCLI vault entry for github.com with Basic auth is already registered: ${existing.name} (${existing.id}).`,
    );
    console.log('Re-run with --force to overwrite.');
    process.exit(0);
  }

  // Resolve token.
  let token = args.token;
  if (!token) {
    token = getGhToken() ?? undefined;
    if (!token) {
      console.error(
        'No --token provided and `gh auth token` did not return a token. ' +
          'Either install/authenticate the github CLI (https://cli.github.com) ' +
          'or pass --token <pat> explicitly. The PAT needs `repo` scope for private clones.',
      );
      process.exit(1);
    }
  }

  // Encode as base64(x-access-token:<token>) per github's git
  // smart-HTTP HTTP Basic format.
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');

  // Hand off to onecli secrets create. Don't echo the token; pass via
  // argv (still ends up in process listings briefly, but onecli's CLI
  // doesn't expose a stdin path).
  const oneCliArgs = [
    'secrets',
    'create',
    '--name',
    args.name,
    '--type',
    'generic',
    '--value',
    encoded,
    '--host-pattern',
    'github.com',
    '--header-name',
    'Authorization',
    '--value-format',
    'Basic {value}',
  ];

  const result = spawnSync('onecli', oneCliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? '';
    console.error('Failed to create OneCLI secret:');
    console.error(stderr);
    process.exit(1);
  }

  console.log(`Registered "${args.name}" in OneCLI vault for host github.com.`);
  console.log('Private github plugin clones will work in any agent container running under OneCLI.');
  console.log('No restart required — the gateway picks up new secrets at request time.');
}

main();
