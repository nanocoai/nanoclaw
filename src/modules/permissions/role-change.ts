/**
 * Human-readable summary + card rendering for role-change approvals
 * (`ncl roles grant` / `ncl roles revoke`).
 *
 * A role change is a privilege mutation: the raw command line
 * (`ncl roles-grant --user slack:U0… --role admin --group g-…`) tells the
 * approving admin almost nothing — a namespaced handle, no display name, no
 * before/after state, no blast radius. This module resolves the handle to a
 * name, describes what the role grants, and computes the target's current
 * roles vs. the state after the change so the approval card states an actual
 * consequence.
 *
 * The card wording lives here (not inlined into the CLI dispatcher) so the
 * privilege-aware routing work (Issue C) can import `describeRoleChange()` to
 * classify the request and pick an approver from the same structured summary,
 * without duplicating the role/scope resolution. `renderRoleChangeCard()` is
 * the presentation half and stays render-only.
 */
import type { UserRole } from '../../types.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getUserRoles } from './db/user-roles.js';
import { getUser } from './db/users.js';

/** CLI command names that mutate privileges. Exported for Issue C's routing. */
export const ROLE_CHANGE_COMMANDS = new Set(['roles-grant', 'roles-revoke']);

export type RoleChangeOp = 'grant' | 'revoke';

export interface RoleScope {
  kind: 'global' | 'group';
  /** Null for a global role (owner, or global admin). */
  groupId: string | null;
  /** Resolved agent-group name, when a scoped role names a known group. */
  groupName: string | null;
}

/** One role a user holds (or will hold), used for the before/after lists. */
export interface RoleLine {
  role: string;
  scope: RoleScope;
}

export interface RoleChangeSummary {
  op: RoleChangeOp;
  /** Namespaced handle, e.g. `slack:U0123`. */
  targetUserId: string;
  /** Display name from the users table, or null when unknown. */
  targetDisplay: string | null;
  role: string;
  scope: RoleScope;
  /** Plain-English description of what the role can do. */
  capabilities: string;
  /** Target's roles before the change. */
  before: RoleLine[];
  /** Target's roles after the change is applied. */
  after: RoleLine[];
  /** True when the change has no effect (grant of a held role / revoke of an absent one). */
  noop: boolean;
}

/** Normalize `--hyphen-keys` to underscore keys, matching crud.ts's parseArgs. */
function normalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.replace(/-/g, '_')] = v;
  return out;
}

function resolveScope(role: string, groupId: string | null): RoleScope {
  // Owner is always global regardless of any --group passed (the handler
  // rejects owner+group, but the card describes what was requested).
  if (role === 'owner' || !groupId) {
    return { kind: 'global', groupId: null, groupName: null };
  }
  return { kind: 'group', groupId, groupName: getAgentGroup(groupId)?.name ?? null };
}

function toLine(r: UserRole): RoleLine {
  return {
    role: r.role,
    scope:
      r.agent_group_id === null
        ? { kind: 'global', groupId: null, groupName: null }
        : { kind: 'group', groupId: r.agent_group_id, groupName: getAgentGroup(r.agent_group_id)?.name ?? null },
  };
}

function sameRole(a: RoleLine, role: string, groupId: string | null): boolean {
  return a.role === role && a.scope.groupId === groupId;
}

function describeCapabilities(role: string, scope: RoleScope): string {
  if (role === 'owner') return 'full control over all agent groups, users, and privilege grants';
  if (role === 'admin') {
    return scope.kind === 'global'
      ? 'manage all agent groups and approve sensitive actions across the system'
      : 'manage this agent group (implies membership) and approve sensitive actions for it';
  }
  return 'unknown role';
}

/**
 * Resolve a role-change request into a structured, consequence-bearing summary.
 * Reads the users and user_roles tables; performs no writes.
 */
export function describeRoleChange(op: RoleChangeOp, rawArgs: Record<string, unknown>): RoleChangeSummary {
  const args = normalizeArgs(rawArgs);
  const targetUserId = args.user != null ? String(args.user) : '';
  const role = args.role != null ? String(args.role) : '';
  const requestedGroup = args.group != null ? String(args.group) : null;

  const scope = resolveScope(role, requestedGroup);
  const effectiveGroupId = scope.groupId; // null once owner/global is normalized

  const targetDisplay = targetUserId ? (getUser(targetUserId)?.display_name ?? null) : null;
  const before = targetUserId ? getUserRoles(targetUserId).map(toLine) : [];

  const held = before.some((l) => sameRole(l, role, effectiveGroupId));
  let after: RoleLine[];
  let noop: boolean;
  if (op === 'grant') {
    noop = held;
    after = held ? before : [...before, { role, scope }];
  } else {
    noop = !held;
    after = before.filter((l) => !sameRole(l, role, effectiveGroupId));
  }

  return {
    op,
    targetUserId,
    targetDisplay,
    role,
    scope,
    capabilities: describeCapabilities(role, scope),
    before,
    after,
    noop,
  };
}

function formatScope(scope: RoleScope): string {
  if (scope.kind === 'global') return 'global (all agent groups)';
  const label = scope.groupName ? `"${scope.groupName}" (\`${scope.groupId}\`)` : `\`${scope.groupId}\``;
  return `agent group ${label}`;
}

function formatRoleLine(line: RoleLine): string {
  if (line.scope.kind === 'global') return `${line.role} (global)`;
  const label = line.scope.groupName ? `"${line.scope.groupName}"` : `\`${line.scope.groupId}\``;
  return `${line.role} @ ${label}`;
}

function formatRoleList(lines: RoleLine[]): string {
  return lines.length === 0 ? '(none)' : lines.map(formatRoleLine).join(', ');
}

export interface RoleChangeOrigin {
  /** Requesting agent group's name. */
  agentName: string;
  /** Human-readable channel the request came from. */
  channel: string;
  /** Raw command line, shown as secondary detail only. */
  commandLine: string;
}

/**
 * Render the structured summary into an approval card ({ title, question }).
 * House style follows the OneCLI / self-mod cards: `*Label:*` bold keys, one
 * fact per line, raw command demoted to a trailing detail.
 */
export function renderRoleChangeCard(
  summary: RoleChangeSummary,
  origin: RoleChangeOrigin,
): { title: string; question: string } {
  const verb = summary.op === 'grant' ? 'Grant' : 'Revoke';
  const roleLabel = summary.role || '(unspecified)';
  const title = `Role ${summary.op}: ${roleLabel}`;

  const who = summary.targetDisplay
    ? `${summary.targetDisplay} (\`${summary.targetUserId || '?'}\`)`
    : `\`${summary.targetUserId || '?'}\``;

  const lines = [
    `Agent "${origin.agentName}" requests a privilege change.`,
    '',
    `*Action:* ${verb} \`${roleLabel}\` role`,
    `*User:* ${who}`,
    `*Scope:* ${formatScope(summary.scope)}`,
    `*Capabilities:* ${summary.capabilities}`,
    `*Current roles:* ${formatRoleList(summary.before)}`,
    `*After approval:* ${formatRoleList(summary.after)}`,
  ];
  if (summary.noop) {
    lines.push(
      summary.op === 'grant'
        ? '_No effect: the user already holds this role._'
        : '_No effect: the user does not currently hold this role._',
    );
  }
  lines.push(
    '',
    `*Origin:* agent "${origin.agentName}", channel ${origin.channel}`,
    `_Command:_ \`${origin.commandLine}\``,
  );
  return { title, question: lines.join('\n') };
}
