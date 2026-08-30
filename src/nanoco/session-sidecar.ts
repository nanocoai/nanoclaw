/**
 * NanoCo per-session sidecar orchestration.
 *
 * This module owns only the NanoClaw side of the runtime boundary: trusted
 * lineage, two isolated Docker networks, the sidecar process, and cleanup.
 * Certificate issuance and lease persistence stay behind
 * SessionChannelProvisioner because their production control-plane API is not
 * owned by this repository yet.
 */
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { inspect } from 'util';

import { CONTAINER_INSTALL_LABEL, INSTALL_SLUG } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { statHostPath } from '../drivers/pod-driver.js';
import type { ContainerSpec, MountClass, MountSpec } from '../drivers/types.js';
import { log } from '../log.js';
import { validateRequestCapability } from './mailbox-capability.js';
import {
  registerSessionEgressAdopter,
  registerSessionEgressFactory,
  type PrepareSessionEgressContext,
  type SessionEgressHandle,
  type SessionEgressState,
} from '../session-egress.js';

const SIDECAR_ALIAS = 'sidecar';

const SIDECAR_PORT = 15001;
/**
 * Decision 1B: where the agent finds the proxy is a property of the topology
 * the session driver realized, not a constant.
 *
 * In a pod the two containers share one network namespace, so the proxy is on
 * loopback and a Docker network alias resolves to nothing — this is the change
 * that makes the alias machinery deleted rather than ported. Under the Docker
 * driver the sidecar is a separate netns bridged to an uplink the agent must
 * NOT be able to route to, so the agent stays on its own internal network and
 * addresses the sidecar by alias. Collapsing both onto loopback there would mean
 * joining the agent to the sidecar's namespace, which hands it the sidecar's
 * uplink — trading topology gating for nothing, since on Docker there is no
 * NetworkPolicy to make the gateway the only reachable endpoint.
 */
const SIDECAR_LOOPBACK_PROXY_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const SIDECAR_ALIAS_PROXY_URL = `http://${SIDECAR_ALIAS}:${SIDECAR_PORT}`;
const SIDECAR_GATEWAY_CA = '/run/nanoco/gateway-ca.pem';
const SIDECAR_CLIENT_CERT = '/run/nanoco/session-cert.pem';
const SIDECAR_CLIENT_KEY = '/run/nanoco/session-key.pem';
const AGENT_PROXY_CA = '/run/nanoco/proxy-ca.pem';
const IDENTIFIER_MAX_BYTES = 128;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MIN_RENEWAL_WINDOW_MS = 1_000;
const RENEWAL_RETRY_BASE_DELAY_MS = 2_000;
const RENEWAL_RETRY_MAX_DELAY_MS = 15_000;
const RENEWAL_RETRY_JITTER_MS = 500;
// How far ahead of expiry to stop *starting* attempts. This does not bound when
// teardown lands: the attempt straddling that deadline carries the control
// request's own timeout, so notifyUnavailable can fire seconds after the lease
// expired and the agent sees egress failures in the gap. Kept anyway — renewal
// has no lease-expiry precondition gateway-side, so a straddling attempt that
// does land still recovers the session.
const RENEWAL_ABANDON_MARGIN_MS = 2_000;

export interface SessionChannelLineage {
  deploymentId: string;
  agentId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  requestCapability?: string;
}

/** Sensitive filesystem locations with redacted JSON and inspect output. */
export class SessionChannelMaterials {
  readonly #gatewayCaPath: string;
  readonly #clientCertificatePath: string;
  readonly #clientPrivateKeyPath: string;
  readonly #proxyCaPath: string;

  constructor(args: {
    gatewayCaPath: string;
    clientCertificatePath: string;
    clientPrivateKeyPath: string;
    proxyCaPath: string;
  }) {
    this.#gatewayCaPath = requireAbsolutePath(args.gatewayCaPath, 'gateway CA');
    this.#clientCertificatePath = requireAbsolutePath(args.clientCertificatePath, 'client certificate');
    this.#clientPrivateKeyPath = requireAbsolutePath(args.clientPrivateKeyPath, 'client private key');
    this.#proxyCaPath = requireAbsolutePath(args.proxyCaPath, 'proxy CA');
  }

  gatewayCaPath(): string {
    return this.#gatewayCaPath;
  }

  clientCertificatePath(): string {
    return this.#clientCertificatePath;
  }

  clientPrivateKeyPath(): string {
    return this.#clientPrivateKeyPath;
  }

  proxyCaPath(): string {
    return this.#proxyCaPath;
  }

  toJSON(): string {
    return 'SessionChannelMaterials([redacted])';
  }

  [inspect.custom](): string {
    return 'SessionChannelMaterials([redacted])';
  }
}

export interface ProvisionedSessionChannel {
  lineage: SessionChannelLineage;
  gatewayAddress: string;
  gatewayServerName: string;
  expiresAt: string;
  /**
   * The channel's hard ceiling. The Gateway will renew a lease that has already
   * lapsed — it gates on status='active' and this timestamp — so this, not
   * `expiresAt`, is what actually bounds how long recovery is possible.
   */
  certificateNotAfter: string;
  leaseVersion: number;
  materials: SessionChannelMaterials;
}

