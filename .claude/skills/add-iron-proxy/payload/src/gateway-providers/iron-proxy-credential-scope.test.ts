import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IronCredentialScope,
  effectiveConfigRules,
  ironCredentialRules,
  localConfigRules,
  ruleCovers,
  seenRuleFile,
  type CredentialRule,
  type Destination,
  type RuleSink,
} from './iron-proxy-credential-scope.js';

const covers = (rules: CredentialRule[], destination: Destination) =>
  rules.some((rule) => ruleCovers(rule, destination));
const ruleFrom = (rule: unknown) => effectiveConfigRules({ secrets: [{ rules: [rule] }], transforms: [] });

describe('reading Iron credential rules', () => {
  it.each([
    ['api.example.com', 'api.example.com', true],
    ['api.example.com', 'API.EXAMPLE.COM:443', true],
    ['api.example.com', 'deep.api.example.com', false],
    ['*.example.com', 'example.com', true],
    ['*.example.com', 'deep.api.example.com', true],
    ['*.example.com', 'xexample.com', false],
    ['api.*', 'api.evil.test', true],
    ['a?i.example.com', 'abi.example.com', true],
    ['[ab]pi.example.com', 'anything.test', true],
    ['*', 'anything.test', true],
  ])('matches host %s against %s like Iron', (host, destination, expected) => {
    expect(covers(ruleFrom({ host }), { host: destination, method: 'GET' })).toBe(expected);
  });

  it('narrows on methods but never on paths', () => {
    const writes = ruleFrom({ host: 'api.example.com', methods: ['post'], paths: ['/repos/*'] });
    expect(covers(writes, { host: 'api.example.com', method: 'GET' })).toBe(false);
    expect(covers(writes, { host: 'api.example.com', method: 'POST' })).toBe(true);
    expect(covers(writes, { host: 'api.example.com' })).toBe(true);
    for (const methods of [[], ['*'], ['POST', '*'], [1]]) {
      expect(covers(ruleFrom({ host: 'api.example.com', methods }), { host: 'api.example.com', method: 'GET' })).toBe(
        true,
      );
    }
  });

  it('covers every host for a rule host that is not plain ASCII, which Go lowercases differently', () => {
    expect(covers(ruleFrom({ host: 'ap\u0130.example.com' }), { host: 'unrelated.test', method: 'GET' })).toBe(true);
    expect(
      covers(ruleFrom({ host: 'api.example.com', methods: ['GET\u0130'] }), {
        host: 'api.example.com',
        method: 'POST',
      }),
    ).toBe(true);
  });

  it('applies a CIDR rule to literal IP hosts only', () => {
    const rules = ruleFrom({ cidr: '10.0.0.0/8' });
    expect(covers(rules, { host: '192.0.2.1', method: 'GET' })).toBe(true);
    expect(covers(rules, { host: '[::1]:443', method: 'GET' })).toBe(true);
    expect(covers(rules, { host: 'ten.example.test', method: 'GET' })).toBe(false);
  });

  it.each([
    ['an unknown rule key', { host: 'api.example.com', query: '*' }],
    ['host and cidr together', { host: 'api.example.com', cidr: '10.0.0.0/8' }],
    ['neither host nor cidr', { methods: ['GET'] }],
    ['a non-object rule', 'api.example.com'],
  ])('covers every request for %s', (_name, rule) => {
    expect(covers(ruleFrom(rule), { host: 'unrelated.test', method: 'GET' })).toBe(true);
  });

  it('reads an Iron Control effective config', () => {
    const rules = effectiveConfigRules({
      id: 'prn_1',
      secrets: [
        {
          source: { type: 'control_plane', value: '[redacted]' },
          replace: { proxy_value: 'gateway-managed' },
          rules: [{ host: 'api.github.com', methods: ['GET', 'POST'], paths: ['/repos/*'] }],
        },
        { source: { type: 'env', var: 'UNSCOPED' }, inject: { header: 'X-Key' } },
      ],
      transforms: [
        { name: 'hmac_sign', config: { rules: [{ host: 'hooks.example.com', methods: ['POST'] }] } },
        { name: 'oauth_token', config: { tokens: [{ rules: [{ host: 'slack.com', methods: ['POST'] }] }] } },
      ],
      postgres: [{ id: 'pgs_1', dsn: { type: 'env', var: 'DSN' } }],
    });
    expect(covers(rules, { host: 'api.github.com', method: 'GET' })).toBe(true);
    expect(covers(rules, { host: 'hooks.example.com', method: 'GET' })).toBe(false);
    expect(covers(rules, { host: 'slack.com', method: 'POST' })).toBe(true);
    expect(covers(rules, { host: 'docs.example.test', method: 'GET' })).toBe(false);
  });

  it.each([
    ['gcp_auth without rules, which Iron applies everywhere', { transforms: [{ name: 'gcp_auth', config: {} }] }],
    ['an empty oauth bundle', { transforms: [{ name: 'oauth_token', config: { tokens: [] } }] }],
    ['an unknown transform', { transforms: [{ name: 'grpc', config: { rules: [{ host: 'x.test' }] } }] }],
    ['a transform without config', { transforms: [{ name: 'aws_auth' }] }],
    ['a null transform', { transforms: [null] }],
    ['secret rules that are not a list', { secrets: [{ rules: { host: 'x.test' } }] }],
    ['an unknown top-level key', { mcp: { servers: [] } }],
  ])('covers every request for %s', (_name, config) => {
    expect(
      covers(effectiveConfigRules({ secrets: [], transforms: [], ...config }), {
        host: 'docs.example.test',
        method: 'GET',
      }),
    ).toBe(true);
  });

  it('refuses an effective config without its credential lists', () => {
    for (const config of [[], null, {}, { secrets: [] }, { transforms: [] }, { secrets: {}, transforms: [] }])
      expect(() => effectiveConfigRules(config)).toThrow();
  });

  it('reads the local configuration and treats unknown sections as covering everything', () => {
    const managed =
      'dns:\n  enabled: false\nproxy:\n  tunnel_listen: 127.0.0.1:18080\ntransforms: []\nlog:\n  level: info\n';
    expect(localConfigRules(managed)).toEqual([]);
    for (const extra of [
      'mcp_gateway:\n  upstreams: []\n',
      'control_plane:\n  poll_interval: 5m\n',
      'future_feature: true\n',
    ]) {
      expect(covers(localConfigRules(managed + extra), { host: 'docs.example.test', method: 'GET' })).toBe(true);
    }
    expect(() => localConfigRules('- not\n- a mapping\n')).toThrow();
  });

  // Iron's YAML decoder applies merge keys; a merged-in credential must never read as "no rules".
  it.each([
    ['a merged secret entry', ['      secrets:', '        - <<: *secret']],
    ['a merged secrets block', ['      <<: *block']],
    ['a merged rule', ['      secrets:', '        - rules:', '            - <<: *rule']],
  ])('covers every request for %s', (_name, config) => {
    const yaml = [
      'proxy:',
      '  anchors:',
      '    - &rule { host: api.github.com }',
      '    - &secret { rules: [*rule] }',
      '    - &block { secrets: [*secret] }',
      'transforms:',
      '  - name: secrets',
      '    config:',
      ...config,
    ].join('\n');
    expect(covers(localConfigRules(yaml), { host: 'docs.example.test', method: 'GET' })).toBe(true);
  });

  it.each([
    [
      'an extra transform key',
      { transforms: [{ name: 'hmac_sign', '<<': {}, config: { rules: [{ host: 'x.test' }] } }] },
    ],
    ['an extra secret key', { secrets: [{ '<<': { rules: [{ host: 'x.test' }] } }] }],
  ])('covers every request for %s in an effective config', (_name, config) => {
    expect(
      covers(effectiveConfigRules({ secrets: [], transforms: [], ...config }), {
        host: 'docs.example.test',
        method: 'GET',
      }),
    ).toBe(true);
  });
});

