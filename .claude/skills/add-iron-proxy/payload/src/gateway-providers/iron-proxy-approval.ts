import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { log } from '../log.js';
import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import { normalizeGatewayApprovalSummary } from '../gateway-approval-summary.js';

import type { GatewayApprovalDecision, GatewayApprovalRequest } from './gateway-provider-registry.js';

export const IRON_PROXY_IDENTITY_METADATA = 'x-iron-workload-identity';

const CONTINUE = 1;
const REJECT = 2;

interface TransformRequest {
  method?: string;
  url?: string;
  host?: string;
}

interface TransformRequestMessage {
  request?: TransformRequest;
}

interface TransformReply {
  action: number;
  response?: { statusCode: number; body: Buffer };
}

export interface IronApprovalIdentity {
  runtimeIdentity: string;
  sessionId: string;
  agentGroupId: string;
  groupName: string;
}

export interface IronApprovalBridgeSettings {
  socketPath: string;
  timeoutMs: number;
  maxPending: number;
  protoPath?: string;
  tls?: { address: string; ca: string; cert: string; key: string };
}

interface PendingTransform {
  identity: string;
  settle: (decision: GatewayApprovalDecision) => void;
}

type IdentityResolver = (runtimeIdentity: string) => IronApprovalIdentity | undefined;
type ApprovalDecider = (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>;

function rejection(text = 'Request denied by approval policy'): TransformReply {
  return { action: REJECT, response: { statusCode: 403, body: Buffer.from(text) } };
}

function metadataIdentity(metadata: grpc.Metadata): string | undefined {
  const values = metadata.get(IRON_PROXY_IDENTITY_METADATA);
  return values.length === 1 && typeof values[0] === 'string' && values[0].length <= 512 ? values[0] : undefined;
}

function safeRequest(
  request: TransformRequest | undefined,
): { method: string; host: string; path: string } | undefined {
  const method = request?.method?.toUpperCase() ?? '';
  if (!/^[A-Z]{1,16}$/.test(method)) return undefined;
  const host = (request?.host ?? '').slice(0, 253);
  if (!host || /[\0\r\n]/.test(host)) return undefined;
  try {
    const base = new URL(`https://${host}`);
    const url = new URL(request?.url || '/', base);
    if (url.origin !== base.origin || url.username || url.password || base.username || base.password) return undefined;
    const requestPath = url.pathname.slice(0, 240) || '/';
    return { method, host, path: requestPath };
  } catch {
    return undefined;
  }
}

function safeDisplay(value: string): string {
  return value.replace(/[<>&`]/g, '_');
}

function serviceDefinition(protoPath: string): grpc.ServiceDefinition {
  const definition = protoLoader.loadSync(protoPath, {
    defaults: true,
    enums: Number,
    longs: String,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    transform: { v1: { TransformService: { service: grpc.ServiceDefinition } } };
  };
  return loaded.transform.v1.TransformService.service;
}

/** Iron's gRPC transport. NanoClaw core owns the human approval workflow. */
export class IronProxyApprovalBridge {
  readonly #pending = new Map<string, PendingTransform>();
  #server: grpc.Server | null = null;
  #ready: Promise<void> | null = null;
  #decide: ApprovalDecider | null = null;

  constructor(
    readonly settings: IronApprovalBridgeSettings,
    private readonly resolveIdentity: IdentityResolver,
  ) {}

  get running(): boolean {
    return this.#server !== null;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async ready(): Promise<void> {
    if (!this.#ready) throw new Error('Iron Proxy approval subscription has not started');
    await this.#ready;
    if (!this.#server) throw new Error('Iron Proxy approval bridge is unavailable');
  }

  async subscribe(decide: ApprovalDecider, signal: AbortSignal): Promise<void> {
    if (this.#ready) throw new Error('Iron Proxy approval subscription already started');
    if (signal.aborted) return;
    this.#decide = decide;
    this.#ready = this.#start();
    await this.#ready;
    if (signal.aborted) {
      await this.#stop();
      return;
    }
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    await this.#stop();
  }

  cancelIdentity(runtimeIdentity: string): void {
    for (const state of this.#pending.values()) {
      if (state.identity === runtimeIdentity) state.settle('deny');
    }
  }

  async #start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.settings.socketPath), { recursive: true, mode: 0o700 });
    if (!this.settings.tls) fs.rmSync(this.settings.socketPath, { force: true });
    const server = new grpc.Server({
      'grpc.max_receive_message_length': 1024 * 1024,
      'grpc.max_send_message_length': 64 * 1024,
    });
    const transformRequest: grpc.handleUnaryCall<TransformRequestMessage, TransformReply> = (call, callback) => {
      void this.#transformRequest(call).then(
        (reply) => callback(null, reply),
        (err) => {
          log.error('Iron Proxy approval transform failed closed', { err });
          callback(null, rejection('Approval bridge failed'));
        },
      );
    };
    const transformResponse: grpc.handleUnaryCall<TransformRequestMessage, TransformReply> = (call, callback) => {
      const identity = metadataIdentity(call.metadata);
      callback(null, identity && this.resolveIdentity(identity) ? { action: CONTINUE } : rejection());
    };
    server.addService(
      serviceDefinition(
        this.settings.protoPath ?? path.join(process.cwd(), 'src', 'gateway-providers', 'iron-proxy-transform.proto'),
      ),
      {
        TransformRequest: transformRequest,
        transformRequest,
        TransformResponse: transformResponse,
        transformResponse,
      },
    );
    const tls = this.settings.tls;
    const credentials = tls
      ? grpc.ServerCredentials.createSsl(
          fs.readFileSync(tls.ca),
          [{ private_key: fs.readFileSync(tls.key), cert_chain: fs.readFileSync(tls.cert) }],
          true,
        )
      : grpc.ServerCredentials.createInsecure();
    await new Promise<void>((resolve, reject) => {
      server.bindAsync(tls?.address ?? `unix:${this.settings.socketPath}`, credentials, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    if (!tls) fs.chmodSync(this.settings.socketPath, 0o600);
    this.#server = server;
    log.info('Iron Proxy approval bridge started', {
      address: tls?.address ?? this.settings.socketPath,
      mutualTls: !!tls,
    });
  }

  async #stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    for (const state of [...this.#pending.values()]) state.settle('deny');
    if (server) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 5_000);
        server.tryShutdown(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.#decide = null;
    this.#ready = null;
    if (!this.settings.tls) fs.rmSync(this.settings.socketPath, { force: true });
  }

  async #transformRequest(
    call: grpc.ServerUnaryCall<TransformRequestMessage, TransformReply>,
  ): Promise<TransformReply> {
    if (!this.#server || !this.#decide) return rejection('Approval bridge unavailable');
    const runtimeIdentity = metadataIdentity(call.metadata);
    const identity = runtimeIdentity ? this.resolveIdentity(runtimeIdentity) : undefined;
    if (!runtimeIdentity || !identity) return rejection('Unknown workload identity');

    const request = safeRequest(call.request.request);
    if (!request) return rejection('Invalid request metadata');
    // Iron uses a synthetic CONNECT before MITM. The inner HTTP request is the
    // only approval point; Iron itself closes non-HTTP/TLS tunnel payloads.
    if (request.method === 'CONNECT') return { action: CONTINUE };
    if (this.#pending.size >= this.settings.maxPending) return rejection('Approval queue is full');

    const id = `iron-${randomBytes(10).toString('hex')}`;
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.settings.timeoutMs);
    const approval: GatewayApprovalRequest = {
      id,
      trigger: 'default',
      destination: { host: request.host, method: request.method },
      agentGroupId: identity.agentGroupId,
      sessionId: identity.sessionId,
      runtimeIdentity: identity.runtimeIdentity,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      summary: {
        agent: identity.groupName.slice(0, 120),
        action: ['GET', 'HEAD'].includes(request.method)
          ? 'Read from an external service'
          : 'Send a request that may change external data',
        resource: `${request.method} ${request.host}${request.path}`.slice(0, 600),
        reason: 'No automatic approval rule covers this request. Its exact business action is unavailable.',
      },
      title: 'Network credentials request',
      question: `*Agent:* ${safeDisplay(identity.groupName.slice(0, 120))}\n*Request:* ${safeDisplay(`${request.method} ${request.host}${request.path}`)}`,
      audit: request,
    };

    // This metadata is produced by the trusted proxy, never accepted from HTTP
    // headers. Its fields are display-only; malformed metadata fails closed.
    const summaries = call.metadata.get('x-iron-approval-summary');
    if (summaries.length) {
      try {
        if (summaries.length !== 1 || typeof summaries[0] !== 'string' || summaries[0].length > 44000)
          throw new Error();
        const summary = JSON.parse(Buffer.from(summaries[0], 'base64').toString('utf8'));
        approval.summary = normalizeGatewayApprovalSummary(
          { agent: identity.groupName, method: request.method, host: request.host, path: request.path },
          summary,
        );
        gatewayApprovalPresentation(approval);
      } catch {
        return rejection('Invalid approval summary');
      }
    }

    const decision = await new Promise<GatewayApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (value: GatewayApprovalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(id);
        const active = this.resolveIdentity(runtimeIdentity);
        resolve(
          active?.sessionId === identity.sessionId && active.agentGroupId === identity.agentGroupId ? value : 'deny',
        );
      };
      const timer = setTimeout(() => finish('deny'), this.settings.timeoutMs);
      const state: PendingTransform = { identity: runtimeIdentity, settle: finish };
      this.#pending.set(id, state);
      call.on('cancelled', () => finish('deny'));
      void this.#decide!(approval).then(finish, (err) => {
        log.error('Iron Proxy approval callback failed closed', { requestId: id, err });
        finish('deny');
      });
    });
    return decision === 'approve'
      ? { action: CONTINUE }
      : rejection(
          'Gateway approval was not granted. The request was denied or expired before reaching the external service. This response does not establish credential permissions.',
        );
  }
}
