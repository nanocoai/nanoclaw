import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  postHook: null as null | ((msg: any, session: any) => Promise<void>),
  action: null as null | ((content: Record<string, unknown>, session: any) => Promise<void>),
  emitted: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../delivery.js', () => ({
  registerPostDeliveryHook: (hook: typeof state.postHook) => {
    state.postHook = hook;
  },
  registerDeliveryAction: (_name: string, action: typeof state.action) => {
    state.action = action;
  },
}));

vi.mock('../../guard/index.js', () => ({ unguarded: () => ({}) }));
vi.mock('../../audit/emit.js', () => ({
  emitAuditEvent: async (event: Record<string, unknown>) => { state.emitted.push(event); },
}));
vi.mock('../../audit/migration.js', () => ({}));

await import('./index.js');

beforeEach(() => state.emitted.splice(0));

describe('host runtime observers', () => {
  it('records a completed response and outbound file count without file names or paths', async () => {
    await state.postHook?.(
      {
        id: 'response-1',
        channelType: 'slack',
        content: JSON.stringify({ text: 'SECRET TEXT', files: ['/secret/path.pdf', 'secret-name.csv'] }),
      },
      { id: 'session-1', agent_group_id: 'agent-1', messaging_group_id: 'mg-1' },
    );

    expect(state.emitted.map((event) => event.eventType)).toEqual(['response_completed', 'file_delivered']);
    expect(state.emitted[1]).toMatchObject({
      dimensions: { file_count: 2, file_direction: 'outbound', file_classification: 'contains_non_text' },
    });
    expect(JSON.stringify(state.emitted)).not.toMatch(/SECRET|path\.pdf|secret-name/);
  });

  it('emits no file delivery for a no-file response and marks unknown file types without source leakage', async () => {
    const session = { id: 'session-1', agent_group_id: 'agent-1', messaging_group_id: 'mg-1' };
    await state.postHook?.({ id: 'response-no-file', channelType: 'slack', content: '{"text":"SECRET"}' }, session);
    await state.postHook?.({
      id: 'response-unknown-file',
      channelType: 'slack',
      content: JSON.stringify({ files: ['/private/UNKNOWN_SENTINEL.weird'] }),
    }, session);

    expect(state.emitted.map((event) => event.eventType)).toEqual([
      'response_completed', 'response_completed', 'file_delivered',
    ]);
    expect(state.emitted[2]).toMatchObject({
      dimensions: { file_count: 1, file_classification: 'unknown' },
    });
    expect(JSON.stringify(state.emitted)).not.toMatch(/SECRET|UNKNOWN_SENTINEL|private|weird/);
  });

  it('accepts only the closed skill action and ignores added fields', async () => {
    const session = { id: 'session-1', agent_group_id: 'agent-1' };
    await state.action?.({ action: 'host_audit_activity', event_type: 'skill_used', activity_id: 'weekly-brief' }, session);
    await state.action?.(
      { action: 'host_audit_activity', event_type: 'skill_used', activity_id: 'weekly-brief', path: '/secret' },
      session,
    );

    expect(state.emitted).toEqual([
      expect.objectContaining({
        eventType: 'skill_used',
        dimensions: expect.objectContaining({ activity_id: 'weekly-brief', resource_refs: ['skill:weekly-brief'] }),
      }),
    ]);
  });
});
