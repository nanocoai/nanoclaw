// Agents overview — the one derived page in clidash.
//
// This is the join, not the rendering: it takes the `ncl` snapshots the UI has
// already fetched for its resource tabs (groups, sessions, wirings,
// messaging-groups) plus the activity totals and per-group container config, and
// returns plain card data. `app.js` renders the result and adds nothing to it.
//
// It lives client-side on purpose. A server-side version would have to re-run
// four `ncl … list` execs per refresh for rows the browser is already holding,
// which is exactly the exec fan-out the server's concurrency gate exists to
// contain. Being a pure function of its inputs, it is unit-tested directly
// (test/overview.test.js) — the rendered path and the tested path are the same
// code.

export const GREEN_MAX_MIN = 15;
export const AMBER_MAX_MIN = 120;

/** green <15m since last_active, amber <2h, red older, gray never / unparseable. */
export function staleness(lastActive, now = Date.now()) {
  if (!lastActive) return 'gray';
  const ageMin = (now - new Date(lastActive).getTime()) / 60_000;
  if (Number.isNaN(ageMin)) return 'gray';
  if (ageMin < GREEN_MAX_MIN) return 'green';
  if (ageMin < AMBER_MAX_MIN) return 'amber';
  return 'red';
}

// `configs` is a Map in the running UI (state.configCache) and is handy as a
// plain object in tests; accept either.
function configFor(configs, id) {
  if (!configs) return null;
  return (configs instanceof Map ? configs.get(id) : configs[id]) ?? null;
}

/**
 * @param {object} input
 * @param {object[]} input.groups            rows from `ncl groups list --json`
 * @param {object[]} [input.sessions]        rows from `ncl sessions list --json`
 * @param {object[]} [input.wirings]         rows from `ncl wirings list --json`
 * @param {object[]} [input.messagingGroups] rows from `ncl messaging-groups list --json`
 * @param {object[]} [input.activity]        per-session `{ agent_group_id, in, out }` from /api/activity
 * @param {Map|object} [input.configs]       agent-group id -> container config
 * @param {number} [input.now]               injectable clock, for tests
 * @returns {{ title: string, cards: object[] }}
 */
export function buildOverview({
  groups,
  sessions = [],
  wirings = [],
  messagingGroups = [],
  activity = [],
  configs = null,
  now = Date.now(),
}) {
  const mgById = new Map(messagingGroups.map((mg) => [mg.id, mg]));
  const mgLabel = (id) => {
    const mg = mgById.get(id);
    if (!mg) return String(id);
    return `${mg.channel_type ?? '?'}: ${mg.name ?? mg.platform_id ?? mg.id}`;
  };

  const cards = groups.map((group) => {
    const groupSessions = sessions.filter((s) => s.agent_group_id === group.id);
    const lastActive = groupSessions
      .map((s) => s.last_active)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    // One running container in the group makes the group "running"; otherwise
    // report the first session's status, or "none" when there are no sessions.
    const container = groupSessions.some((s) => s.container_status === 'running')
      ? 'running'
      : groupSessions[0]?.container_status ?? 'none';

    const groupActivity = activity.filter((a) => a.agent_group_id === group.id);
    const cfg = configFor(configs, group.id);

    return {
      id: group.id,
      title: group.name,
      subtitle: group.folder,
      status: staleness(lastActive, now),
      container,
      sessions: groupSessions.length,
      messagesIn: groupActivity.reduce((total, a) => total + (a.in ?? 0), 0),
      messagesOut: groupActivity.reduce((total, a) => total + (a.out ?? 0), 0),
      lastActive,
      badges: wirings
        .filter((w) => w.agent_group_id === group.id)
        .map((w) => mgLabel(w.messaging_group_id)),
      config: cfg
        ? {
          provider: cfg.provider ?? 'claude',
          model: cfg.model ?? 'default',
          cliScope: cfg.cli_scope ?? 'group',
          packages: (cfg.packages_apt?.length ?? 0) + (cfg.packages_npm?.length ?? 0),
          mcpServers: Object.keys(cfg.mcp_servers ?? {}).length,
        }
        : null,
    };
  });

  return { title: 'Agents overview', cards };
}
