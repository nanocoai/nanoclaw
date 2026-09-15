import { readEnvFile } from '../../../../src/env.js';

export interface KeyInjection {
  headerName: string;
  valueFormat: string;
}

export interface OneCliCredential {
  name: string;
  type: 'openai' | 'generic';
  hostPattern: string;
  injectionConfig?: KeyInjection;
  authMode?: 'oauth';
}

export interface OneCliCredentialConnection {
  find(options?: { confirmHostChange: (previous: string, next: string) => Promise<boolean> }): Promise<string | null>;
  save(value: string, existingId: string | null): Promise<string>;
  keep(existingId: string): Promise<void>;
}

const BEARER: KeyInjection = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameInjection(value: unknown, expected: KeyInjection): boolean {
  return (
    isRecord(value) &&
    value.headerName === expected.headerName &&
    value.valueFormat === expected.valueFormat &&
    Object.keys(value).every((key) => key === 'headerName' || key === 'valueFormat')
  );
}

function namedSecret(payload: unknown, name: string): Record<string, unknown> | undefined {
  if (!Array.isArray(payload) || !payload.every(isRecord)) {
    throw new Error('OneCLI returned invalid secret metadata.');
  }
  const matches = payload.filter((row) => row.name === name);
  if (matches.length > 1) {
    throw new Error(`Multiple ${name} credentials exist. Resolve duplicates in OneCLI before continuing.`);
  }
  return matches[0];
}

function exactHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('*')) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Read metadata only. Never edit an inherited, ambiguous, or differently scoped credential. */
export function findOneCliCredential(payload: unknown, descriptor: OneCliCredential): string | null {
  const secret = namedSecret(payload, descriptor.name);
  if (!secret) return null;
  const injection = descriptor.injectionConfig;
  // Older OpenCode setup used bearer injection for every generic key. Only
  // that known mistake may be repaired; arbitrary rules belong to the operator.
  const knownKeyMapping =
    !injection || sameInjection(secret.injectionConfig, injection) || sameInjection(secret.injectionConfig, BEARER);
  const mismatches = [
    typeof secret.id !== 'string' || !secret.id.trim() ? 'id' : undefined,
    secret.type !== descriptor.type ? 'type' : undefined,
    secret.hostPattern !== descriptor.hostPattern ? 'hostPattern' : undefined,
    // Legacy OneCLI responses omitted both source fields and only supported
    // inline values. Explicit external or unknown sources remain ineligible.
    secret.valueSource !== undefined && secret.valueSource !== 'inline' ? 'valueSource' : undefined,
    secret.opRef !== undefined && secret.opRef !== null ? 'opRef' : undefined,
    secret.scope !== 'project' ? 'scope' : undefined,
    secret.pathPattern ? 'pathPattern' : undefined,
    !knownKeyMapping ? 'injectionConfig' : undefined,
    descriptor.authMode && (!isRecord(secret.metadata) || secret.metadata.authMode !== descriptor.authMode)
      ? 'metadata.authMode'
      : undefined,
  ].filter((field) => field !== undefined);
  if (mismatches.length) {
    throw new Error(
      `The ${descriptor.name} vault entry has unexpected metadata in: ${mismatches.join(', ')}. Check those fields in OneCLI.`,
    );
  }
  return secret.id as string;
}

