import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
} from '../../../../setup/gateways/credential-store.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { controlPaths, controlRequest, grantSecret, IronControlRequestError } from './control.js';
import { run, statePaths } from './setup.js';
import { assertCredentialIsolation, ironHeaderName } from './credential-isolation.js';

export async function allowModelHost(host: string, root: string): Promise<void> {
  const file = statePaths(root).frontConfigFile;
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).allowed_hosts?.includes(host)) return;
  await run(['--allow-host', host], root);
}

/**
 * Names no public CA certifies, with their subdomains: IANA special-use names and the
 * TLDs ICANN will never delegate (home, corp, mail). Iron verifies upstream TLS
 * against public roots only.
 */
const PRIVATE_NAME = /(?:^|\.)(?:internal|local|localhost|home\.arpa|home|corp|mail)$/;

export function ironModelEndpoint(raw: string, root: string) {
  const url = new URL(raw);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(url.hostname) ||
    PRIVATE_NAME.test(url.hostname) ||
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Iron Proxy requires an HTTPS model endpoint on port 443 whose host is a DNS name with a publicly trusted certificate; plain HTTP, other ports, IP addresses, and private names such as host.docker.internal cannot work. Put a TLS reverse proxy with such a certificate in front of a local model server.',
    );
  return { configure: () => allowModelHost(url.hostname, root) };
}

/** The header the ChatGPT profile routes on; a property of the profile, not of the caller. */
const CHATGPT_ACCOUNT_HEADER = 'ChatGPT-Account-Id';
/**
 * One login writes three Iron records (broker, account secret, bearer secret).
 * They share this label so an interrupted re-login cannot leave one account's
 * bearer token paired with another account's header and still look reusable.
 */
const LOGIN_LABEL = 'nanoclaw.login';
/** Iron's `live` only means a token was minted once; an expired one cannot authenticate. */
const brokerExpired = (broker: any, now = Date.now()): boolean =>
  broker?.status === 'live' && (typeof broker.expires_at !== 'string' || !(Date.parse(broker.expires_at) > now));
const BEARER = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };

interface Dependencies {
  request: (resource: string, method?: string, data?: unknown) => Promise<any>;
  grant: (id: string) => Promise<void>;
  allowHost: (host: string) => Promise<void>;
  checkIsolation: () => Promise<void>;
}

