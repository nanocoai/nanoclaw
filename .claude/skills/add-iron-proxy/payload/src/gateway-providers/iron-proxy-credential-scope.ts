import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

/** One credential rule as Iron applies it, widened wherever that reading is uncertain. */
export interface CredentialRule {
  /** An Iron host glob. Absent for a CIDR rule, which Iron applies only to literal IP hosts. */
  host?: string;
  /** Upper-case methods; null is every method. Paths are never narrowed on. */
  methods: string[] | null;
}

export interface Destination {
  host: string;
  method?: string;
}

export type RuleSink = (rules: CredentialRule[]) => void;

const EVERY_REQUEST: CredentialRule = { host: '*', methods: null };
// Iron decodes YAML merge keys (<<) and this parser does not, so any key outside these lists covers everything.
const RULE_KEYS = new Set(['host', 'cidr', 'methods', 'paths']);
const SECRET_KEYS = new Set(['source', 'rules', 'inject', 'replace']);
const TRANSFORM_KEYS = new Set(['name', 'config']);
// Local configuration keys that never attach a credential to an HTTP request. A control_plane
// block is not one of them: it can change the sync interval the warm-up below relies on.
const INERT_CONFIG_KEYS = new Set(['dns', 'proxy', 'tls', 'log', 'metrics', 'management', 'postgres']);
// Go and JavaScript lowercase some non-ASCII letters differently, so only plain ASCII is matched.
const ASCII = /^[\x21-\x7e]+$/;
const CONTROL_TIMEOUT_MS = 2_000;
// Longer than a few of Iron's 10 s grant syncs, so a grant revoked before this host's first read is gone.
const WARM_UP_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function methodsOf(raw: unknown): string[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((method) => typeof method !== 'string' || method === '*' || !ASCII.test(method))
  )
    return null;
  return raw.map((method: string) => method.toUpperCase());
}

function ruleOf(raw: unknown): CredentialRule {
  if (!isRecord(raw) || !hasOnly(raw, RULE_KEYS)) return EVERY_REQUEST;
  const methods = methodsOf(raw.methods);
  if (typeof raw.host === 'string' && ASCII.test(raw.host) && raw.cidr == null)
    return { host: raw.host.toLowerCase(), methods };
  if (typeof raw.cidr === 'string' && raw.cidr && raw.host == null) return { methods };
  return EVERY_REQUEST;
}

/** No rules means "never" for an Iron secret, but "always" (or a load error) for its other transforms. */
function rulesOf(raw: unknown, whenEmpty: CredentialRule[]): CredentialRule[] {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return whenEmpty;
  return Array.isArray(raw) ? raw.map(ruleOf) : [EVERY_REQUEST];
}

function secretRules(raw: unknown): CredentialRule[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [EVERY_REQUEST];
  return raw.flatMap((entry) =>
    isRecord(entry) && hasOnly(entry, SECRET_KEYS) ? rulesOf(entry.rules, []) : [EVERY_REQUEST],
  );
}

function transformRules(raw: unknown): CredentialRule[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [EVERY_REQUEST];
  return raw.flatMap((transform): CredentialRule[] => {
    if (!isRecord(transform) || !hasOnly(transform, TRANSFORM_KEYS) || !isRecord(transform.config))
      return [EVERY_REQUEST];
    const { name, config } = transform;
    if (name === 'secrets')
      return hasOnly(config, new Set(['secrets'])) ? secretRules(config.secrets) : [EVERY_REQUEST];
    if (name === 'gcp_auth' || name === 'aws_auth' || name === 'hmac_sign')
      return rulesOf(config.rules, [EVERY_REQUEST]);
    if (name === 'oauth_token' && Array.isArray(config.tokens) && config.tokens.length > 0)
      return config.tokens.flatMap((token) =>
        isRecord(token) ? rulesOf(token.rules, [EVERY_REQUEST]) : [EVERY_REQUEST],
      );
    return [EVERY_REQUEST];
  });
}

/** Rules in an Iron Control effective config, the same shape the proxy receives on sync. */
export function effectiveConfigRules(data: unknown): CredentialRule[] {
  if (!isRecord(data) || !Array.isArray(data.secrets) || !Array.isArray(data.transforms))
    throw new Error('Iron Control effective config has an unexpected shape');
  return Object.entries(data).flatMap(([key, value]): CredentialRule[] => {
    if (key === 'id' || key === 'postgres') return [];
    if (key === 'secrets') return secretRules(value);
    if (key === 'transforms') return transformRules(value);
    return [EVERY_REQUEST];
  });
}

