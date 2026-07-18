#!/usr/bin/env pnpm exec tsx
/**
 * Wire a WeChat DM (or group) to an agent group.
 *
 * After /add-wechat installs the adapter and the user scans the QR login,
 * the first inbound message from another WeChat account auto-creates a
 * `messaging_groups` row. This script finds that row, asks the operator
 * which agent group to wire it to, and creates the wiring via
 * `ncl wirings create` — engage mode/pattern and priority come from the
 * WeChat adapter's declared channel defaults, not from SQL baked into this
 * script, so it can't drift against schema migrations.
 *
 * PREREQUISITE: the NanoClaw host service must be RUNNING — `ncl` talks to
 * it over a Unix socket and has no offline mode.
 *
 * Usage (from the project root):
 *   pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts
 *
 * Flags:
 *   --platform-id <id>      Wire a specific messaging group (default: most recent unwired)
 *   --agent-group <id>      Target agent group (default: interactive pick; auto-picked when only one exists)
 *   --sender-policy <p>     public | strict | request_approval — overrides the
 *                           channel-declared unknown_sender_policy on the
 *                           messaging group (default: leave as the adapter declared)
 *   --session-mode <m>      shared | per-thread (default: shared)
 *   --non-interactive       Fail instead of prompting
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// <root>/.claude/skills/add-wechat/scripts/wire-dm.ts → <root>
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

type SenderPolicy = 'public' | 'strict' | 'request_approval';

interface Args {
  platformId?: string;
  agentGroupId?: string;
  senderPolicy?: SenderPolicy;
  sessionMode: 'shared' | 'per-thread';
  interactive: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    // No --sender-policy default: the router already stamped the policy the
    // WeChat adapter declares when it auto-created the messaging group.
    // Only an explicit flag overrides it.
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

/** Run one ncl command against the running host and return its parsed data. */
function ncl(...cliArgs: string[]): unknown {
  const res = spawnSync('pnpm', ['exec', 'tsx', 'src/cli/client.ts', ...cliArgs, '--json'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
  });
  if (res.error) throw res.error;
  let frame: { ok: boolean; data?: unknown; error?: { message: string } } | undefined;
  try {
    frame = JSON.parse(res.stdout);
  } catch {
    // No frame — transport-level failure (host not running), reported on stderr.
  }
  if (frame && !frame.ok) throw new Error(`ncl ${cliArgs.join(' ')} failed: ${frame.error?.message}`);
  if (!frame || res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(
      `ncl ${cliArgs.join(' ')} failed:\n${detail}\n\n` +
      'Is the NanoClaw host service running? ncl connects to it over a Unix socket.',
    );
  }
  return frame.data;
}

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

interface MgRow { id: string; platform_id: string; name: string | null; is_group: number; created_at: string }
interface AgRow { id: string; name: string; created_at: string }

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const mgs = ncl('messaging-groups', 'list', '--channel-type', 'wechat') as MgRow[];
  const wirings = ncl('wirings', 'list', '--limit', '10000') as Array<{ messaging_group_id: string }>;
  const wiredMgIds = new Set(wirings.map((w) => w.messaging_group_id));

  // 1. Pick the messaging group
  let mg: MgRow | undefined;
  if (args.platformId) {
    mg = mgs.find((r) => r.platform_id === args.platformId);
    if (!mg) throw new Error(`no wechat messaging_group with platform_id = ${args.platformId}`);
  } else {
    const unwired = mgs
      .filter((r) => !wiredMgIds.has(r.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    if (unwired.length === 0) {
      console.error('No unwired WeChat messaging groups found.');
      console.error('Send a message to the bot first (from another WeChat account), then re-run.');
      process.exit(1);
    }

    if (unwired.length === 1 || !args.interactive) {
      mg = unwired[0];
      console.log(`Using most recent unwired group: ${mg.platform_id} (${mg.is_group ? 'group' : 'DM'})`);
    } else {
      console.log('Unwired WeChat messaging groups:');
      unwired.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.platform_id}  (${r.is_group ? 'group' : 'DM'}, ${r.created_at})`);
      });
      const pick = await prompt('Pick one [1]: ');
      const idx = pick === '' ? 0 : parseInt(pick, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= unwired.length) throw new Error('invalid choice');
      mg = unwired[idx];
    }
  }

  // 2. Pick the agent group
  let agentGroupId = args.agentGroupId;
  if (!agentGroupId) {
    const agents = (ncl('groups', 'list') as AgRow[])
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (agents.length === 0) throw new Error('no agent groups exist — create one first');

    if (agents.length === 1) {
      agentGroupId = agents[0].id;
      console.log(`Auto-selected sole agent group: ${agents[0].name} (${agentGroupId})`);
    } else if (args.interactive) {
      console.log('Agent groups:');
      agents.forEach((a, i) => {
        console.log(`  ${i + 1}. ${a.name} (${a.id})`);
      });
      const pick = await prompt('Pick one [1]: ');
      const idx = pick === '' ? 0 : parseInt(pick, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= agents.length) throw new Error('invalid choice');
      agentGroupId = agents[idx].id;
    } else {
      throw new Error('multiple agent groups exist; pass --agent-group <id>');
    }
  }

  const ag = (ncl('groups', 'list') as AgRow[]).find((a) => a.id === agentGroupId);
  if (!ag) throw new Error(`no agent_group with id = ${agentGroupId}`);

  // 3. Wire, then apply the optional policy override. Engage mode/pattern and
  //    priority are filled by the wirings resolveDefaults hook from the WeChat
  //    adapter's declared channel defaults. Policy update runs second so a
  //    failed create (e.g. already wired) leaves the mg row untouched.
  const wiring = ncl(
    'wirings', 'create',
    '--messaging-group-id', mg.id,
    '--agent-group-id', ag.id,
    '--session-mode', args.sessionMode,
  ) as { engage_mode: string; engage_pattern: string | null };
  if (args.senderPolicy) {
    ncl('messaging-groups', 'update', mg.id, '--unknown-sender-policy', args.senderPolicy);
  }

  console.log('');
  console.log(
    `WIRED platform_id=${mg.platform_id} agent_group=${ag.name} ` +
    `engage=${wiring.engage_mode}${wiring.engage_pattern ? `(${wiring.engage_pattern})` : ''} ` +
    `policy=${args.senderPolicy ?? '(channel default)'} mode=${args.sessionMode}`,
  );
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
