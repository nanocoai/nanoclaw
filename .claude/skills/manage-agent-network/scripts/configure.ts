/**
 * /agent-network configuration CLI.
 *
 * WAN policy (bucket-level + incremental whitelist edits with notes)
 * and inter-agent edge CRUD against agent_destinations. After WAN
 * edits, re-runs the Squid provider's `ensure()` so the running Squid
 * container picks up the new config without a host bounce.
 *
 * Usage:
 *   --agent <id-or-folder> --wan full
 *   --agent <id-or-folder> --wan whitelisted [--domains a.com,b.com]
 *   --agent <id-or-folder> --wan model-only
 *   --agent <id-or-folder> --add-domain a.com [--note "what this is for"]
 *   --agent <id-or-folder> --remove-domain a.com
 *   --add-edge <source>=<local-name>:<target>
 *   --remove-edge <source>=<local-name>
 *   --show <id-or-folder>
 *   --list-agents
 *
 * <source>, <target>, and <id-or-folder> accept either an agent_group_id
 * or a folder name.
 */
import path from 'path';

import { DATA_DIR } from '../../../../src/config.js';
import { initDb } from '../../../../src/db/connection.js';
import { runMigrations } from '../../../../src/db/migrations/index.js';
import { getAgentGroupByFolder, getAllAgentGroups, getAgentGroup } from '../../../../src/db/agent-groups.js';
import { getDb } from '../../../../src/db/connection.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinations,
} from '../../../../src/modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../../../../src/modules/agent-to-agent/write-destinations.js';
import { getRunningSessions } from '../../../../src/db/sessions.js';
import { resolveProviderName } from '../../../../src/container-runner.js';
import {
  squidPolicyProvider,
  domainStrings,
  type DomainEntry,
  type InternetAccessPolicy,
} from '../../../../src/modules/network/squid-policy-provider.js';
import type { AgentGroup, AgentDestination } from '../../../../src/types.js';

type WanBucket = 'full' | 'whitelisted' | 'model-only';

