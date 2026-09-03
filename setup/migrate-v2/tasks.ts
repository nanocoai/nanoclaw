/**
 * migrate-v2 step: tasks
 *
 * Port v1 scheduled_tasks into v2 session inbound DBs.
 *
 * v1: scheduled_tasks table (schedule_type, schedule_value, next_run)
 * v2: messages_in rows with kind='task' in per-session inbound.db
 *
 * Requires: db step must have run first (agent_groups + messaging_groups seeded).
 *
 * Usage: pnpm exec tsx setup/migrate-v2/tasks.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH, DATA_DIR } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/connection.js';
import { getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import '../../src/mailbox/compose.js';
import { resolveSession, withMailboxSession } from '../../src/session-manager.js';
import { readEnvFile } from '../../src/env.js';
import { buildDiscordResolver, type DiscordResolver } from './discord-resolver.js';
import { parseJid, v2PlatformId } from './shared.js';

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  status: string;
  context_mode: string | null;
  script: string | null;
}

function toCron(t: V1Task): { processAfter: string; recurrence: string | null } | null {
  const now = new Date().toISOString();

  if (t.schedule_type === 'cron') {
    const fields = t.schedule_value.trim().split(/\s+/).length;
    if (fields < 5 || fields > 6) return null;
    return { processAfter: t.next_run || now, recurrence: t.schedule_value.trim() };
  }

  if (t.schedule_type === 'interval') {
    const m = /^(\d+)([smhd])$/.exec(t.schedule_value.trim());
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (!n || n < 1) return null;
    let cron: string | null = null;
    if (unit === 'm' && n < 60) cron = `*/${n} * * * *`;
    else if (unit === 'h' && n < 24) cron = `0 */${n} * * *`;
    else if (unit === 'd' && n < 28) cron = `0 0 */${n} * *`;
    if (!cron) return null;
    return { processAfter: t.next_run || now, recurrence: cron };
  }

  if (t.schedule_type === 'once' || t.schedule_type === 'at') {
    return { processAfter: t.next_run || t.schedule_value || now, recurrence: null };
  }

  return null;
}

async function main(): Promise<void> {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/tasks.ts <v1-path>');
    process.exit(1);
  }

  const v1DbPath = path.join(v1Path, 'store', 'messages.db');
  if (!fs.existsSync(v1DbPath)) {
    console.log('SKIPPED:no v1 DB');
    process.exit(0);
  }

  // Read v1 tasks
  const v1Db = new Database(v1DbPath, { readonly: true, fileMustExist: true });
  const allTasks = v1Db.prepare('SELECT * FROM scheduled_tasks').all() as V1Task[];
  v1Db.close();

  const activeTasks = allTasks.filter((t) => t.status === 'active');
  if (activeTasks.length === 0) {
    console.log('SKIPPED:no active tasks');
    process.exit(0);
  }

  // Init v2 central DB
  const v2DbPath = CENTRAL_DB_PATH;
  if (!fs.existsSync(v2DbPath)) {
    console.error('v2.db not found — run db step first');
    process.exit(1);
  }
  const v2Db = await initDb(v2DbPath);
  await runMigrations(v2Db);

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  // Mirrors db.ts: Discord platform_id needs API lookup to recover guildId.
  let discordResolver: DiscordResolver | null = null;
  const hasDiscord = activeTasks.some((t) => parseJid(t.chat_jid)?.channel_type === 'discord');
  if (hasDiscord) {
    const env = readEnvFile(['DISCORD_BOT_TOKEN']);
    discordResolver = await buildDiscordResolver(env.DISCORD_BOT_TOKEN ?? '');
  }

  for (const t of activeTasks) {
    try {
      const ag = await getAgentGroupByFolder(t.group_folder);
      if (!ag) {
        skipped++;
        continue;
      }

      const parsed = parseJid(t.chat_jid);
      if (!parsed) {
        skipped++;
        continue;
      }

      let platformId: string;
      if (parsed.channel_type === 'discord') {
        const resolved = discordResolver?.resolve(parsed.id) ?? null;
        if (!resolved) {
          skipped++;
          continue;
        }
        platformId = resolved;
      } else {
        platformId = v2PlatformId(parsed.channel_type, t.chat_jid);
      }
      const mg = await getMessagingGroupByPlatform(parsed.channel_type, platformId);
      if (!mg) {
        skipped++;
        continue;
      }

      const scheduling = toCron(t);
      if (!scheduling) {
        skipped++;
        continue;
      }

      const { session } = await resolveSession(ag.id, mg.id, null, 'shared');
      const inserted = await withMailboxSession(ag.id, session.id, async (mailbox) => {
        if (mailbox.getTask(t.id)) return false;
        await mailbox.insertMessage({
          id: t.id,
          kind: 'task',
          timestamp: new Date().toISOString(),
          processAfter: scheduling.processAfter,
          recurrence: scheduling.recurrence,
          platformId,
          channelType: parsed.channel_type,
          threadId: null,
          content: JSON.stringify({
            prompt: t.prompt,
            script: t.script ?? null,
            migrated_from_v1: { original_id: t.id, context_mode: t.context_mode ?? null },
          }),
          trigger: true,
        });
        return true;
      });
      if (inserted) migrated++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error(`TASK_ERROR:${t.id}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await closeDb();
  console.log(`OK:active=${activeTasks.length},migrated=${migrated},skipped=${skipped},failed=${failed}`);
}

main().catch((err) => {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
