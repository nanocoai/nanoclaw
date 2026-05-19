#!/usr/bin/env pnpm exec tsx
/**
 * Wire a WeChat DM (or group) to an agent group.
 *
 * After /add-wechat installs the adapter and the user scans the QR login,
 * the first inbound message from another WeChat account auto-creates a
 * `messaging_groups` row. This script finds that row, asks the operator
 * which agent group to wire it to, and inserts the `messaging_group_agents`
 * join row with sensible defaults — the "post-login wiring" step /add-wechat
 * otherwise requires manual SQL for.
 *
 * Usage:
 *   pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts
 *
 * Flags:
 *   --platform-id <id>      Wire a specific messaging group (default: most recent unwired)
 *   --agent-group <id>      Target agent group (default: interactive pick; or solo admin group)
 *   --sender-policy <p>     public | strict (default: public)
 *   --session-mode <m>      shared | per-thread (default: shared)
 *   --non-interactive       Fail instead of prompting
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import readline from 'node:readline';

const DB_PATH = process.env.NANOCLAW_DB_PATH ?? path.join(process.cwd(), 'data', 'v2.db');

type SenderPolicy = 'public' | 'strict' | 'request_approval';

interface Args {
  platformId?: string;
  agentGroupId?: string;
  senderPolicy: SenderPolicy;
  sessionMode: 'shared' | 'per-thread';
  interactive: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    // Default matches the router's auto-create (`request_approval`) so the
    // admin gets an approval card on the next unknown-sender DM rather than
    // a silent allow. Pass `--sender-policy public` to open the channel to
    // anyone, or `strict` to require explicit membership.
    senderPolicy: 'request_approval',
    sessionMode: 'shared',
    interactive: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case '--platform-id': args.platformId = val; i++; break;
      case '--agent-group': args.agentGroupId = val; i++; break;
      case '--sender-policy':
        if (val !== 'public' && val !== 'strict' && val !== 'request_approval') {
          throw new Error(`bad --sender-policy: ${val} (use public | strict | request_approval)`);
        }
        args.senderPolicy = val; i++; break;
      case '--session-mode':
        if (val !== 'shared' && val !== 'per-thread') throw new Error(`bad --session-mode: ${val}`);
        args.sessionMode = val; i++; break;
      case '--non-interactive': args.interactive = false; break;
      case '--help': case '-h':
        console.log('See .claude/skills/add-wechat/scripts/wire-dm.ts header for usage.');
        process.exit(0);
    }
  }
  return args;
}

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // 1. Pick the messaging group
  let platformId = args.platformId;
  if (!platformId) {
    const rows = db.prepare(`
      SELECT mg.id, mg.platform_id, mg.name, mg.is_group, mg.created_at
      FROM messaging_groups mg
      LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
      WHERE mg.channel_type = 'wechat' AND mga.id IS NULL
      ORDER BY mg.created_at DESC
    `).all() as Array<{ id: string; platform_id: string; name: string | null; is_group: number; created_at: string }>;

    if (rows.length === 0) {
      console.error('No unwired WeChat messaging groups found.');
      console.error('Send a message to the bot first (from another WeChat account), then re-run.');
      process.exit(1);
    }

    if (rows.length === 1 || !args.interactive) {
      platformId = rows[0].platform_id;
      console.log(`Using most recent unwired group: ${platformId} (${rows[0].is_group ? 'group' : 'DM'})`);
    } else {
      console.log('Unwired WeChat messaging groups:');
      rows.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.platform_id}  (${r.is_group ? 'group' : 'DM'}, ${r.created_at})`);
      });
      const pick = await prompt('Pick one [1]: ');
      const idx = pick === '' ? 0 : parseInt(pick, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= rows.length) throw new Error('invalid choice');
      platformId = rows[idx].platform_id;
    }
  }

  const mg = db.prepare(
    'SELECT id, platform_id, is_group FROM messaging_groups WHERE channel_type = ? AND platform_id = ?'
  ).get('wechat', platformId) as { id: string; platform_id: string; is_group: number } | undefined;
  if (!mg) throw new Error(`no wechat messaging_group with platform_id = ${platformId}`);

  // 2. Pick the agent group
  let agentGroupId = args.agentGroupId;
  if (!agentGroupId) {
    const agents = db.prepare('SELECT id, name, is_admin FROM agent_groups ORDER BY is_admin DESC, created_at ASC')
      .all() as Array<{ id: string; name: string; is_admin: number }>;
    if (agents.length === 0) throw new Error('no agent groups exist — create one first');

    const adminAgents = agents.filter((a) => a.is_admin === 1);
    if (adminAgents.length === 1 && !args.interactive) {
      agentGroupId = adminAgents[0].id;
      console.log(`Auto-selected sole admin agent group: ${adminAgents[0].name} (${agentGroupId})`);
    } else if (args.interactive) {
      console.log('Agent groups:');
      agents.forEach((a, i) => {
        console.log(`  ${i + 1}. ${a.name} (${a.id})${a.is_admin ? ' [admin]' : ''}`);
      });
      const pick = await prompt('Pick one [1]: ');
      const idx = pick === '' ? 0 : parseInt(pick, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= agents.length) throw new Error('invalid choice');
      agentGroupId = agents[idx].id;
    } else {
      throw new Error('multiple agent groups exist; pass --agent-group <id>');
    }
  }

  const ag = db.prepare('SELECT id, name FROM agent_groups WHERE id = ?').get(agentGroupId) as
    { id: string; name: string } | undefined;
  if (!ag) throw new Error(`no agent_group with id = ${agentGroupId}`);

  // 3. Update sender policy + wire
  const tx = db.transaction(() => {
    db.prepare('UPDATE messaging_groups SET unknown_sender_policy = ? WHERE id = ?')
      .run(args.senderPolicy, mg.id);

    db.prepare(`
      INSERT INTO messaging_group_agents
        (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
      VALUES (?, ?, ?, '', 'all', ?, 10, datetime('now'))
    `).run(generateId('mga'), mg.id, ag.id, args.sessionMode);
  });
  tx();

  console.log('');
  console.log(`WIRED platform_id=${mg.platform_id} agent_group=${ag.name} policy=${args.senderPolicy} mode=${args.sessionMode}`);
  db.close();
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