interface Cases {
  ironProxyCommit: string;
  rules: Record<string, unknown>[];
  requests: { host: string; method: string; path: string }[];
  matches: string[];
}

describe("conformance with Iron's own matcher", () => {
  const cases = JSON.parse(
    fs.readFileSync('.claude/skills/add-iron-proxy/conformance/credential-scope-cases.json', 'utf8'),
  ) as Cases;
  const pins = JSON.parse(fs.readFileSync('.claude/skills/add-iron-proxy/versions.json', 'utf8'));

  it('was recorded at the pinned Iron Proxy commit', () => {
    expect(cases.ironProxyCommit).toBe(pins['iron-proxy-commit']);
    expect(cases.matches).toHaveLength(cases.rules.length);
  });

  it('never answers "none" where Iron would attach a credential', () => {
    const missed: string[] = [];
    cases.rules.forEach((rule, i) => {
      const rules = ruleFrom(rule);
      cases.requests.forEach((request, j) => {
        if (cases.matches[i][j] === '1' && !covers(rules, request))
          missed.push(`${JSON.stringify(rule)} ${request.method} ${request.host}`);
      });
    });
    expect(missed).toEqual([]);
  });

  it('agrees with Iron exactly wherever it does not widen on purpose', () => {
    const differ: string[] = [];
    cases.rules.forEach((rule, i) => {
      const methods = Array.isArray(rule.methods) ? rule.methods : [];
      const widened =
        rule.cidr !== undefined ||
        rule.paths !== undefined ||
        /[[\\]/.test(String(rule.host)) ||
        (methods.length > 1 && methods.includes('*'));
      if (widened) return;
      const rules = ruleFrom(rule);
      cases.requests.forEach((request, j) => {
        if ((cases.matches[i][j] === '1') !== covers(rules, request))
          differ.push(`${JSON.stringify(rule)} ${request.method} ${request.host}`);
      });
    });
    expect(differ).toEqual([]);
  });
});

describe('fresh credential scope', () => {
  const docs = { host: 'docs.example.test', method: 'GET' };
  const github = { host: 'api.github.com', method: 'GET' };
  const githubRule: CredentialRule = { host: 'api.github.com', methods: null };
  let clock = 0;
  const scopeOf = (load: (keep: RuleSink) => Promise<void>) => new IronCredentialScope(load, () => clock);

  beforeEach(() => {
    clock = 0;
  });

  it('keeps every card until it has watched Iron for longer than a few syncs, reading fresh each time', async () => {
    const load = vi.fn(async () => {});
    const scope = scopeOf(load);
    expect(await scope.lookup(docs)).toBe('credential');
    clock = 29_999;
    expect(await scope.lookup(docs)).toBe('credential');
    clock = 30_000;
    expect(await scope.lookup(docs)).toBe('none');
    expect(await scope.lookup(docs)).toBe('none');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('starts watching at the first read that succeeds', async () => {
    let failing = true;
    const scope = scopeOf(async () => {
      if (failing) throw new Error('control plane down');
    });
    await expect(scope.lookup(docs)).rejects.toThrow('control plane down');
    clock = 10_000;
    failing = false;
    expect(await scope.lookup(docs)).toBe('credential');
    clock = 39_999;
    expect(await scope.lookup(docs)).toBe('credential');
    clock = 40_000;
    expect(await scope.lookup(docs)).toBe('none');
  });

  it('keeps a revoked rule in scope', async () => {
    let grants = [githubRule];
    const scope = scopeOf(async (keep) => keep(grants));
    expect(await scope.lookup(github)).toBe('credential');
    grants = [];
    clock = 60_000;
    expect(await scope.lookup(github)).toBe('credential');
    expect(await scope.lookup(docs)).toBe('none');
  });

  it('keeps rules a failing read had already reported, and rejects instead of answering', async () => {
    const scope = scopeOf(async (keep) => {
      keep([githubRule]);
      throw new Error('control plane down');
    });
    await expect(scope.lookup(docs)).rejects.toThrow('control plane down');
    expect(await scope.lookup(github)).toBe('credential');
  });

  it('never answers from a read that started before the question', async () => {
    const reads: Array<{ grants: CredentialRule[]; finish: () => void }> = [];
    const scope = scopeOf(
      (keep) =>
        new Promise<void>((resolve) => {
          const read = {
            grants: [] as CredentialRule[],
            finish: () => {
              keep(read.grants);
              resolve();
            },
          };
          reads.push(read);
        }),
    );
    const early = scope.lookup(github);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    clock = 60_000;
    // A grant lands while the first read is in flight; later questions must see it.
    const late = scope.lookup(github);
    const later = scope.lookup(github);
    reads[0].finish();
    expect(await early).toBe('none');
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1].grants = [githubRule];
    reads[1].finish();
    expect(await late).toBe('credential');
    expect(await later).toBe('credential');
    expect(reads).toHaveLength(2);
  });

  describe('across host restarts', () => {
    let dir: string;
    const file = () => path.join(dir, 'seen-credential-rules.json');

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-seen-'));
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('remembers every rule it has seen, so a grant Iron may still apply keeps its card', async () => {
      const first = new IronCredentialScope(
        async (keep) => keep([githubRule]),
        () => clock,
        seenRuleFile(file()),
      );
      expect(await first.lookup(github)).toBe('credential');
      expect((fs.statSync(file()).mode & 0o777).toString(8)).toBe('600');
      clock = 60_000;
      const restarted = new IronCredentialScope(
        async () => {},
        () => clock,
        seenRuleFile(file()),
      );
      expect(await restarted.lookup(github)).toBe('credential');
      expect(await restarted.lookup(docs)).toBe('credential');
      clock = 90_000;
      expect(await restarted.lookup(github)).toBe('credential');
      expect(await restarted.lookup(docs)).toBe('none');
    });

    it.each([
      ['not JSON', '{'],
      ['not a list', '{}'],
      ['an unknown rule shape', JSON.stringify([{ host: 'api.github.com', methods: null, paths: [] }])],
      ['a bad method list', JSON.stringify([{ host: 'api.github.com', methods: 'GET' }])],
    ])('refuses to answer from a record that is %s', async (_name, text) => {
      fs.writeFileSync(file(), text);
      const scope = new IronCredentialScope(
        async () => {},
        () => clock,
        seenRuleFile(file()),
      );
      clock = 60_000;
      await expect(scope.lookup(docs)).rejects.toThrow();
    });

    it('retries a failed save on the next read, so a restart still remembers the rule', async () => {
      let failing = true;
      let saved: CredentialRule[] = [];
      const store = {
        load: () => saved,
        save: vi.fn((rules: CredentialRule[]) => {
          if (failing) throw new Error('disk full');
          saved = rules;
        }),
      };
      const scope = new IronCredentialScope(
        async (keep) => keep([githubRule]),
        () => clock,
        store,
      );
      await expect(scope.lookup(docs)).rejects.toThrow('disk full');
      failing = false;
      clock = 60_000;
      expect(await scope.lookup(docs)).toBe('credential');
      expect(saved).toContainEqual(githubRule);
      clock = 120_000;
      const restarted = new IronCredentialScope(
        async () => {},
        () => clock,
        store,
      );
      expect(await restarted.lookup(github)).toBe('credential');
    });

    it('rejects when a new rule cannot be recorded, but still covers it', async () => {
      const store = {
        load: () => [],
        save: vi.fn(() => {
          throw new Error('disk full');
        }),
      };
      const scope = new IronCredentialScope(
        async (keep) => keep([githubRule]),
        () => clock,
        store,
      );
      await expect(scope.lookup(docs)).rejects.toThrow('disk full');
      expect(await scope.lookup(github)).toBe('credential');
    });
  });
});

describe('Iron rule sources', () => {
  let root: string;
  let proxyStartedAt: () => Promise<number>;
  const control = () => path.join(root, 'data', 'session-materials', 'iron-control');
  const proxyEnv = () => path.join(control(), 'proxy.env');
  const key = `iak_${'a'.repeat(64)}`;
  const configFile = () => path.join(root, 'config.yaml');
  const managed = () => ({ configFile: configFile(), projectRoot: root, managed: true });
  const unmanaged =
    'transforms:\n  - name: secrets\n    config:\n      secrets:\n        - source: { type: file, path: /run/secrets/upstream }\n          replace: { proxy_value: gateway-managed }\n          rules:\n            - host: api.anthropic.com\n              methods: [GET, POST]\n';

  function respond(bodies: Record<string, unknown>, status = 200) {
    return vi.fn(async (url: string | URL | Request) => {
      const resource = String(url).replace('http://127.0.0.1:10257/api/v1/', '');
      return new Response(JSON.stringify(bodies[resource] ?? {}), { status: resource in bodies ? status : 404 });
    });
  }

  async function read(settings: Parameters<typeof ironCredentialRules>[0], fetchImpl?: unknown) {
    const rules: CredentialRule[] = [];
    await ironCredentialRules(settings, { proxyStartedAt, fetchImpl: fetchImpl as typeof fetch })((found) =>
      rules.push(...found),
    );
    return rules;
  }

  beforeEach(() => {
    proxyStartedAt = async () => Date.now() + 60_000;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-scope-'));
    fs.writeFileSync(configFile(), unmanaged);
    fs.mkdirSync(control(), { recursive: true });
    fs.writeFileSync(
      path.join(control(), 'control.env'),
      `RAILS_ENV=production\nIRON_CONTROL_INITIAL_API_KEY=${key}\n`,
    );
    fs.writeFileSync(
      path.join(control(), 'registration.json'),
      JSON.stringify({ principalId: 'prn_setup', proxyId: 'prx_1' }),
    );
    fs.writeFileSync(proxyEnv(), 'IRON_PROXY_TOKEN=iprx_x\nIRON_CONTROL_PLANE_URL=http://web:3000\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads only the local file for an unmanaged proxy', async () => {
    fs.rmSync(proxyEnv());
    const fetchImpl = respond({});
    const rules = await read({ configFile: configFile(), projectRoot: root }, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(covers(rules, { host: 'api.anthropic.com', method: 'GET' })).toBe(true);
    expect(covers(rules, { host: 'docs.example.test', method: 'GET' })).toBe(false);
  });

  it("reads the grants of the principal the proxy is assigned now, with the operator's key", async () => {
    const fetchImpl = respond({
      'proxies/prx_1': { data: { id: 'prx_1', principal_id: 'prn_swapped' } },
      'principals/prn_swapped/effective_config': {
        data: { id: 'prn_swapped', secrets: [{ rules: [{ host: 'api.github.com' }] }], transforms: [], postgres: [] },
      },
    });
    const rules = await read(managed(), fetchImpl);
    expect(covers(rules, { host: 'api.github.com', method: 'GET' })).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:10257/api/v1/proxies/prx_1',
      'http://127.0.0.1:10257/api/v1/principals/prn_swapped/effective_config',
      'http://127.0.0.1:10257/api/v1/proxies/prx_1',
    ]);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    expect(init.redirect).toBe('error');
  });

  it('treats a present proxy token as managed even when the host setting says otherwise', async () => {
    const fetchImpl = respond({ 'proxies/prx_1': { data: { principal_id: null } } });
    await read({ configFile: configFile(), projectRoot: root }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another principal', ['prn_a', 'prn_b'], ['t1', 't1']],
    ['the same principal assigned again', ['prn_a', 'prn_a'], ['t1', 't2']],
  ])('fails when the proxy is reassigned to %s during the read', async (_name, principals, stamps) => {
    let reads = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/proxies/prx_1')) {
        const i = Math.min(reads++, 1);
        return Response.json({ data: { principal_id: principals[i], principal_assigned_at: stamps[i] } });
      }
      return Response.json({ data: { secrets: [], transforms: [] } });
    });
    await expect(read(managed(), fetchImpl)).rejects.toThrow('assignment changed');
  });

  it('keeps the rules it read before refusing a reassigned proxy', async () => {
    let reads = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/proxies/prx_1'))
        return Response.json({ data: { principal_id: reads++ === 0 ? 'prn_a' : 'prn_b' } });
      return Response.json({ data: { secrets: [{ rules: [{ host: 'api.github.com' }] }], transforms: [] } });
    });
    const kept: CredentialRule[] = [];
    await expect(
      ironCredentialRules(managed(), { proxyStartedAt, fetchImpl: fetchImpl as unknown as typeof fetch })((found) =>
        kept.push(...found),
      ),
    ).rejects.toThrow('assignment changed');
    expect(covers(kept, { host: 'api.github.com', method: 'GET' })).toBe(true);
  });

  it.each([
    ['an error status', () => respond({ 'proxies/prx_1': { data: {} } }, 500), 'returned 500'],
    ['an invalid principal', () => respond({ 'proxies/prx_1': { data: { principal_id: 7 } } }), 'principal is invalid'],
    ['a body without data', () => respond({ 'proxies/prx_1': { principal_id: 'prn_1' } }), 'unexpected body'],
    [
      'an effective config without credential lists',
      () =>
        respond({
          'proxies/prx_1': { data: { principal_id: 'prn_1' } },
          'principals/prn_1/effective_config': { data: {} },
        }),
      'unexpected shape',
    ],
    [
      'a network failure',
      () =>
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      'fetch failed',
    ],
  ])('fails on %s', async (_name, fetchImpl, message) => {
    await expect(read(managed(), fetchImpl())).rejects.toThrow(message);
  });

  it.each([
    [
      'a missing key',
      () => fs.writeFileSync(path.join(control(), 'control.env'), 'RAILS_ENV=production\n'),
      'registration is incomplete',
    ],
    [
      'a malformed key',
      () => fs.writeFileSync(path.join(control(), 'control.env'), 'IRON_CONTROL_INITIAL_API_KEY=iak_short\n'),
      'registration is incomplete',
    ],
    ['a missing registration', () => fs.rmSync(path.join(control(), 'registration.json')), 'registration.json'],
    ['a missing local file', () => fs.rmSync(configFile()), 'config.yaml'],
    ['a missing proxy token file', () => fs.rmSync(proxyEnv()), 'proxy.env'],
  ])('fails on %s', async (_name, breakIt, message) => {
    breakIt();
    const fetchImpl = respond({ 'proxies/prx_1': { data: { principal_id: null } } });
    await expect(read(managed(), fetchImpl)).rejects.toThrow(message);
  });

  it('fails while the running proxy may still hold an older local configuration', async () => {
    proxyStartedAt = async () => fs.statSync(configFile()).mtimeMs - 1;
    await expect(read(managed(), respond({}))).rejects.toThrow('changed after the proxy started');
    proxyStartedAt = async () => Promise.reject(new Error('no such container'));
    await expect(read(managed(), respond({}))).rejects.toThrow('no such container');
  });

  it('fails when the proxy environment changed after the proxy started', async () => {
    const start = Date.now() - 60_000;
    fs.utimesSync(configFile(), new Date(start - 10_000), new Date(start - 10_000));
    fs.utimesSync(proxyEnv(), new Date(start + 10_000), new Date(start + 10_000));
    proxyStartedAt = async () => start;
    await expect(read(managed(), respond({ 'proxies/prx_1': { data: { principal_id: null } } }))).rejects.toThrow(
      'environment changed after the proxy started',
    );
  });

  it('fails when the proxy syncs on a custom interval', async () => {
    fs.appendFileSync(proxyEnv(), 'IRON_CONTROL_PLANE_POLL_INTERVAL=5m\n');
    const fetchImpl = respond({ 'proxies/prx_1': { data: { principal_id: null } } });
    await expect(read(managed(), fetchImpl)).rejects.toThrow('custom sync interval');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails when a managed proxy has no known project root', async () => {
    await expect(read({ configFile: configFile(), managed: true })).rejects.toThrow('Iron Control location is unknown');
  });
});
