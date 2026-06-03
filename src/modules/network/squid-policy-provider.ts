/**
 * Squid-based NetworkPolicyProvider.
 *
 * Registers itself at module-import time. Implements the two hooks:
 *
 *   - `ensure()` brings up the egress Docker network (subnet-pinned, no
 *     NAT) + Squid container at host startup. Walks the central DB to
 *     allocate IPs for any agent group that doesn't have one yet, and
 *     sweeps orphan IP entries whose agent_group_id no longer exists.
 *     Idempotent.
 *
 *   - `applyContainerArgs()` looks up the agent's pre-allocated IP on the
 *     egress network, adds `--ip <ip>` and `--network <egress>` to the
 *     spawn args, and rewrites the agent's HTTPS_PROXY to point at Squid.
 *     If the agent doesn't have an allocation yet (e.g. it was created
 *     since the last host bounce), we allocate on the fly.
 *
 * Agent identity at Squid = source IP. Per-agent ACLs are keyed by
 * `src <ip>/32`. A request from any IP not in the allocation table falls
 * through to the final `http_access deny all` and the agent has no
 * internet. That's the "no allocation → no access" guarantee — agents
 * never have NAT (the egress network is `--internal`), so the only way
 * out is through Squid, and Squid only knows IPs in `ips.json`.
 *
 * Squid forwards to OneCLI via `cache_peer parent ... login=PASSTHRU`,
 * preserving the agent's Proxy-Authorization (its OneCLI per-agent token)
 * end-to-end. Squid never authenticates agents itself — IP IS identity.
 *
 * Per-agent allowlists are computed from `agent_groups.internet_access_policy`
 * (opaque JSON, owned by this skill) unioned with the agent's provider's
 * canonical hosts (from `provider-hosts-registry.ts`). Buckets:
 *
 *   - `full`        → `dst all`
 *   - `whitelisted` → `dstdomain <configured-hostnames> ∪ <provider-hosts>`
 *                     plus `dst <configured-ip-literals>` for any IPv4 entries
 *                     (LAN IPs bypass the OneCLI parent and route direct —
 *                     OneCLI can't tunnel CONNECTs to private LAN IPs).
 *   - `model-only`  → `dstdomain <provider-hosts>`
 *   - missing/null  → treated as `full` for backward-compat with agents
 *                     that pre-date the skill's installation.
 *
 * Whitelist domains may be plain strings (legacy) or `{domain, note?,
 * added_at?}` objects. The note is operator-facing only — Squid only
 * sees the domain string. The same `domains` array carries both hostnames
 * and IPv4 literals; the provider classifies at config-gen time so the
 * operator interface remains a single list ("destinations you can reach").
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import { isIPv4 } from 'net';
import path from 'path';

import { CONTAINER_IMAGE_BASE, DATA_DIR } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { resolveProviderName } from '../../container-runner.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { getProviderHosts } from '../../providers/provider-hosts-registry.js';
import type { AgentGroup } from '../../types.js';
import { registerNetworkPolicyProvider } from './registry.js';
import type { ContainerArgsContext, NetworkPolicyProvider } from './types.js';

const SQUID_DIR = path.join(DATA_DIR, 'squid');
const IPS_FILE = path.join(SQUID_DIR, 'ips.json');
const CONFIG_FILE = path.join(SQUID_DIR, 'squid.conf');
const DNSMASQ_CONFIG_FILE = path.join(SQUID_DIR, 'dnsmasq.conf');
const SOCAT_FORWARDS_FILE = path.join(SQUID_DIR, 'socat-forwards.conf');
const LOGS_DIR = path.join(SQUID_DIR, 'logs');
const ROTATE_STATE_FILE = path.join(SQUID_DIR, 'last-rotated.txt');
const SQUID_LISTEN_PORT = 3128;
const ONECLI_PARENT_HOST = 'host.docker.internal';
const ONECLI_PARENT_PORT = 10255;
const LOG_RETENTION_MONTHS = 6;

const NETWORK_NAME = `${CONTAINER_IMAGE_BASE}-egress`;
const CONTAINER_NAME = `${CONTAINER_IMAGE_BASE}-squid`;
const IMAGE_NAME = `${CONTAINER_IMAGE_BASE}-squid:latest`;

// Subnet for the egress network. /24 = 256 addresses, plenty for ~20-50
// active agents. .0 (network), .255 (broadcast), .1 (gateway) reserved
// by Docker. Squid takes .2; agents get .3 through .254.
const EGRESS_SUBNET = '172.30.0.0/24';
const EGRESS_GATEWAY = '172.30.0.1';
const SQUID_IP = '172.30.0.2';
const AGENT_IP_START = 3;
const AGENT_IP_END = 254;

export interface DomainEntry {
  domain: string;
  note?: string;
  added_at?: string;
}

export interface InternetAccessPolicy {
  bucket: 'full' | 'whitelisted' | 'model-only';
  domains?: (string | DomainEntry)[];
  /**
   * If set, this agent can drive a host-side Chrome via CDP. `cdpPort` is
   * the *container-side* listen port on the Squid container — each agent
   * needs a unique value so the per-(src-IP, dst, port) socat listener can
   * isolate them. The agent's helper dials `host.docker.internal:<cdpPort>`
   * (resolved to Squid's egress IP via --add-host) and socat tunnels the
   * raw TCP to the host's Chrome at `<cdpHostPort>` (default 9222).
   *
   * The provider also emits per-agent Squid ACLs that bypass the global
   * Safe_ports deny (CDP ports aren't 80/443) and bypass the OneCLI parent
   * peer (OneCLI can't tunnel CONNECTs to host-loopback destinations).
   */
  cdpPort?: number;
  /**
   * Port on the actual host that the CDP service (Chrome) listens on.
   * Defaults to 9222 (Chrome's standard remote-debugging port). Distinct
   * from `cdpPort` so multiple agents can share one host Chrome via
   * unique container-side listen ports.
   */
  cdpHostPort?: number;
}

