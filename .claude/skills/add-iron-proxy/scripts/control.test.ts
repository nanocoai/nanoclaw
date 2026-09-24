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

// The wizard's consent prompt is recorded, never rendered; it answers Abort.
const clack = vi.hoisted(() => ({ selects: [] as Array<Record<string, unknown>> }));
vi.mock('@clack/prompts', async (importActual) => ({
  ...(await importActual<typeof import('@clack/prompts')>()),
  select: vi.fn(async (options: Record<string, unknown>) => {
    clack.selects.push(options);
    return 'abort';
  }),
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

  describe('an earlier install left in Docker without its keys', () => {
    interface FakeContainer {
      name: string;
      project: string;
      service: string;
      running?: boolean;
      mounts?: string[];
    }
    // A fake docker: `volume ls`, `ps -a --filter label=…` and `ps -a --filter
    // volume=…` answer from the given state; removals are only recorded.
    const fakeDocker = (volumes: string[], containers: FakeContainer[] = []) => {
      const calls: string[][] = [];
      const docker: DockerRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'volume' && args[1] === 'ls') return volumes.join('\n') + '\n';
        if (args[0] === 'ps') {
          const filter = args[args.indexOf('--filter') + 1];
          const project = filter.match(/^label=com\.docker\.compose\.project=(.+)$/)?.[1];
          const volume = filter.match(/^volume=(.+)$/)?.[1];
          return (
            containers
              .filter((c) => (project ? c.project === project : !!volume && (c.mounts ?? []).includes(volume)))
              .map((c) => (project ? `${c.name}\t${c.service}\t${c.running ? 'running' : 'exited'}` : c.name))
              .join('\n') + '\n'
          );
        }
        return '';
      };
      return {
        docker,
        calls,
        removals: () => calls.filter((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm')),
      };
    };
    // The containers Compose creates for an install's project, newest first as
    // `docker ps` lists them; the database service mounts the volume.
    const leftovers = (project: string, running = true) => {
      const volume = `${project}_database`;
      return {
        volume,
        web: { name: `${project}-web-1`, project, service: 'web', running },
        database: { name: `${project}-database-1`, project, service: 'database', running, mounts: [volume] },
      };
    };
    const other = leftovers('nanoclaw-iron-control-other');

    it("does nothing when this install left nothing, whatever another install's project holds", async () => {
      const root = temporary();
      const fake = fakeDocker([other.volume], [other.web, other.database]);
      await resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => true });
      expect(fake.removals()).toEqual([]);
      // The only container query is scoped to this install's compose project.
      expect(fake.calls.filter((a) => a[0] === 'ps').map((a) => a[3])).toEqual([
        `label=com.docker.compose.project=${controlPaths(root).project}`,
      ]);
    });

    it('stops a headless run with the volume name and its removal command', async () => {
      const root = temporary();
      const { volume } = leftovers(controlPaths(root).project);
      const fake = fakeDocker([volume]);
      const failure = await resolveOrphanedDatabase(root, { docker: fake.docker }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`with: docker volume rm ${volume}`);
      expect((failure as Error).message).not.toContain('docker rm -f');
      expect((failure as Error).message).toContain(controlPaths(root).environment);
      expect(fake.removals()).toEqual([]);
    });

    it('removes an orphaned volume only after the operator agrees', async () => {
      const root = temporary();
      const { volume } = leftovers(controlPaths(root).project);
      const questions: string[] = [];
      const fake = fakeDocker([volume]);
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

    it('a headless run names the old services, the volume and the keys the running web container holds', async () => {
      const root = temporary();
      const { volume, web, database } = leftovers(controlPaths(root).project);
      const fake = fakeDocker([volume], [web, database]);
      const failure = await resolveOrphanedDatabase(root, { docker: fake.docker }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain(`with: docker rm -f ${web.name} ${database.name} && docker volume rm ${volume}`);
      expect(message).toContain(`The running web container ${web.name} holds the only remaining copy of those keys`);
      expect(message).toContain('removing it destroys them and every credential stored in the database');
      expect(message).toContain(controlPaths(root).environment);
      expect(fake.removals()).toEqual([]);
    });

    it("one answer removes this install's services and database together, after the keys warning", async () => {
      const root = temporary();
      const { volume, web, database } = leftovers(controlPaths(root).project);
      const questions: string[] = [];
      const fake = fakeDocker([volume], [web, database]);
      await resolveOrphanedDatabase(root, {
        docker: fake.docker,
        confirmRemoval: async (message) => {
          questions.push(message);
          return true;
        },
      });
      expect(questions).toEqual([
        `Remove it and start fresh? This destroys the keys held by ${web.name} and every credential in the old database.`,
      ]);
      expect(fake.removals()).toEqual([
        ['rm', '-f', web.name, database.name],
        ['volume', 'rm', volume],
      ]);
    });

    it('removes leftover services on consent when the volume is already gone', async () => {
      const root = temporary();
      const { web, database } = leftovers(controlPaths(root).project, false);
      const headless = fakeDocker([], [web, database]);
      const failure = await resolveOrphanedDatabase(root, { docker: headless.docker }).catch((error: Error) => error);
      expect((failure as Error).message).toContain(`with: docker rm -f ${web.name} ${database.name}`);
      expect((failure as Error).message).not.toContain('docker volume rm');
      expect((failure as Error).message).toContain(`The web container ${web.name} holds the only remaining copy`);
      expect(headless.removals()).toEqual([]);
      const consented = fakeDocker([], [web, database]);
      await resolveOrphanedDatabase(root, { docker: consented.docker, confirmRemoval: async () => true });
      expect(consented.removals()).toEqual([['rm', '-f', web.name, database.name]]);
    });

    it("never removes another install's containers, even with consent", async () => {
      const root = temporary();
      const { volume, web, database } = leftovers(controlPaths(root).project);
      const fake = fakeDocker([volume, other.volume], [other.web, other.database, web, database]);
      await resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => true });
      expect(fake.removals()).toEqual([
        ['rm', '-f', web.name, database.name],
        ['volume', 'rm', volume],
      ]);
      expect(JSON.stringify(fake.removals())).not.toContain('other');
    });

    it('never removes a volume a container outside this install mounts and names the exact commands', async () => {
      const root = temporary();
      const { volume, web } = leftovers(controlPaths(root).project);
      const stranger = { name: 'pg-backup', project: 'backups', service: 'backup', mounts: [volume] };
      const fake = fakeDocker([volume], [web, stranger]);
      await expect(
        resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => true }),
      ).rejects.toThrow(`by hand: docker rm -f ${web.name} pg-backup && docker volume rm ${volume}`);
      expect(fake.removals()).toEqual([]);
    });

    it('keeps everything and stops when the operator aborts', async () => {
      const root = temporary();
      const { volume, web, database } = leftovers(controlPaths(root).project);
      const fake = fakeDocker([volume], [web, database]);
      await expect(
        resolveOrphanedDatabase(root, { docker: fake.docker, confirmRemoval: async () => false }),
      ).rejects.toThrow(
        `Kept the old Iron Control install (services ${web.name}, ${database.name} and database volume ${volume}). ` +
          `Restore ${controlPaths(root).environment} or run: docker rm -f ${web.name} ${database.name} && docker volume rm ${volume}`,
      );
      expect(fake.removals()).toEqual([]);
    });

    it('the wizard prompt starts on Abort, so Enter alone keeps everything', async () => {
      const root = temporary();
      const { volume, web, database } = leftovers(controlPaths(root).project);
      const fake = fakeDocker([volume], [web, database]);
      const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      try {
        await expect(resolveOrphanedDatabase(root, { docker: fake.docker })).rejects.toThrow(
          'Kept the old Iron Control',
        );
      } finally {
        if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      expect(clack.selects.at(-1)).toMatchObject({
        message: expect.stringContaining(`Remove it and start fresh? This destroys the keys held by ${web.name}`),
        initialValue: 'abort',
      });
      expect((clack.selects.at(-1)!.options as { value: string }[]).map((o) => o.value)).toEqual(['remove', 'abort']);
      expect(fake.removals()).toEqual([]);
    });

    it('a consented fresh start also retires the registration of the removed database', async () => {
      const root = temporary();
      const paths = controlPaths(root);
      const { volume } = leftovers(paths.project);
      fs.mkdirSync(paths.directory, { recursive: true });
      fs.writeFileSync(paths.registration, JSON.stringify({ principalId: 'principal-1', proxyId: 'proxy-1' }));
      fs.writeFileSync(paths.proxyEnvironment, 'IRON_PROXY_TOKEN=old\nIRON_CONTROL_PLANE_URL=http://web:3000\n');
      const fake = fakeDocker([volume]);
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