/** Use this installation's management connection, independently of the global OneCLI CLI configuration. */
export function createOneCliCredentialConnection(
  descriptor: OneCliCredential,
  url?: string,
  apiKey?: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  root = process.cwd(),
): OneCliCredentialConnection {
  // The setup wizard may have written these after src/config was imported.
  const saved = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'ONECLI_PROJECT_ID'], root);
  url ??= process.env.ONECLI_URL || saved.ONECLI_URL;
  apiKey ??= process.env.ONECLI_API_KEY || saved.ONECLI_API_KEY;
  if (!url) throw new Error('Configure ONECLI_URL before connecting an OpenCode credential.');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('ONECLI_URL must be an HTTP(S) gateway URL without embedded credentials, query, or fragment.');
  }
  const projectId = process.env.ONECLI_PROJECT_ID || saved.ONECLI_PROJECT_ID;
  const request = async (suffix: string, method: string, body?: unknown): Promise<unknown> => {
    try {
      const response = await fetchImpl(`${base.href.replace(/\/+$/, '')}/v1/secrets${suffix}`, {
        method,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(projectId ? { 'X-Project-Id': projectId } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      // API responses can include previews of secrets. Never echo them or a
      // transport error, including when a successful write's response is lost.
      throw new Error(
        'Could not confirm the OpenCode credential in OneCLI. Check gateway connectivity and management permissions, then retry.',
      );
    }
  };
  // A host move is explicit and keeps the granted ID. Revalidate the old
  // descriptor on the final read so an edit during prompts cannot be adopted.
  let expected = descriptor;
  const find: OneCliCredentialConnection['find'] = async (options) => {
    const metadata = await request('', 'GET');
    const secret = namedSecret(metadata, descriptor.name);
    if (
      options &&
      expected === descriptor &&
      descriptor.type === 'generic' &&
      descriptor.injectionConfig &&
      !descriptor.authMode &&
      secret &&
      secret.hostPattern !== descriptor.hostPattern &&
      exactHost(secret.hostPattern) &&
      exactHost(descriptor.hostPattern)
    ) {
      const previous = { ...descriptor, hostPattern: secret.hostPattern };
      findOneCliCredential(metadata, previous);
      if (!(await options.confirmHostChange(previous.hostPattern, descriptor.hostPattern))) {
        throw new Error('OpenCode credential host change cancelled. Existing credential and defaults are unchanged.');
      }
      expected = previous;
    }
    return findOneCliCredential(metadata, expected);
  };
  const hostUpdate = () =>
    expected.hostPattern === descriptor.hostPattern ? {} : { hostPattern: descriptor.hostPattern };
  return {
    find,
    async keep(existingId) {
      const metadata = await request('', 'GET');
      if (findOneCliCredential(metadata, expected) !== existingId) {
        throw new Error('The OpenCode vault entry changed during setup. Check OneCLI and retry.');
      }
      const secret = (metadata as Array<Record<string, unknown>>).find((row) => row.id === existingId)!;
      const changes = {
        ...hostUpdate(),
        ...(descriptor.injectionConfig && !sameInjection(secret.injectionConfig, descriptor.injectionConfig)
          ? { injectionConfig: descriptor.injectionConfig }
          : {}),
      };
      if (Object.keys(changes).length) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', changes);
        expected = descriptor;
      }
    },
    async save(value, existingId) {
      if (!value.trim()) throw new Error('Cannot save an empty OpenCode credential.');
      if ((await find()) !== existingId) {
        throw new Error('The OpenCode vault entry changed during setup. Check OneCLI and retry.');
      }
      if (existingId) {
        await request(`/${encodeURIComponent(existingId)}`, 'PATCH', {
          value,
          ...hostUpdate(),
          ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
        });
        expected = descriptor;
        return existingId;
      }
      const result = await request('', 'POST', {
        name: descriptor.name,
        type: descriptor.type,
        valueSource: 'inline',
        hostPattern: descriptor.hostPattern,
        value,
        ...(descriptor.injectionConfig ? { injectionConfig: descriptor.injectionConfig } : {}),
      });
      // Return the ID alone: the create response may also contain a key preview.
      if (!isRecord(result) || typeof result.id !== 'string' || !result.id) {
        throw new Error('OneCLI did not confirm the saved credential ID. Check its entries before retrying.');
      }
      return result.id;
    },
  };
}

/** Native OneCLI translation is confined to its gateway adapter. */
export function createProviderCredentialConnection(
  target: import('../../../../setup/gateways/credential-store.js').GatewayCredentialTarget,
  root = process.cwd(),
): import('../../../../setup/gateways/credential-store.js').GatewayCredentialConnection {
  const vault = createOneCliCredentialConnection(
    {
      name: target.name,
      type: target.kind === 'oauth' ? 'openai' : 'generic',
      hostPattern: target.host,
      ...(target.injection ? { injectionConfig: target.injection } : {}),
      ...(target.kind === 'oauth' ? { authMode: 'oauth' as const } : {}),
    },
    undefined,
    undefined,
    globalThis.fetch,
    root,
  );
  return {
    find: vault.find,
    keep: vault.keep,
    save: (value, existingId) => {
      if ((target.kind === 'api-key') !== (typeof value === 'string'))
        throw new Error('Credential does not match its connection type');
      const encoded =
        typeof value === 'string'
          ? value
          : JSON.stringify({
              tokens: {
                access_token: value.accessToken,
                refresh_token: value.refreshToken,
                account_id: value.accountId,
              },
              OPENAI_API_KEY: null,
              last_refresh: new Date().toISOString(),
            });
      return vault.save(encoded, existingId);
    },
  };
}
