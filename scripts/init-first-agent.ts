/**
 * Init the first (or Nth) NanoClaw v2 agent for a DM channel.
 *
 * Wires a real DM channel (discord, telegram, etc.) to a new agent group,
 * then hands a welcome message to the running service via the CLI socket
 * (admin transport). The service routes that message into the DM session,
 * which wakes the container synchronously — the agent processes the welcome
 * and DMs the operator through the normal delivery path.
 *
 * CLI channel wiring is handled separately by `scripts/init-cli-agent.ts`.
 *
 * Creates/reuses: user, owner grant (if none), agent group + filesystem,
 * messaging group(s), wiring.
 *
 * Runs alongside the service (WAL-mode sqlite + CLI socket IPC) — does NOT
 * initialize channel adapters, so there's no Gateway conflict. Requires
 * the service to be running: the welcome hand-off goes over the CLI socket
 * and fails loudly if the service isn't up.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-first-agent.ts \
 *     --channel discord \
 *     --user-id discord:1470183333427675709 \
 *     --platform-id discord:@me:1491573333382523708 \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"] \
 *     [--welcome "System instruction: ..."] \
 *     [--role owner|admin|member]    # default: owner
 *
 * For direct-addressable channels (telegram, whatsapp, etc.), --platform-id
 * is typically the same as the handle in --user-id, with the channel prefix.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

type Role = 'owner' | 'admin' | 'member';

interface Args {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  welcome: string;
  role: Role;
}

const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

const DEFAULT_ROLE: Role = 'owner';

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--channel':
        out.channel = (val ?? '').toLowerCase();
        i++;
        break;
      case '--user-id':
        out.userId = val;
        i++;
        break;
      case '--platform-id':
        out.platformId = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--agent-name':
        out.agentName = val;
        i++;
        break;
      case '--welcome':
        out.welcome = val;
        i++;
        break;
      case '--role': {
        const raw = (val ?? '').toLowerCase();
        if (raw !== 'owner' && raw !== 'admin' && raw !== 'member') {
          console.error(
            `Invalid --role: ${raw} (expected 'owner', 'admin', or 'member')`,
          );
          process.exit(2);
        }
        out.role = raw;
        i++;
        break;
      }
    }
  }

  const required: (keyof Args)[] = ['channel', 'userId', 'platformId', 'displayName'];
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    console.error(
      `Missing required args: ${missing.map((k) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}`,
    );
    console.error('See scripts/init-first-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    channel: out.channel!,
    userId: out.userId!,
    platformId: out.platformId!,
    displayName: out.displayName!,
    agentName: out.agentName?.trim() || out.displayName!,
    welcome: out.welcome?.trim() || DEFAULT_WELCOME,
    role: out.role ?? DEFAULT_ROLE,
  };
}

function namespacedUserId(channel: string, raw: string): string {
  return raw.includes(':') ? raw : `${channel}:${raw}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wireIfMissing(mg: MessagingGroup, ag: AgentGroup, now: string, label: string): void {
  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (existing) {
    console.log(`Wiring already exists: ${existing.id} (${label})`);
    return;
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    // DM / CLI (is_group=0) default to "respond to everything" via a '.' regex.
    // Group chats default to mention-only; admins can upgrade to mention-sticky
    // via /manage-channels once the agent is in use.
    engage_mode: mg.is_group === 0 ? 'pattern' : 'mention',
    engage_pattern: mg.is_group === 0 ? '.' : null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired ${label}: ${mg.id} -> ${ag.id}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const now = new Date().toISOString();

  // 1. User + (conditional) owner grant.
  const userId = namespacedUserId(args.channel, args.userId);
  upsertUser({
    id: userId,
    kind: args.channel,
    display_name: args.displayName,
    created_at: now,
  });

  // Owner grant is deferred until after the agent group is resolved, since
  // an admin grant is scoped to that group. See step 2b.

  // 2. Agent group + filesystem.
  const folder = `dm-with-${normalizeName(args.displayName)}`;
  const pickedProvider = process.env.NANOCLAW_PICKED_PROVIDER?.trim().toLowerCase();
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  // Ensure the config row exists; defer workspace scaffolding to the first
  // spawn (group-init), where the DB-resolved provider decides the surface
  // (Claude: CLAUDE.local.md; a surfaces-owning provider: the memory scaffold)
  // — so a non-Claude group never gets stale CLAUDE.* files written here.
  ensureContainerConfig(ag.id);
  // Runtime provider lives on the config row, not the deprecated agent_provider.
  if (pickedProvider && pickedProvider !== 'claude') {
    updateContainerConfigScalars(ag.id, { provider: pickedProvider });
  }
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, '.seed.md'),
    `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName}. ` +
      'When the user first reaches out (or you receive a system welcome prompt), introduce yourself briefly and invite them to chat. Keep replies concise.\n',
  );

  // 2b. Assign the user a role for this agent group. The caller picks via
  // --role; the channel drivers default to 'owner' for the self-host case.
  //  - owner:  global owner (agent_group_id=null). Cross-channel access.
  //  - admin:  scoped admin for this agent group only.
  //  - member: no role grant, just the membership row below.
  // grantRole inserts a new row per call — idempotence check against
  // getUserRoles prevents duplicates on re-runs.
  const existingRoles = getUserRoles(userId);
  if (args.role === 'owner') {
    const alreadyOwner = existingRoles.some(
      (r) => r.role === 'owner' && r.agent_group_id === null,
    );
    if (!alreadyOwner) {
      grantRole({
        user_id: userId,
        role: 'owner',
        agent_group_id: null,
        granted_by: null,
        granted_at: now,
      });
    }
    // Owner's agent group gets global CLI access
    updateContainerConfigScalars(ag.id, { cli_scope: 'global' });
  } else if (args.role === 'admin') {
    const alreadyAdmin = existingRoles.some(
      (r) => r.role === 'admin' && r.agent_group_id === ag.id,
    );
    if (!alreadyAdmin) {
      grantRole({
        user_id: userId,
        role: 'admin',
        agent_group_id: ag.id,
        granted_by: null,
        granted_at: now,
      });
    }
  }

  // Always add a membership row so the access gate has a straightforward
  // yes/no even for users without a role grant. INSERT OR IGNORE, so this
  // is a no-op when the row already exists (e.g. re-runs, owners whose
  // access already passes via role).
  addMember({
    user_id: userId,
    agent_group_id: ag.id,
    added_by: null,
    added_at: now,
  });

  // 3. DM messaging group.
  const platformId = namespacedPlatformId(args.channel, args.platformId);
  let dmMg = getMessagingGroupByPlatform(args.channel, platformId);
  if (!dmMg) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: args.channel,
      platform_id: platformId,
      name: args.displayName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    dmMg = getMessagingGroupByPlatform(args.channel, platformId)!;
    console.log(`Created messaging group: ${dmMg.id} (${platformId})`);
  } else {
    console.log(`Reusing messaging group: ${dmMg.id} (${platformId})`);
  }

  // 4. Wire DM messaging group to the agent.
  wireIfMissing(dmMg, ag, now, 'dm');

  // 5. Welcome delivery over the CLI socket. Router picks up the line,
  // writes the message into the DM session's inbound.db, and wakes the
  // container synchronously — no sweep wait. The paired user's identity is
  // passed so the sender resolver sees the real owner, not cli:local.
  await sendWelcomeViaCliSocket(dmMg, args.welcome, {
    senderId: userId,
    sender: args.displayName,
  });

  const roleLabel =
    args.role === 'owner'
      ? 'owner (global)'
      : args.role === 'admin'
        ? `admin (scoped to ${ag.id})`
        : 'member';

  console.log('');
  console.log('Init complete.');
  console.log(`  user:    ${userId}`);
  console.log(`  role:    ${roleLabel}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: ${args.channel} ${dmMg.platform_id}`);
  console.log('');
  console.log('Welcome DM queued — the agent will greet you shortly.');
}

/**
 * Hand the welcome to the running service via its CLI Unix socket. The
 * service's CLI adapter receives `{text, to}`, builds an InboundEvent
 * targeting the DM messaging group, and calls routeInbound(). Router writes
 * the message into inbound.db and wakes the container synchronously.
 *
 * Throws if the socket isn't reachable — this script requires the service
 * to be running.
 */
async function sendWelcomeViaCliSocket(
  dmMg: MessagingGroup,
  welcome: string,
  identity: { senderId: string; sender: string },
): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;

    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };

    socket.once('error', (err) =>
      settle(
        new Error(
          `CLI socket at ${sockPath} not reachable: ${err.message}. Is the NanoClaw service running?`,
        ),
      ),
    );
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text: welcome,
          senderId: identity.senderId,
          sender: identity.sender,
          to: {
            channelType: dmMg.channel_type,
            platformId: dmMg.platform_id,
            threadId: dmMg.platform_id,
          },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) {
          settle(err);
          return;
        }
        // Brief flush delay so the router picks up the line before we close.
        // Router handles it synchronously once read, so 50ms is plenty.
        setTimeout(() => settle(null), 50);
      });
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
