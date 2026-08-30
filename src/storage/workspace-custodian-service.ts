import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { access, appendFile, chmod, chown, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { GroupResticPassword, createRoleBackedGroupKms, type WrappedEnvelopeStore } from './group-restic-password.js';
import { createRoleBackedS3SnapshotStore, createRoleBackedSnapshotObjectStore } from './s3-snapshot-store.js';
import { WorkspaceCustodian } from './workspace-custodian.js';
import { initializeCipherTree } from './workspace-runtime-factory.js';
import { bearerMatches, validateWorkspacePaths } from './workspace-plane.js';
import { startGatewayWorkspaceProxy } from "./gateway-workspace-proxy.js";

type Config = {
  groupId: string; generation: number; groupRoot: string; bucket: string; prefix: string;
  region: string; endpoint: string; token: string; runAsUid: number; runAsGid: number;
  transport: 'role' | 'gateway'; gatewayProxy: string; gatewayCa: string; storageCapability: string;
};

class CustodianService {
  readonly #config: Config;
  readonly #custodian: WorkspaceCustodian;
  readonly #passwords: GroupResticPassword;
  readonly #snapshots: Awaited<ReturnType<typeof createRoleBackedS3SnapshotStore>>;
  #mount?: ChildProcess;
  #ready = false;
  #operation: Promise<unknown> = Promise.resolve();

  private constructor(config: Config, custodian: WorkspaceCustodian, passwords: GroupResticPassword, snapshots: Awaited<ReturnType<typeof createRoleBackedS3SnapshotStore>>) {
    this.#config = config; this.#custodian = custodian; this.#passwords = passwords; this.#snapshots = snapshots;
  }

  static async create(config: Config): Promise<CustodianService> {
    const workspaceProxy = config.transport === 'gateway'
      ? await startGatewayWorkspaceProxy({
          proxy: config.gatewayProxy,
          proxyCaPath: config.gatewayCa,
          capability: config.storageCapability,
          region: config.region,
          bucket: config.bucket,
          scopePrefix: `${config.prefix}/${config.groupId}`,
        })
      : undefined;
    const awsTransport = workspaceProxy
      ? { endpoint: workspaceProxy.s3Endpoint, credentials: workspaceProxy.syntheticCredentials }
      : {};
    const objects = await createRoleBackedSnapshotObjectStore({
      bucket: config.bucket,
      region: config.region,
      ...awsTransport,
    });
    const snapshots = await createRoleBackedS3SnapshotStore({ bucket: config.bucket, prefix: config.prefix, region: config.region, objects });
    const passwords = new GroupResticPassword({
      root: '/run/nanoco',
      kms: await createRoleBackedGroupKms(
        config.region,
        workspaceProxy?.kmsEndpoint,
        workspaceProxy?.syntheticCredentials,
      ),
      envelopes: objects as WrappedEnvelopeStore,
      prefix: config.prefix,
    });
    const resticPassword = path.join('/run/nanoco', config.groupId, 'secrets', 'restic.pass');
    const custodian = new WorkspaceCustodian({
      root: path.join(config.groupRoot, 'metadata'), workspace: () => path.join(config.groupRoot, 'cipher'),
      repository: () => workspaceProxy
        ? `s3:${workspaceProxy.s3Endpoint}/${config.bucket}/${config.prefix}/${config.groupId}`
        : `s3:${config.endpoint.replace(/^https?:\/\//, '')}/${config.bucket}/${config.prefix}/${config.groupId}`,
      passwordFile: () => resticPassword,
      snapshots,
      resticEnvironment: workspaceProxy?.resticEnvironment,
      quiesce: async () => {
        if (await mounted(path.join(config.groupRoot, 'generations', String(config.generation), 'plain'))) {
          throw new Error('checkpoint refused while the plaintext filesystem is mounted');
        }
      },
    });
    return new CustodianService(config, custodian, passwords, snapshots);
  }

  get ready(): boolean { return this.#ready; }
  authenticate(req: IncomingMessage): boolean {
    return bearerMatches(this.#config.token, req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
  }

  async start(): Promise<void> {
    await this.#audit('start', 'begin');
    const pass = await this.#passwords.ensure(this.#config.groupId);
    // The repository is an INVARIANT of a Ready custodian, not a side effect of
    // the first successful backup. Without it a never-checkpointed workspace
    // carries no repository at all, so its first teardown cannot flush and the
    // session pod's checkpoint finalizer waits on something that can never
    // succeed. Idempotent, and it runs before anything is mounted.
    const repository = await this.#custodian.ensureRepository(this.#config.groupId);
    await this.#audit('start', `repository-${repository}`);
    const cipher = path.join(this.#config.groupRoot, 'cipher');
    const plain = this.#plain();
    await mkdir(cipher, { recursive: true, mode: 0o700 });
    await mkdir(plain, { recursive: true, mode: 0o700 });
    if (!await exists(path.join(cipher, 'gocryptfs.conf'))) {
      const head = await this.#snapshots.head(this.#config.groupId);
      if (head) await this.#custodian.restore(this.#config.groupId, head, { discardLocal: true });
      else await initializeCipherTree({ cipher, passwordFile: pass.gocryptfs, run });
    }
    await this.#mountFilesystem(pass.gocryptfs);
    for (const dir of ['agent', 'provider-state']) {
      const target = path.join(plain, dir);
      await mkdir(target, { recursive: true, mode: 0o2770 });
      await chown(target, this.#config.runAsUid, this.#config.runAsGid);
      await chmod(target, 0o2770);
    }
    // A killed init container cannot clean up its directory lock. A generation
    // starts with no session writers, so this is the one safe recovery point.
    await rm(path.join(plain, 'agent', '.nanoco-materialize.lock.d'), { recursive: true, force: true });
    this.#ready = true;
    await this.#audit('start', 'ready');
  }

  checkpoint(): Promise<{ snapshotId: string }> {
    return this.#serialized(async () => {
      this.#ready = false;
      await this.#audit('checkpoint', 'begin');
      const pass = await this.#passwords.ensure(this.#config.groupId);
      await this.#unmountFilesystem();
      try {
        const publication = await this.#custodian.checkpoint(this.#config.groupId);
        if (!publication.published) throw new Error(`workspace checkpoint lost the S3 HEAD race to ${publication.current.snapshotId}`);
        await this.#audit('checkpoint', 'published', publication.head.snapshotId);
        return { snapshotId: publication.head.snapshotId };
      } catch (error) {
        await this.#audit('checkpoint', 'failed');
        throw error;
      } finally {
        await this.#mountFilesystem(pass.gocryptfs);
        this.#ready = true;
      }
    });
  }

  ensurePaths(paths: unknown): Promise<void> {
    return this.#serialized(async () => {
      if (!this.#ready) throw new Error('workspace filesystem is not ready');
      for (const relative of validateWorkspacePaths(paths)) {
        const target = path.join(this.#plain(), relative);
        await mkdir(target, { recursive: true, mode: 0o2770 });
        await chown(target, this.#config.runAsUid, this.#config.runAsGid);
        await chmod(target, 0o2770);
      }
      await this.#audit('paths', 'ready');
    });
  }

  shutdown(): Promise<void> {
    return this.#serialized(async () => {
      this.#ready = false;
      await this.#unmountFilesystem();
      await rm(path.join('/run/nanoco', this.#config.groupId, 'secrets'), { recursive: true, force: true });
      await this.#audit('shutdown', 'complete');
    });
  }

  async #mountFilesystem(passwordFile: string): Promise<void> {
    if (await mounted(this.#plain())) return;
    const child = spawn('gocryptfs', ['-fg', '-q', '-allow_other', '-passfile', passwordFile, path.join(this.#config.groupRoot, 'cipher'), this.#plain()], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.#mount = child;
    child.once('close', () => { if (this.#mount === child) this.#ready = false; });
    let stderr = '';
    this.#mount.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await mounted(this.#plain())) return;
      if (this.#mount.exitCode !== null) throw new Error(`gocryptfs mount failed: ${stderr.trim().split('\n').at(-1) || 'no output'}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.#mount.kill('SIGTERM');
    throw new Error('gocryptfs mount did not become ready');
  }

  async #unmountFilesystem(): Promise<void> {
    if (await mounted(this.#plain())) {
      const sync = await run(['sync']);
      if (sync.code !== 0) throw new Error(`sync failed: ${sync.stderr}`);
      const result = await run(['fusermount3', '-u', this.#plain()]);
      if (result.code !== 0) throw new Error(`gocryptfs unmount failed: ${result.stderr.trim()}`);
    }
    if (this.#mount?.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => this.#mount!.once('close', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)),
      ]);
    }
    if (this.#mount?.exitCode === null) throw new Error('gocryptfs still has a published session mount');
    this.#mount = undefined;
    if (await mounted(this.#plain())) throw new Error('plaintext filesystem remained mounted');
  }

  #plain(): string { return path.join(this.#config.groupRoot, 'generations', String(this.#config.generation), 'plain'); }
  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.catch(() => {}).then(operation);
    this.#operation = next;
    return next;
  }
  async #audit(operation: string, outcome: string, snapshotId?: string): Promise<void> {
    const file = path.join(this.#config.groupRoot, 'audit', 'events.jsonl');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), groupId: this.#config.groupId, generation: this.#config.generation, operation, outcome, ...(snapshotId ? { snapshotId } : {}) })}\n`, { mode: 0o600 });
  }
}

function configFromEnv(env: NodeJS.ProcessEnv): Promise<Config> {
  return (async () => {
    const groupId = env.NANOCO_WORKSPACE_GROUP_ID ?? '';
    const generation = Number(env.NANOCO_WORKSPACE_GENERATION);
    const groupRoot = env.NANOCO_WORKSPACE_GROUP_ROOT ?? '';
    const bucket = env.NANOCLAW_WORKSPACE_S3_BUCKET ?? '';
    const prefix = (env.NANOCLAW_WORKSPACE_S3_PREFIX ?? '').replace(/^\/+|\/+$/g, '');
    const region = env.NANOCLAW_WORKSPACE_S3_REGION ?? '';
    const endpoint = env.NANOCLAW_WORKSPACE_S3_ENDPOINT ?? '';
    const tokenFile = env.NANOCO_WORKSPACE_TOKEN_FILE ?? '';
    const runAsUid = Number(env.NANOCO_WORKSPACE_RUN_AS_UID);
    const runAsGid = Number(env.NANOCO_WORKSPACE_RUN_AS_GID);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(groupId)) throw new Error('invalid Custodian group ID');
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid Custodian generation');
    if (!path.isAbsolute(groupRoot) || groupRoot === '/') throw new Error('invalid Custodian group root');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !prefix || prefix.includes('..')) throw new Error('invalid workspace S3 location');
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region) || endpoint !== `https://s3.${region}.amazonaws.com`) throw new Error('workspace S3 endpoint and region disagree');
    if (!Number.isSafeInteger(runAsUid) || runAsUid < 1 || !Number.isSafeInteger(runAsGid) || runAsGid < 1) throw new Error('invalid workspace writer identity');
    const transport = env.NANOCLAW_WORKSPACE_S3_TRANSPORT?.trim() || 'role';
    if (transport !== "role" && transport !== "gateway")
      throw new Error(`unknown workspace S3 transport: ${transport}`);
    const gatewayProxy = env.NANOCLAW_MAILBOX_GATEWAY_PROXY?.trim() || '';
    const gatewayCa = env.NANOCLAW_MAILBOX_GATEWAY_CA?.trim() || '';
    const storageCapabilityFile = env.NANOCLAW_STORAGE_CAPABILITY_FILE?.trim() || '';
    const storageCapability = storageCapabilityFile
      ? (await readFile(storageCapabilityFile, 'utf8')).trim()
      : env.NANOCLAW_STORAGE_CAPABILITY?.trim() || '';
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 32) throw new Error('invalid Custodian API token');
    return {
      groupId, generation, groupRoot, bucket, prefix, region, endpoint, token, runAsUid, runAsGid,
      transport, gatewayProxy, gatewayCa, storageCapability,
    };
  })();
}

async function mounted(target: string): Promise<boolean> {
  const escaped = target.replaceAll(' ', '\\040');
  return (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').some((line) => line.split(' - ')[0]?.split(' ')[4] === escaped);
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function run(argv: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] }); let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; }); child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}
function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); }

async function main(): Promise<void> {
  const service = await CustodianService.create(await configFromEnv(process.env));
  await service.start();
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/live' && req.method === 'GET') return send(res, 200, { live: true });
      if (req.url === '/ready' && req.method === 'GET') return send(res, service.ready ? 200 : 503, { ready: service.ready });
      if (!service.authenticate(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.url === '/v1/paths/ensure' && req.method === 'POST') return send(res, 200, await service.ensurePaths((await requestBody(req)).paths).then(() => ({ ready: true })));
      if (req.url === '/v1/checkpoint' && req.method === 'POST') return send(res, 200, await service.checkpoint());
      if (req.url === '/v1/shutdown' && req.method === 'POST') { await service.shutdown(); send(res, 200, { stopped: true }); setImmediate(() => process.exit(0)); return; }
      send(res, 404, { error: 'not found' });
    } catch (error) { send(res, 409, { error: (error as Error).message }); }
  });
  server.listen(8788, '0.0.0.0');
  const stop = () => service.shutdown().finally(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('request too large'); }
  return JSON.parse(raw || '{}') as Record<string, unknown>;
}

if (process.argv[1]?.endsWith('/workspace-custodian-service.js')) void main().catch((error) => { process.stderr.write(`${(error as Error).stack ?? error}\n`); process.exit(1); });
