/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * Namespace a raw platform user ID with its channel type to match users(id).
 *
 * Distinct from namespacedPlatformId: user IDs get no '@'/'+' escapes, so
 * WhatsApp JIDs and Signal numbers keep the prefix they are stored with.
 *
 * The prefix test is startsWith(`${channel}:`), not includes(':'): Teams user
 * IDs are natively colon-bearing ("29:1Eiqnrl..."), so an includes(':') test
 * reads them as already-namespaced and leaves them bare — they then never
 * match the stored "teams:29:1Eiqnrl..." and every card click is rejected as
 * an unauthorized clicker.
 */
export function namespacedUserId(channel: string, raw: string): string {
  return raw.startsWith(`${channel}:`) ? raw : `${channel}:${raw}`;
}
