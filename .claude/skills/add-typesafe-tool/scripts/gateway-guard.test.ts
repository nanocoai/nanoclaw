import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { gatewayRefusal, selectedGateway } from './gateway-guard.js';

const dirs: string[] = [];
function copyWithEnv(env: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-guard-'));
  dirs.push(root);
  if (env !== null) fs.writeFileSync(path.join(root, '.env'), env);
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('/add-typesafe-tool gateway guard', () => {
  it('reads the stamp from the environment first, then .env, without probing', () => {
    const root = copyWithEnv('NANOCLAW_GATEWAY_PROVIDER=iron-proxy\n');
    expect(selectedGateway(root, {})).toBe('iron-proxy');
    expect(selectedGateway(root, { NANOCLAW_GATEWAY_PROVIDER: ' OneCLI ' })).toBe('onecli');
    expect(selectedGateway(copyWithEnv(null), {})).toBe('');
  });

  it('accepts OneCLI', () => {
    expect(gatewayRefusal('onecli')).toBeUndefined();
  });

  it('refuses Iron Proxy and says why', () => {
    const refusal = gatewayRefusal('iron-proxy');
    expect(refusal).toMatch(/OneCLI gateway only/);
    expect(refusal).toMatch(/approval card/);
    expect(refusal).toMatch(/per-host auto-approval rule in core/);
  });

  it('refuses an unknown gateway and an unstamped copy', () => {
    expect(gatewayRefusal('other')).toMatch(/OneCLI gateway only; this copy runs "other"/);
    expect(gatewayRefusal('')).toMatch(/NANOCLAW_GATEWAY_PROVIDER is unset/);
    expect(gatewayRefusal('')).toMatch(/does not probe/);
  });
});
