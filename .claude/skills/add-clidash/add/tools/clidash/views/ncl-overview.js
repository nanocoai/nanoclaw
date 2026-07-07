// Curated "Agents overview" view for ncl: joins groups + sessions +
// messaging-groups + wirings into per-agent cards. Returns the generic
// card shape the frontend renders, so the UI itself stays CLI-agnostic:
//   { title, cards: [{ title, subtitle, status, fields, badges }] }
// status: green <15m since last_active, amber <2h, red older, gray never.

const GREEN_MAX_MIN = 15;
const AMBER_MAX_MIN = 120;

function staleness(lastActive) {
  if (!lastActive) return 'gray';
  const ageMin = (Date.now() - new Date(lastActive).getTime()) / 60_000;
  if (ageMin < GREEN_MAX_MIN) return 'green';
  if (ageMin < AMBER_MAX_MIN) return 'amber';
  return 'red';
}

export default async function overview({ fetch }) {
  const [groups, sessions, messagingGroups, wirings] = await Promise.all([
    fetch('groups'),
    fetch('sessions'),
    fetch('messaging-groups'),
    fetch('wirings'),
  ]);

  const mgById = new Map(messagingGroups.map((mg) => [mg.id, mg]));

  const cards = groups.map((group) => {
    const groupSessions = sessions.filter((s) => s.agent_group_id === group.id);
    const lastActive = groupSessions
      .map((s) => s.last_active)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const container = groupSessions.some((s) => s.container_status === 'running')
      ? 'running'
      : groupSessions[0]?.container_status ?? 'none';

    const badges = wirings
      .filter((w) => w.agent_group_id === group.id)
      .map((w) => {
        const mg = mgById.get(w.messaging_group_id);
        return mg ? `${mg.channel_type}: ${mg.name ?? mg.platform_id}` : w.messaging_group_id;
      });

    return {
      title: group.name,
      subtitle: group.folder,
      status: staleness(lastActive),
      fields: {
        container,
        sessions: groupSessions.length,
        'last active': lastActive,
      },
      badges,
    };
  });

  return { title: 'Agents overview', cards };
}
