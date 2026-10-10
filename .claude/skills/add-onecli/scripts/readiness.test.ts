import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectInstalledOneCLI } from './detect.js';
import { gatewayReadinessError } from './setup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OneCLI readiness', () => {
  it('detects configuration independently of runtime readiness', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-detect-'));
    roots.push(root);

    expect(await detectInstalledOneCLI(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
    expect(await detectInstalledOneCLI(root)).toBe(true);
  });

  it('refuses unreachable and pre-v1 gateways', () => {
    expect(gatewayReadinessError('ok')).toBeNull();
    expect(gatewayReadinessError('unreachable')).toMatch(/unreachable/);
    expect(gatewayReadinessError('incompatible')).toMatch(/lacks the \/v1 API/);
  });
});