/** Credential values never return from Iron Control. Only owned metadata is inspected. */
export function createIronCredentialConnection(
  target: GatewayCredentialTarget,
  root = process.cwd(),
  deps?: Dependencies,
): GatewayCredentialConnection {
  if (
    !/^[a-zA-Z0-9_-]{8,100}$/.test(target.proxyValue) ||
    !target.name.trim() ||
    target.name.length > 120 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(target.host)
  )
    throw new Error('Iron credentials require a name, a runtime placeholder, and an exact DNS hostname');
  const injection = target.kind === 'oauth' ? BEARER : target.injection;
  if (!/^[a-zA-Z0-9-]+$/.test(injection.headerName) || !['{value}', 'Bearer {value}'].includes(injection.valueFormat))
    throw new Error('Unsupported Iron credential injection scheme');
  const oauth = target.kind === 'oauth' ? target.oauth : undefined;
  if (oauth) {
    if (oauth.profile !== 'chatgpt')
      throw new Error(
        `Iron stores only the ChatGPT subscription OAuth profile; ${String(oauth.profile)} is not supported.`,
      );
    if (!oauth.clientId) throw new Error('OAuth requires its provider-owned client id');
    const endpoint = new URL(oauth.tokenEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('OAuth refresh endpoint must use HTTPS');
  }
  const namespace = getInstallSlug(root);
  const foreignId = 'provider-' + createHash('sha256').update(target.name).digest('hex').slice(0, 24);
  const connectionDeps = deps ?? {
    request: (resource, method, data) => controlRequest(root, resource, method, data),
    grant: (id) => grantSecret('static', id, root),
    allowHost: (host) => allowModelHost(host, root),
    checkIsolation: () =>
      assertCredentialIsolation(root, {
        host: target.host,
        headers: [injection.headerName, ...(oauth ? [CHATGPT_ACCOUNT_HEADER] : [])],
        proxyValue: target.proxyValue,
        ownedForeignIds: [foreignId, foreignId + '-account'],
      }),
  };
  const replaceConfig = (header = injection.headerName) => ({
    proxy_value: target.proxyValue,
    match_headers: [ironHeaderName(header)],
    require: false,
  });
  const lookup = async (resource: string, id = foreignId): Promise<any | null> => {
    try {
      return await connectionDeps.request(`${resource}/lookup/${encodeURIComponent(namespace)}/${id}`);
    } catch (error) {
      if (error instanceof IronControlRequestError && error.status === 404) return null;
      throw error;
    }
  };
  // The record find() observed. Its id never leaves this adapter: keep() and
  // save() act on it, and both refuse an entry that changed since the lookup.
  let observed: any | null | undefined;
  let oauthObserved: { broker: any; account: any } | undefined;
  let expectedHost = target.host;
  let canKeep = true;
  const observedId = (): string | null => {
    if (observed === undefined) throw new Error('Look up the Iron credential before keeping or saving it');
    return observed?.id ?? null;
  };
  const identity = (record: any, id: string) =>
    record?.namespace === namespace && record?.foreign_id === id && typeof record?.id === 'string';
  const validate = (record: any, host: string) => {
    const rule = record?.rules?.[0];
    if (
      !identity(record, foreignId) ||
      record.name !== target.name ||
      Object.keys(record.inject_config ?? {}).length ||
      !isDeepStrictEqual(record.replace_config, replaceConfig()) ||
      record.rules?.length !== 1 ||
      rule.host !== host ||
      rule.cidr ||
      (rule.paths?.length ?? 0) ||
      !isDeepStrictEqual(rule.http_methods, ['*']) ||
      record.source?.source_type !== (target.kind === 'oauth' ? 'token_broker' : 'control_plane') ||
      (target.kind === 'api-key' && Object.keys(record.source.config ?? {}).length)
    )
      throw new Error('The Iron credential has unexpected metadata; inspect it in Iron Control before continuing');
  };
  const oauthState = async () => {
    const broker = await lookup('broker_credentials');
    const account = await lookup('static_secrets', foreignId + '-account');
    if (
      broker &&
      (!identity(broker, foreignId) ||
        broker.name !== target.name ||
        broker.client_id !== oauth!.clientId ||
        broker.token_endpoint !== oauth!.tokenEndpoint ||
        broker.oauth_app_id ||
        (broker.scopes?.length ?? 0) ||
        (broker.token_endpoint_header_names?.length ?? 0))
    )
      throw new Error('The Iron OAuth broker has unexpected metadata; inspect it in Iron Control');
    const rule = account?.rules?.[0];
    if (
      account &&
      (!identity(account, foreignId + '-account') ||
        account.name !== target.name + ' account' ||
        Object.keys(account.inject_config ?? {}).length ||
        !isDeepStrictEqual(account.replace_config, replaceConfig(CHATGPT_ACCOUNT_HEADER)) ||
        account.source?.source_type !== 'control_plane' ||
        Object.keys(account.source.config ?? {}).length ||
        account.rules?.length !== 1 ||
        rule.host !== target.host ||
        rule.cidr ||
        (rule.paths?.length ?? 0) ||
        !isDeepStrictEqual(rule.http_methods, ['*']))
    )
      throw new Error('The Iron OAuth account has unexpected metadata; inspect it in Iron Control');
    // Broker refresh timestamps and liveness may change normally during login.
    // Compare the immutable connection binding, not its running refresh status.
    const binding = broker && {
      id: broker.id,
      namespace: broker.namespace,
      foreign_id: broker.foreign_id,
      name: broker.name,
      client_id: broker.client_id,
      token_endpoint: broker.token_endpoint,
    };
    const state = { broker: binding, account };
    if (oauthObserved && !isDeepStrictEqual(state, oauthObserved))
      throw new Error('The Iron OAuth connection changed during setup; retry before saving');
    return { state, broker, account };
  };
  // Reusable only when every record of the login carries the same marker and
  // the broker can still mint a usable token. A mismatch or an expired token
  // means signing in again, which rewrites all three records together.
  const oauthReusable = (record: any, broker: any, account: any): boolean => {
    const login = broker?.labels?.[LOGIN_LABEL];
    return (
      typeof login === 'string' &&
      login.length > 0 &&
      account?.labels?.[LOGIN_LABEL] === login &&
      record?.labels?.[LOGIN_LABEL] === login &&
      !broker.dead &&
      !brokerExpired(broker)
    );
  };
  const read = async () => {
    if (!fs.existsSync(controlPaths(root).registration))
      throw new Error('Install Iron Control before connecting credentials');
    const record = await lookup('static_secrets');
    if (record) validate(record, expectedHost);
    return record;
  };
  const unchanged = async (id: string | null) => {
    const current = await read();
    if ((current?.id ?? null) !== id || (observed !== undefined && !isDeepStrictEqual(current, observed)))
      throw new Error('The Iron credential changed during setup; retry before saving');
    if (target.kind === 'oauth') {
      const { broker, account } = await oauthState();
      if (current && (!broker || !account || current.source.config?.credential_id !== broker.id))
        throw new Error('The Iron OAuth connection is incomplete; inspect it in Iron Control');
      if (current && !oauthReusable(current, broker, account)) canKeep = false;
    }
    return current;
  };
  const waitForBroker = async (brokerId: string, afterRefresh?: string | null): Promise<void> => {
    // A seed is not yet an access token. The native scheduler may need a
    // minute to bootstrap it; do not let setup proceed while it is pending.
    const deadline = Date.now() + 120_000;
    let announced = false;
    for (;;) {
      const refreshed = await lookup('broker_credentials');
      if (
        !identity(refreshed, foreignId) ||
        refreshed.id !== brokerId ||
        refreshed.client_id !== oauth!.clientId ||
        refreshed.token_endpoint !== oauth!.tokenEndpoint
      )
        throw new Error('The Iron OAuth broker changed during refresh; inspect it in Iron Control');
      if (refreshed.dead)
        throw new Error(
          'Iron could not refresh this OAuth login. Sign in again; existing IDs and defaults are preserved.',
        );
      if (
        refreshed.status === 'live' &&
        refreshed.last_refresh &&
        !brokerExpired(refreshed) &&
        (afterRefresh === undefined || refreshed.last_refresh !== afterRefresh)
      )
        return;
      if (Date.now() >= deadline)
        throw new Error(
          'Iron OAuth refresh is still pending. Check Iron Control before retrying setup; the saved credential and defaults have been kept.',
        );
      if (!announced) {
        console.log('Waiting for Iron to refresh the OAuth login (up to two minutes)…');
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };
  const connection: GatewayCredentialConnection = {
    get canKeep() {
      return canKeep;
    },
    async find(options) {
      if (!fs.existsSync(controlPaths(root).registration))
        throw new Error('Install Iron Control before connecting credentials');
      await connectionDeps.checkIsolation();
      const record = await lookup('static_secrets');
      if (record && record.rules?.[0]?.host !== expectedHost && target.kind === 'api-key' && observed === undefined) {
        const previous = record.rules?.[0]?.host;
        validate(record, previous);
        if (
          !options ||
          !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(previous) ||
          !(await options.confirmHostChange(previous, target.host))
        )
          throw new Error('Credential host change cancelled. Existing credential and defaults are unchanged.');
        expectedHost = previous;
        canKeep = false;
      }
      if (record) validate(record, expectedHost);
      if (target.kind === 'oauth') {
        const { state, broker, account } = await oauthState();
        if (record && (!broker || !account || record.source.config?.credential_id !== broker.id))
          throw new Error('The Iron OAuth connection is incomplete; inspect it in Iron Control');
        oauthObserved = state;
        canKeep = !record || oauthReusable(record, broker, account);
      }
      if (observed !== undefined && !isDeepStrictEqual(record, observed))
        throw new Error('The Iron credential changed during setup; retry before saving');
      observed = record;
      return record ? { reusable: canKeep } : null;
    },
    async keep() {
      const existingId = observedId();
      if (existingId === null) throw new Error('No stored Iron credential to keep; enter a value');
      await connectionDeps.checkIsolation();
      await unchanged(existingId);
      if (!canKeep)
        throw new Error(
          'Re-enter the API key after changing its host, or sign in again for an expired OAuth connection',
        );
      await connectionDeps.allowHost(target.host);
      await connectionDeps.checkIsolation();
      await unchanged(existingId);
      await connectionDeps.grant(existingId);
      if (target.kind === 'oauth') {
        const broker = await lookup('broker_credentials');
        await waitForBroker(broker.id);
        await connectionDeps.checkIsolation();
        await unchanged(existingId);
        const account = await lookup('static_secrets', foreignId + '-account');
        await connectionDeps.grant(account.id);
      }
    },
    async save(value) {
      if (
        target.kind === 'api-key'
          ? typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)
          : typeof value === 'string' ||
            value.profile !== 'chatgpt' ||
            ![value.accessToken, value.refreshToken, value.accountId].every(
              (v) => typeof v === 'string' && v.trim() && !/[\r\n]/.test(v),
            )
      )
        throw new Error('Credential does not match its connection type');
      const existingId = observedId();
      await connectionDeps.checkIsolation();
      await unchanged(existingId);
      // Reconcile the network boundary before changing a stored credential.
      await connectionDeps.allowHost(target.host);
      await connectionDeps.checkIsolation();
      await unchanged(existingId);
      // An existing record is updated by its opaque id, which Iron refuses with
      // 404 once the record is gone. The foreign-id form would upsert into a
      // replacement created after the last unchanged() read, writing this value
      // into a record whose grants were never checked.
      const login = typeof value === 'string' ? undefined : randomUUID();
      const put = (id: string, source: unknown, config: unknown, name = target.name) =>
        connectionDeps.request(`static_secrets/${id}`, 'PUT', {
          namespace,
          name,
          source,
          inject_config: {},
          replace_config: config,
          rules: [{ host: target.host, http_methods: ['*'] }],
          ...(login ? { labels: { [LOGIN_LABEL]: login } } : {}),
        });
      let source: unknown;
      let account: any;
      if (typeof value === 'string') source = { source_type: 'control_plane', secret: value, config: {} };
      else {
        const broker = await connectionDeps.request(
          `broker_credentials/${oauthObserved?.broker?.id ?? foreignId}`,
          'PUT',
          {
            namespace,
            name: target.name,
            token_endpoint: oauth!.tokenEndpoint,
            client_id: oauth!.clientId,
            refresh_token: value.refreshToken,
            labels: { [LOGIN_LABEL]: login },
          },
        );
        if (!identity(broker, foreignId) || (oauthObserved?.broker && broker.id !== oauthObserved.broker.id))
          throw new Error('Iron did not confirm the OAuth broker identity');
        oauthObserved = {
          broker: {
            id: broker.id,
            namespace: broker.namespace,
            foreign_id: broker.foreign_id,
            name: broker.name,
            client_id: broker.client_id,
            token_endpoint: broker.token_endpoint,
          },
          account: oauthObserved?.account ?? null,
        };
        await waitForBroker(broker.id, broker.last_refresh ?? null);
        await connectionDeps.checkIsolation();
        await unchanged(existingId);
        source = { source_type: 'token_broker', config: { credential_id: broker.id } };
        account = await put(
          oauthObserved.account?.id ?? foreignId + '-account',
          { source_type: 'control_plane', secret: value.accountId, config: {} },
          replaceConfig(CHATGPT_ACCOUNT_HEADER),
          target.name + ' account',
        );
        if (!identity(account, foreignId + '-account'))
          throw new Error('Iron did not confirm the OAuth account identity');
      }
      const saved = await put(existingId ?? foreignId, source, replaceConfig());
      if (!identity(saved, foreignId) || (existingId && saved.id !== existingId))
        throw new Error('Iron did not confirm the existing credential identity');
      await connectionDeps.grant(saved.id);
      if (account) await connectionDeps.grant(account.id);
      expectedHost = target.host;
      observed = saved;
      // Later operations reread all native metadata; values are never read back.
      oauthObserved = undefined;
      if (target.kind === 'oauth') oauthObserved = (await oauthState()).state;
      canKeep = true;
    },
  };
  return connection;
}
