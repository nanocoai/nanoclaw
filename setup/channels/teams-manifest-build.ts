/**
 * Tiny CLI wrapper around `buildTeamsAppPackage` so the add-teams SKILL.md can
 * generate the sideload app package with a single declarative step instead of an
 * inline `tsx -e` blob. The whole zip-building logic (manifest + icons, no
 * external image deps) already lives in `setup/lib/teams-manifest.ts`; this just
 * maps a couple of CLI flags onto it and prints the resulting zip path.
 *
 * The short name comes from NANOCLAW_AGENT_NAME (falling back to "NanoClaw"), the
 * description is "<name> personal assistant powered by NanoClaw.", the website
 * URL is the operator's public base URL, and the output lands in data/teams/.
 *
 * `--rsc` adds the resource-specific-consent permissions (receive all channel /
 * group-chat messages without @-mention) and bumps the manifest version so the
 * re-upload supersedes the original package.
 *
 * Usage:
 *   pnpm exec tsx setup/channels/teams-manifest-build.ts \
 *     --app-id <azure-app-id> --url https://your-domain [--out data/teams] [--rsc]
 */
import { buildTeamsAppPackage } from '../lib/teams-manifest.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const appId = flag('app-id');
const url = flag('url');
const outDir = flag('out') ?? 'data/teams';
const rsc = process.argv.includes('--rsc');
const shortName = process.env.NANOCLAW_AGENT_NAME?.trim() || 'NanoClaw';

if (!appId || !url) {
  console.error(
    'usage: teams-manifest-build.ts --app-id <azure-app-id> --url <https-url> [--out <dir>] [--rsc]',
  );
  process.exit(2);
}

const result = buildTeamsAppPackage({
  appId,
  shortName,
  longDescription: `${shortName} personal assistant powered by NanoClaw.`,
  websiteUrl: url,
  outDir,
  rsc,
});

console.log(`Teams app package: ${result.zipPath}`);
