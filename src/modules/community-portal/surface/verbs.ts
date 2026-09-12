/**
 * `ncl sandboxes surface status | archive | enable | disable` — the
 * operator's view of the chat surface bound to a coding session, and the
 * host's setting for opening one, added to the sandboxes resource through
 * code mode's resource extension. Host-only, like every sandbox verb: the
 * ncl socket is the auth boundary.
 */
import { extendResource, RESOURCE_EXTENSION_SEAM, type CustomOperation } from '../../../cli/crud.js';
import { sandboxVerbs } from '../../../code-mode/sandboxes.js';
import { archiveSandboxSurface, getSessionSurfaceByGroup } from '../../../code-mode/surface/index.js';
import type { AgentGroup } from '../../../types.js';
import type { ChannelRecord } from './client.js';
import { clientForRow } from './index.js';
import { setSurfaceAutoOpen, type SurfaceSetting } from './setting.js';

/** id-first, then folder — the sandbox API's own resolution; the not-found text names the verb. */
async function resolveSandboxGroup(raw: unknown, verb: string): Promise<AgentGroup> {
  const id = raw === undefined || raw === null ? '' : String(raw);
  if (!id) throw new Error(`usage: ncl sandboxes ${verb} <name-or-id>`);
  const group = await sandboxVerbs().find(id);
  if (!group) throw new Error(`no sandbox '${id}' — create it: ncl sandboxes new --name ${id}`);
  return group;
}

export interface SurfaceStatusView {
  sandbox: string;
  provider: string;
  surfaceId: string;
  sessionId: string;
  title: string;
  /** The service's view when reachable, else the last status this host sent. */
  status: string | null;
  lastStatusSent: string | null;
  lastStatusAt: string | null;
  stoppedAt: string | null;
  archivedAt: string | null;
  members: Array<{ id: string; role?: string; sandbox?: string | null; terminalAddress?: string | null }>;
  views: Array<{ viewKey: string; type: string; updatedAt?: string }>;
  createdAt: string;
  serviceError?: string;
}

async function surfaceStatus(
  args: Record<string, unknown>,
): Promise<SurfaceStatusView | { sandbox: string; surface: null }> {
  const group = await resolveSandboxGroup(args.id, 'surface status');
  const row = await getSessionSurfaceByGroup(group.id);
  if (!row) return { sandbox: group.folder, surface: null };
  let live: ChannelRecord | undefined;
  let serviceError: string | undefined;
  if (!row.archived_at) {
    const found = await clientForRow(row);
    if (found) {
      try {
        live = await found.client.get(row.surface_id);
      } catch (err) {
        serviceError = err instanceof Error ? err.message : String(err);
      }
    } else {
      serviceError = 'this host serves no surface for the platform (no managed install or sign-in)';
    }
  }
  return {
    sandbox: group.folder,
    provider: row.provider,
    surfaceId: row.surface_id,
    sessionId: row.session_id,
    title: row.title,
    status: live?.status ?? (row.archived_at ? 'closed' : row.last_status),
    lastStatusSent: row.last_status,
    lastStatusAt: row.last_status_at,
    stoppedAt: live?.stoppedAt ?? row.stopped_at,
    archivedAt: live?.archivedAt ?? row.archived_at,
    members: (live?.members ?? []).map((m) => ({
      id: m.botUserId,
      ...(m.role ? { role: m.role } : {}),
      ...(m.sandboxName !== undefined ? { sandbox: m.sandboxName } : {}),
      ...(m.terminalAddress !== undefined ? { terminalAddress: m.terminalAddress } : {}),
    })),
    views: (live?.views ?? []).map((v) => ({
      viewKey: v.viewKey,
      type: v.type,
      ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
    })),
    createdAt: row.created_at,
    ...(serviceError ? { serviceError } : {}),
  };
}

