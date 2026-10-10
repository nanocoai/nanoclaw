// Scope Dial to the chosen agents through the OneCLI v2 policy API
// (/v1/policy), which the pinned gateway enforces; the pinned CLI has no
// policy commands, so this talks HTTP with the CLI's own key.
//
// One BLOCK rule, "Dial: blocked agents", on api.getdial.ai names the agents
// not chosen; `all` means no rule. A block and never an allow: OneCLI drops a
// deleted agent from a rule's identities, and a rule with none matches every
// agent, so a leftover allow would open Dial to everyone while a leftover
// block only closes it. The block is moved to the top of the order, so under
// first-match no operator allow can let a blocked agent through; operator
// rules keep their relative order and are otherwise never touched.
//
// Usage (from the NanoClaw repo root):
//   pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents <all|none|ag-1,ag-2>
//   pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts remove

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DIAL_HOST = 'api.getdial.ai';
export const BLOCK_RULE = 'Dial: blocked agents';
/** The legacy per-agent block rules migrate under their own names. */
const LEGACY_BLOCK_PREFIX = 'Dial: blocked for ';
/** OneCLI caps a rule's identities (validations/policy.ts: max 100). */
const MAX_IDENTITIES = 100;

export interface PolicyIdentity {
  type: string;
  id: string;
}
export interface PolicyTarget {
  kind: string;
  hostPattern?: string | null;
  pathPattern?: string | null;
  method?: string | null;
  secretId?: string | null;
  secretScope?: string | null;
}
export interface PolicyRule {
  id: string;
  logicalId: string;
  source: string;
  name: string;
  action: string;
  enabled: boolean;
  priority: number;
  identities: PolicyIdentity[];
  targets: PolicyTarget[];
}
export interface OneCliAgent {
  id: string;
  identifier: string;
  name: string;
}
export interface AgentGroup {
  id: string;
  name: string;
}

export interface PolicyClient {
  listAgents(): Promise<OneCliAgent[]>;
  /** Vault metadata only (ids, names, hosts): never values. */
  listSecrets(): Promise<Array<{ id: string; name: string; hostPattern: string }>>;
  listRules(status: 'draft' | 'published'): Promise<PolicyRule[]>;
  /** True once the gateway's boot cutover published a generation (its Default Rule has an id). */
  cutOver(): Promise<boolean>;
  /** Set the whole draft order; must name every non-default draft rule once. */
  reorder(orderedIds: string[]): Promise<void>;
  createRule(body: unknown): Promise<PolicyRule>;
  deleteRule(id: string): Promise<void>;
  publish(): Promise<void>;
}

export class PolicyApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The gateway's `{ error: { message } }` envelope, or a status-only message. */
async function errorMessage(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const err = isRecord(body) ? body.error : undefined;
  const text = isRecord(err) && typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : '';
  return text ? `${response.status}: ${text}` : `HTTP ${response.status}`;
}