export interface SessionChannelProvisioner {
  provision(lineage: SessionChannelLineage): Promise<ProvisionedSessionChannel>;
  renew(channel: ProvisionedSessionChannel): Promise<ProvisionedSessionChannel>;
  revoke(channel: ProvisionedSessionChannel, reason: string): Promise<void>;
  release(channel: ProvisionedSessionChannel): Promise<void>;
  /**
   * Reconstruct a channel this process did not provision, from persisted
   * material plus the control plane's idempotent provision read-back. Optional:
   * a provisioner without it cannot re-adopt, and adopted sessions take the
   * bounded horizon instead.
   */
  adopt?(lineage: SessionChannelLineage): Promise<ProvisionedSessionChannel>;
  /** Map a sessionId to the lineage `provision` persisted, if any survives on disk. */
  findAdoptableLineage?(sessionId: string): SessionChannelLineage | null;
}

/** A deliberately low-cardinality provisioning failure safe for host logs. */
export class SessionChannelProvisioningError extends Error {
  readonly stage: 'key_generation' | 'csr_generation' | 'control_request' | 'response_validation' | 'material_commit';
  readonly status: number | null;
  readonly code: string | null;
  readonly transport: string | null;

  constructor(
    stage: 'key_generation' | 'csr_generation' | 'control_request' | 'response_validation' | 'material_commit',
    detail: { status?: number | null; code?: string | null; transport?: string | null } = {},
  ) {
    super(`NanoCo session channel provisioning failed at ${stage}`);
    this.name = 'SessionChannelProvisioningError';
    this.stage = stage;
    this.status = detail.status ?? null;
    this.code = detail.code ?? null;
    this.transport = detail.transport ?? null;
  }
}

/**
 * How a renewal failure should be acted on.
 *
 * - `transient` — the lease is presumed intact and a later attempt inside the
 *   same lease window can still succeed (Gateway restarting, control plane
 *   unavailable, request timed out, connection refused or reset).
 * - `fatal` — no retry can help; the channel is gone or was never ours.
 * - `stale_version` — the compare-and-swap saw a different version. Resolved
 *   inside the provisioner; it never reaches the renewal loop as itself.
 *
 * A provisioner that does not classify its failures keeps the pre-retry
 * behaviour: anything the loop cannot read as `transient` is treated as fatal.
 */
export type SessionChannelFailureKind = 'transient' | 'fatal' | 'stale_version';

/**
 * A renewal failure the retry loop can act on. It carries only the HTTP status
 * and the Gateway's short error code — never a response body, a filesystem
 * path, or certificate detail.
 */
export class SessionChannelRenewalError extends Error {
  readonly kind: SessionChannelFailureKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(kind: SessionChannelFailureKind, detail: { status?: number | null; code?: string | null } = {}) {
    super(`NanoCo session channel lease renewal failed (${kind})`);
    this.name = 'SessionChannelRenewalError';
    this.kind = kind;
    this.status = detail.status ?? null;
    this.code = detail.code ?? null;
  }
}

export interface SidecarMount {
  hostPath: string;
  containerPath: string;
  /**
   * Which pinning rule this file is subject to (see `MountSpec` in
   * `drivers/types.ts`). Declared here, at the point where what the file *is* is
   * known, rather than inferred downstream from the fact that they arrive
   * together: the sidecar's three mounts come from two different roots.
   */
  class: MountClass;
}

export interface SidecarContainerSpec {
  name: string;
  image: string;
  uplinkNetwork: string;
  privateNetwork: string;
  labels: Readonly<Record<string, string>>;
  environment: Readonly<Record<string, string>>;
  mounts: readonly SidecarMount[];
}

export interface SessionSidecarProcess {
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SessionSidecarDriver {
  /**
   * True when the agent and the sidecar end up in one network namespace, so the
   * proxy is reachable on loopback. Decides the agent's proxy URL — the one
   * thing about the sidecar's placement the agent's environment has to know.
   */
  readonly sharesNetworkNamespace: boolean;
  /**
   * True when the egress runtime is realized inside the session itself — the
   * sidecar is contributed to the session spec and the netns is the session's —
   * so a successor host that adopts the session has adopted the whole egress
   * runtime with it, and lease re-adoption can attach a live handle. Absent or
   * false when this driver creates out-of-band resources (the Docker
   * realization's attach-supervised sidecar process and per-session networks)
   * that a successor can neither supervise nor tear down by name; adopted
   * sessions then take the bounded horizon. A capability, deliberately, so the
   * gate never reads driver kind.
   */
  readonly realizesEgressInSession?: boolean;
  createNetwork(name: string, internal: boolean): void;
  createSidecar(spec: SidecarContainerSpec): void;
  startSidecar(name: string): SessionSidecarProcess;
  stopSidecar(name: string): void;
  removeSidecar(name: string): void;
  removeNetwork(name: string): void;
  /**
   * Per-session networks this install owns, for startup reaping. Optional: a
   * realization that creates no networks (the pod one) has nothing to list.
   */
  listInstallNetworks?(): string[];
  /**
   * Containers this driver defers to the session driver rather than creating
   * itself. Empty for Docker (it creates the sidecar out-of-band); one
   * `egress-sidecar` ContainerSpec for the pod path, where the sidecar is a
   * native sidecar container in the session's own pod.
   */
  contributedContainers(): readonly ContainerSpec[];
  /** Runtime args selecting the agent's network boundary. Empty when the session driver owns it. */
  agentNetworkArgs(privateNetwork: string): readonly string[];
}

export interface NanoCoSessionSidecarOptions {
  deploymentId: string;
  sidecarImage: string;
}

/**
 * Every per-session network this install creates starts with this. Shared by
 * the namer and the reaper so the two cannot drift into a sweep that matches
 * nothing (or, worse, another install's networks).
 */
const SESSION_NETWORK_PREFIX = `nc-${INSTALL_SLUG}-`;

export class DockerSessionSidecarDriver implements SessionSidecarDriver {
  readonly sharesNetworkNamespace = false;
  /**
   * The sidecar process and the two networks are created out-of-band and
   * supervised through this process's own `start --attach` child. A successor
   * host has neither; its adoptions take the bounded horizon.
   */
  readonly realizesEgressInSession = false;