interface IpMap {
  [agentGroupId: string]: string;
}

// ── IP allocation ───────────────────────────────────────────────────────────

function loadIpMap(): IpMap {
  try {
    return JSON.parse(fs.readFileSync(IPS_FILE, 'utf8')) as IpMap;
  } catch {
    return {};
  }
}

function saveIpMap(map: IpMap): void {
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  fs.writeFileSync(IPS_FILE, JSON.stringify(map, null, 2));
}

function nextFreeIp(map: IpMap): string | null {
  const used = new Set(Object.values(map));
  used.add(EGRESS_GATEWAY);
  used.add(SQUID_IP);
  for (let octet4 = AGENT_IP_START; octet4 <= AGENT_IP_END; octet4 += 1) {
    const ip = `172.30.0.${octet4}`;
    if (!used.has(ip)) return ip;
  }
  return null;
}

/**
 * Get an agent's IP on the egress network, allocating one if missing.
 * Returns null if the address pool is exhausted (operator should delete
 * unused agents or widen the subnet).
 */
function allocateAgentIp(agentGroupId: string): string | null {
  const map = loadIpMap();
  const existing = map[agentGroupId];
  if (existing) return existing;
  const ip = nextFreeIp(map);
  if (!ip) return null;
  map[agentGroupId] = ip;
  saveIpMap(map);
  return ip;
}

/**
 * Drop entries from ips.json whose agent_group_id no longer exists in
 * the central DB. Runs at startup so freed addresses can be recycled
 * after a deletion + bounce.
 */
function sweepOrphanIps(): number {
  const map = loadIpMap();
  const liveIds = new Set(getAllAgentGroups().map((a) => a.id));
  let removed = 0;
  for (const id of Object.keys(map)) {
    if (!liveIds.has(id)) {
      delete map[id];
      removed += 1;
    }
  }
  if (removed > 0) {
    saveIpMap(map);
    log.info('squid-policy-provider: swept orphan IP allocations', { removed });
  }
  return removed;
}

/**
 * Ensure every agent in the central DB has an IP allocation. Called at
 * startup so the steady-state guarantee "an agent has an IP" holds
 * without per-spawn allocation. New agents created since last bounce
 * get lazy-allocated in `applyContainerArgs` instead.
 */
function ensureAllAgentsHaveIps(): void {
  for (const agent of getAllAgentGroups()) {
    const ip = allocateAgentIp(agent.id);
    if (!ip) {
      log.warn('squid-policy-provider: IP pool exhausted, agent not allocated', {
        agentGroupId: agent.id,
        agentName: agent.name,
      });
    }
  }
}

// ── Policy parsing ──────────────────────────────────────────────────────────

function parsePolicy(raw: string | null | undefined): InternetAccessPolicy {
  if (!raw) return { bucket: 'full' };
  try {
    const parsed = JSON.parse(raw) as Partial<InternetAccessPolicy>;
    const bucket = parsed.bucket;
    if (bucket === 'full' || bucket === 'whitelisted' || bucket === 'model-only') {
      const result: InternetAccessPolicy = {
        bucket,
        domains: Array.isArray(parsed.domains) ? parsed.domains : [],
      };
      if (typeof parsed.cdpPort === 'number') result.cdpPort = parsed.cdpPort;
      if (typeof parsed.cdpHostPort === 'number') result.cdpHostPort = parsed.cdpHostPort;
      return result;
    }
    log.warn('squid-policy-provider: unknown bucket in internet_access_policy, defaulting to full', { raw });
    return { bucket: 'full' };
  } catch (err) {
    log.warn('squid-policy-provider: malformed internet_access_policy JSON, defaulting to full', { raw, err });
    return { bucket: 'full' };
  }
}

/** Extract just the domain strings from a policy, accepting both legacy
 *  `string[]` entries and `{domain, note?}` objects. */
export function domainStrings(policy: InternetAccessPolicy): string[] {
  return (policy.domains ?? []).map((d) => (typeof d === 'string' ? d : d.domain));
}