/** Rules in the proxy's own YAML configuration. */
export function localConfigRules(text: string): CredentialRule[] {
  const config: unknown = parseYaml(text);
  if (!isRecord(config)) throw new Error('Iron Proxy configuration is not a mapping');
  return Object.entries(config).flatMap(([key, value]): CredentialRule[] => {
    if (INERT_CONFIG_KEYS.has(key) || value == null) return [];
    if (key === 'transforms') return transformRules(value);
    return [EVERY_REQUEST];
  });
}

/** Iron's StripPort: one colon or a bracketed literal carries a port; anything else is all host. */
function stripPort(host: string): string {
  const bracketed = /^\[([^\]]*)\](?::[^:]*)?$/.exec(host);
  if (bracketed) return bracketed[1];
  const colon = host.indexOf(':');
  return colon >= 0 && colon === host.lastIndexOf(':') ? host.slice(0, colon) : host;
}

/** Iron's MatchGlob on a host name: "*", "*.suffix" (apex included), else a path.Match glob. */
function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  // Character classes and escapes are not modeled, so they cover every host.
  if (/[[\\]/.test(pattern)) return true;
  const glob = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*')
    .replace(/\\\?/g, '.');
  return new RegExp(`^${glob}$`).test(host);
}

export function ruleCovers(rule: CredentialRule, destination: Destination): boolean {
  const host = stripPort(destination.host.toLowerCase());
  const hostCovered = rule.host === undefined ? isIP(host) !== 0 : hostMatches(rule.host, host);
  const method = destination.method?.toUpperCase();
  return hostCovered && (rule.methods === null || method === undefined || rule.methods.includes(method));
}

/** Where rules once seen are kept, so a host restart does not forget what Iron may still apply. */
export interface SeenRuleStore {
  /** Throws when the record cannot be trusted. */
  load(): CredentialRule[];
  save(rules: CredentialRule[]): void;
}

const STORED_RULE_KEYS = new Set(['host', 'methods']);

function isStoredRule(value: unknown): value is CredentialRule {
  return (
    isRecord(value) &&
    hasOnly(value, STORED_RULE_KEYS) &&
    (value.host === undefined || typeof value.host === 'string') &&
    (value.methods === null || (Array.isArray(value.methods) && value.methods.every((m) => typeof m === 'string')))
  );
}

export function seenRuleFile(file: string): SeenRuleStore {
  return {
    load() {
      if (!fs.existsSync(file)) return [];
      const rules: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(rules) || !rules.every(isStoredRule))
        throw new Error(`Unreadable credential rule record: ${file}`);
      return rules;
    },
    save(rules) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(rules) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, file);
    },
  };
}

/**
 * Answers only from rules read after the question was asked, because the proxy
 * re-syncs grants on its own clock. Every rule ever read stays in scope, across
 * restarts when a store is given: Iron can keep applying a grant after Control drops it.
 */
export class IronCredentialScope {
  readonly #seen = new Map<string, CredentialRule>();
  #running: Promise<void> | null = null;
  #queued: Promise<void> | null = null;
  #watchingSince: number | null = null;
  #restored = false;
  // Stays set until a save succeeds, so one failed write is retried on the next read.
  #unsaved = false;

  constructor(
    private readonly load: (keep: RuleSink) => Promise<void>,
    private readonly now: () => number = () => Date.now(),
    private readonly store?: SeenRuleStore,
  ) {}

