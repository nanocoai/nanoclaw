import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => (keys.includes('WEBHOOK_PORT') ? { WEBHOOK_PORT: '3918' } : {}),
}));

const originalWebhookPort = process.env.WEBHOOK_PORT;

afterEach(() => {
  if (originalWebhookPort === undefined) delete process.env.WEBHOOK_PORT;
  else process.env.WEBHOOK_PORT = originalWebhookPort;
  vi.resetModules();
});

describe('webhook port config', () => {
  it('reads WEBHOOK_PORT from .env config', async () => {
    delete process.env.WEBHOOK_PORT;
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(3918);
  });
});
