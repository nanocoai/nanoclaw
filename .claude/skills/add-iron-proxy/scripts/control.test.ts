import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as yaml } from 'yaml';

import {
  controlCompose,
  controlPaths,
  controlPort,
  installControl,
  resolveOrphanedDatabase,
  type DockerRunner,
} from './control.js';
import { hasFrontProxy, frontProxyHash } from './build-managed-proxy.js';

// `compose up` and every other docker call outside the injected runner is a
// no-op here; the tests below never start a container.
vi.mock('./install-command.js', async (importActual) => ({
  ...(await importActual<typeof import('./install-command.js')>()),
  installCommand: vi.fn(async () => ''),
}));

const roots: string[] = [];
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-control-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllGlobals();
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

  describe('database volume without its keys', () => {
    // A fake docker: `volume ls` and `ps -a --filter volume=` answer from the
    // given state; every other invocation (the removal) is only recorded.
    const fakeDocker = (volumes: string[], containers: string[]) => {
      const calls: string[][] = [];
      const docker: DockerRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'volume' && args[1] === 'ls') return volumes.join('\n') + '\n';
        if (args[0] === 'ps') return containers.join('\n') + '\n';
        return '';
      };
      return { docker, calls, removals: () => calls.filter((a) => a[0] === 'volume' && a[1] === 'rm') };
    };

    it('does nothing when no database volume exists for this install', async () => {
      const root = temporary();
      const fake = fakeDocker(['unrelated_database'], []);
      await resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => true });
      expect(fake.removals()).toEqual([]);
      expect(fake.calls.some((a) => a[0] === 'ps')).toBe(false);
    });

    it('never removes a volume a container still mounts and names the exact commands', async () => {
      const root = temporary();
      const volume = `${controlPaths(root).project}_database`;
      const container = `${controlPaths(root).project}-database-1`;
      const fake = fakeDocker([volume], [container]);
      await expect(
        resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => true }),
      ).rejects.toThrow(`docker rm -f ${container} && docker volume rm ${volume}`);
      expect(fake.removals()).toEqual([]);
    });

    it('stops a headless run with the volume name and its removal command', async () => {
      const root = temporary();
      const volume = `${controlPaths(root).project}_database`;
      const fake = fakeDocker([volume], []);
      const failure = await resolveOrphanedDatabase(root, { docker: fake.docker }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`docker volume rm ${volume}`);
      expect((failure as Error).message).toContain(controlPaths(root).environment);
      expect(fake.removals()).toEqual([]);
    });

    it('removes an orphaned volume only after the operator agrees', async () => {
      const root = temporary();
      const volume = `${controlPaths(root).project}_database`;
      const questions: string[] = [];
      const fake = fakeDocker([volume], []);
      await resolveOrphanedDatabase(root, {
        docker: fake.docker,
        confirmRemoval: async (message) => {
          questions.push(message);
          return true;
        },
      });
      expect(questions).toEqual(['Remove it and start fresh?']);
      expect(fake.removals()).toEqual([['volume', 'rm', volume]]);
    });

    it('a consented fresh start also retires the registration of the removed database', async () => {
      const root = temporary();
      const paths = controlPaths(root);
      const volume = `${paths.project}_database`;
      fs.mkdirSync(paths.directory, { recursive: true });
      fs.writeFileSync(paths.registration, JSON.stringify({ principalId: 'principal-1', proxyId: 'proxy-1' }));
      fs.writeFileSync(paths.proxyEnvironment, 'IRON_PROXY_TOKEN=old\nIRON_CONTROL_PLANE_URL=http://web:3000\n');
      const fake = fakeDocker([volume], []);
      const requests: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          const resource = new URL(url).pathname.replace('/api/v1/', '');
          requests.push(`${init.method ?? 'GET'} ${resource}`);
          if (resource === 'proxies/proxy-1') return new Response('', { status: 404 });
          if (resource === 'principals/nanoclaw') return Response.json({ data: { id: 'principal-2' } });
          if (resource === 'proxies') return Response.json({ data: { id: 'proxy-2', token: 'fresh-token' } });
          return new Response('', { status: 500 });
        }),
      );
      await installControl(root, { docker: fake.docker, confirmRemoval: async () => true });
      expect(fake.removals()).toEqual([['volume', 'rm', volume]]);
      expect(requests).not.toContain('GET proxies/proxy-1');
      expect(JSON.parse(fs.readFileSync(paths.registration, 'utf8'))).toEqual({
        principalId: 'principal-2',
        proxyId: 'proxy-2',
      });
      expect(fs.readFileSync(paths.proxyEnvironment, 'utf8')).toContain('IRON_PROXY_TOKEN=fresh-token');
    });

    it('keeps the volume and stops when the operator aborts', async () => {
      const root = temporary();
      const volume = `${controlPaths(root).project}_database`;
      const fake = fakeDocker([volume], []);
      await expect(
        resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => false }),
      ).rejects.toThrow(`docker volume rm ${volume}`);
      expect(fake.removals()).toEqual([]);
    });
  });

  it('requires both the pinned source and the exact approval front', () => {
    const labels = {
      'org.opencontainers.image.revision': '2393dd175a8c419153fb49917fdeceb94cd9ed59',
      'ai.nanoclaw.approval-front': frontProxyHash,
    };
    expect(hasFrontProxy({ Config: { Labels: labels } })).toBe(true);
    expect(hasFrontProxy({ Config: { Labels: { ...labels, 'ai.nanoclaw.approval-front': 'old' } } })).toBe(false);
    expect(hasFrontProxy({ Config: {} })).toBe(false);
  });
});
