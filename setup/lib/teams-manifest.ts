/**
 * Build the Teams app package zip that the operator sideloads from the Teams
 * "Manage your apps" screen.
 *
 * A Teams app package is a zip containing:
 *   - manifest.json  — declares the bot, scopes, required permissions
 *   - outline.png    — 32×32 transparent outline icon
 *   - color.png      — 192×192 full-color icon
 *
 * The static parts live in setup/assets/teams/ — manifest.template.json
 * (pinned to schema v1.16 to match the skill doc) plus the two icons — so
 * the manifest is reviewable as plain JSON. This module only fills in the
 * per-install fields (app id, name, domain, optional RSC block) and zips the
 * three files in-process via ./zip.ts, so no `zip` binary is needed on the
 * host.
 */
import fs from 'fs';
import path from 'path';

import { buildZip } from './zip.js';

const ASSETS_DIR = new URL('../assets/teams/', import.meta.url);

export interface ManifestOptions {
  /** The Azure AD app ID (same value used for `bots[0].botId`). */
  appId: string;
  /** Short bot name shown in Teams (<= 30 chars). */
  shortName: string;
  /** Long bot description. */
  longDescription: string;
  /** Developer website URL (required by schema — any reachable URL works). */
  websiteUrl: string;
  /** Out-dir for the generated zip + loose files. */
  outDir: string;
  /**
   * Include RSC permissions (ChannelMessage.Read.Group, ChatMessage.Read.Chat)
   * so the bot receives all channel/group-chat messages without @-mention.
   */
  rsc?: boolean;
}

export interface ManifestResult {
  zipPath: string;
  manifestPath: string;
  outlinePath: string;
  colorPath: string;
}

/** The manifest.template.json fields this module rewrites per install. */
interface ManifestTemplate {
  version: string;
  id: string;
  developer: { name: string; websiteUrl: string; privacyUrl: string; termsOfUseUrl: string };
  name: { short: string; full: string };
  description: { short: string; full: string };
  bots: [{ botId: string }];
  validDomains: string[];
  webApplicationInfo?: { id: string; resource: string };
  authorization?: { permissions: { resourceSpecific: Array<{ name: string; type: string }> } };
}

/** Build the full app package zip and return the paths. */
export function buildTeamsAppPackage(opts: ManifestOptions): ManifestResult {
  fs.mkdirSync(opts.outDir, { recursive: true });

  const manifestPath = path.join(opts.outDir, 'manifest.json');
  const outlinePath = path.join(opts.outDir, 'outline.png');
  const colorPath = path.join(opts.outDir, 'color.png');
  const zipPath = path.join(opts.outDir, 'teams-app-package.zip');

  const manifest = Buffer.from(renderManifest(opts));
  const outline = fs.readFileSync(new URL('outline.png', ASSETS_DIR));
  const color = fs.readFileSync(new URL('color.png', ASSETS_DIR));

  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(outlinePath, outline);
  fs.writeFileSync(colorPath, color);
  fs.writeFileSync(
    zipPath,
    buildZip([
      { name: 'manifest.json', data: manifest },
      { name: 'outline.png', data: outline },
      { name: 'color.png', data: color },
    ]),
  );

  return { zipPath, manifestPath, outlinePath, colorPath };
}

function renderManifest(opts: ManifestOptions): string {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('manifest.template.json', ASSETS_DIR), 'utf8'),
  ) as ManifestTemplate;

  manifest.id = opts.appId;
  manifest.bots[0].botId = opts.appId;
  manifest.name.short = opts.shortName.slice(0, 30);
  manifest.name.full = `${opts.shortName} Assistant`;
  manifest.description.full = opts.longDescription;
  manifest.developer.websiteUrl = opts.websiteUrl;
  manifest.developer.privacyUrl = opts.websiteUrl;
  manifest.developer.termsOfUseUrl = opts.websiteUrl;
  manifest.validDomains = [new URL(opts.websiteUrl).host];

  if (opts.rsc) {
    // Teams app-update flows want a higher version than the already-uploaded
    // package, so the RSC variant (typically a re-upload) bumps it.
    manifest.version = '1.1.0';
    // RSC grants bind to webApplicationInfo.id, not bots[].botId — without
    // this block the permissions are never attached to the app and the bot
    // silently keeps requiring @-mention. `resource` must be non-empty but
    // its value is unused for RSC-only apps.
    manifest.webApplicationInfo = { id: opts.appId, resource: 'https://notapplicable' };
    manifest.authorization = {
      permissions: {
        resourceSpecific: [
          { name: 'ChannelMessage.Read.Group', type: 'Application' },
          { name: 'ChatMessage.Read.Chat', type: 'Application' },
        ],
      },
    };
  }

  return JSON.stringify(manifest, null, 2) + '\n';
}