  async lookup(destination: Destination): Promise<'credential' | 'none'> {
    if (!this.#restored && this.store) {
      for (const rule of this.store.load()) this.#seen.set(JSON.stringify(rule), rule);
      this.#restored = true;
    }
    if (this.#covers(destination)) return 'credential';
    await this.#freshRead();
    if (this.#covers(destination)) return 'credential';
    return this.#watchingSince !== null && this.now() - this.#watchingSince >= WARM_UP_MS ? 'none' : 'credential';
  }

  #covers(destination: Destination): boolean {
    for (const rule of this.#seen.values()) if (ruleCovers(rule, destination)) return true;
    return false;
  }

  /** Settles after a read that started no earlier than this call; concurrent callers share it. */
  #freshRead(): Promise<void> {
    if (this.#queued) return this.#queued;
    const start = (): Promise<void> => {
      const startedAt = this.now();
      const read: Promise<void> = this.load((rules) => {
        for (const rule of rules) {
          const key = JSON.stringify(rule);
          if (this.#seen.has(key)) continue;
          this.#seen.set(key, rule);
          this.#unsaved = true;
        }
        if (this.#unsaved && this.store) {
          this.store.save([...this.#seen.values()]);
          this.#unsaved = false;
        }
      })
        .then(() => {
          this.#watchingSince ??= startedAt;
        })
        .finally(() => {
          if (this.#running === read) this.#running = null;
        });
      this.#running = read;
      return read;
    };
    if (!this.#running) return start();
    this.#queued = this.#running
      .catch(() => {})
      .then(() => {
        this.#queued = null;
        return start();
      });
    return this.#queued;
  }
}

export interface IronScopeSettings {
  configFile: string;
  projectRoot?: string;
  managed?: boolean;
  controlPort?: number;
}

const EMPTY_CONFIG = { secrets: [], transforms: [], postgres: [] };

async function controlEffectiveConfig(
  directory: string,
  port: number,
  fetchImpl: typeof fetch,
): Promise<{ config: unknown; stable: boolean }> {
  const env = fs.readFileSync(path.join(directory, 'control.env'), 'utf8');
  const key = /^IRON_CONTROL_INITIAL_API_KEY=(iak_[0-9a-f]{64})$/m.exec(env)?.[1];
  const registration: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'registration.json'), 'utf8'));
  const proxyId = isRecord(registration) ? registration.proxyId : undefined;
  if (!key || typeof proxyId !== 'string' || !proxyId) throw new Error('Iron Control registration is incomplete');
  const get = async (resource: string): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/${resource}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Iron Control returned ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.data)) throw new Error('Iron Control returned an unexpected body');
    return body.data;
  };
  // The proxy enforces the principal it is assigned now, which need not be the one setup
  // registered; reading the assignment again catches a swap between the two reads.
  const assignment = async (): Promise<{ principal: string | null; stamp: string }> => {
    const proxy = await get(`proxies/${encodeURIComponent(proxyId)}`);
    const principal = proxy.principal_id;
    if (principal !== null && (typeof principal !== 'string' || !principal))
      throw new Error('Iron Control proxy principal is invalid');
    return { principal, stamp: `${principal}@${String(proxy.principal_assigned_at)}` };
  };
  const before = await assignment();
  const config =
    before.principal === null
      ? EMPTY_CONFIG
      : await get(`principals/${encodeURIComponent(before.principal)}/effective_config`);
  return { config, stable: (await assignment()).stamp === before.stamp };
}

export interface IronScopeSources {
  /** When the running proxy last started: it reads its YAML only then. */
  proxyStartedAt(): Promise<number>;
  fetchImpl?: typeof fetch;
}

/** Every rule the proxy may hold: its own file and, when managed, its Iron Control principal's grants. */
export function ironCredentialRules(
  settings: IronScopeSettings,
  sources: IronScopeSources,
): (keep: RuleSink) => Promise<void> {
  return async (keep) => {
    keep(localConfigRules(fs.readFileSync(settings.configFile, 'utf8')));
    const startedAt = await sources.proxyStartedAt();
    // Stat after reading, so an edit between the two can only make this check stricter.
    if (fs.statSync(settings.configFile).mtimeMs > startedAt)
      throw new Error('Iron Proxy configuration changed after the proxy started; restart the proxy');
    const directory =
      settings.projectRoot && path.join(settings.projectRoot, 'data', 'session-materials', 'iron-control');
    const proxyEnv = directory && path.join(directory, 'proxy.env');
    if (!settings.managed && !(proxyEnv && fs.existsSync(proxyEnv))) return;
    if (!directory || !proxyEnv) throw new Error('Iron Control location is unknown');
    if (/^IRON_CONTROL_PLANE_POLL_INTERVAL=/m.test(fs.readFileSync(proxyEnv, 'utf8')))
      throw new Error('Iron Proxy uses a custom sync interval');
    // The container keeps the environment it started with, whatever the file says now.
    if (fs.statSync(proxyEnv).mtimeMs > startedAt)
      throw new Error('Iron Proxy environment changed after the proxy started; restart the proxy');
    const { config, stable } = await controlEffectiveConfig(
      directory,
      settings.controlPort ?? 10_257,
      sources.fetchImpl ?? fetch,
    );
    keep(effectiveConfigRules(config));
    if (!stable) throw new Error('Iron Control proxy assignment changed during the read');
  };
}
