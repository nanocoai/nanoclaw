import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { detectInstalledOneCLI } from '../../.claude/skills/add-onecli/scripts/detect.js';
import { resolveGatewaySelection } from './selection.js';

const roots: string[] = [];
function fixture(env?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-detection-'));
  roots.push(root);
  if (env !== undefined) fs.writeFileSync(path.join(root, '.env'), env);
  return root;
}
afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
});
it.each(['http://127.0.0.1:1', 'http://127.0.0.1:1/v1', '"https://vault.example.test/v1"'])(
  'detects configured OneCLI without contacting %s',
  async (url) => {
    const fetch = vi.fn(() => {
      throw new Error('gateway is offline');
    });
    vi.stubGlobal('fetch', fetch);
    expect(await detectInstalledOneCLI(fixture(`ONECLI_URL=${url}\n`))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each([undefined, '', 'ONECLI_URL=\n', '# ONECLI_URL=http://old\n', 'ONECLI_URL=not-a-url\n'])(
  'does not invent an installation from missing or invalid config: %s',
  async (env) => {
    expect(await detectInstalledOneCLI(fixture(env))).toBe(false);
  },
);
it('resolves an unstamped offline legacy install through the actual detector', () => {
  const root = fixture('ONECLI_URL=http://127.0.0.1:1\n');
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  expect(resolveGatewaySelection(root, undefined, path.resolve('.claude/skills'))).toBe('onecli');
  expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).not.toContain('NANOCLAW_GATEWAY_PROVIDER');
});
