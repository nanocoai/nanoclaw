/**
 * One-time idempotent setup for the health-monitor agent group.
 * Creates agent group, messaging group for the keepalive channel, and wires them.
 * Safe to call on every startup — skips rows that already exist.
 *
 * Required .env keys:
 *   HEALTH_MONITOR_DISCORD_GUILD_ID    — Discord server (guild) ID
 *   HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID — Channel ID for alert delivery
 *
 * If either key is missing, the agent group is still created but Discord
 * wiring is skipped (alerts will be suppressed with a warning).
 */
import { getDb } from '../../db/connection.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { HEALTH_MONITOR_AGENT_ID } from './alert.js';

const HEALTH_MONITOR_MG_ID = 'mg-health-monitor';

export function ensureHealthMonitorSetup(): void {
  const db = getDb();

  // Agent group
  const existing = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get(HEALTH_MONITOR_AGENT_ID);
  if (!existing) {
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, NULL, datetime('now'))`,
    ).run(HEALTH_MONITOR_AGENT_ID, 'Health Monitor', 'health-monitor');
    log.info('[health-monitor] Created agent group');
  }

  const env = readEnvFile(['HEALTH_MONITOR_DISCORD_GUILD_ID', 'HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID']);
  if (!env.HEALTH_MONITOR_DISCORD_GUILD_ID || !env.HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID) {
    log.warn(
      '[health-monitor] HEALTH_MONITOR_DISCORD_GUILD_ID or HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID not set in .env — Discord wiring skipped',
    );
    return;
  }

  // Messaging group for the keepalive Discord channel
  const platformId = `discord:${env.HEALTH_MONITOR_DISCORD_GUILD_ID}:${env.HEALTH_MONITOR_KEEPALIVE_CHANNEL_ID}`;
  const existingMg = db.prepare('SELECT id FROM messaging_groups WHERE id = ?').get(HEALTH_MONITOR_MG_ID);
  if (!existingMg) {
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'discord', ?, 'keepalive', 1, 'ignore', datetime('now'))`,
    ).run(HEALTH_MONITOR_MG_ID, platformId);
    log.info('[health-monitor] Created messaging group', { platformId });
  }

  // Wiring
  const existingWiring = db
    .prepare('SELECT 1 FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(HEALTH_MONITOR_MG_ID, HEALTH_MONITOR_AGENT_ID);
  if (!existingWiring) {
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, created_at)
       VALUES ('mga-health-monitor', ?, ?, 'shared', 0, datetime('now'))`,
    ).run(HEALTH_MONITOR_MG_ID, HEALTH_MONITOR_AGENT_ID);
    log.info('[health-monitor] Created wiring');
  }

  // Named destination so the agent can use <message to="keepalive"> in its output
  const existingDest = db
    .prepare("SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND local_name = 'keepalive'")
    .get(HEALTH_MONITOR_AGENT_ID);
  if (!existingDest) {
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'keepalive', 'channel', ?, datetime('now'))`,
    ).run(HEALTH_MONITOR_AGENT_ID, HEALTH_MONITOR_MG_ID);
    log.info('[health-monitor] Created keepalive destination');
  }
}
