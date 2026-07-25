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
 * Normalize a WhatsApp sender handle to bare phone digits.
 *
 * The Baileys (native) adapter emits the full JID as the sender —
 * e.g. `15551234567@s.whatsapp.net` or `15551234567:12@s.whatsapp.net`
 * (the `:N` suffix is the device index). The WhatsApp Business Cloud adapter
 * (via Chat SDK bridge) emits the bare `wa_id` — e.g. `15551234567`. Both
 * paths use `channelType = 'whatsapp'`, so if they produce different handles
 * the resulting user IDs diverge (`whatsapp:15551234567@s.whatsapp.net` vs
 * `whatsapp:15551234567`), breaking role and membership lookups for anyone
 * who switches paths or whose install runs both.
 *
 * Canonical form: bare digits (no `@` domain, no `:device`). Matches what
 * the Cloud path emits natively. Applied only when channelType is 'whatsapp'
 * and the handle contains `@s.whatsapp.net` (group JIDs ending in `@g.us`
 * are platform IDs, not user handles, and are never passed here).
 *
 * Only the user-identity layer calls this (permissions/index.ts). The
 * messaging_groups.platform_id still stores the full JID — the Baileys
 * adapter emits the JID as the event platformId, so messaging-group routing
 * must NOT be normalized.
 */
export function normalizeWhatsAppHandle(channelType: string, handle: string): string {
  if (channelType !== 'whatsapp') return handle;
  // Strip @s.whatsapp.net (and any leading :device suffix before the @).
  // "15551234567:12@s.whatsapp.net" → "15551234567"
  // "15551234567@s.whatsapp.net"    → "15551234567"
  // "15551234567"                   → "15551234567"  (Cloud path, already canonical)
  // "1234567890@g.us"               → "1234567890@g.us"  (group JID — untouched)
  if (!handle.includes('@s.whatsapp.net')) return handle;
  return handle.split('@')[0].split(':')[0];
}