interface Args {
  agent?: string;
  wan?: WanBucket;
  domains?: string[];
  addDomain?: string;
  removeDomain?: string;
  note?: string;
  addEdge?: string;
  removeEdge?: string;
  show?: string;
  listAgents?: boolean;
  cdpPort?: number | 'unset';
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--agent':
        out.agent = next;
        i += 1;
        break;
      case '--wan':
        if (next !== 'full' && next !== 'whitelisted' && next !== 'model-only') {
          fatal(`--wan must be one of: full, whitelisted, model-only (got "${next}")`);
        }
        out.wan = next;
        i += 1;
        break;
      case '--domains':
        out.domains = (next ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case '--add-domain':
        out.addDomain = next;
        i += 1;
        break;
      case '--remove-domain':
        out.removeDomain = next;
        i += 1;
        break;
      case '--note':
        out.note = next;
        i += 1;
        break;
      case '--add-edge':
        out.addEdge = next;
        i += 1;
        break;
      case '--remove-edge':
        out.removeEdge = next;
        i += 1;
        break;
      case '--show':
        out.show = next;
        i += 1;
        break;
      case '--list-agents':
        out.listAgents = true;
        break;
      case '--cdp-port': {
        if (next === 'unset' || next === 'off' || next === 'none') {
          out.cdpPort = 'unset';
        } else {
          const port = parseInt(next ?? '', 10);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            fatal(`--cdp-port must be a positive integer port (or "unset" to clear), got "${next}"`);
          }
          out.cdpPort = port;
        }
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        fatal(`Unknown argument: ${flag}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage:
  configure.ts --agent <id-or-folder> --wan full|whitelisted|model-only [--domains a.com,b.com]
  configure.ts --agent <id-or-folder> --add-domain a.com [--note "what this is for"]
  configure.ts --agent <id-or-folder> --remove-domain a.com
  configure.ts --add-edge <source>=<local-name>:<target>
  configure.ts --remove-edge <source>=<local-name>
  configure.ts --show <id-or-folder>
  configure.ts --list-agents`);
}

function fatal(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

function resolveAgent(idOrFolder: string): AgentGroup {
  const byId = getAgentGroup(idOrFolder);
  if (byId) return byId;
  const byFolder = getAgentGroupByFolder(idOrFolder);
  if (byFolder) return byFolder;
  fatal(`No agent found matching id or folder "${idOrFolder}"`);
}

function readPolicy(agent: AgentGroup): InternetAccessPolicy {
  const raw = agent.internet_access_policy;
  if (!raw) return { bucket: 'full' };
  try {
    const parsed = JSON.parse(raw) as Partial<InternetAccessPolicy>;
    if (parsed.bucket === 'full' || parsed.bucket === 'whitelisted' || parsed.bucket === 'model-only') {
      const result: InternetAccessPolicy = {
        bucket: parsed.bucket,
        domains: Array.isArray(parsed.domains) ? parsed.domains : [],
      };
      if (typeof parsed.cdpPort === 'number') result.cdpPort = parsed.cdpPort;
      return result;
    }
  } catch {
    /* fall through */
  }
  return { bucket: 'full' };
}

function writePolicy(agent: AgentGroup, policy: InternetAccessPolicy): void {
  getDb()
    .prepare('UPDATE agent_groups SET internet_access_policy = ? WHERE id = ?')
    .run(JSON.stringify(policy), agent.id);
}

async function reloadSquid(): Promise<void> {
  await squidPolicyProvider.ensure!();
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function setWan(agent: AgentGroup, bucket: WanBucket, domains: string[] | undefined): Promise<void> {
  const policy: InternetAccessPolicy = { bucket };
  if (bucket === 'whitelisted') {
    const now = new Date().toISOString();
    policy.domains = (domains ?? []).map<DomainEntry>((d) => ({ domain: d, added_at: now }));
  }
  writePolicy(agent, policy);
  console.log(
    `Set ${agent.name} (${agent.id}) WAN policy: ${bucket}` +
      (bucket === 'whitelisted' ? ` domains=[${(domains ?? []).join(', ') || '<none>'}]` : ''),
  );
  await reloadSquid();
}

async function addDomain(agent: AgentGroup, domain: string, note: string | undefined): Promise<void> {
  const policy = readPolicy(agent);
  if (policy.bucket !== 'whitelisted') {
    fatal(
      `--add-domain only works when the agent is in 'whitelisted' bucket (current: ${policy.bucket}). ` +
        `Run \`--agent ${agent.folder} --wan whitelisted\` first if you want to switch.`,
    );
  }
  const existing = domainStrings(policy);
  if (existing.includes(domain)) {
    console.log(`Domain "${domain}" already in ${agent.name}'s whitelist. No-op.`);
    return;
  }
  const entry: DomainEntry = { domain, added_at: new Date().toISOString() };
  if (note) entry.note = note;
  policy.domains = [...(policy.domains ?? []), entry];
  writePolicy(agent, policy);
  console.log(`Added "${domain}" to ${agent.name}'s whitelist${note ? ` (${note})` : ''}.`);
  await reloadSquid();
}

async function setCdpPort(agent: AgentGroup, port: number | 'unset'): Promise<void> {
  const policy = readPolicy(agent);
  if (port === 'unset') {
    if (policy.cdpPort === undefined) {
      console.log(`${agent.name} has no cdpPort set. No-op.`);
      return;
    }
    delete policy.cdpPort;
    writePolicy(agent, policy);
    console.log(`Cleared cdpPort on ${agent.name} (${agent.id}).`);
  } else {
    policy.cdpPort = port;
    writePolicy(agent, policy);
    console.log(
      `Set cdpPort=${port} on ${agent.name} (${agent.id}). Agent can reach host.docker.internal:${port}.`,
    );
  }
  await reloadSquid();
}

async function removeDomain(agent: AgentGroup, domain: string): Promise<void> {
  const policy = readPolicy(agent);
  if (policy.bucket !== 'whitelisted') {
    fatal(`--remove-domain only works when the agent is in 'whitelisted' bucket (current: ${policy.bucket}).`);
  }
  const before = policy.domains ?? [];
  const after = before.filter((d) => (typeof d === 'string' ? d : d.domain) !== domain);
  if (after.length === before.length) {
    console.log(`Domain "${domain}" not in ${agent.name}'s whitelist. No-op.`);
    return;
  }
  policy.domains = after;
  writePolicy(agent, policy);
  console.log(`Removed "${domain}" from ${agent.name}'s whitelist.`);
  await reloadSquid();
}

function parseAddEdgeSpec(spec: string): { source: string; localName: string; target: string } {
  const eq = spec.indexOf('=');
  const colon = spec.indexOf(':', eq + 1);
  if (eq <= 0 || colon <= eq) {
    fatal(`--add-edge expects "<source>=<local-name>:<target>", got "${spec}"`);
  }
  return {
    source: spec.slice(0, eq),
    localName: spec.slice(eq + 1, colon),
    target: spec.slice(colon + 1),
  };
}

function parseRemoveEdgeSpec(spec: string): { source: string; localName: string } {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    fatal(`--remove-edge expects "<source>=<local-name>", got "${spec}"`);
  }
  return { source: spec.slice(0, eq), localName: spec.slice(eq + 1) };
}

function refreshActiveSessions(agentGroupId: string): number {
  const sessions = getRunningSessions().filter((s) => s.agent_group_id === agentGroupId);
  for (const s of sessions) {
    try {
      writeDestinations(agentGroupId, s.id);
    } catch (err) {
      console.warn(`  warning: writeDestinations failed for session ${s.id}:`, err);
    }
  }
  return sessions.length;
}

function addEdge(spec: string): void {
  const { source, localName, target } = parseAddEdgeSpec(spec);
  const sourceAgent = resolveAgent(source);
  const targetAgent = resolveAgent(target);

  if (sourceAgent.id === targetAgent.id) {
    fatal('Self-edges are not supported (and unnecessary — agents can always self-message).');
  }

  const existing = getDestinationByName(sourceAgent.id, localName);
  if (existing) {
    if (existing.target_type === 'agent' && existing.target_id === targetAgent.id) {
      console.log(`Edge already exists: ${sourceAgent.name} → ${targetAgent.name} as "${localName}". No-op.`);
      return;
    }
    fatal(
      `Local name "${localName}" already used on ${sourceAgent.name} for ${existing.target_type}=${existing.target_id}. Pick a different name or remove the existing edge first.`,
    );
  }

  createDestination({
    agent_group_id: sourceAgent.id,
    local_name: localName,
    target_type: 'agent',
    target_id: targetAgent.id,
    created_at: new Date().toISOString(),
  });
  const refreshed = refreshActiveSessions(sourceAgent.id);
  console.log(
    `Added edge: ${sourceAgent.name} (${sourceAgent.id}) → ${targetAgent.name} (${targetAgent.id}) as "${localName}".`,
  );
  if (refreshed > 0) {
    console.log(`Refreshed ${refreshed} running session(s) of ${sourceAgent.name}.`);
  }
}

function removeEdge(spec: string): void {
  const { source, localName } = parseRemoveEdgeSpec(spec);
  const sourceAgent = resolveAgent(source);
  const existing = getDestinationByName(sourceAgent.id, localName);
  if (!existing) {
    console.log(`No edge "${localName}" on ${sourceAgent.name}. No-op.`);
    return;
  }
  deleteDestination(sourceAgent.id, localName);
  const refreshed = refreshActiveSessions(sourceAgent.id);
  console.log(`Removed edge: ${sourceAgent.name} (${sourceAgent.id}) → "${localName}".`);
  if (refreshed > 0) {
    console.log(`Refreshed ${refreshed} running session(s) of ${sourceAgent.name}.`);
  }
}

function showAgent(idOrFolder: string): void {
  const agent = resolveAgent(idOrFolder);
  const provider = resolveProviderName(null, agent.agent_provider);
  const policy = readPolicy(agent);

  console.log(`${agent.name}`);
  console.log(`  id:        ${agent.id}`);
  console.log(`  folder:    ${agent.folder}`);
  console.log(`  provider:  ${provider}`);
  console.log(`  WAN:       ${policy.bucket}`);
  if (policy.cdpPort) {
    console.log(`  CDP port:  host.docker.internal:${policy.cdpPort} (host-side Chrome via agent-browser)`);
  }

  if (policy.bucket === 'whitelisted') {
    console.log(`  Allowed domains:`);
    const domains = policy.domains ?? [];
    if (domains.length === 0) {
      console.log(`    (none — only provider hosts will be reachable)`);
    } else {
      for (const d of domains) {
        if (typeof d === 'string') {
          console.log(`    ${d}`);
        } else {
          const added = d.added_at ? ` (added ${d.added_at.slice(0, 10)})` : '';
          const note = d.note ? ` — ${d.note}` : '';
          console.log(`    ${d.domain}${added}${note}`);
        }
      }
    }
  }

  console.log(`  Outgoing edges:`);
  const out = getDestinations(agent.id);
  if (out.length === 0) {
    console.log(`    (none)`);
  } else {
    for (const d of out) {
      console.log(`    "${d.local_name}" → ${d.target_type}=${d.target_id}`);
    }
  }

  const incoming = getDb()
    .prepare(`SELECT * FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?`)
    .all(agent.id) as AgentDestination[];
  console.log(`  Incoming edges:`);
  if (incoming.length === 0) {
    console.log(`    (none)`);
  } else {
    for (const d of incoming) {
      const src = getAgentGroup(d.agent_group_id);
      const srcLabel = src ? `${src.name} (${src.id})` : d.agent_group_id;
      console.log(`    ${srcLabel} → "${d.local_name}"`);
    }
  }
}

function listAgents(): void {
  const all = getAllAgentGroups();
  if (all.length === 0) {
    console.log('No agent groups exist yet.');
    return;
  }
  console.log(`${all.length} agent group(s):`);
  for (const a of all) {
    const policy = a.internet_access_policy ?? '<unset>';
    const provider = resolveProviderName(null, a.agent_provider);
    console.log(`  ${a.id}  folder=${a.folder}  provider=${provider}  wan=${policy}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  let dispatched = false;

  if (args.listAgents) {
    listAgents();
    dispatched = true;
  }

  if (args.show) {
    showAgent(args.show);
    dispatched = true;
  }

  if (args.addEdge) {
    addEdge(args.addEdge);
    dispatched = true;
  }

  if (args.removeEdge) {
    removeEdge(args.removeEdge);
    dispatched = true;
  }

  if (args.agent && args.wan) {
    const agent = resolveAgent(args.agent);
    await setWan(agent, args.wan, args.domains);
    dispatched = true;
  } else if (args.agent && args.addDomain) {
    const agent = resolveAgent(args.agent);
    await addDomain(agent, args.addDomain, args.note);
    dispatched = true;
  } else if (args.agent && args.removeDomain) {
    const agent = resolveAgent(args.agent);
    await removeDomain(agent, args.removeDomain);
    dispatched = true;
  } else if (args.agent && args.cdpPort !== undefined) {
    const agent = resolveAgent(args.agent);
    await setCdpPort(agent, args.cdpPort);
    dispatched = true;
  } else if (args.agent && !args.wan && !args.addDomain && !args.removeDomain && args.cdpPort === undefined) {
    fatal('--agent must be paired with --wan, --add-domain, --remove-domain, or --cdp-port (use --show for inspection)');
  } else if ((args.wan || args.addDomain || args.removeDomain || args.cdpPort !== undefined) && !args.agent) {
    fatal('--wan, --add-domain, --remove-domain, --cdp-port all require --agent');
  }

  if (!dispatched) {
    printHelp();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