function effectiveAllowList(agent: AgentGroup): string[] | 'all' {
  const policy = parsePolicy(agent.internet_access_policy);
  const providerHosts = getProviderHosts(resolveProviderName(null, agent.agent_provider));

  switch (policy.bucket) {
    case 'full':
      return 'all';
    case 'whitelisted':
      return Array.from(new Set([...domainStrings(policy), ...providerHosts]));
    case 'model-only':
      return [...providerHosts];
  }
}

/**
 * Squid's `dstdomain` matches the literal hostname when the entry lacks
 * a leading dot (`proton.me` only matches `proton.me`, not
 * `calendar.proton.me`). Adding the dot makes it cover the apex AND
 * every subdomain — almost always what operators mean when they
 * whitelist a domain. Provider host entries already carry the dot.
 */
function toDstdomainEntry(d: string): string {
  if (d.startsWith('.')) return d;
  // Bare IPs and 'all' shouldn't get a dot prefix. Numeric leading char
  // is a cheap IP-detect that's good enough for our use.
  if (/^\d/.test(d)) return d;
  return `.${d}`;
}

// ── Squid config generation ─────────────────────────────────────────────────

/** A short, ACL-safe identifier for an agent group. */
function aclSlug(agentGroupId: string): string {
  return agentGroupId.replace(/[^a-zA-Z0-9]/g, '_');
}