  contributedContainers(): readonly ContainerSpec[] {
    // The Docker path creates the sidecar itself, out of band from the session
    // driver, so it contributes nothing to the session spec.
    return [];
  }

  agentNetworkArgs(privateNetwork: string): readonly string[] {
    return ['--network', privateNetwork];
  }

  createNetwork(name: string, internal: boolean): void {
    const args = ['network', 'create'];
    if (internal) args.push('--internal');
    args.push('--label', CONTAINER_INSTALL_LABEL, name);
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15_000 });
  }

  createSidecar(spec: SidecarContainerSpec): void {
    const args = [
      'create',
      '--name',
      spec.name,
      '--network',
      spec.uplinkNetwork,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
    ];
    if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      args.push('--user', `${process.getuid()}:${process.getgid()}`);
    }
    for (const [key, value] of Object.entries(spec.labels)) {
      args.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.environment)) {
      args.push('-e', `${key}=${value}`);
    }
    for (const mount of spec.mounts) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    }
    args.push(spec.image);
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15_000 });
    try {
      execFileSync(
        CONTAINER_RUNTIME_BIN,
        ['network', 'connect', '--alias', SIDECAR_ALIAS, spec.privateNetwork, spec.name],
        { stdio: 'pipe', timeout: 15_000 },
      );
    } catch (error) {
      try {
        execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '--force', spec.name], {
          stdio: 'pipe',
          timeout: 15_000,
        });
      } catch {
        // Preserve the original network-connect failure. Startup reconciliation
        // removes any still-labeled sidecar if this best-effort rollback fails.
      }
      throw error;
    }
  }

  startSidecar(name: string): ChildProcess {
    return spawn(CONTAINER_RUNTIME_BIN, ['start', '--attach', name], {
      // The relay has no host-facing output contract. Discard output so a
      // noisy or compromised sidecar cannot block on a full pipe or surface
      // certificate-related diagnostics in NanoClaw logs.
      stdio: 'ignore',
    });
  }

  stopSidecar(name: string): void {
    execFileSync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], { stdio: 'pipe', timeout: 15_000 });
  }

  removeSidecar(name: string): void {
    execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '--force', name], { stdio: 'pipe', timeout: 15_000 });
  }

  removeNetwork(name: string): void {
    execFileSync(CONTAINER_RUNTIME_BIN, ['network', 'rm', name], { stdio: 'pipe', timeout: 15_000 });
  }

  listInstallNetworks(): string[] {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'ls', '--filter', `name=${SESSION_NETWORK_PREFIX}`, '--format', '{{.Name}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15_000 },
    );
    return out.trim().split('\n').filter(Boolean);
  }
}

/**
 * Pod realization of the sidecar: it creates nothing.
 *
 * Everything the Docker driver choreographs — two networks, an alias, an
 * ordered seven-step teardown — is a property of the pod object, so this driver
 * captures the sidecar's shape and hands it to the session driver as an
 * `egress-sidecar` ContainerSpec. Ordering is a native sidecar container;
 * teardown is the pod delete. There is nothing left for it to clean up.
 */
export class PodSessionSidecarDriver implements SessionSidecarDriver {
  readonly sharesNetworkNamespace = true;
  /** The sidecar is a container of the session pod: adopt the pod, adopt it all. */
  readonly realizesEgressInSession = true;
  #captured: ContainerSpec | null = null;

  constructor(private readonly statHostPath: (p: string) => 'File' | 'Directory' | null = () => 'File') {}

  contributedContainers(): readonly ContainerSpec[] {
    return this.#captured ? [this.#captured] : [];
  }

  agentNetworkArgs(): readonly string[] {
    // The pod is the network boundary. Raw Docker flags would be rejected by
    // the Pod session driver anyway, which is the point of that rejection.
    return [];
  }

  createNetwork(): void {}

  createSidecar(spec: SidecarContainerSpec): void {
    this.#captured = {
      role: 'egress-sidecar',
      image: spec.image,
      env: { ...spec.environment },
      labels: { ...spec.labels },
      // Carry the declared class through. An earlier version asserted
      // `identity-material` for all three, which was true of two of them: the
      // Gateway server CA lives in the deployment's PKI root, so it could never
      // satisfy that class's pinning rule and every spawn was denied at prepare.
      mounts: spec.mounts.map((mount) => ({
        class: mount.class,
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        mode: 'ro' as const,
        groupScope: spec.labels['nanoclaw-group'] ?? '',
      })),
    };
    // Fail here, where the path is named, rather than at kubelet mount time.
    for (const mount of this.#captured.mounts) {
      if (this.statHostPath(mount.hostPath) === null) {
        throw new Error('NanoCo session channel material is not present on the node');
      }
    }
  }

  startSidecar(): SessionSidecarProcess {
    // Supervision belongs to the session driver: the sidecar is a container in
    // the agent's own pod, so its death is the pod's terminal event, not a
    // separate child process this module could watch.
    return INERT_SIDECAR_PROCESS;
  }

  stopSidecar(): void {}
  removeSidecar(): void {}
  removeNetwork(): void {}
  /** A pod session has no Docker network to leave behind. */
  listInstallNetworks(): string[] {
    return [];
  }
}

