/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a chat-sdk-side prefix: "telegram:123456", "discord:guild:chan".
 * That prefix comes from the underlying chat-sdk adapter's name and is NOT
 * necessarily the same as NanoClaw's channel registry key — if one chat-sdk
 * adapter is registered under multiple channel keys (e.g. two Telegram bots
 * on keys `telegram` and `telegram-2`), the underlying SDK still emits
 * `telegram:<id>` for both. So any `<prefix>:<id>`-shaped value is trusted
 * as-is; only bare ids get the channel prefix appended.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  if (/^[a-z][a-z0-9_-]*:/i.test(raw)) return raw;
  return `${channel}:${raw}`;
}