function generateSquidConfig(agents: AgentGroup[], ips: IpMap): string {
  const lines: string[] = [];
  lines.push('# /etc/squid/squid.conf — generated by the agent-network skill');
  lines.push('# DO NOT EDIT — overwritten on every reconfigure.');
  lines.push('');
  lines.push('# --- Cache + DNS -----------------------------------------------------------');
  lines.push('cache deny all');
  lines.push('visible_hostname nanoclaw-squid');
  lines.push('');
  lines.push('# --- Forward chain to OneCLI gateway --------------------------------------');
  lines.push('# OneCLI accepts per-agent BasicAuth tokens that the agent itself sets in');
  lines.push("# its HTTPS_PROXY env var. login=PASSTHRU forwards the agent's");
  lines.push('# Proxy-Authorization header unchanged so OneCLI sees the original token.');
  lines.push(
    `cache_peer ${ONECLI_PARENT_HOST} parent ${ONECLI_PARENT_PORT} 0 no-query no-digest default login=PASSTHRU connect-timeout=5 name=onecli`,
  );
  lines.push('# `never_direct allow all` is emitted near the bottom of this file —');
  lines.push('# AFTER any per-agent `never_direct deny ...` lines for LAN whitelist');
  lines.push('# entries, since never_direct is evaluated first-match-wins.');
  lines.push('');
  lines.push('# --- Safety port ACL definitions ------------------------------------------');
  lines.push('# Declared early; the `http_access deny !Safe_ports` line is emitted further');
  lines.push('# down, AFTER per-agent LAN allows. LAN destinations may legitimately use');
  lines.push('# non-standard ports (e.g. the Neo Smart Controller on 8838), so their allow');
  lines.push('# rules must short-circuit the Safe_ports check. Hostname/WAN allows stay');
  lines.push('# below the Safe_ports deny so non-IP whitelists are still port-restricted.');
  lines.push('acl SSL_ports port 443');
  lines.push('acl Safe_ports port 80 443');
  lines.push('acl CONNECT method CONNECT');
  lines.push('');
  lines.push('# --- Listener -------------------------------------------------------------');
  lines.push(`http_port 0.0.0.0:${SQUID_LISTEN_PORT}`);
  lines.push('');
  lines.push('# --- Log format -----------------------------------------------------------');
  lines.push('# Human-readable: local timestamp, src IP, agent name (from note tag below),');
  lines.push('# squid status / HTTP code, method, target URL, response size.');
  lines.push('# Unidentified source IPs (no matching agent ACL) show "-" in the agent slot.');
  lines.push('logformat nanoclaw %{%Y-%m-%d %H:%M:%S}tl %>a %{agent}note %Ss/%>Hs %rm %ru %<st');
  lines.push('access_log stdio:/var/log/squid/access.log nanoclaw');
  lines.push('');
  lines.push('# --- Per-agent ACL definitions --------------------------------------------');
  lines.push('# Just the ACL declarations + agent note tags. The actual http_access grants');
  lines.push('# are split into two sections below: LAN allows (before Safe_ports deny) and');
  lines.push('# WAN/hostname allows (after Safe_ports deny). Any source IP without an ACL');
  lines.push('# falls through to the final deny — no allocation in ips.json = no internet.');

  // Pre-compute per-agent classifications so we can emit them in two http_access
  // passes (LAN before Safe_ports, WAN after). One pass through agents builds
  // the three lists; we then splice each into its correct position below.
  interface AgentEmit {
    slug: string;
    allowKind: 'all' | 'empty' | 'list';
    hostnames: string[];
    lanIps: string[];
    cdpPort?: number;
  }
  const emits: AgentEmit[] = [];

  for (const agent of agents) {
    const ip = ips[agent.id];
    if (!ip) continue;
    const slug = aclSlug(agent.id);
    const allow = effectiveAllowList(agent);
    const policy = parsePolicy(agent.internet_access_policy);

    lines.push('');
    lines.push(`# Agent: ${agent.name} (${agent.id}) — ip=${ip} bucket=${policy.bucket}`);
    lines.push(`acl from_${slug} src ${ip}/32`);
    // Tag matching transactions with the agent's folder name so the log
    // line shows "diddyclaw" rather than just "172.30.0.3". Folder names
    // are already slug-safe (lowercase, hyphenated) so no extra escaping.
    lines.push(`note agent ${agent.folder} from_${slug}`);

    // CDP per-agent destination: `dstdomain host.docker.internal` paired with
    // an agent-specific port ACL. Each agent gets a uniquely-named port ACL so
    // the per-(src, dst, port) http_access grant is exclusive to that agent.
    if (policy.cdpPort && Number.isInteger(policy.cdpPort) && policy.cdpPort > 0) {
      lines.push(`acl cdp_dst_${slug} dstdomain host.docker.internal`);
      lines.push(`acl cdp_port_${slug} port ${policy.cdpPort}`);
    }

    if (allow === 'all') {
      emits.push({
        slug,
        allowKind: 'all',
        hostnames: [],
        lanIps: [],
        cdpPort: policy.cdpPort,
      });
    } else if (allow.length === 0) {
      lines.push(`# No allowed destinations — provider hosts empty for bucket=${policy.bucket}`);
      emits.push({
        slug,
        allowKind: 'empty',
        hostnames: [],
        lanIps: [],
        cdpPort: policy.cdpPort,
      });
    } else {
      // Split hostnames from IPv4 literals. Hostnames go through `dstdomain`
      // (and via the OneCLI parent for credential injection). IPs go through
      // `dst` and bypass OneCLI — the parent is a forward HTTP proxy that
      // can't reach private LAN ranges and OneCLI has no use for traffic to
      // unmanaged endpoints anyway.
      const lanIps = allow.filter((e) => isIPv4(e));
      const hostnames = allow.filter((e) => !isIPv4(e));

      if (hostnames.length > 0) {
        const entries = hostnames.map(toDstdomainEntry);
        lines.push(`acl allowed_${slug} dstdomain ${entries.join(' ')}`);
      }
      if (lanIps.length > 0) {
        lines.push(`acl allowed_lan_${slug} dst ${lanIps.join(' ')}`);
      }
      emits.push({
        slug,
        allowKind: 'list',
        hostnames,
        lanIps,
        cdpPort: policy.cdpPort,
      });
    }
  }

  // --- Phase 1: per-agent LAN + CDP allows + per-(src,dst) routing bypass ---
  // These MUST come before `http_access deny !Safe_ports` so LAN destinations
  // on non-standard ports (e.g. Neo Smart Controller on 8838) and CDP ports
  // (typically 9222+) are admitted before the global port check fires.
  const hasLan = emits.some((e) => e.lanIps.length > 0);
  const hasCdp = emits.some((e) => e.cdpPort);
  if (hasLan || hasCdp) {
    lines.push('');
    lines.push('# --- Per-agent LAN + CDP allows (BEFORE Safe_ports deny) ------------------');
    lines.push('# These allows fire before the global non-standard-port deny so each agent');
    lines.push('# can reach its whitelisted LAN IPs and its host-side CDP endpoint regardless');
    lines.push('# of port. The paired `cache_peer_access`/`never_direct` denies steer each');
    lines.push('# matching (src, dst) pair direct instead of through the OneCLI parent,');
    lines.push("# which can't tunnel to LAN or host-loopback destinations.");
    for (const e of emits) {
      if (e.lanIps.length > 0) {
        lines.push(`http_access allow from_${e.slug} allowed_lan_${e.slug}`);
        lines.push(`cache_peer_access onecli deny from_${e.slug} allowed_lan_${e.slug}`);
        lines.push(`never_direct deny from_${e.slug} allowed_lan_${e.slug}`);
      }
      if (e.cdpPort) {
        lines.push(`http_access allow from_${e.slug} cdp_dst_${e.slug} cdp_port_${e.slug}`);
        lines.push(`cache_peer_access onecli deny from_${e.slug} cdp_dst_${e.slug} cdp_port_${e.slug}`);
        lines.push(`never_direct deny from_${e.slug} cdp_dst_${e.slug} cdp_port_${e.slug}`);
      }
    }
  }

  lines.push('');
  lines.push('# --- Global port safety denies --------------------------------------------');
  lines.push('# Block any request to a non-Safe_port (anything not 80/443) and any');
  lines.push('# CONNECT to a non-SSL_port. Per-agent LAN allows above already short-');
  lines.push('# circuited their narrowly-scoped (src, dst) pairs, so this catches');
  lines.push('# everything else: hostname-whitelist traffic to weird ports, unauthorized');
  lines.push('# CONNECTs, etc.');
  lines.push('http_access deny !Safe_ports');
  lines.push('http_access deny CONNECT !SSL_ports');

  // --- Phase 2: per-agent WAN/hostname allows (AFTER Safe_ports deny) ---
  lines.push('');
  lines.push('# --- Per-agent WAN/hostname allows (after Safe_ports deny) ----------------');
  for (const e of emits) {
    if (e.allowKind === 'all') {
      lines.push(`http_access allow from_${e.slug}`);
    } else if (e.allowKind === 'empty') {
      lines.push(`http_access deny from_${e.slug}`);
    } else if (e.hostnames.length > 0) {
      lines.push(`http_access allow from_${e.slug} allowed_${e.slug}`);
    }
  }

  lines.push('');
  lines.push('# --- Final deny -----------------------------------------------------------');
  lines.push('http_access deny all');
  lines.push('');
  lines.push('# --- Global routing (after per-agent denies; first-match-wins) ------------');
  lines.push("# Catch-all for every request that wasn't covered by a per-agent LAN");
  lines.push('# `never_direct deny`. Force it through the OneCLI parent so credentials');
  lines.push('# can be injected on the way out.');
  lines.push('never_direct allow all');
  lines.push('');
  lines.push('# --- Logging (access_log defined with custom format above) ----------------');
  lines.push('cache_log /var/log/squid/cache.log');
  lines.push('');
  return lines.join('\n');
}