const INERT_SIDECAR_PROCESS: SessionSidecarProcess = {
  on(): SessionSidecarProcess {
    return INERT_SIDECAR_PROCESS;
  },
};

/**
 * The lease half of a session's egress runtime: renewal, degradation
 * accounting, and the two ways it can end. Shared by `prepare` (which wraps it
 * around driver-created resources) and `adoptPrepared` (which has none — on the
 * adoptable realization the sidecar and netns are the session's own).
 */
interface ChannelLeaseRuntime {
  notifyUnavailable(error: Error): void;
  armLeaseTimer(): void;
  /** Full teardown, unguarded: resource teardown, then revoke, then release. */
  cleanup(reason: string): Promise<void>;
  egressState(): SessionEgressState;
  onUnavailable(callback: (error?: Error) => void): void;
  close(reason: string): Promise<void>;
  detach(): Promise<void>;
}

export class NanoCoSessionSidecarManager {
  readonly #options: NanoCoSessionSidecarOptions;
  readonly #provisioner: SessionChannelProvisioner;
  readonly #driver: SessionSidecarDriver;
  readonly #newId: () => string;

  constructor(
    options: NanoCoSessionSidecarOptions,
    provisioner: SessionChannelProvisioner,
    driver: SessionSidecarDriver = defaultSessionSidecarDriver(),
    newId: () => string = randomUUID,
  ) {
    this.#options = {
      deploymentId: validateIdentifier('deployment_id', options.deploymentId),
      sidecarImage: requireImageReference(options.sidecarImage),
    };
    this.#provisioner = provisioner;
    this.#driver = driver;
    this.#newId = newId;
  }

  async prepare(context: PrepareSessionEgressContext): Promise<SessionEgressHandle> {
    const token = validateIdentifier('runtime token', this.#newId());
    const lineage: SessionChannelLineage = {
      deploymentId: this.#options.deploymentId,
      agentId: validateIdentifier('agent_id', context.agentGroup.id),
      sessionId: validateIdentifier('session_id', context.session.id),
      containerInstanceId: validateIdentifier('container_instance_id', `container-${token}`),
      channelId: validateIdentifier('channel_id', `channel-${token}`),
      ...(context.requestCapability
        ? { requestCapability: validateRequestCapability(context.requestCapability) }
        : {}),
    };
    let channel: ProvisionedSessionChannel;
    try {
      channel = await this.#provisioner.provision(lineage);
    } catch (error) {
      if (error instanceof SessionChannelProvisioningError) throw error;
      // Provisioner failures can originate in certificate tooling. Do not let
      // their error objects (or command arguments) reach NanoClaw's logs.
      // eslint-disable-next-line preserve-caught-error -- the cause may contain private-key tooling arguments
      throw new Error('NanoCo session channel provisioning failed');
    }
    try {
      validateProvisionedChannel(channel, lineage);
    } catch (error) {
      await Promise.allSettled([
        this.#provisioner.revoke(channel, 'invalid-provisioned-channel'),
        this.#provisioner.release(channel),
      ]);
      throw error;
    }

    const shortToken = token.replaceAll('-', '').slice(0, 16);
    const networkBase = `${SESSION_NETWORK_PREFIX}${shortToken}`;
    const privateNetwork = `${networkBase}-session`;
    const uplinkNetwork = `${networkBase}-uplink`;
    const sidecarName = `${context.containerName}-sidecar`;

    let privateNetworkCreated = false;
    let uplinkNetworkCreated = false;
    let sidecarCreated = false;
    let sidecarProcess: SessionSidecarProcess | null = null;

    const runtime = this.#channelLeaseRuntime(lineage, channel, (failures) => {
      if (sidecarCreated) {
        try {
          this.#driver.stopSidecar(sidecarName);
        } catch {
          failures.push('sidecar stop');
        }
        try {
          this.#driver.removeSidecar(sidecarName);
        } catch {
          failures.push('sidecar removal');
        }
      }
      if (privateNetworkCreated) {
        try {
          this.#driver.removeNetwork(privateNetwork);
        } catch {
          failures.push('private network removal');
        }
      }
      if (uplinkNetworkCreated) {
        try {
          this.#driver.removeNetwork(uplinkNetwork);
        } catch {
          failures.push('uplink network removal');
        }
      }
    });

    try {
      this.#driver.createNetwork(privateNetwork, true);
      privateNetworkCreated = true;
      this.#driver.createNetwork(uplinkNetwork, false);
      uplinkNetworkCreated = true;
      this.#driver.createSidecar({
        name: sidecarName,
        image: this.#options.sidecarImage,
        uplinkNetwork,
        privateNetwork,
        labels: {
          'nanoclaw-install': INSTALL_SLUG,
          'nanoclaw-role': 'session-sidecar',
          'nanoclaw-group': lineage.agentId,
          'nanoclaw-session': lineage.sessionId,
          'nanoco-channel': lineage.channelId,
          'nanoco-container-instance': lineage.containerInstanceId,
        },
        environment: {
          NANOCO_SIDECAR_LISTEN_ADDR: '0.0.0.0:15001',
          NANOCO_SIDECAR_GATEWAY_ADDR: channel.gatewayAddress,
          NANOCO_SIDECAR_GATEWAY_SERVER_NAME: channel.gatewayServerName,
          NANOCO_SIDECAR_GATEWAY_CA: SIDECAR_GATEWAY_CA,
          NANOCO_SIDECAR_CLIENT_CERT: SIDECAR_CLIENT_CERT,
          NANOCO_SIDECAR_CLIENT_KEY: SIDECAR_CLIENT_KEY,
        },
        mounts: [
          {
            // The Gateway's SERVER CA, and deliberately not identity-material.
            // It verifies the Gateway's certificate, carries no identity of
            // ours, is world-readable by design, and is one file shared by every
            // session — minted into the deployment's PKI root by the environment,
            // never emitted per-session by the provisioner. The material root and
            // the PKI root are two different roots on a real deployment, so it
            // cannot satisfy identity-material's pinning rule; the same reasoning
            // that classes the proxy CA below. Keeping it out of the agent is the
            // sidecar mount list's job, not the class's.
            hostPath: channel.materials.gatewayCaPath(),
            containerPath: SIDECAR_GATEWAY_CA,
            class: 'allowlisted-extra',
          },
          {
            // Ours, per-session, provisioner-emitted, 0600, under materialsRoot.
            hostPath: channel.materials.clientCertificatePath(),
            containerPath: SIDECAR_CLIENT_CERT,
            class: 'identity-material',
          },
          {
            hostPath: channel.materials.clientPrivateKeyPath(),
            containerPath: SIDECAR_CLIENT_KEY,
            class: 'identity-material',
          },
        ],
      });
      sidecarCreated = true;
      sidecarProcess = this.#driver.startSidecar(sidecarName);
      sidecarProcess.on('error', (error) => runtime.notifyUnavailable(sanitizeSidecarFailure('failed to start', error)));
      sidecarProcess.on('close', (code) => {
        runtime.notifyUnavailable(new Error(`NanoCo session sidecar exited unexpectedly (code ${code ?? 'signal'})`));
      });
      runtime.armLeaseTimer();
    } catch (_error) {
      await runtime.cleanup('sidecar-start-failed');
      // eslint-disable-next-line preserve-caught-error -- Docker errors may contain certificate mount paths
      throw new Error('NanoCo session sidecar failed to start');
    }

    const proxyUrl = this.#driver.sharesNetworkNamespace ? SIDECAR_LOOPBACK_PROXY_URL : SIDECAR_ALIAS_PROXY_URL;
    const proxyCaMount: MountSpec = {
      // A public trust anchor, deliberately NOT identity-material: that class
      // is rejected on the agent role, and this is the one piece of the egress
      // path the agent legitimately holds. It lives in the deployment's PKI
      // root rather than a release surface, so `allowlisted-extra` — vetted by
      // the operator's own configuration — is the pinning rule that actually
      // holds for it.
      class: 'allowlisted-extra',
      hostPath: channel.materials.proxyCaPath(),
      containerPath: AGENT_PROXY_CA,
      mode: 'ro',
      groupScope: lineage.agentId,
    };

    return {
      agentEnvironment: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NODE_EXTRA_CA_CERTS: AGENT_PROXY_CA,
        SSL_CERT_FILE: AGENT_PROXY_CA,
        CURL_CA_BUNDLE: AGENT_PROXY_CA,
        REQUESTS_CA_BUNDLE: AGENT_PROXY_CA,
        // git links a libcurl flavor that consults neither CURL_CA_BUNDLE nor
        // SSL_CERT_FILE for its CA path — without this, every git-over-HTTPS
        // call inside the session dies at certificate verification.
        GIT_SSL_CAINFO: AGENT_PROXY_CA,
      },
      agentNetworkArgs: this.#driver.agentNetworkArgs(privateNetwork),
      containers: this.#driver.contributedContainers(),
      // Applied after the ordinary mounts by every driver, so a nested
      // read-only public CA cannot be shadowed by its writable parent.
      agentMounts: [proxyCaMount],
      agentLabels: {
        'nanoco-channel': lineage.channelId,
        'nanoco-container-instance': lineage.containerInstanceId,
      },
      egressState: () => runtime.egressState(),
      onUnavailable: (callback) => runtime.onUnavailable(callback),
      close: (reason) => runtime.close(reason),
      detach: () => runtime.detach(),
    };
  }

  /**
   * Reconstruct the egress handle for a session adopted from a previous host.
   *
   * The lease is recovered through the provisioner's idempotent provision
   * read-back (`adopt`), keyed by the lineage `provision` persisted beside the
   * channel material. Nothing is created here: on the adoptable realization the
   * sidecar and the network namespace are the session's own, so the handle
   * contributes no environment, no network args and no containers — the spec
   * was realized when the session spawned. What the successor owns again is
   * the lease: renewal re-arms, and intentional teardown flows
   * teardown-then-revoke exactly like a spawned session's.
   *
   * Returns null — the caller then applies the bounded horizon — when this
   * realization creates out-of-band resources a successor cannot own, when the
   * provisioner cannot adopt, when no persisted lineage matches the session, or
   * when the lineage belongs to a different agent group.
   */
  async adoptPrepared(context: PrepareSessionEgressContext): Promise<SessionEgressHandle | null> {
    if (!this.#driver.realizesEgressInSession) return null;
    const provisioner = this.#provisioner;
    if (!provisioner.adopt || !provisioner.findAdoptableLineage) return null;
    const lineage = provisioner.findAdoptableLineage(validateIdentifier('session_id', context.session.id));
    if (!lineage) return null;
    if (lineage.agentId !== context.agentGroup.id || lineage.deploymentId !== this.#options.deploymentId) {
      log.warn('NanoCo persisted session lineage does not match the adopted session; declining adoption', {
        sessionId: context.session.id,
      });
      return null;
    }
    const channel = await provisioner.adopt(lineage);
    validateProvisionedChannel(channel, lineage);

    const runtime = this.#channelLeaseRuntime(lineage, channel, () => {
      // Nothing to tear down: the sidecar and netns are the session's own and
      // die with it. Teardown-then-revoke still holds — the pod delete has
      // already happened by the time close() runs on the host's kill path.
    });
    runtime.armLeaseTimer();
    log.info('NanoCo session channel lease re-adopted', {
      sessionId: lineage.sessionId,
      channelId: lineage.channelId,
      leaseVersion: channel.leaseVersion,
      expiresAt: channel.expiresAt,
    });
    return {
      agentEnvironment: {},
      agentNetworkArgs: [],
      containers: [],
      egressState: () => runtime.egressState(),
      onUnavailable: (callback) => runtime.onUnavailable(callback),
      close: (reason) => runtime.close(reason),
      detach: () => runtime.detach(),
    };
  }

  /**
   * The per-channel lease state machine. `teardownResources` runs first inside
   * `cleanup`, before the lease is touched: intentional teardown is
   * teardown-then-revoke (D1), so a crash between the two leaves an unrevoked
   * lease over a dismantled runtime — benign, re-adopted or expiring on its own
   * horizon — never a revoked lease under a session that is still alive.
   */
  #channelLeaseRuntime(
    lineage: SessionChannelLineage,
    initialChannel: ProvisionedSessionChannel,
    teardownResources: (failures: string[]) => void,
  ): ChannelLeaseRuntime {
    let channel = initialChannel;
    let intentionalClose = false;
    let unavailable: ((error?: Error) => void) | null = null;
    let pendingUnavailable: Error | null = null;
    let closePromise: Promise<void> | null = null;
    let detachPromise: Promise<void> | null = null;
    let leaseTimer: ReturnType<typeof setTimeout> | null = null;
    let renewalPromise: Promise<void> | null = null;
    let cancelRetryWait: (() => void) | null = null;
    /**
     * When the lease lapsed while the certificate is still renewable. Non-null
     * exactly while the session is egress-dead but not yet torn down — the
     * window D3 traded a kill for. Surfaced through `egressState()` and bracketed
     * by two log lines so it is assertable from outside the process.
     */
    let degradedSince: string | null = null;
    let renewalAttempts = 0;

    const notifyUnavailable = (error: Error): void => {
      if (intentionalClose || pendingUnavailable) return;
      pendingUnavailable = error;
      unavailable?.(error);
    };

    const armLeaseTimer = (): void => {
      const remainingMs = Date.parse(channel.expiresAt) - Date.now();
      if (remainingMs <= 0) {
        notifyUnavailable(new Error('NanoCo session channel lease expired'));
        return;
      }
      if (remainingMs <= MIN_RENEWAL_WINDOW_MS) {
        leaseTimer = setTimeout(armLeaseTimer, remainingMs);
      } else {
        leaseTimer = setTimeout(
          () => {
            renewalPromise = renewLease();
          },
          Math.min(Math.floor(remainingMs / 2), MAX_TIMER_DELAY_MS),
        );
      }
      leaseTimer.unref?.();
    };

    // Resolves early when cleanup cancels it, so close() never waits out a backoff.
    const waitBeforeRetry = (delayMs: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelRetryWait = null;
          resolve();
        }, delayMs);
        timer.unref?.();
        cancelRetryWait = () => {
          clearTimeout(timer);
          cancelRetryWait = null;
          resolve();
        };
      });

    const renewLease = async (): Promise<void> => {
      let attempt = 0;
      let delayMs = RENEWAL_RETRY_BASE_DELAY_MS;
      try {
        for (;;) {
          const previous = channel;
          attempt += 1;
          try {
            const renewed = await this.#provisioner.renew(previous);
            if (intentionalClose) return;
            validateProvisionedChannel(renewed, lineage);
            if (
              renewed.gatewayAddress !== previous.gatewayAddress ||
              renewed.gatewayServerName !== previous.gatewayServerName ||
              renewed.materials !== previous.materials ||
              // A lost response recovered inside the provisioner lands at
              // previous + 2, so the floor is a minimum rather than an equality.
              // Lease expiry stays strictly monotonic either way.
              renewed.leaseVersion < previous.leaseVersion + 1 ||
              Date.parse(renewed.expiresAt) < Date.parse(previous.expiresAt)
            ) {
              throw new Error('NanoCo session channel renewal changed immutable channel state');
            }
            channel = renewed;
            log.info('NanoCo session channel lease renewed', {
              sessionId: lineage.sessionId,
              channelId: lineage.channelId,
              leaseVersion: renewed.leaseVersion,
              expiresAt: renewed.expiresAt,
              attempts: attempt,
            });
            if (degradedSince) {
              log.info('NanoCo session channel egress recovered after a degraded window', {
                sessionId: lineage.sessionId,
                channelId: lineage.channelId,
                degradedSince,
                degradedMs: Date.now() - Date.parse(degradedSince),
                attempts: attempt,
              });
              degradedSince = null;
            }
            renewalAttempts = attempt;
            armLeaseTimer();
            return;
          } catch (error) {
            if (intentionalClose) return;
            // Renewal errors can carry mTLS paths or response details, so only
            // the classification, status, and short Gateway code are logged.
            const failure = classifyRenewalFailure(error);
            if (failure.kind !== 'transient') {
              log.error('NanoCo session channel lease renewal failed permanently', {
                sessionId: lineage.sessionId,
                channelId: lineage.channelId,
                leaseVersion: previous.leaseVersion,
                kind: failure.kind,
                status: failure.status,
                code: failure.code,
                attempts: attempt,
              });
              notifyUnavailable(new Error('NanoCo session channel lease renewal failed'));
              return;
            }
            // The retry budget runs to the certificate ceiling, not to lease
            // expiry. The Gateway imposes no lease-expiry precondition on
            // renewal — it gates on status='active' and certificate_not_after —
            // so a channel whose lease lapsed is still renewable, and stopping
            // at expiry threw away a recovery the control plane would have
            // granted. That mattered little when the outage being absorbed was
            // a unit restart measured in seconds; a pod reschedule routinely
            // exceeds the ~150s a half-life lease window leaves.
            //
            // What the session loses in the meantime is real and is not hidden:
            // past expiry the Gateway tears down the sidecar's live connections
            // and refuses new ones, so the agent sees egress failures rather
            // than a clean stop. That window is logged on entry and on exit and
            // is readable through egressState().
            const budgetEndsAt = Date.parse(previous.certificateNotAfter);
            const remainingMs = budgetEndsAt - RENEWAL_ABANDON_MARGIN_MS - Date.now();
            const leaseExpired = Date.now() >= Date.parse(previous.expiresAt);
            if (leaseExpired && !degradedSince && remainingMs > 0) {
              // The window opened when the lease lapsed, not when this attempt
              // happened to notice — the agent's egress was already failing.
              degradedSince = previous.expiresAt;
              log.warn('NanoCo session channel lease expired; egress degraded while the certificate is renewable', {
                sessionId: lineage.sessionId,
                channelId: lineage.channelId,
                leaseVersion: previous.leaseVersion,
                expiredAt: previous.expiresAt,
                certificateNotAfter: previous.certificateNotAfter,
                budgetRemainingMs: remainingMs,
                attempts: attempt,
              });
            }
            if (remainingMs <= 0) {
              log.error('NanoCo session channel lease renewal exhausted the certificate window', {
                sessionId: lineage.sessionId,
                channelId: lineage.channelId,
                leaseVersion: previous.leaseVersion,
                status: failure.status,
                code: failure.code,
                attempts: attempt,
                degradedSince,
                certificateNotAfter: previous.certificateNotAfter,
              });
              notifyUnavailable(new Error('NanoCo session channel lease renewal exhausted the certificate window'));
              return;
            }
            const waitMs = Math.min(delayMs + Math.floor(Math.random() * RENEWAL_RETRY_JITTER_MS), remainingMs);
            log.warn('NanoCo session channel lease renewal failed, retrying inside the lease window', {
              sessionId: lineage.sessionId,
              channelId: lineage.channelId,
              leaseVersion: previous.leaseVersion,
              kind: failure.kind,
              status: failure.status,
              code: failure.code,
              attempt,
              retryInMs: waitMs,
              windowRemainingMs: remainingMs,
            });
            delayMs = Math.min(delayMs * 2, RENEWAL_RETRY_MAX_DELAY_MS);
            await waitBeforeRetry(waitMs);
            if (intentionalClose) return;
          }
        }
      } finally {
        renewalPromise = null;
      }
    };

    /**
     * Stop renewing and supervising without touching the channel itself.
     * Everything detach() promises to leave alone — the lease, the material on
     * disk, the running session — is left alone by construction: this touches
     * only process-local timers and flags.
     */
    const quiesce = async (): Promise<void> => {
      intentionalClose = true;
      if (leaseTimer) {
        clearTimeout(leaseTimer);
        leaseTimer = null;
      }
      cancelRetryWait?.();
      await renewalPromise;
    };

    const cleanup = async (reason: string): Promise<void> => {
      await quiesce();
      const failures: string[] = [];
      // Teardown before revocation, deliberately (D1): dismantle the runtime
      // the lease authenticates, then surrender the lease. A crash between the
      // two leaves an unrevoked lease — re-adopted by a successor or expiring
      // on its own horizon — which is benign; the pre-inversion order left a
      // revoked lease under a still-running session, which is the measured
      // incident this ordering exists to prevent.
      teardownResources(failures);
      try {
        await this.#provisioner.revoke(channel, reason);
      } catch {
        failures.push('lease revocation');
      }
      try {
        await this.#provisioner.release(channel);
      } catch {
        failures.push('channel material release');
      }
      if (failures.length > 0) {
        throw new Error(`NanoCo session sidecar cleanup failed: ${failures.join(', ')}`);
      }
    };

    return {
      notifyUnavailable,
      armLeaseTimer,
      cleanup,
      egressState(): SessionEgressState {
        return {
          degradedSince,
          leaseExpiresAt: channel.expiresAt,
          certificateNotAfter: channel.certificateNotAfter,
          renewalAttempts,
        };
      },
      onUnavailable(callback: (error?: Error) => void): void {
        unavailable = callback;
        if (pendingUnavailable) callback(pendingUnavailable);
      },
      close(reason: string): Promise<void> {
        closePromise ??= cleanup(reason);
        return closePromise;
      },
      detach(): Promise<void> {
        detachPromise ??= quiesce();
        return detachPromise;
      },
    };
  }
}

