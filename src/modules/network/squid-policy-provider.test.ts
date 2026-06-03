import { afterEach, describe, expect, it } from 'vitest';

import { registerProviderHosts, resetProviderHostsForTests } from '../../providers/provider-hosts-registry.js';
import type { AgentGroup } from '../../types.js';
import { __test__ } from './squid-policy-provider.js';

const {
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
} = __test__;

afterEach(() => {
  resetProviderHostsForTests();
});

const baseAgent: AgentGroup = {
  id: 'ag-1234567890-abcdef',
  name: 'Test Agent',
  folder: 'test-agent',
  agent_provider: 'claude',
  created_at: '2026-01-01T00:00:00Z',
};

describe('squid-policy-provider helpers', () => {
  describe('aclSlug', () => {
    it('replaces non-alphanumerics with underscores', () => {
      expect(aclSlug('ag-1234-abc')).toBe('ag_1234_abc');
      expect(aclSlug('ag.with.dots')).toBe('ag_with_dots');
      expect(aclSlug('plain')).toBe('plain');
    });
  });

  describe('parsePolicy', () => {
    it('returns full when raw is null/undefined/empty', () => {
      expect(parsePolicy(null)).toEqual({ bucket: 'full' });
      expect(parsePolicy(undefined)).toEqual({ bucket: 'full' });
      expect(parsePolicy('')).toEqual({ bucket: 'full' });
    });

    it('parses each valid bucket with legacy string domains', () => {
      expect(parsePolicy('{"bucket":"full"}')).toEqual({ bucket: 'full', domains: [] });
      expect(parsePolicy('{"bucket":"whitelisted","domains":["nytimes.com","reuters.com"]}')).toEqual({
        bucket: 'whitelisted',
        domains: ['nytimes.com', 'reuters.com'],
      });
      expect(parsePolicy('{"bucket":"model-only"}')).toEqual({ bucket: 'model-only', domains: [] });
    });

    it('parses whitelisted with rich domain entries (note + added_at)', () => {
      const raw = JSON.stringify({
        bucket: 'whitelisted',
        domains: [{ domain: 'nytimes.com', note: 'subscription', added_at: '2026-05-08T19:00:00Z' }, 'reuters.com'],
      });
      const parsed = parsePolicy(raw);
      expect(parsed.bucket).toBe('whitelisted');
      expect(parsed.domains).toEqual([
        { domain: 'nytimes.com', note: 'subscription', added_at: '2026-05-08T19:00:00Z' },
        'reuters.com',
      ]);
    });

    it('falls back to full on unknown bucket', () => {
      expect(parsePolicy('{"bucket":"weird"}')).toEqual({ bucket: 'full' });
    });

    it('falls back to full on malformed JSON', () => {
      expect(parsePolicy('{not json')).toEqual({ bucket: 'full' });
    });
  });

  describe('domainStrings', () => {
    it('extracts strings from a legacy string[] array', () => {
      expect(domainStrings({ bucket: 'whitelisted', domains: ['a.com', 'b.com'] })).toEqual(['a.com', 'b.com']);
    });

    it('extracts strings from rich DomainEntry objects', () => {
      expect(
        domainStrings({
          bucket: 'whitelisted',
          domains: [{ domain: 'a.com', note: 'for X' }, { domain: 'b.com' }],
        }),
      ).toEqual(['a.com', 'b.com']);
    });

    it('handles mixed legacy + rich entries', () => {
      expect(
        domainStrings({
          bucket: 'whitelisted',
          domains: ['a.com', { domain: 'b.com', note: 'why' }],
        }),
      ).toEqual(['a.com', 'b.com']);
    });

    it('returns [] when domains is missing', () => {
      expect(domainStrings({ bucket: 'full' })).toEqual([]);
    });
  });

  describe('effectiveAllowList', () => {
    it('returns "all" for full bucket regardless of provider', () => {
      const agent = { ...baseAgent, internet_access_policy: '{"bucket":"full"}' };
      expect(effectiveAllowList(agent)).toBe('all');
    });

    it('returns just provider hosts for model-only', () => {
      const agent = { ...baseAgent, internet_access_policy: '{"bucket":"model-only"}' };
      expect(effectiveAllowList(agent)).toEqual(['.api.anthropic.com']);
    });

    it('unions configured domains with provider hosts for whitelisted', () => {
      const agent = {
        ...baseAgent,
        internet_access_policy: '{"bucket":"whitelisted","domains":["nytimes.com","reuters.com"]}',
      };
      const result = effectiveAllowList(agent) as string[];
      expect(result.sort()).toEqual(['.api.anthropic.com', 'nytimes.com', 'reuters.com']);
    });

    it('extracts domains from rich entries for whitelisted', () => {
      const raw = JSON.stringify({
        bucket: 'whitelisted',
        domains: [{ domain: 'nytimes.com', note: 'subscription' }, 'reuters.com'],
      });
      const agent = { ...baseAgent, internet_access_policy: raw };
      const result = effectiveAllowList(agent) as string[];
      expect(result.sort()).toEqual(['.api.anthropic.com', 'nytimes.com', 'reuters.com']);
    });

    it('returns empty list for model-only with unregistered provider', () => {
      const agent = {
        ...baseAgent,
        agent_provider: 'mystery',
        internet_access_policy: '{"bucket":"model-only"}',
      };
      expect(effectiveAllowList(agent)).toEqual([]);
    });

    it('returns "all" when policy is missing (backward-compat default)', () => {
      const agent = { ...baseAgent, internet_access_policy: null };
      expect(effectiveAllowList(agent)).toBe('all');
    });

    it('honors registered hosts for non-claude providers', () => {
      registerProviderHosts('ollama', ['localhost', '127.0.0.1']);
      const agent = {
        ...baseAgent,
        agent_provider: 'ollama',
        internet_access_policy: '{"bucket":"model-only"}',
      };
      const result = effectiveAllowList(agent) as string[];
      expect(result.sort()).toEqual(['127.0.0.1', 'localhost']);
    });
  });

  describe('generateSquidConfig', () => {
    it('emits cache_peer parent + safety + per-agent src ACLs + final deny', () => {
      const agents = [
        { ...baseAgent, id: 'ag-A', internet_access_policy: '{"bucket":"full"}' },
        {
          ...baseAgent,
          id: 'ag-B',
          internet_access_policy: '{"bucket":"whitelisted","domains":["nytimes.com"]}',
        },
        { ...baseAgent, id: 'ag-C', internet_access_policy: '{"bucket":"model-only"}' },
      ];
      const ips = {
        'ag-A': '172.30.0.10',
        'ag-B': '172.30.0.11',
        'ag-C': '172.30.0.12',
      };

      const conf = generateSquidConfig(agents, ips);

      expect(conf).toContain('cache_peer host.docker.internal parent 10255');
      expect(conf).toContain('login=PASSTHRU');
      expect(conf).toContain('never_direct allow all');
      expect(conf).toContain('http_access deny !Safe_ports');

      // Single listener; no per-agent ports.
      expect(conf).toContain('http_port 0.0.0.0:3128');
      expect(conf).not.toContain('http_port 0.0.0.0:3129');

      // Custom human-readable log format + per-agent note tag.
      expect(conf).toContain('logformat nanoclaw');
      expect(conf).toContain('%{%Y-%m-%d %H:%M:%S}tl');
      expect(conf).toContain('%{agent}note');
      expect(conf).toContain('access_log stdio:/var/log/squid/access.log nanoclaw');

      // Per-agent src ACLs + note directives.
      expect(conf).toContain('acl from_ag_A src 172.30.0.10/32');
      expect(conf).toContain('note agent test-agent from_ag_A');
      expect(conf).toContain('acl from_ag_B src 172.30.0.11/32');
      expect(conf).toContain('note agent test-agent from_ag_B');
      expect(conf).toContain('acl from_ag_C src 172.30.0.12/32');
      expect(conf).toContain('note agent test-agent from_ag_C');

      // Per-bucket rules.
      expect(conf).toContain('http_access allow from_ag_A\n'); // full → no dst predicate
      // dstdomain entries are auto-prefixed with `.` to cover subdomains.
      expect(conf).toContain('dstdomain .nytimes.com .api.anthropic.com');
      expect(conf).toContain('http_access allow from_ag_B allowed_ag_B');
      expect(conf).toContain('dstdomain .api.anthropic.com'); // model-only

      // Final deny + ends with cache_log line.
      expect(conf.trim().endsWith('cache_log /var/log/squid/cache.log')).toBe(true);
      expect(conf).toContain('\nhttp_access deny all\n');

      // access_log is declared once (with the custom format), not twice.
      const accessLogLines = conf.split('\n').filter((l) => l.startsWith('access_log '));
      expect(accessLogLines).toHaveLength(1);
    });

    it('emits an explicit deny for an agent with no resolvable destinations', () => {
      const agents = [
        {
          ...baseAgent,
          id: 'ag-mystery',
          agent_provider: 'unknown-provider',
          internet_access_policy: '{"bucket":"model-only"}',
        },
      ];
      const ips = { 'ag-mystery': '172.30.0.10' };
      const conf = generateSquidConfig(agents, ips);
      expect(conf).toContain('# No allowed destinations');
      expect(conf).toContain('http_access deny from_ag_mystery');
    });

    it('skips agents that have no IP allocation', () => {
      const agents = [{ ...baseAgent, id: 'ag-A', internet_access_policy: '{"bucket":"full"}' }];
      const ips: Record<string, string> = {};
      const conf = generateSquidConfig(agents, ips);
      expect(conf).not.toContain('from_ag_A');
      expect(conf).not.toContain('allowed_ag_A');
    });

    it('always emits the listener even when no agents have IPs', () => {
      const conf = generateSquidConfig([], {});
      expect(conf).toContain('http_port 0.0.0.0:3128');
    });

    it('emits per-agent `dst` ACL and routing-bypass denies for LAN IPv4 whitelist entries', () => {
      // Two agents share the same whitelist conceptually but exercise different
      // mixes: Homie has IP-only (LAN), Mr Internet has hostname-only (WAN).
      const homiePolicy = JSON.stringify({
        bucket: 'whitelisted',
        domains: [{ domain: '192.168.30.4', note: 'Neo Smart Controller' }],
      });
      const mrInternetPolicy = JSON.stringify({
        bucket: 'whitelisted',
        domains: ['nytimes.com'],
      });
      const agents = [
        { ...baseAgent, id: 'ag-homie', folder: 'homie', internet_access_policy: homiePolicy },
        { ...baseAgent, id: 'ag-mr', folder: 'mr-internet', internet_access_policy: mrInternetPolicy },
      ];
      const ips = { 'ag-homie': '172.30.0.20', 'ag-mr': '172.30.0.21' };
      const conf = generateSquidConfig(agents, ips);

      // Homie: dst ACL with the raw IP literal, plus per-(src,dst) routing denies.
      expect(conf).toContain('acl allowed_lan_ag_homie dst 192.168.30.4');
      expect(conf).toContain('http_access allow from_ag_homie allowed_lan_ag_homie');
      expect(conf).toContain('cache_peer_access onecli deny from_ag_homie allowed_lan_ag_homie');
      expect(conf).toContain('never_direct deny from_ag_homie allowed_lan_ag_homie');

      // Homie still gets dstdomain for the provider's API host (api.anthropic.com),
      // unioned automatically by effectiveAllowList.
      expect(conf).toContain('acl allowed_ag_homie dstdomain .api.anthropic.com');
      expect(conf).toContain('http_access allow from_ag_homie allowed_ag_homie');

      // Mr Internet: no LAN ACL at all — they have no IPv4 entries.
      expect(conf).not.toContain('allowed_lan_ag_mr');
      expect(conf).not.toContain('cache_peer_access onecli deny from_ag_mr');
      expect(conf).not.toContain('never_direct deny from_ag_mr');

      // The cache_peer line carries name=onecli so cache_peer_access can target it cleanly.
      expect(conf).toContain('name=onecli');

      // `never_direct allow all` must come AFTER per-agent denies (first-match-wins).
      // Search for line-start to skip any references in `#` comments.
      const denyIdx = conf.indexOf('\nnever_direct deny from_ag_homie');
      const allowAllIdx = conf.indexOf('\nnever_direct allow all');
      expect(denyIdx).toBeGreaterThan(-1);
      expect(allowAllIdx).toBeGreaterThan(denyIdx);

      // CRITICAL ordering: the per-agent LAN `http_access allow` must come BEFORE
      // the global `http_access deny !Safe_ports`. The Neo controller listens on
      // 8838 which isn't in Safe_ports (80/443); if the deny fires first the LAN
      // request is rejected with TCP_DENIED/403 regardless of the per-agent allow.
      // This is a regression check against the real bug we shipped on first
      // attempt — see commit history.
      const lanAllowIdx = conf.indexOf('\nhttp_access allow from_ag_homie allowed_lan_ag_homie');
      const safePortsDenyIdx = conf.indexOf('\nhttp_access deny !Safe_ports');
      expect(lanAllowIdx).toBeGreaterThan(-1);
      expect(safePortsDenyIdx).toBeGreaterThan(-1);
      expect(safePortsDenyIdx).toBeGreaterThan(lanAllowIdx);

      // Conversely, hostname/WAN allows stay BELOW the Safe_ports deny so a
      // whitelisted hostname can't be reached on a non-Safe_port. (Mr Internet's
      // nytimes.com allow must stay port-gated.)
      const mrWanAllowIdx = conf.indexOf('\nhttp_access allow from_ag_mr allowed_ag_mr');
      expect(mrWanAllowIdx).toBeGreaterThan(-1);
      expect(mrWanAllowIdx).toBeGreaterThan(safePortsDenyIdx);
    });

    it('AND-ing src+dst in cache_peer_access scopes the bypass to one agent only', () => {
      // Two agents, both with the same LAN IP whitelisted. Each must get its
      // own `from_<slug>` ACL paired in the deny — Diddyclaw's traffic to that
      // IP shouldn't trigger Homie's bypass, and vice versa.
      const policy = JSON.stringify({ bucket: 'whitelisted', domains: ['192.168.30.4'] });
      const agents = [
        { ...baseAgent, id: 'ag-homie', folder: 'homie', internet_access_policy: policy },
        { ...baseAgent, id: 'ag-diddy', folder: 'diddyclaw', internet_access_policy: policy },
      ];
      const ips = { 'ag-homie': '172.30.0.20', 'ag-diddy': '172.30.0.21' };
      const conf = generateSquidConfig(agents, ips);

      // Each agent has its own pair of denies — never a global one.
      expect(conf).toContain('cache_peer_access onecli deny from_ag_homie allowed_lan_ag_homie');
      expect(conf).toContain('never_direct deny from_ag_homie allowed_lan_ag_homie');
      expect(conf).toContain('cache_peer_access onecli deny from_ag_diddy allowed_lan_ag_diddy');
      expect(conf).toContain('never_direct deny from_ag_diddy allowed_lan_ag_diddy');

      // No global deny (e.g. `cache_peer_access onecli deny allowed_lan_anything`).
      // The src ACL is always paired in.
      const lines = conf.split('\n');
      const bareDenies = lines.filter((l) => /^(cache_peer_access onecli|never_direct) deny\s/.test(l));
      for (const l of bareDenies) {
        expect(l).toMatch(/deny from_\S+ allowed_lan_\S+/);
      }
    });

    it('handles a mixed whitelist of hostnames + IPs in one agent (both ACL types emitted)', () => {
      const policy = JSON.stringify({
        bucket: 'whitelisted',
        domains: ['nytimes.com', '192.168.30.4', { domain: '10.0.0.5', note: 'home server' }],
      });
      const agents = [{ ...baseAgent, id: 'ag-mix', folder: 'mix', internet_access_policy: policy }];
      const ips = { 'ag-mix': '172.30.0.22' };
      const conf = generateSquidConfig(agents, ips);

      // dstdomain holds hostnames only (provider host + nytimes), not IPs.
      const dstdomainLine = conf.split('\n').find((l) => l.startsWith('acl allowed_ag_mix dstdomain'));
      expect(dstdomainLine).toBeDefined();
      expect(dstdomainLine).toContain('.nytimes.com');
      expect(dstdomainLine).toContain('.api.anthropic.com');
      expect(dstdomainLine).not.toContain('192.168.30.4');
      expect(dstdomainLine).not.toContain('10.0.0.5');

      // dst holds IP literals only.
      const dstLine = conf.split('\n').find((l) => l.startsWith('acl allowed_lan_ag_mix dst'));
      expect(dstLine).toBeDefined();
      expect(dstLine).toContain('192.168.30.4');
      expect(dstLine).toContain('10.0.0.5');
      expect(dstLine).not.toContain('nytimes.com');
    });

    it('flattens rich DomainEntry whitelists into Squid dstdomain entries', () => {
      const raw = JSON.stringify({
        bucket: 'whitelisted',
        domains: [
          { domain: 'nytimes.com', note: 'subscription', added_at: '2026-05-08' },
          { domain: 'reuters.com', note: 'temporary - remove after 2026-06' },
        ],
      });
      const agents = [{ ...baseAgent, id: 'ag-A', internet_access_policy: raw }];
      const ips = { 'ag-A': '172.30.0.10' };
      const conf = generateSquidConfig(agents, ips);
      expect(conf).toContain('dstdomain');
      // Auto-prefixed for subdomain coverage.
      expect(conf).toContain('.nytimes.com');
      expect(conf).toContain('.reuters.com');
      expect(conf).not.toContain('"note"');
      expect(conf).not.toContain('added_at');
    });
  });

  describe('toDstdomainEntry', () => {
    it('adds a leading dot so subdomains match', () => {
      expect(toDstdomainEntry('proton.me')).toBe('.proton.me');
      expect(toDstdomainEntry('nytimes.com')).toBe('.nytimes.com');
    });

    it('leaves already-prefixed entries alone', () => {
      expect(toDstdomainEntry('.api.anthropic.com')).toBe('.api.anthropic.com');
    });

    it('leaves bare IPs alone (no dot prefix)', () => {
      expect(toDstdomainEntry('127.0.0.1')).toBe('127.0.0.1');
      expect(toDstdomainEntry('192.168.1.1')).toBe('192.168.1.1');
    });
  });

  describe('generateDnsmasqConfig', () => {
    it('configures dnsmasq as a logging NXDOMAIN black hole', () => {
      const conf = generateDnsmasqConfig();
      // No upstream forwarding, no records — every query gets REFUSED
      // (functionally equivalent to NXDOMAIN for our purposes).
      expect(conf).toContain('no-resolv');
      expect(conf).toContain('no-hosts');
      expect(conf).toContain('no-poll');
      // Logs go to the bind-mounted path.
      expect(conf).toContain('log-facility=/var/log/squid/dns.log');
      expect(conf).toContain('log-queries=extra');
      // Binds on demand so it works regardless of NIC ordering.
      expect(conf).toContain('bind-dynamic');
      expect(conf).toContain('port=53');
    });
  });

  describe('monthKey', () => {
    it('emits YYYY-MM in UTC', () => {
      expect(monthKey(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01');
      expect(monthKey(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-12');
    });

    it('pads single-digit months with a leading zero', () => {
      expect(monthKey(new Date(Date.UTC(2026, 4, 1)))).toBe('2026-05');
      expect(monthKey(new Date(Date.UTC(2026, 8, 30)))).toBe('2026-09');
    });

    it('is timezone-stable (UTC-based)', () => {
      // 2026-01-01T00:30:00-05:00 (US-Eastern) is 2026-01-01T05:30:00Z.
      // Treating in UTC: month is January.
      const d = new Date('2026-01-01T00:30:00-05:00');
      expect(monthKey(d)).toBe('2026-01');
    });
  });

  describe('rewriteProxyEnv', () => {
    it('rewrites HTTPS_PROXY, HTTP_PROXY, and lowercase variants to point at Squid (172.30.0.2:3128)', () => {
      const args = [
        'run',
        '-e',
        'HTTPS_PROXY=http://x:aoc_token@host.docker.internal:10255',
        '-e',
        'HTTP_PROXY=http://x:aoc_token@host.docker.internal:10255',
        '-e',
        'https_proxy=http://x:aoc_token@host.docker.internal:10255',
        '-e',
        'http_proxy=http://x:aoc_token@host.docker.internal:10255',
      ];
      rewriteProxyEnv(args);

      // host:port → 172.30.0.2:3128 ; user:pass preserved.
      for (const idx of [2, 4, 6, 8]) {
        const entry = args[idx];
        expect(entry).toContain('172.30.0.2:3128');
        expect(entry).toContain('x:aoc_token@');
        expect(entry).not.toContain('host.docker.internal:10255');
      }
    });

    it('leaves non-proxy env entries untouched', () => {
      const args = [
        'run',
        '-e',
        'TZ=America/New_York',
        '-e',
        'NODE_EXTRA_CA_CERTS=/tmp/onecli-gateway-ca.pem',
        '-e',
        'HTTPS_PROXY=http://x:tok@host.docker.internal:10255',
      ];
      const before = [...args];
      rewriteProxyEnv(args);
      expect(args[2]).toBe(before[2]);
      expect(args[4]).toBe(before[4]);
      expect(args[6]).not.toBe(before[6]);
    });

    it('leaves args alone if no proxy env vars are present', () => {
      const args = ['run', '-e', 'TZ=UTC', '--name', 'foo'];
      const before = [...args];
      rewriteProxyEnv(args);
      expect(args).toEqual(before);
    });

    it('skips malformed env values silently', () => {
      const args = ['run', '-e', 'HTTPS_PROXY=not a url'];
      const before = [...args];
      rewriteProxyEnv(args);
      expect(args).toEqual(before);
    });
  });

  describe('generateSocatForwardsConfig', () => {
    const agentA: AgentGroup = {
      ...baseAgent,
      id: 'ag-a',
      name: 'A',
      folder: 'a',
      internet_access_policy: JSON.stringify({ bucket: 'full', cdpPort: 9222 }),
    };
    const agentB: AgentGroup = {
      ...baseAgent,
      id: 'ag-b',
      name: 'B',
      folder: 'b',
      internet_access_policy: JSON.stringify({ bucket: 'full', cdpPort: 9223 }),
    };
    const ips = { 'ag-a': '172.30.0.3', 'ag-b': '172.30.0.4' };

    it('emits one forward per agent with a cdpPort', () => {
      const conf = generateSocatForwardsConfig([agentA, agentB], ips);
      const lines = conf.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('9222 172.30.0.3/32 host.docker.internal 9222');
      expect(lines[1]).toBe('9223 172.30.0.4/32 host.docker.internal 9222');
    });

    it('upstream port is the host port (default 9222), not the listen port', () => {
      // The bug this regression-tests: multiple agents with distinct cdpPorts
      // need unique container-side LISTEN ports (so source-IP filters can
      // isolate them), but they all forward to the SAME host-side Chrome.
      // If the upstream port mirrored cdpPort, only agent A (cdpPort=9222)
      // would actually reach a Chrome.
      const conf = generateSocatForwardsConfig([agentB], ips);
      expect(conf).toContain('9223 172.30.0.4/32 host.docker.internal 9222');
      expect(conf).not.toContain('9223 172.30.0.4/32 host.docker.internal 9223');
    });

    it('honors cdpHostPort override when set', () => {
      const agentC: AgentGroup = {
        ...baseAgent,
        id: 'ag-c',
        name: 'C',
        folder: 'c',
        internet_access_policy: JSON.stringify({
          bucket: 'full',
          cdpPort: 9224,
          cdpHostPort: 19222,
        }),
      };
      const conf = generateSocatForwardsConfig([agentC], { 'ag-c': '172.30.0.5' });
      expect(conf).toContain('9224 172.30.0.5/32 host.docker.internal 19222');
    });

    it('skips agents without cdpPort', () => {
      const noBrowserAgent: AgentGroup = {
        ...baseAgent,
        id: 'ag-x',
        folder: 'x',
        name: 'X',
        internet_access_policy: JSON.stringify({ bucket: 'full' }),
      };
      const conf = generateSocatForwardsConfig([noBrowserAgent], { 'ag-x': '172.30.0.5' });
      const lines = conf.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(lines).toHaveLength(0);
    });

    it('skips agents without an IP allocation', () => {
      const conf = generateSocatForwardsConfig([agentA], {
        /* no entry for ag-a */
      });
      const lines = conf.split('\n').filter((l) => l && !l.startsWith('#'));
      expect(lines).toHaveLength(0);
    });
  });

  describe('parsePolicy with cdpHostPort', () => {
    it('reads cdpHostPort from JSON when present', () => {
      const policy = parsePolicy(JSON.stringify({ bucket: 'full', cdpPort: 9223, cdpHostPort: 19222 }));
      expect(policy.cdpPort).toBe(9223);
      expect(policy.cdpHostPort).toBe(19222);
    });

    it('omits cdpHostPort when not in JSON', () => {
      const policy = parsePolicy(JSON.stringify({ bucket: 'full', cdpPort: 9223 }));
      expect(policy.cdpPort).toBe(9223);
      expect(policy.cdpHostPort).toBeUndefined();
    });
  });
});
