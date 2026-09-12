/**
 * Where the waiting room sends a stranger to be approved: the configured
 * page, else the enrolled portal's page, else nowhere (approval on the
 * machine). No address is built into the host.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-door-approval-${process.pid}`);

vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>();
  return { ...actual, DATA_DIR: `${ROOT}/data` };
});

import { writePrivate } from '../../../community-portal/private-file.js';
import { resolveApprovalUrl } from './index.js';

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${ROOT}/data`, { recursive: true });
  vi.stubEnv('NANOCLAW_TERMINAL_APPROVAL_URL', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('resolveApprovalUrl', () => {
  it('is nothing on a checkout that never enrolled with a portal', async () => {
    expect(await resolveApprovalUrl()).toBeUndefined();
  });

  it('is the enrolled portal origin, bare', async () => {
    await writePrivate(`${ROOT}/data/community-portal.json`, {
      origin: 'https://portal.example.test/',
      deviceId: 'dev_1',
      credentials: {},
      operations: {},
    });
    expect(await resolveApprovalUrl()).toBe('https://portal.example.test');
  });

  it('is the configured page when one is set, whatever the journal says', async () => {
    await writePrivate(`${ROOT}/data/community-portal.json`, { origin: 'https://portal.example.test' });
    vi.stubEnv('NANOCLAW_TERMINAL_APPROVAL_URL', 'https://approve.example.test/keys');
    expect(await resolveApprovalUrl()).toBe('https://approve.example.test/keys');
  });

  it('ignores a journal origin that is not a URL', async () => {
    await writePrivate(`${ROOT}/data/community-portal.json`, { origin: 'not a url' });
    expect(await resolveApprovalUrl()).toBeUndefined();
  });
});