/**
 * The recipe installs `nanoco-docker`, whose sidecar realization is Docker.
 * Keep driver selection outside this module: importing the driver barrel from
 * a gateway-provider registration creates a cycle through both installed
 * barrels before their module constants are initialized.
 */
export function defaultSessionSidecarDriver(): SessionSidecarDriver {
  return new PodSessionSidecarDriver(statHostPath);
}

/**
 * Remove per-session networks a dead host left behind.
 *
 * The session driver reaps containers because it created them; it never created
 * these and cannot know their naming scheme, so the module that names them owns
 * cleaning them up. Removal is best-effort by design rather than by resignation:
 * Docker refuses to remove a network that still has an endpoint attached, which
 * is exactly the guard an adopted session needs — a network still carrying one
 * survives the sweep and is reaped on a later start.
 */
export function reapOrphanedSessionNetworks(driver: SessionSidecarDriver): void {
  let names: string[];
  try {
    names = driver.listInstallNetworks?.() ?? [];
  } catch (err) {
    log.warn('Failed to list session networks for reaping', { err });
    return;
  }
  const removed: string[] = [];
  for (const name of names) {
    try {
      driver.removeNetwork(name);
      removed.push(name);
    } catch {
      /* still in use by a live session, or already gone */
    }
  }
  if (removed.length > 0) {
    log.info('Removed orphaned session networks', { count: removed.length, names: removed });
  }
}