function writeSquidConfig(): void {
  const agents = getAllAgentGroups();
  const ips = loadIpMap();
  const conf = generateSquidConfig(agents, ips);
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, conf);
}

// ── dnsmasq config ──────────────────────────────────────────────────────────

/**
 * dnsmasq config: NXDOMAIN-everything black hole. Docker's `--internal`
 * network already blocks the embedded resolver from forwarding queries,
 * so this is a second layer that we can OBSERVE — every query is logged
 * with timestamp + source IP. Agents using HTTPS_PROXY don't resolve
 * locally (Squid does it server-side), so legitimate traffic isn't
 * affected; queries that DO land here are signs of an agent bypassing
 * the proxy convention, which is exactly what we want a record of.
 */
function generateDnsmasqConfig(): string {
  const lines: string[] = [];
  lines.push('# /etc/dnsmasq.conf — generated by the agent-network skill');
  lines.push('# DO NOT EDIT — overwritten on every reconfigure.');
  lines.push('');
  lines.push('# Listen on UDP/TCP 53 on all interfaces (egress + bridge).');
  lines.push('# Agents on the egress network reach us via 172.30.0.2:53.');
  lines.push('port=53');
  lines.push('bind-dynamic');
  lines.push('');
  lines.push('# No upstream forwarders, no /etc/hosts, no /etc/resolv.conf.');
  lines.push('# With no upstream to forward to and no records to answer from,');
  lines.push('# dnsmasq returns REFUSED for every query (functionally equivalent');
  lines.push('# to NXDOMAIN for our purposes — the agent learns "DNS does not');
  lines.push('# work" and gives up). A clean NXDOMAIN would require running an');
  lines.push('# authoritative server with an explicit empty zone; not worth the');
  lines.push('# extra complexity for the same outcome.');
  lines.push('no-resolv');
  lines.push('no-poll');
  lines.push('no-hosts');
  lines.push('');
  lines.push('# Logging — every query, with extra detail and source IP.');
  lines.push('log-queries=extra');
  lines.push('log-facility=/var/log/squid/dns.log');
  lines.push('');
  return lines.join('\n');
}

function writeDnsmasqConfig(): void {
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  fs.writeFileSync(DNSMASQ_CONFIG_FILE, generateDnsmasqConfig());
}

// ── socat per-agent CDP forwarders ─────────────────────────────────────────
//
// Agents whose policy has `cdpPort` set need a raw-TCP path to the
// host-side CDP proxy at host.docker.internal:<cdpPort>. The HTTP
// fetch portion of the CDP handshake works fine through Squid's
// HTTP_PROXY path, but the subsequent WebSocket connection bypasses
// HTTP_PROXY (Playwright/ws library limitation) and tries direct DNS
// for `host.docker.internal` from inside the container — which fails
// because the egress network is --internal and DNS points at our
// sinkhole.
//
// The fix: have the agent container resolve `host.docker.internal` to
// the Squid container's egress IP (via container-runner adding
// `--add-host host.docker.internal:172.30.0.2`), and have Squid run a
// per-agent socat forwarder that bridges TCP from that port to the
// real host.docker.internal on the bridge network. Each forwarder is
// source-IP restricted to exactly one agent, so Wild Internet's port
// can't be reached by Diddyclaw and vice versa.

/** Default port for the host-side CDP endpoint (Chrome's standard
 *  remote-debugging port). Override per-agent with `cdpHostPort` if your
 *  host-side Chrome is bound elsewhere. */
const DEFAULT_CDP_HOST_PORT = 9222;

