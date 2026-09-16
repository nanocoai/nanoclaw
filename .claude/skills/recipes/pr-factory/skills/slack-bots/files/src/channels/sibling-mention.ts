/**
 * Sibling-mention suppression for multi-instance channels (owned by the
 * pr-factory `slack-bots` component skill).
 *
 * When several adapter instances share one platform channel (distinct
 * `instance` rows on the same `channel_type` + `platform_id`), a message
 * that starts with an `@` but did NOT mention this bot (`isMention` false)
 * is usually addressed to one of the siblings. A mention-sticky wiring
 * would still fire on it because the subscribed-thread session already
 * exists — so the router asks this helper before letting the sticky
 * follow-up engage.
 *
 * Returns true when at least one sibling bot (a different NAMED instance —
 * `instance != channel_type` — wired with engage_mode='mention') sits on
 * the same platform channel and the text starts with '@'. The caller
 * (evaluateEngage in src/router.ts) suppresses the sticky follow-up in
 * that case. The default instance (instance = channel_type) never counts
 * as a sibling — matching the validated fork semantics where only named
 * bots are mention-addressed.
 *
 * KNOWN SMELL (skill-guidelines anti-pattern #4): this is a raw SQL read
 * against the core central DB, dependent on the messaging_groups /
 * messaging_group_agents schema. The clean fix is a core helper in
 * src/db/messaging-groups.ts (e.g. `countSiblingMentionBots(channelType,
 * platformId, instance)`) — a natural follow-on to the native instance
 * substrate, tracked as an upstream carve-out. Until then the query lives
 * here, in skill-owned code, guarded by src/router-sibling-mention.test.ts.
 */
import { getDb } from '../db/connection.js';
import type { MessagingGroup } from '../types.js';

export function hasSiblingMention(mg: MessagingGroup, text: string): boolean {
  if (!text.startsWith('@')) return false;
  const count = getDb()
    .prepare(
      `SELECT count(*) as n FROM messaging_groups mg2
       JOIN messaging_group_agents mga ON mg2.id = mga.messaging_group_id
       WHERE mg2.channel_type = ? AND mg2.platform_id = ?
         AND mg2.instance != mg2.channel_type AND mg2.instance != ?
         AND mga.engage_mode = 'mention'`,
    )
    .get(mg.channel_type, mg.platform_id, mg.instance ?? mg.channel_type) as { n: number };
  return count.n > 0;
}