export function createPolicyClient(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): PolicyClient {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('the OneCLI api-host must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const root = base.href.replace(/\/+$/, '');
  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch (e) {
      throw new Error(`could not reach the OneCLI gateway at ${root}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!response.ok)
      throw new PolicyApiError(response.status, `${method} ${path} failed with ${await errorMessage(response)}`);
    if (response.status === 204) return undefined;
    return response.json();
  };
  const list = async (path: string, what: string): Promise<unknown[]> => {
    const payload = await request('GET', path);
    if (!Array.isArray(payload)) throw new Error(`OneCLI returned an unexpected ${what} payload`);
    return payload;
  };
  return {
    listAgents: async () =>
      (await list('/v1/agents', 'agent list')).map((a) => {
        if (!isRecord(a) || typeof a.id !== 'string' || typeof a.identifier !== 'string') {
          throw new Error('OneCLI returned an unexpected agent entry');
        }
        return { id: a.id, identifier: a.identifier, name: typeof a.name === 'string' ? a.name : a.identifier };
      }),
    listSecrets: async () =>
      (await list('/v1/secrets', 'secret list')).map((s) => ({
        id: isRecord(s) && typeof s.id === 'string' ? s.id : '',
        name: isRecord(s) && typeof s.name === 'string' ? s.name : '',
        hostPattern: isRecord(s) && typeof s.hostPattern === 'string' ? s.hostPattern : '',
      })),
    listRules: async (status) =>
      (await list(`/v1/policy/rules?status=${status}`, 'policy rule list')).map((r) => {
        if (!isRecord(r) || typeof r.id !== 'string' || typeof r.name !== 'string') {
          throw new Error('OneCLI returned an unexpected policy rule');
        }
        return r as unknown as PolicyRule;
      }),
    cutOver: async () => {
      const d = await request('GET', '/v1/policy/default?status=published');
      return isRecord(d) && typeof d.id === 'string' && d.id !== '';
    },
    reorder: async (orderedIds) => {
      await request('PUT', '/v1/policy/rules/order', { orderedIds });
    },
    createRule: async (body) => (await request('POST', '/v1/policy/rules', body)) as PolicyRule,
    deleteRule: async (id) => {
      await request('DELETE', `/v1/policy/rules/${encodeURIComponent(id)}`);
    },
    publish: async () => {
      await request('POST', '/v1/policy/publish');
    },
  };
}

const wholeDialHost = (rule: PolicyRule): boolean =>
  rule.targets.length === 1 &&
  rule.targets[0].kind === 'network' &&
  rule.targets[0].hostPattern === DIAL_HOST &&
  !rule.targets[0].pathPattern &&
  !rule.targets[0].method;

/** This skill's rules: its block, or a migrated legacy per-agent block, on the whole Dial host. */
export const isDialRule = (rule: PolicyRule): boolean =>
  rule.action === 'block' &&
  wholeDialHost(rule) &&
  (rule.name === BLOCK_RULE ||
    (rule.name.startsWith(LEGACY_BLOCK_PREFIX) && rule.name.length > LEGACY_BLOCK_PREFIX.length));

export type DialScope = { kind: 'all' } | { kind: 'none' } | { kind: 'ids'; ids: string[] };

export function parseScope(raw: string): DialScope {
  const words = [
    ...new Set(
      raw
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
  if (words.length === 1 && words[0] === 'all') return { kind: 'all' };
  if (words.length === 1 && words[0] === 'none') return { kind: 'none' };
  if (words.length && words.every((w) => /^ag-[A-Za-z0-9-]+$/.test(w))) return { kind: 'ids', ids: words };
  throw new Error(`invalid agent selection '${raw}': use agent ids separated by commas, all, or none`);
}

/** Delete every Dial rule in the draft; returns how many went. */
async function deleteDialRules(client: PolicyClient): Promise<number> {
  const mine = (await client.listRules('draft')).filter(isDialRule);
  for (const rule of mine) await client.deleteRule(rule.id);
  return mine.length;
}

export interface ScopeOutcome {
  allowed: AgentGroup[];
  blocked: AgentGroup[];
}

/** Reconcile the Dial policy to `scope` and publish it. */
export async function scopeDial(client: PolicyClient, scope: DialScope, groups: AgentGroup[]): Promise<ScopeOutcome> {
  const agents = await client.listAgents();
  const agentOf = new Map(agents.map((a) => [a.identifier, a]));
  for (const g of groups) {
    if (!agentOf.has(g.id))
      throw new Error(`no OneCLI agent for ${g.name} (${g.id}) — the agent creation step did not run`);
  }
  if (scope.kind === 'ids') {
    const known = new Set(groups.map((g) => g.id));
    for (const id of scope.ids)
      if (!known.has(id)) throw new Error(`unknown agent group '${id}' — see: ncl groups list`);
  }
  const chosen =
    scope.kind === 'all' ? groups : scope.kind === 'none' ? [] : groups.filter((g) => scope.ids.includes(g.id));
  const blocked = groups.filter((g) => !chosen.some((c) => c.id === g.id));
  const ownAgents = new Set(groups.map((g) => agentOf.get(g.id)!.id));

  // A project whose 1.42 boot cutover has not published a generation still
  // runs on legacy rules; a publish here would pre-empt that migration
  // (policy-oss-cutover.ts PREEMPTED) and silently drop those rules.
  if (!(await client.cutOver())) {
    throw new Error(
      'this OneCLI project has no published policy yet (its 1.42 migration did not run); check the gateway log for policy-oss-cutover, then re-run',
    );
  }
  const draft = await client.listRules('draft');
  const published = await client.listRules('published');
  // Agents another NanoClaw install on this gateway blocked stay blocked: only
  // this install's groups are reconciled (the legacy per-agent rules behaved
  // the same way). The published set counts too, so a run interrupted after
  // the delete does not lose them on retry.
  const foreignBlocked = [...draft, ...published]
    .filter(isDialRule)
    .flatMap((r) => r.identities.filter((i) => i.type === 'agent' && !ownAgents.has(i.id)).map((i) => i.id));
  const blockedAgentIds = [...new Set([...foreignBlocked, ...blocked.map((g) => agentOf.get(g.id)!.id)])];
  if (blockedAgentIds.length > MAX_IDENTITIES) {
    throw new Error(`more than ${MAX_IDENTITIES} agents to block; OneCLI allows ${MAX_IDENTITIES} per rule`);
  }
  // Create the new block first and delete the old ones last, so the draft
  // holds a Dial block, at the top, at every step. No agent left out (`all`, or every group
  // named) needs no rule; `none` before any group exists blocks every agent
  // until a group exists and the skill is re-run.
  const blockEveryone = scope.kind === 'none' && groups.length === 0;
  if (blockedAgentIds.length || blockEveryone) {
    await client.createRule({
      name: BLOCK_RULE,
      description:
        'Managed by NanoClaw /add-dial-tool: the agents that may not use Dial. Re-run the skill to change it.',
      action: 'block',
      // Everyone blocked = no identities; naming any would narrow it.
      identities: blockEveryone ? [] : blockedAgentIds.map((id) => ({ type: 'agent', id })),
      targets: [{ kind: 'network', hostPattern: DIAL_HOST }],
    });
  }
  // First-match: put the Dial rules (the new one first, then the old ones) at
  // the top so no earlier operator allow can let a blocked agent through;
  // every other rule keeps its relative order. Reorder before deleting, so a
  // failed reorder never leaves the new block at the bottom with the old
  // ones gone.
  const after = await client.listRules('draft');
  const oldIds = new Set(draft.filter(isDialRule).map((r) => r.id));
  const ours = after.filter(isDialRule).sort((a, b) => Number(oldIds.has(a.id)) - Number(oldIds.has(b.id)));
  if (ours.length) {
    await client.reorder([...ours, ...after.filter((r) => !isDialRule(r))].map((r) => r.id));
  }
  for (const id of oldIds) await client.deleteRule(id);
  await client.publish();

  // Read the active generation back: exactly one block with exactly the
  // agents that were not chosen, or none.
  const mine = (await client.listRules('published')).filter(isDialRule);
  const liveIds = mine.flatMap((r) => r.identities.map((i) => i.id)).sort();
  const expected = blockedAgentIds.length || blockEveryone ? 1 : 0;
  if (
    mine.length !== expected ||
    !mine.every((r) => r.enabled) ||
    liveIds.join() !== (blockEveryone ? [] : [...blockedAgentIds].sort()).join()
  ) {
    throw new Error('the published OneCLI policy does not block exactly the agents that were not chosen');
  }
  return { allowed: chosen, blocked };
}

/**
 * Delete this skill's rules (and migrated legacy ones) and publish. Refuses
 * while a Dial secret is still in the vault: the block is what keeps unchosen
 * agents away from a key that is injected for every `all`-mode agent.
 */
export async function removeDial(client: PolicyClient): Promise<number> {
  const assertNoDialSecret = async () => {
    const dialSecret = (await client.listSecrets()).find((s) => s.hostPattern === DIAL_HOST || /dial/i.test(s.name));
    if (dialSecret) {
      throw new Error(
        `the OneCLI vault still holds a Dial secret (${dialSecret.name}); delete it first, then remove the policy`,
      );
    }
  };
  await assertNoDialSecret();
  const draft = await deleteDialRules(client);
  const live = (await client.listRules('published')).filter(isDialRule).length;
  if (draft || live) await client.publish();
  return draft;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const run = (cmd: string, args: string[]): string =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** The gateway the onecli CLI writes to, and the key it authenticates with. */
export function cliConnection(): { url: string; apiKey: string } {
  let url = '';
  try {
    const parsed: unknown = JSON.parse(run('onecli', ['config', 'get', 'api-host']));
    if (isRecord(parsed) && typeof parsed.value === 'string') url = parsed.value.trim();
  } catch {
    url = '';
  }
  if (!url) throw new Error("could not read the onecli CLI's api-host, so the OneCLI gateway is unknown");
  // A gateway with ambient local auth needs no key; the CLI then fails here
  // and the requests go without one.
  let apiKey = '';
  try {
    const parsed: unknown = JSON.parse(run('onecli', ['auth', 'api-key']));
    if (isRecord(parsed) && typeof parsed.apiKey === 'string') apiKey = parsed.apiKey.trim();
  } catch {
    apiKey = '';
  }
  return { url, apiKey };
}

function agentGroups(): AgentGroup[] {
  let payload: unknown;
  try {
    // `ncl` lists 200 rows by default; ask for every group.
    payload = JSON.parse(run('ncl', ['groups', 'list', '--json', '--limit', '100000']));
  } catch {
    throw new Error('could not list agent groups — is the NanoClaw host running?');
  }
  const data = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(data)) throw new Error('ncl groups list returned an unexpected payload');
  return data.map((g) => {
    if (!isRecord(g) || typeof g.id !== 'string') throw new Error('ncl groups list returned an unexpected group');
    return { id: g.id, name: typeof g.name === 'string' ? g.name : g.id };
  });
}

function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof PolicyApiError && e.status === 401) {
    return `${msg}. The OneCLI gateway rejected the CLI's key: run onecli auth login, then re-run.`;
  }
  if (e instanceof PolicyApiError && e.status === 403 && /editing is not enabled/i.test(msg)) {
    return `${msg}. This gateway does not enforce the policy engine (OneCLI gateway 1.42 does); upgrade to the pinned 1.42.0 (docs/onecli-upgrades.md).`;
  }
  return msg;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'scope') {
      const at = rest.indexOf('--agents');
      if (at < 0 || !rest[at + 1]) throw new Error('usage: dial-policy.ts scope --agents <all|none|ag-1,ag-2>');
      const scope = parseScope(rest[at + 1]);
      const { url, apiKey } = cliConnection();
      const outcome = await scopeDial(createPolicyClient(url, apiKey), scope, agentGroups());
      // stdout is captured by the skill and interpolated into later steps, so
      // it carries ids only (validated as `ag-…`), never a free-text name.
      for (const g of outcome.allowed) console.log(`allowed:${g.id}`);
      for (const g of outcome.blocked) console.log(`blocked:${g.id}`);
      console.log('published');
      for (const g of outcome.allowed) console.error(`allowed: ${g.name} (${g.id})`);
      for (const g of outcome.blocked) console.error(`blocked: ${g.name} (${g.id})`);
      return 0;
    }
    if (command === 'remove') {
      const { url, apiKey } = cliConnection();
      const gone = await removeDial(createPolicyClient(url, apiKey));
      console.log(gone ? `removed ${gone} Dial policy rule(s) and published` : 'no Dial policy rules to remove');
      return 0;
    }
    throw new Error('usage: dial-policy.ts <scope --agents …|remove>');
  } catch (e) {
    console.error(explain(e));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