function generateSocatForwardsConfig(agents: AgentGroup[], ips: IpMap): string {
  const lines: string[] = [];
  lines.push('# Per-agent CDP TCP forwarders — generated by squid-policy-provider.');
  lines.push('# Format: <listen-port> <source-ip-or-cidr> <upstream-host> <upstream-port>');
  lines.push('# Each line spawns one socat process inside the Squid container.');
  lines.push('# Source IPs are /32 — exactly one agent reachable per forwarder port.');
  lines.push('# Listen port (cdpPort) is per-agent so the source-IP filter actually');
  lines.push('# isolates them; upstream port (cdpHostPort, default 9222) is the same');
  lines.push('# host-side Chrome for everyone unless explicitly varied.');
  lines.push('');
  for (const agent of agents) {
    const policy = parsePolicy(agent.internet_access_policy);
    if (!policy.cdpPort) continue;
    const ip = ips[agent.id];
    if (!ip) continue;
    const hostPort = policy.cdpHostPort ?? DEFAULT_CDP_HOST_PORT;
    lines.push(`# ${agent.name} (${agent.folder}, ${agent.id})`);
    lines.push(`${policy.cdpPort} ${ip}/32 host.docker.internal ${hostPort}`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeSocatForwardsConfig(): void {
  const agents = getAllAgentGroups();
  const ips = loadIpMap();
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  fs.writeFileSync(SOCAT_FORWARDS_FILE, generateSocatForwardsConfig(agents, ips));
}

// ── Log rotation ────────────────────────────────────────────────────────────

const LOG_BASENAMES = ['access.log', 'dns.log', 'cache.log'] as const;

/**
 * Format a Date as `YYYY-MM` in UTC. We rotate on month boundaries (UTC)
 * so it's a calendar-driven decision, not subject to host timezone shifts.
 */
function monthKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function readLastRotatedMonth(): string | null {
  try {
    return fs.readFileSync(ROTATE_STATE_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeLastRotatedMonth(month: string): void {
  fs.mkdirSync(SQUID_DIR, { recursive: true });
  fs.writeFileSync(ROTATE_STATE_FILE, month);
}

/**
 * If the calendar month has rolled over since last rotation, archive
 * each log file as `<base>-YYYY-MM.log`, gzip it, prune anything older
 * than `LOG_RETENTION_MONTHS`, and signal the daemons to reopen their
 * handles. Idempotent within a month: re-running on the same month is
 * a no-op.
 */
function rotateLogsIfNeeded(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const now = new Date();
  const currentMonth = monthKey(now);
  const lastRotated = readLastRotatedMonth();

  if (lastRotated === currentMonth) {
    pruneOldArchives(now);
    return;
  }

  // The month we're rotating OUT belongs to whatever the prior live
  // files were. We don't actually need to know that to name correctly —
  // we just use the previous calendar month relative to "now". If the
  // host has been down across multiple month boundaries, only one
  // archive is produced; we accept the smudge.
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const archiveSuffix = monthKey(prev);

  for (const base of LOG_BASENAMES) {
    const live = path.join(LOGS_DIR, base);
    if (!fs.existsSync(live) || fs.statSync(live).size === 0) continue;
    const stem = base.replace(/\.log$/, '');
    const archive = path.join(LOGS_DIR, `${stem}-${archiveSuffix}.log`);
    try {
      fs.renameSync(live, archive);
      // Gzip the archive (sync) using zlib so we don't depend on the
      // gzip binary being present.
      const gz = `${archive}.gz`;
      const zlib = require('zlib') as typeof import('zlib');
      const buf = fs.readFileSync(archive);
      fs.writeFileSync(gz, zlib.gzipSync(buf));
      fs.unlinkSync(archive);
      log.info('squid-policy-provider: rotated log', { file: base, archive: path.basename(gz) });
    } catch (err) {
      log.warn('squid-policy-provider: rotation failed', { file: base, err });
    }
  }

  pruneOldArchives(now);
  signalDaemonsReopenLogs();
  writeLastRotatedMonth(currentMonth);
}

function pruneOldArchives(now: Date): void {
  if (!fs.existsSync(LOGS_DIR)) return;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - LOG_RETENTION_MONTHS, 1));
  const cutoffKey = monthKey(cutoff);
  for (const f of fs.readdirSync(LOGS_DIR)) {
    // Match `<stem>-YYYY-MM.log[.gz]` and compare YYYY-MM lexically.
    const m = /^[a-z]+-([0-9]{4}-[0-9]{2})\.log(\.gz)?$/.exec(f);
    if (!m) continue;
    if (m[1] < cutoffKey) {
      try {
        fs.unlinkSync(path.join(LOGS_DIR, f));
        log.info('squid-policy-provider: pruned old log archive', { file: f });
      } catch (err) {
        log.warn('squid-policy-provider: prune failed', { file: f, err });
      }
    }
  }
}

function signalDaemonsReopenLogs(): void {
  if (!containerRunning(CONTAINER_NAME)) return;
  try {
    // Squid: `-k rotate` triggers log reopening (its built-in rotation).
    execFileSync(CONTAINER_RUNTIME_BIN, ['exec', CONTAINER_NAME, 'squid', '-k', 'rotate'], { stdio: 'pipe' });
  } catch (err) {
    log.warn('squid-policy-provider: squid -k rotate failed', { err });
  }
  try {
    // dnsmasq: SIGUSR2 reopens its log file.
    execFileSync(CONTAINER_RUNTIME_BIN, ['exec', CONTAINER_NAME, 'sh', '-c', 'pkill -USR2 dnsmasq'], {
      stdio: 'pipe',
    });
  } catch (err) {
    log.warn('squid-policy-provider: dnsmasq SIGUSR2 failed', { err });
  }
}

let rotateTimer: NodeJS.Timeout | null = null;

function startRotationTimer(): void {
  if (rotateTimer) return;
  // Check once an hour. Rotation only does work when the month rolls
  // over; the rest are cheap no-ops.
  rotateTimer = setInterval(
    () => {
      try {
        rotateLogsIfNeeded();
      } catch (err) {
        log.warn('squid-policy-provider: scheduled rotation failed', { err });
      }
    },
    60 * 60 * 1000,
  );
  // Don't keep the event loop alive just for this timer.
  if (typeof rotateTimer.unref === 'function') rotateTimer.unref();
}

// ── Docker primitives ───────────────────────────────────────────────────────

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function dockerOutput(args: string[]): string {
  try {
    return execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    return '';
  }
}

function networkExists(name: string): boolean {
  return dockerOutput(['network', 'ls', '--format', '{{.Name}}'])
    .split('\n')
    .map((s) => s.trim())
    .includes(name);
}

function networkSubnet(name: string): string | null {
  const out = dockerOutput(['network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}}{{end}}', name]).trim();
  return out || null;
}

function imageExists(tag: string): boolean {
  return dockerOk(['image', 'inspect', tag]);
}

function containerRunning(name: string): boolean {
  const out = dockerOutput(['inspect', '--format', '{{.State.Status}}', name]).trim();
  return out === 'running';
}

function containerExists(name: string): boolean {
  return dockerOutput(['ps', '-a', '--format', '{{.Names}}'])
    .split('\n')
    .map((s) => s.trim())
    .includes(name);
}

function reconfigureSquid(): void {
  if (!containerRunning(CONTAINER_NAME)) return;
  try {
    // Re-render /tmp/squid.conf from the mounted /etc/squid/squid.conf,
    // substituting host.docker.internal → its IPv4 on `cache_peer` lines
    // only (see entrypoint.sh for the rationale — Squid 6 prefers IPv6,
    // OneCLI is IPv4-only, but dstdomain ACLs must keep the hostname so
    // they match the client's literal request URL). Squid runs from
    // /tmp/squid.conf, so the rewrite must happen on every reload, not
    // just at startup.
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'exec',
        CONTAINER_NAME,
        'sh',
        '-c',
        "HOST_V4=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR==1 {print $1}'); " +
          'cp /etc/squid/squid.conf /tmp/squid.conf && ' +
          'if [ -n "$HOST_V4" ]; then sed -i "/^cache_peer /s/host\\.docker\\.internal/$HOST_V4/g" /tmp/squid.conf; fi && ' +
          'squid -k reconfigure',
      ],
      { stdio: 'pipe' },
    );
    log.info('squid-policy-provider: squid -k reconfigure', { container: CONTAINER_NAME });
  } catch (err) {
    log.warn('squid-policy-provider: reconfigure failed', { err });
  }
}

function createEgressNetwork(): void {
  execFileSync(
    CONTAINER_RUNTIME_BIN,
    ['network', 'create', '--internal', '--subnet', EGRESS_SUBNET, '--gateway', EGRESS_GATEWAY, NETWORK_NAME],
    { stdio: 'pipe' },
  );
  log.info('squid-policy-provider: network created', { network: NETWORK_NAME, subnet: EGRESS_SUBNET });
}

function startSquidContainer(): void {
  if (containerExists(CONTAINER_NAME)) {
    if (containerRunning(CONTAINER_NAME)) return;
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' });
  }

  const args = [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '--restart',
    'unless-stopped',
    // Initial attachment is `bridge` so Squid has NAT to the host (and
    // via host-gateway, OneCLI on host.docker.internal:10255). We then
    // attach the egress network with our reserved Squid IP as a second
    // NIC below.
    '--network',
    'bridge',
    '--add-host',
    `${ONECLI_PARENT_HOST}:host-gateway`,
    '-v',
    `${CONFIG_FILE}:/etc/squid/squid.conf:ro`,
    '-v',
    `${DNSMASQ_CONFIG_FILE}:/etc/dnsmasq.conf:ro`,
    '-v',
    `${SOCAT_FORWARDS_FILE}:/etc/socat-forwards.conf:ro`,
    '-v',
    `${LOGS_DIR}:/var/log/squid`,
    IMAGE_NAME,
  ];
  execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe' });

  execFileSync(CONTAINER_RUNTIME_BIN, ['network', 'connect', '--ip', SQUID_IP, NETWORK_NAME, CONTAINER_NAME], {
    stdio: 'pipe',
  });
  log.info('squid-policy-provider: container started (dual-homed bridge + egress)', {
    name: CONTAINER_NAME,
    egressIp: SQUID_IP,
  });
}

// ── Provider implementation ────────────────────────────────────────────────

export const squidPolicyProvider: NetworkPolicyProvider = {
  async ensure() {
    fs.mkdirSync(SQUID_DIR, { recursive: true });

    if (!networkExists(NETWORK_NAME)) {
      createEgressNetwork();
    } else {
      const subnet = networkSubnet(NETWORK_NAME);
      if (subnet && subnet !== EGRESS_SUBNET) {
        log.warn('squid-policy-provider: egress network has unexpected subnet', {
          expected: EGRESS_SUBNET,
          actual: subnet,
        });
      }
    }

    if (!imageExists(IMAGE_NAME)) {
      log.info('squid-policy-provider: building Squid image', { image: IMAGE_NAME });
      const buildScript = path.resolve(process.cwd(), 'container/squid/build.sh');
      execFileSync('bash', [buildScript], { stdio: 'inherit' });
    }

    // Reconcile IP allocations against the DB before generating config.
    sweepOrphanIps();
    ensureAllAgentsHaveIps();

    writeSquidConfig();
    writeDnsmasqConfig();
    writeSocatForwardsConfig();
    fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Rotate logs at boot if a month has elapsed since last rotation,
    // then schedule hourly checks for the rest of the process lifetime.
    rotateLogsIfNeeded();
    startRotationTimer();

    if (!containerRunning(CONTAINER_NAME)) {
      startSquidContainer();
    } else {
      reconfigureSquid();
    }
  },

  async applyContainerArgs(args: string[], { agentGroup }: ContainerArgsContext) {
    // Existing allocation? Use it. If this agent was created since the
    // last host bounce, allocate now and trigger a reconfigure so the
    // new IP gets an ACL.
    const existing = loadIpMap()[agentGroup.id];
    let ip: string | null = existing ?? null;

    if (!ip) {
      ip = allocateAgentIp(agentGroup.id);
      if (ip) {
        writeSquidConfig();
        reconfigureSquid();
        log.info('squid-policy-provider: lazy-allocated IP for newly-created agent', {
          agentGroupId: agentGroup.id,
          ip,
        });
      } else {
        log.warn('squid-policy-provider: IP pool exhausted, agent will have no internet', {
          agentGroupId: agentGroup.id,
        });
      }
    }

    // Attach to the egress network. With --internal + no NAT, this is
    // the only way out. If we failed to allocate an IP, Docker hands
    // the container whatever's free; Squid won't recognize that IP and
    // the default-deny catches it — no internet for that agent.
    if (ip) {
      args.push('--network', NETWORK_NAME, '--ip', ip);
    } else {
      args.push('--network', NETWORK_NAME);
    }

    // Point the agent's DNS at our dnsmasq (running alongside Squid on
    // the same container at 172.30.0.2:53). It NXDOMAINs everything and
    // logs the query — defense-in-depth on top of Docker's --internal
    // also blocking the embedded resolver from forwarding, plus the
    // logging we couldn't get otherwise.
    args.push('--dns', SQUID_IP);

    // CDP forwarding: if this agent has a host-side Chrome via CDP, point
    // `host.docker.internal` at Squid's egress IP so the agent's WS client
    // (which doesn't honor HTTP_PROXY) can reach Chrome through a socat
    // forwarder running inside the Squid container. agent-browser's HTTP
    // discovery still goes through HTTPS_PROXY → Squid via the normal
    // path; this --add-host is only consulted for direct hostname-to-IP
    // resolution by raw TCP libraries.
    const policy = parsePolicy(agentGroup.internet_access_policy);
    if (policy.cdpPort) {
      args.push('--add-host', `host.docker.internal:${SQUID_IP}`);
    }

    rewriteProxyEnv(args);

    // Chromium-specific env var. Chromium refuses to use proxy URLs
    // with embedded credentials (`http://user:pass@host:port`) — it
    // emits ERR_NO_SUPPORTED_PROXIES. agent-browser checks
    // AGENT_BROWSER_PROXY before HTTPS_PROXY, so set it to the auth-
    // less form here. OneCLI doesn't authenticate the proxy connection
    // itself (it uses the token only for credential injection on
    // managed hosts), so non-managed hosts like Proton work fine; for
    // managed hosts via the browser, the SDK path via HTTPS_PROXY
    // remains the right route.
    args.push('-e', `AGENT_BROWSER_PROXY=http://${SQUID_IP}:${SQUID_LISTEN_PORT}`);
  },
};

function rewriteProxyEnv(args: string[]): void {
  const proxyKeys = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']);

  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-e') continue;
    const env = args[i + 1] ?? '';
    const eq = env.indexOf('=');
    if (eq <= 0) continue;
    const key = env.slice(0, eq);
    if (!proxyKeys.has(key)) continue;

    let url: URL;
    try {
      url = new URL(env.slice(eq + 1));
    } catch {
      continue;
    }
    url.host = `${SQUID_IP}:${SQUID_LISTEN_PORT}`;
    args[i + 1] = `${key}=${url.toString()}`;
  }
}

registerNetworkPolicyProvider(squidPolicyProvider);

/** Test-only exports — pure helpers, no Docker side-effects. */
export const __test__ = {
  aclSlug,
  parsePolicy,
  domainStrings,
  effectiveAllowList,
  toDstdomainEntry,
  generateSquidConfig,
  generateSocatForwardsConfig,
  generateDnsmasqConfig,
  rewriteProxyEnv,
  monthKey,
};
