import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });

  it('gives task sessions only explicit-tool delivery instructions', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'daily-briefing-a25c' });

    expect(prompt).toContain('isolated task run');
    expect(prompt).toContain('send_message({ to: "name"');
    expect(prompt).toContain('tasks/daily-briefing-a25c.md');
    expect(prompt).toContain('Only notify someone when the task asks');
    expect(prompt).not.toContain('<message to=');
    expect(prompt).not.toContain('default to addressing');
  });

  it("defaults task escalation to the agent's own channel instead of its parent agent", () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'Parent', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' });

    expect(prompt).toContain(
      'For user-visible escalation output, default to your own channel destination(s): `casa`',
    );
    expect(prompt).toContain(
      'Use an agent-type destination like `parent` only when the task explicitly calls for routing through another agent, not as your default escalation path.',
    );
    expect(prompt).not.toContain('default to `parent`');
  });

  it('keeps generic task guidance when no channel destination exists', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'Parent', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' });

    expect(prompt).toContain('Always pass the explicit named destination.');
    expect(prompt).not.toContain('For user-visible escalation output, default to');
    expect(prompt).not.toContain('your own channel destination(s):');
  });
});
