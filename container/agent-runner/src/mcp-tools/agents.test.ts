import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { createAgent } from './agents.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('create_agent', () => {
  it('carries the template ref in the outbound request', async () => {
    const result = await createAgent.handler({ name: 'SDR Bot', template: 'sales/sdr' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toMatchObject({
      action: 'create_agent',
      name: 'SDR Bot',
      instructions: null,
      template: 'sales/sdr',
    });
  });

  it('omits the template key when absent or empty', async () => {
    for (const args of [{ name: 'Plain' }, { name: 'Plain', template: '' }]) {
      await createAgent.handler(args);
    }

    for (const message of getUndeliveredMessages()) {
      expect(JSON.parse(message.content)).not.toHaveProperty('template');
    }
  });
});