export interface NanoCoSessionSidecarRegistration {
  /**
   * Sweep this install's orphaned per-session networks. Deliberately NOT run
   * at registration: startup order is register → adopt → reapOrphans, so
   * reconciliation has decided which sessions survive before any network is
   * swept — the property the old registration-time reap could only keep by
   * forcing registration to follow adoption, which re-adoption inverts.
   */
  reapOrphans(): void;
}

/** Activate NanoCo as the required per-session egress path. */
export function registerNanoCoSessionSidecar(
  options: NanoCoSessionSidecarOptions,
  provisioner: SessionChannelProvisioner,
  driver?: SessionSidecarDriver,
): NanoCoSessionSidecarRegistration {
  const sidecarDriver = driver ?? defaultSessionSidecarDriver();
  const manager = new NanoCoSessionSidecarManager(options, provisioner, sidecarDriver);
  registerSessionEgressFactory((context) => manager.prepare(context));
  registerSessionEgressAdopter((context) => manager.adoptPrepared(context));
  return { reapOrphans: () => reapOrphanedSessionNetworks(sidecarDriver) };
}

/**
 * The renewal loop retries only what the provisioner explicitly classified as
 * transient. Validation failures, provisioner bugs, and provisioners that
 * predate this contract fail closed the way a single-shot renewal always did.
 */