function renderSetting(data: unknown): string {
  const s = data as SurfaceSetting;
  return s.autoOpen
    ? 'New sandboxes get a chat surface when the service offers one.'
    : 'New sandboxes get no chat surface on this host (ncl sandboxes surface enable turns it back on).';
}

export const surfaceOperations: Record<string, CustomOperation> = {
  'surface enable': {
    access: 'open',
    hostOnly: true,
    description:
      'Open a chat surface for every new sandbox the service offers one for — the default (host operators only).\n' +
      'Usage: ncl sandboxes surface enable. Kept across host restarts. Sandboxes created while it was disabled ' +
      'stay plain.',
    handler: async () => setSurfaceAutoOpen(true),
    formatHuman: renderSetting,
  },
  'surface disable': {
    access: 'open',
    hostOnly: true,
    description:
      'Stop opening a chat surface for new sandboxes on this host (host operators only).\n' +
      'Usage: ncl sandboxes surface disable. Kept across host restarts. Surfaces already open are untouched: ' +
      'they keep mirroring their sessions until archived.',
    handler: async () => setSurfaceAutoOpen(false),
    formatHuman: renderSetting,
  },
  'surface status': {
    access: 'open',
    hostOnly: true,
    description:
      "Show the chat surface bound to a sandbox's coding session, as the service sees it (host operators only).\n" +
      'Usage: ncl sandboxes surface status <name-or-id>. Reports the surface id, the status the service holds, ' +
      'the last status this host sent, the members with their terminal addresses, and the views it carries. ' +
      'A sandbox on a host without a managed chat app has none.',
    handler: surfaceStatus,
    formatHuman: (data) => {
      const d = data as Partial<SurfaceStatusView> & { sandbox: string; surface?: null };
      if (!d.surfaceId) return `${d.sandbox}: no chat surface`;
      const lines = [
        `${d.sandbox}: ${d.provider} ${d.surfaceId} (${d.title ?? ''})`,
        `  status:     ${d.status ?? '-'}${d.archivedAt ? ' (archived)' : ''}${d.stoppedAt && !d.archivedAt ? ' (stopped by the user)' : ''}`,
        `  last sent:  ${d.lastStatusSent ?? '-'}${d.lastStatusAt ? ` at ${d.lastStatusAt}` : ''}`,
        `  members:    ${
          d.members && d.members.length > 0
            ? d.members
                .map(
                  (m) =>
                    `${m.id}${m.role ? ` (${m.role})` : ''}${m.terminalAddress ? ` ssh ${m.terminalAddress}` : ''}`,
                )
                .join(', ')
            : '-'
        }`,
        `  views:      ${d.views && d.views.length > 0 ? d.views.map((v) => `${v.viewKey} (${v.type})`).join(', ') : '-'}`,
      ];
      if (d.serviceError) lines.push(`  service:    ${d.serviceError}`);
      return lines.join('\n');
    },
  },
  'surface archive': {
    access: 'open',
    hostOnly: true,
    description:
      "Archive the chat surface bound to a sandbox's coding session (host operators only).\n" +
      'Usage: ncl sandboxes surface archive <name-or-id> [--summary <text>]. The explicit wrap-up: the surface ' +
      'closes at the service (with the summary posted first, when given) and this host stops mirroring it. ' +
      'Nothing else archives a surface — not a Stop, not deleting the sandbox. The sandbox itself is untouched.',
    handler: async (args) => {
      const group = await resolveSandboxGroup(args.id, 'surface archive');
      const summary = args.summary === undefined ? undefined : String(args.summary);
      return archiveSandboxSurface(group, summary ? { summary } : {});
    },
    formatHuman: (data) => {
      const d = data as { sandbox: string; surfaceId: string; archivedAt: string };
      return `${d.sandbox}: surface ${d.surfaceId} archived at ${d.archivedAt}`;
    },
  },
};

extendResource('sandboxes', surfaceOperations, { seam: RESOURCE_EXTENSION_SEAM });
