import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as yaml } from 'yaml';

import { controlCompose, controlPaths, controlPort, installControl } from './control.js';
import { hasFrontProxy, frontProxyHash } from './build-managed-proxy.js';
import { installCommand } from './install-command.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { GATEWAY_ROLE, LABELS } from '../../../../src/drivers/types.js';

vi.mock('./install-command.js', async (importActual) => ({
  ...(await importActual<typeof import('./install-command.js')>()),
  installCommand: vi.fn(async () => ''),
}));
const installCommandMock = vi.mocked(installCommand);

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-control-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  installCommandMock.mockClear();
  delete process.env.NANOCLAW_IRON_CONTROL_PORT;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('official Iron Control installation', () => {
  it('isolates installs and exposes only the console on loopback', () => {
    const root = temporary();
    const other = temporary();
    const config = yaml(controlCompose(root, 18443));
    expect(config.name).not.toBe(yaml(controlCompose(other, 18443)).name);
    expect(config.services.web.ports).toEqual(['127.0.0.1:18443:3000']);
    expect(config.services.database.ports).toBeUndefined();
    expect(config.services.database.env_file).toEqual([controlPaths(root).databaseEnvironment]);
    expect(config.services.web.env_file).toEqual([controlPaths(root).environment]);
    expect(config.services.database.volumes).toEqual(['database:/var/lib/postgresql/data']);
    expect(config.services.web.image).toMatch(/^docker.io\/ironsh\/iron-control:.*@sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(config)).not.toContain('INITIAL_USER_PASSWORD');
  });

  it('uses the configured UI port and rejects invalid input before starting services', () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_IRON_CONTROL_PORT=18080\n');
    expect(controlPort(root)).toBe(18080);
    process.env.NANOCLAW_IRON_CONTROL_PORT = '18500';
    expect(controlPort(root)).toBe(18500);
    process.env.NANOCLAW_IRON_CONTROL_PORT = '70000';
    expect(() => controlPort(root)).toThrow('between 1 and 65535');
    delete process.env.NANOCLAW_IRON_CONTROL_PORT;
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_IRON_CONTROL_PORT=invalid\n');
    expect(() => controlPort(root)).toThrow('between 1 and 65535');
  });

  it('labels both services like the central proxy, and neither the volume nor the network', () => {
    const root = temporary();
    const config = yaml(controlCompose(root, 18443));
    const labels = { [LABELS.install]: getInstallSlug(root), [LABELS.role]: GATEWAY_ROLE };
    expect(config.services.web.labels).toEqual(labels);
    expect(config.services.database.labels).toEqual(labels);
    expect(Object.keys(config.services.web).slice(0, 4)).toEqual(['image', 'platform', 'restart', 'labels']);
    expect(config.volumes.database).toEqual({});
    expect(config.networks.default).toEqual({ name: controlPaths(root).network });
  });

  it('prints the exact cleanup commands when the database outlived its keys', async () => {
    const root = temporary();
    const project = controlPaths(root).project;
    installCommandMock.mockResolvedValueOnce(`other_database\n${project}_database\n`);
    const failure = installControl(root);
    await expect(failure).rejects.toThrow(`restore ${controlPaths(root).environment}`);
    await expect(failure).rejects.toThrow(
      `docker rm -f ${project}-database-1 ${project}-web-1; docker volume rm ${project}_database`,
    );
    // Only the volume listing ran: nothing was removed or started.
    expect(installCommandMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(controlPaths(root).environment)).toBe(false);
  });

  it('requires both the pinned source and the exact approval front', () => {
    const labels = {
      'org.opencontainers.image.revision': '8a0eb0beb6524f4a7739b799842a13159d8b739e',
      'ai.nanoclaw.approval-front': frontProxyHash,
    };
    expect(hasFrontProxy({ Config: { Labels: labels } })).toBe(true);
    expect(hasFrontProxy({ Config: { Labels: { ...labels, 'ai.nanoclaw.approval-front': 'old' } } })).toBe(false);
    expect(hasFrontProxy({ Config: {} })).toBe(false);
  });
});
