/**
 * migrate-v2 step: db
 *
 * Seed v2.db from v1's registered_groups table.
 * Creates agent_groups, messaging_groups, and messaging_group_agents.
 *
 * Does NOT seed users/user_roles — the /migrate-from-v1 skill handles that.
 *
 * Idempotent: re-running skips rows that already exist.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/db.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { readEnvFile } from '../../src/env.js';
import { buildDiscordResolver, type DiscordResolver } from './discord-resolver.js';
import {
  generateId,
  inferIsGroup,
  parseJid,
  triggerToEngage,
  v2PlatformId,
} from './shared.js';

interface V1Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string | null;
  requires_trigger: number | null;
}

async function main(): Promise<void> {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/db.ts <v1-path>');
    process.exit(1);
  }

  const v1DbPath = path.join(v1Path, 'store', 'messages.db');
  if (!fs.existsSync(v1DbPath)) {
    console.error(`v1 DB not found: ${v1DbPath}`);
    process.exit(1);
  }

  // Read v1 groups
  const v1Db = new Database(v1DbPath, { readonly: true, fileMustExist: true });

  // v1 schema varies — channel_name was a late addition. Query only the
  // columns we know exist in all v1 installs.
  const v1Groups = v1Db
    .prepare('SELECT jid, name, folder, trigger_pattern, requires_trigger FROM registered_groups')
    .all() as V1Group[];
  v1Db.close();

  if (v1Groups.length === 0) {
    console.log('SKIPPED:no registered groups in v1');
    process.exit(0);
  }

  // Init v2 DB
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const v2Db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(v2Db);

  let created = 0;
  let reused = 0;
  let skipped = 0;
  const errors: string[] = [];

  // v1 stored Discord groups as `dc:<channelId>` with no guild/DM signal.
  // v2 needs either `discord:<guildId>:<channelId>` (guild) or
  // `discord:@me:<channelId>` (DM / group DM). Use the v1 bot token to
  // enumerate guilds + channels and to classify any leftover ids as DMs.
  // On any failure the resolver returns null for every channel and the
  // affected groups skip with a clear warning.
  let discordResolver: DiscordResolver | null = null;
  const discordChannelIds = v1Groups
    .map((g) => parseJid(g.jid))
    .filter((p): p is NonNullable<typeof p> => p?.channel_type === 'discord')
    .map((p) => p.id);
  if (discordChannelIds.length > 0) {
    const env = readEnvFile(['DISCORD_BOT_TOKEN']);
    discordResolver = await buildDiscordResolver(env.DISCORD_BOT_TOKEN ?? '', discordChannelIds);
    const stats = discordResolver.stats();
    if (stats.reason) {
      console.log(`WARN:discord resolver disabled: ${stats.reason}`);
    } else {
      console.log(
        `INFO:discord resolver: ${stats.guilds} guild(s), ${stats.channels} guild channel(s), ${stats.dms} DM(s)`,
      );
    }
  }

  for (const g of v1Groups) {
    const parsed = parseJid(g.jid);
    if (!parsed) {
      skipped++;
      errors.push(`Could not parse JID: ${g.jid}`);
      continue;
    }

    const channelType = parsed.channel_type;
    let platformId: string;
    if (channelType === 'discord') {
      const resolved = discordResolver?.resolve(parsed.id) ?? null;
      if (!resolved) {
        const stats = discordResolver?.stats();
        const why = stats?.reason
          ? `discord resolver unavailable (${stats.reason})`
          : 'not found in any guild the bot can see — re-add the bot to that server and re-run, or rewire after migration';
        skipped++;
        errors.push(`Discord channel ${parsed.id} (${g.folder}): ${why}`);
        continue;
      }
      platformId = resolved;
    } else {
      platformId = v2PlatformId(channelType, parsed.raw);
    }
    const createdAt = new Date().toISOString();

    try {
      // agent_group — one per folder
      let ag = getAgentGroupByFolder(g.folder);
      if (!ag) {
        createAgentGroup({
          id: generateId('ag'),
          name: g.name || g.folder,
          folder: g.folder,
          agent_provider: null,
          created_at: createdAt,
        });
        ag = getAgentGroupByFolder(g.folder)!;
      }

      // messaging_group — one per (channel_type, platform_id).
      //
      // If the row already exists *and* has zero wired agent_groups, it
      // was almost certainly auto-created by the runtime router on an
      // inbound message (which uses 'request_approval' or similar — not
      // the migration's 'public'). Reset its policy to match what the
      // migration would have set if it had created the row first. Once
      // any wiring exists, the user has had a chance to tighten the
      // policy via the skill — leave it alone.
      let mg = getMessagingGroupByPlatform(channelType, platformId);
      if (!mg) {
        createMessagingGroup({
          id: generateId('mg'),
          channel_type: channelType,
          platform_id: platformId,
          name: g.name || null,
          is_group: inferIsGroup(channelType, platformId),
          unknown_sender_policy: 'public',
          created_at: createdAt,
        });
        mg = getMessagingGroupByPlatform(channelType, platformId)!;
      } else if (
        mg.unknown_sender_policy !== 'public' &&
        getMessagingGroupAgents(mg.id).length === 0
      ) {
        updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
        mg = getMessagingGroupByPlatform(channelType, platformId)!;
      }

      // messaging_group_agents — wire them
      const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
      if (!existing) {
        const engage = triggerToEngage({
          trigger_pattern: g.trigger_pattern,
          requires_trigger: g.requires_trigger,
        });
        createMessagingGroupAgent({
          id: generateId('mga'),
          messaging_group_id: mg.id,
          agent_group_id: ag.id,
          engage_mode: engage.engage_mode,
          engage_pattern: engage.engage_pattern,
          sender_scope: 'all',
          ignored_message_policy: 'drop',
          session_mode: 'shared',
          priority: 0,
          created_at: createdAt,
        });
        created++;
      } else {
        reused++;
      }
    } catch (err) {
      skipped++;
      errors.push(`${g.folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  v2Db.close();

  // If every group was skipped, the migration didn't actually do anything.
  // Treat that as failure so the wrapper script surfaces it instead of
  // hiding it under an `OK:` line.
  const totalDone = created + reused;
  if (v1Groups.length > 0 && totalDone === 0) {
    console.error(`FAIL:groups=${v1Groups.length},created=0,reused=0,skipped=${skipped}`);
    for (const e of errors) console.error(`ERROR:${e}`);
    process.exit(1);
  }

  console.log(`OK:groups=${v1Groups.length},created=${created},reused=${reused},skipped=${skipped}`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`ERROR:${e}`);
  }
}

main().catch((err) => {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
