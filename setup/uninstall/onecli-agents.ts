/**
 * OneCLI vault-agent inventory for the uninstaller.
 *
 * Vault agents split into two sets: MINE (identifier matches an agent-group
 * id in this copy's data/v2.db) and ORPHANS (NanoClaw-style `ag-*`
 * identifiers not in our DB — possibly another copy's). Deletion is always
 * by the vault's internal uuid: the agent-group id is NOT a valid
 * `onecli agents delete --id` value (see src/container-runner.ts).
 */
import fs from 'fs';

import Database from 'better-sqlite3';

export interface VaultAgent {
  /** Internal vault uuid — the only valid `onecli agents delete --id` value. */
  uuid: string;
  /** What the agent was registered under, e.g. a NanoClaw agent-group id (`ag-*`). */
  identifier: string;
  name: string;
}

export type RunCommand = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string };

/**
 * List non-default vault agents via `onecli agents list`. `available: false`
 * means the vault couldn't be read at all (binary missing, command failed,
 * or unparseable output) — distinct from an empty vault.
 */
export function listVaultAgents(run: RunCommand): {
  available: boolean;
  agents: VaultAgent[];
} {
  let result: { status: number | null; stdout: string };
  try {
    result = run('onecli', ['agents', 'list']);
  } catch {
    return { available: false, agents: [] };
  }
  if (result.status !== 0) return { available: false, agents: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, agents: [] };
  }

  const data =
    parsed !== null && typeof parsed === 'object' && 'data' in parsed
      ? (parsed as { data: unknown }).data
      : null;
  if (!Array.isArray(data)) return { available: false, agents: [] };

  const agents: VaultAgent[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (a.isDefault === true) continue;
    const identifier = typeof a.identifier === 'string' ? a.identifier : '';
    const uuid = typeof a.id === 'string' ? a.id : '';
    if (!identifier || identifier === 'default' || !uuid) continue;
    agents.push({
      uuid,
      identifier,
      name: typeof a.name === 'string' ? a.name : '',
    });
  }
  return { available: true, agents };
}

/**
 * Read this copy's agent-group ids from data/v2.db (readonly).
 *
 * `known: false` distinguishes "we couldn't read the DB at all" from "this
 * copy has zero agent groups" — without it every ag-* vault agent would be
 * mislabeled an orphan and --yes would silently leave this copy's agents
 * behind.
 */
export function readAgentGroupIds(dbPath: string): {
  ids: Set<string>;
  known: boolean;
} {
  if (!fs.existsSync(dbPath)) return { ids: new Set(), known: false };

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT id FROM agent_groups').all() as {
      id: string;
    }[];
    return { ids: new Set(rows.map((r) => r.id)), known: true };
  } catch {
    return { ids: new Set(), known: false };
  } finally {
    db?.close();
  }
}

/**
 * Split vault agents into MINE (identifier ∈ ids) and ORPHANS (ag-* not in
 * ids). Non-NanoClaw identifiers are ignored entirely. With `known: false`
 * nothing can be MINE, so every ag-* agent lands in ORPHANS — the caller is
 * responsible for warning that the labels are unreliable.
 */
export function splitVaultAgents(
  agents: VaultAgent[],
  ids: Set<string>,
  known: boolean,
): { mine: VaultAgent[]; orphans: VaultAgent[] } {
  const mine: VaultAgent[] = [];
  const orphans: VaultAgent[] = [];
  for (const agent of agents) {
    if (known && ids.has(agent.identifier)) {
      mine.push(agent);
    } else if (agent.identifier.startsWith('ag-')) {
      orphans.push(agent);
    }
  }
  return { mine, orphans };
}

/**
 * Resolve the vault-agent delete set from the user's answers. Under --yes
 * (`assumeYes`) MINE is always deleted but ORPHANS never are — deleting
 * what may be another copy's agents requires explicit human intent.
 */
export function resolveOnecliDeletions(input: {
  mine: VaultAgent[];
  orphans: VaultAgent[];
  assumeYes: boolean;
  deleteMine: boolean;
  deleteOrphans: boolean;
}): VaultAgent[] {
  const out: VaultAgent[] = [];
  if (input.assumeYes || input.deleteMine) out.push(...input.mine);
  if (!input.assumeYes && input.deleteOrphans) out.push(...input.orphans);
  return out;
}
