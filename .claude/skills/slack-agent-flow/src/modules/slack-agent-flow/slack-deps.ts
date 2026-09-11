/**
 * Optional-module seam — the ONLY file in the slack-agent-flow payload that
 * touches the skill-installed Slack channel module (src/channels/slack.ts
 * arrives via the add-slack skill) dynamically. The computed-specifier import
 * keeps tsc from resolving a file that may not be in the tree, so a missing
 * or outdated channel payload surfaces at runtime as a typed, actionable
 * SlackFlowError instead of a crash. The hot-start entry
 * (startChannelAdapter) is trunk registry API and is imported statically like
 * registerChannelAdapter.
 */
import type { ChannelAdapter, ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter, startChannelAdapter } from '../../channels/channel-registry.js';
import { SlackFlowError } from './types.js';

export interface SlackChannelDeps {
  slackInstanceBridgeFactory: (name: string) => ChannelAdapter | null;
  SLACK_DEFAULTS: ChannelDefaults;
  registerChannelAdapter: (
    name: string,
    registration: { factory: () => ChannelAdapter | null; defaults?: ChannelDefaults },
  ) => void;
  startChannelAdapter: (key: string) => Promise<'started' | 'already-active' | 'no-credentials'>;
}

const NOT_INSTALLED =
  'Slack channel payload not installed or too old — apply add-slack first (multi-instance registration ships with the adapter)';

/**
 * Fails fast if the installed Slack adapter doesn't carry the multi-instance
 * factory — checked regardless of hotStart. The adapter owns SLACK_INSTANCES
 * natively (slackInstanceBridgeFactory + the import-time registration loop
 * live in slack.ts); an older installed copy without that export would let
 * S6-S8 wire DB rows to an instance name the runtime could never start, even
 * after a restart. The out-of-process finish path (hotStart: false) needs
 * this check just as much as the hot-add branch below.
 */
export async function assertSlackInstancesModuleInstalled(): Promise<void> {
  try {
    const slackSpec = '../../channels/slack.js';
    const slackMod = (await import(slackSpec)) as Record<string, unknown>;
    if (typeof slackMod.slackInstanceBridgeFactory !== 'function' || !slackMod.SLACK_DEFAULTS) {
      throw new Error('missing exports');
    }
  } catch {
    throw new SlackFlowError('adapter-start', NOT_INSTALLED);
  }
}

export async function loadSlackChannelDeps(): Promise<SlackChannelDeps> {
  let slackMod: Record<string, unknown>;
  try {
    const slackSpec = '../../channels/slack.js';
    slackMod = (await import(slackSpec)) as Record<string, unknown>;
  } catch {
    throw new SlackFlowError('adapter-start', NOT_INSTALLED);
  }

  const slackInstanceBridgeFactory = slackMod.slackInstanceBridgeFactory;
  const SLACK_DEFAULTS = slackMod.SLACK_DEFAULTS;
  if (typeof slackInstanceBridgeFactory !== 'function' || !SLACK_DEFAULTS) {
    throw new SlackFlowError('adapter-start', NOT_INSTALLED);
  }

  return {
    slackInstanceBridgeFactory: slackInstanceBridgeFactory as (name: string) => ChannelAdapter | null,
    SLACK_DEFAULTS: SLACK_DEFAULTS as ChannelDefaults,
    registerChannelAdapter,
    startChannelAdapter,
  };
}
