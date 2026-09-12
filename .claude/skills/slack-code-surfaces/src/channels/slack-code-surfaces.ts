/**
 * Slack as a surface for coding sessions — the platform half.
 *
 * Code mode's session-surface core (src/code-mode/surface) decides WHEN a
 * sandbox gets a chat surface; the community-portal module offers one over
 * the service that manages this host's chat app for every platform that
 * registered its half (src/modules/community-portal/surface/platforms.ts).
 * This file is Slack's half, and everything platform-shaped lives here:
 *
 *   - how the Slack adapter spells a channel id as a messaging_groups row
 *     (`slack:C…` on the adapter's instance), so the binding writes the row
 *     the adapter's inbound path resolves. The live adapter is asked when it
 *     is running (its own encoder), else the spelling is built the same way;
 *   - which bot user this host is on the workspace, from one `auth.test` on
 *     the managed app's bot token, cached under data/ (slack-bot-identity.ts).
 *
 * A row the adapter auto-created for the channel before the binding ran
 * (the bot was invited and a message arrived first) is adopted by core, and
 * its registration card retired; nothing here touches the binding table.
 *
 * Registers on import through the module's platform registry — the one
 * barrel line `import './slack-code-surfaces.js';` installs it. Without a
 * managed Slack app and a sign-in the module offers no surface and a
 * sandbox stays plain; this file changes nothing else about the adapter.
 */
import type { SurfaceSpelling } from '../code-mode/surface/types.js';
import {
  registerSurfacePlatform,
  type BotIdentity,
  type ManagedInstall,
  type SurfacePlatform,
} from '../modules/community-portal/surface/index.js';
import type { ChannelAdapter } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import { resolveBotIdentity } from './slack-bot-identity.js';

/** The platform kind and the adapter's channel type — one and the same. */
export const SLACK_SURFACE_KIND = 'slack';

/** The messaging_groups spelling of a Slack conversation id, in the adapter's form. */
export function spellSlackSurface(
  conversationId: string,
  adapter: ChannelAdapter | undefined = getChannelAdapterExact(SLACK_SURFACE_KIND),
): SurfaceSpelling {
  const instance = adapter?.instance ?? SLACK_SURFACE_KIND;
  if (adapter?.conversationPlatformId) {
    try {
      return { platformId: adapter.conversationPlatformId(conversationId), instance };
    } catch {
      // The adapter's decoder refused the id; the plain form below is what
      // the bridge encodes for a channel it accepts, so fall through to it.
    }
  }
  return { platformId: `${SLACK_SURFACE_KIND}:${conversationId}`, instance };
}

/** This host's bot on the workspace, from the managed install's token; null when unknown. */
export function slackSurfaceBotIdentity(install: ManagedInstall, root = process.cwd()): Promise<BotIdentity | null> {
  return resolveBotIdentity({
    root,
    appId: install.appId,
    ...(install.botToken ? { botToken: install.botToken } : {}),
  });
}

export const slackSurfacePlatform: SurfacePlatform = {
  channelType: SLACK_SURFACE_KIND,
  instance: SLACK_SURFACE_KIND,
  spell: (conversationId) => spellSlackSurface(conversationId),
  botIdentity: (install) => slackSurfaceBotIdentity(install),
};

registerSurfacePlatform(SLACK_SURFACE_KIND, slackSurfacePlatform);
