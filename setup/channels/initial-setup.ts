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
      hint: 'use your server or create an evaluation server',
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