function classifyRenewalFailure(error: unknown): SessionChannelRenewalError {
  return error instanceof SessionChannelRenewalError ? error : new SessionChannelRenewalError('fatal');
}

function validateProvisionedChannel(channel: ProvisionedSessionChannel, expected: SessionChannelLineage): void {
  if (!channel || typeof channel !== 'object' || !channel.lineage || typeof channel.lineage !== 'object') {
    throw new Error('Provisioned session channel has an invalid shape');
  }
  for (const key of Object.keys(expected) as Array<keyof SessionChannelLineage>) {
    if (channel.lineage[key] !== expected[key]) {
      throw new Error(`Provisioned session channel changed trusted ${key}`);
    }
  }
  requireSingleToken(channel.gatewayAddress, 'gateway address');
  requireSingleToken(channel.gatewayServerName, 'gateway server name');
  if (!Number.isSafeInteger(channel.leaseVersion) || channel.leaseVersion < 1) {
    throw new Error('Provisioned session channel has an invalid lease version');
  }
  if (!(channel.materials instanceof SessionChannelMaterials)) {
    throw new Error('Provisioned session channel has invalid materials');
  }
  const expiresAt = Date.parse(channel.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Provisioned session channel is already expired');
  }
  const certificateNotAfter = Date.parse(channel.certificateNotAfter);
  if (!Number.isFinite(certificateNotAfter) || certificateNotAfter < expiresAt) {
    throw new Error('Provisioned session channel has an invalid certificate ceiling');
  }
}

function validateIdentifier(label: string, value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > IDENTIFIER_MAX_BYTES || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${label} is not a safe identifier`);
  }
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(':')
  ) {
    throw new Error(`${label} path must be absolute`);
  }
  return value;
}

function requireImageReference(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/.test(value)) {
    throw new Error('sidecar image is not a safe image reference');
  }
  return value;
}

function requireSingleToken(value: string, label: string): string {
  if (value.length === 0 || /\s/.test(value)) {
    throw new Error(`${label} is missing or contains whitespace`);
  }
  return value;
}

function sanitizeSidecarFailure(action: string, _error: Error): Error {
  return new Error(`NanoCo session sidecar ${action}`);
}
