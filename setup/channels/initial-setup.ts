import type { BACK_TO_CHANNEL_SELECTION } from '../lib/back-nav.js';

export type ChannelChoice =
  | 'telegram'
  | 'discord'
  | 'whatsapp'
  | 'signal'
  | 'teams'
  | 'slack'
  | 'mattermost'
  | 'imessage'
  | 'dial'
  | 'other'
  | 'skip';

type InstallableChannel = Exclude<ChannelChoice, 'other' | 'skip'>;
type ChannelRunOptions = { offerBack: true; wireIfResolved?: true };
type ChannelRunner = (
  channel: string,
  displayName: string,
  options: ChannelRunOptions,
) => Promise<void | typeof BACK_TO_CHANNEL_SELECTION>;

export function initialChannelOptions(): { value: ChannelChoice; label: string; hint?: string }[] {
  return [
    { value: 'slack', label: 'Yes, connect Slack', hint: 'NEW!! one-click install' },
    {
      value: 'mattermost',
      label: 'Yes, connect Mattermost',
      hint: 'connect your server or get setup guidance',
    },
    { value: 'teams', label: 'Yes, connect Microsoft Teams' },
    { value: 'telegram', label: 'Yes, connect Telegram' },
    { value: 'discord', label: 'Yes, connect Discord' },
    { value: 'whatsapp', label: 'Yes, connect WhatsApp', hint: 'best with a dedicated number' },
    {
      value: 'dial',
      label: 'Yes, connect Dial',
      hint: 'a dedicated phone number for your agent — place calls, SMS — worldwide',
    },
    { value: 'signal', label: 'Yes, connect Signal', hint: 'needs signal-cli installed' },
    {
      value: 'imessage',
      label: 'Yes, connect iMessage',
      hint: 'local Mac or hosted iMessage (via photon.codes)',
    },
    { value: 'other', label: 'Other…', hint: 'install via /add-<name> after setup' },
    { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
  ];
}

/**
 * Public channel names a typed "Other" answer may report: the channel skills
 * this repo ships plus common platforms people ask for. A fixed list, not a
 * skill lookup, so a private `add-<name>` skill never names itself.
 */
const KNOWN_OTHER_CHANNELS: ReadonlySet<string> = new Set([
  // shipped as .claude/skills/add-<name>
  'deltachat',
  'dial',
  'discord',
  'emacs',
  'gchat',
  'github',
  'imessage',
  'linear',
  'matrix',
  'mattermost',
  'resend',
  'signal',
  'slack',
  'teams',
  'telegram',
  'webex',
  'wechat',
  'whatsapp',
  'whatsapp-cloud',
  // asked for, not shipped
  'email',
  'irc',
  'line',
  'messenger',
  'rocketchat',
  'sms',
  'viber',
  'xmpp',
  'zulip',
]);

/** Diagnostics value for a typed "Other" channel; free text never leaves the machine. */
export function otherChannelDiagnostic(name: string): string {
  return KNOWN_OTHER_CHANNELS.has(name) ? name : 'unknown';
}

export function runInitialChannel(
  choice: InstallableChannel,
  displayName: string,
  runner: ChannelRunner,
): Promise<void | typeof BACK_TO_CHANNEL_SELECTION> {
  const options: ChannelRunOptions =
    choice === 'teams' ? { wireIfResolved: true, offerBack: true } : { offerBack: true };
  return runner(choice, displayName, options);
}

export function channelDmLabel(choice: ChannelChoice): string | null {
  switch (choice) {
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord DMs';
    case 'whatsapp':
      return 'WhatsApp';
    case 'signal':
      return 'Signal';
    case 'teams':
      return 'Teams';
    case 'imessage':
      return 'iMessage';
    case 'slack':
      return 'Slack DMs';
    case 'mattermost':
      return 'Mattermost DMs';
    case 'dial':
      return 'phone';
    default:
      return null;
  }
}
