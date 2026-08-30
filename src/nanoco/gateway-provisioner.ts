/**
 * NanoClaw host implementation of the Gateway session-channel control API.
 *
 * The host creates every session private key and CSR locally. Only the CSR is
 * sent over deployment-authenticated mTLS; the private key is mounted into the
 * sidecar and never enters the agent or Gateway.
 */
import { execFileSync } from 'child_process';
import { createPrivateKey, X509Certificate } from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { inspect } from 'util';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { validateRequestCapability } from './mailbox-capability.js';
import { registerStatelessSessionEgress } from '../stateless-k8s/session-egress.js';
import {
  registerNanoCoSessionSidecar,
  SessionChannelMaterials,
  SessionChannelProvisioningError,
  SessionChannelRenewalError,
  type ProvisionedSessionChannel,
  type SessionChannelLineage,
  type SessionChannelProvisioner,
} from './session-sidecar.js';

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const IDENTIFIER_MAX_BYTES = 128;
const PROVISION_ATTEMPTS = 3;
const PROVISION_RETRY_BASE_MS = 250;
/**
 * Statuses the Gateway only ever emits for a channel that cannot be renewed
 * again: 403 `deployment_mismatch`, 404 `channel_not_found`, 410
 * `channel_revoked` and `certificate_expired`. Keyed on status rather than on
 * the error code so a revocation still aborts immediately when the body is
 * missing or unparseable — a revoked lease must not burn the retry budget.
 */
const FATAL_RENEWAL_STATUSES = new Set([403, 404, 410]);
/**
 * Certificate-verification failures. A Gateway we cannot authenticate is a
 * trust or configuration problem rather than a blip, so fail fast instead of
 * spending the lease window on it.
 *
 * The list does not have to be exhaustive. An unlisted trust failure is merely
 * retried until the window closes and then tears the session down, and no
 * request ever completes against an unauthenticated Gateway, so guessing wrong
 * costs latency and never exposure.
 */
const FATAL_TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const CONFIG_KEYS = [
  'NANOCO_DEPLOYMENT_ID',
  'NANOCO_SIDECAR_IMAGE',
  'NANOCO_GATEWAY_CONTROL_URL',
  'NANOCO_GATEWAY_CONTROL_SERVER_NAME',
  'NANOCO_GATEWAY_ADDRESS',
  'NANOCO_GATEWAY_SERVER_NAME',
  'NANOCO_GATEWAY_CA',
  'NANOCO_DEPLOYMENT_CERT',
  'NANOCO_DEPLOYMENT_KEY',
  'NANOCO_PROXY_CA',
] as const;

export interface ConfiguredNanoCoSessionEgress {
  configured: boolean;
  /**
   * Sweep orphaned per-session networks. A no-op when unconfigured. Call only
   * after adoption has reconciled survivors: register → adopt → reapOrphans.
   */
  reapOrphans(): void;
}

/** Register the required sidecar egress path when NanoCo settings are present. */
export function registerConfiguredNanoCoSessionSidecar(): ConfiguredNanoCoSessionEgress {
  const dotenv = readEnvFile([...CONFIG_KEYS, 'NANOCO_SESSION_MATERIAL_ROOT']);
  const configured = Object.fromEntries(
    CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || dotenv[key]?.trim() || '']),
  ) as Record<(typeof CONFIG_KEYS)[number], string>;
  if (CONFIG_KEYS.every((key) => !configured[key])) return { configured: false, reapOrphans: () => {} };
  const missing = CONFIG_KEYS.filter((key) => !configured[key]);
  if (missing.length > 0) {
    throw new Error(`NanoCo session egress configuration is incomplete: ${missing.join(', ')}`);
  }
  if (process.env.NANOCO_STATELESS_K8S_HOST?.trim() === '1') {
    return registerStatelessSessionEgress(configured);
  }
  const materialRoot =
    process.env.NANOCO_SESSION_MATERIAL_ROOT?.trim() ||
    dotenv.NANOCO_SESSION_MATERIAL_ROOT?.trim() ||
    path.join(DATA_DIR, 'nanoco-session-channels');
  const provisioner = new GatewaySessionChannelProvisioner({
    deploymentId: configured.NANOCO_DEPLOYMENT_ID,
    controlUrl: configured.NANOCO_GATEWAY_CONTROL_URL,
    controlServerName: configured.NANOCO_GATEWAY_CONTROL_SERVER_NAME,
    gatewayAddress: configured.NANOCO_GATEWAY_ADDRESS,
    gatewayServerName: configured.NANOCO_GATEWAY_SERVER_NAME,
    gatewayCaPath: configured.NANOCO_GATEWAY_CA,
    deploymentCertificatePath: configured.NANOCO_DEPLOYMENT_CERT,
    deploymentPrivateKeyPath: configured.NANOCO_DEPLOYMENT_KEY,
    proxyCaPath: configured.NANOCO_PROXY_CA,
    materialRoot,
  });
  const registration = registerNanoCoSessionSidecar(
    {
      deploymentId: configured.NANOCO_DEPLOYMENT_ID,
      sidecarImage: configured.NANOCO_SIDECAR_IMAGE,
    },
    provisioner,
  );
  return { configured: true, reapOrphans: registration.reapOrphans };
}

/**
 * A control-plane request failure reduced to what is safe for host logs: the
 * HTTP status, the Gateway's short error code, and a transport marker. Response
 * bodies, filesystem paths, and certificate details never reach this object.
 */
export class GatewayControlRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly transport: string | null;

  constructor(detail: { status?: number | null; code?: string | null; transport?: string | null }) {
    super(
      detail.transport
        ? `NanoCo Gateway control request failed at the transport (${detail.transport})`
        : `NanoCo Gateway control request failed with status ${detail.status ?? 0}`,
    );
    this.name = 'GatewayControlRequestError';
    this.status = detail.status ?? null;
    this.code = detail.code ?? null;
    this.transport = detail.transport ?? null;
  }
}

/**
 * The renewal discrimination table, stated against the Gateway's own status
 * mapping (`session_api.rs` / `session_control.rs`).
 *
 * Unrecognized statuses are transient: the caller's retry loop is bounded by
 * the lease window, so a wrong guess costs attempts inside a window that is
 * about to end anyway, and still tears the session down when it does.
 */
export function classifyGatewayRenewalFailure(error: unknown): SessionChannelRenewalError {
  if (error instanceof GatewayControlRequestError) {
    if (error.transport) return transportFailure(error.transport);
    const status = error.status ?? 0;
    if (status === 409) return new SessionChannelRenewalError('stale_version', { status, code: error.code });
    const kind = FATAL_RENEWAL_STATUSES.has(status) ? 'fatal' : 'transient';
    return new SessionChannelRenewalError(kind, { status, code: error.code });
  }
  if (error instanceof SessionChannelRenewalError) return error;
  const transport = transportFailureCode(error);
  if (transport) return transportFailure(transport);
  // Response validation, certificate rotation, ownership checks: retrying a
  // Gateway that answered wrongly does not make the answer right.
  return new SessionChannelRenewalError('fatal');
}

/**
 * Transport failures default to transient — the inverse of the status side, and
 * deliberately so. An unrecognized status means a live Gateway answered oddly;
 * an unrecognized transport code means we could not reach it at all, which is
 * usually the recoverable case. An allowlist would have to predict the
 * substrate: `ENOTFOUND` from a DNS blip during a rollout and `EPROTO` from a
 * port that answers before the process is ready are both transient, and both
 * are exactly what an allowlist written against one substrate would miss. Only
 * trust failures are fatal; the lease window bounds everything else.
 */
function transportFailure(code: string): SessionChannelRenewalError {
  return new SessionChannelRenewalError(FATAL_TLS_CODES.has(code) ? 'fatal' : 'transient', { code });
}

export interface GatewaySessionChannelProvisionerOptions {
  deploymentId: string;
  controlUrl: string;
  controlServerName: string;
  gatewayAddress: string;
  gatewayServerName: string;
  gatewayCaPath: string;
  deploymentCertificatePath: string;
  deploymentPrivateKeyPath: string;
  proxyCaPath: string;
  materialRoot: string;
  opensslBin?: string;
}

interface GatewayProvisionResponse {
  deploymentId: string;
  agentId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  requestCapability?: string;
  certificateSha256: string;
  clientCertificatePem: string;
  leaseExpiresAt: number;
  certificateNotAfter: number;
  leaseVersion: number;
}

export class GatewaySessionChannelProvisioner implements SessionChannelProvisioner {
  readonly #options: Required<GatewaySessionChannelProvisionerOptions>;
  readonly #controlOrigin: URL;
  readonly #ownedDirectories = new Map<string, string>();

  constructor(options: GatewaySessionChannelProvisionerOptions) {
    const controlOrigin = requireControlOrigin(options.controlUrl);
    this.#controlOrigin = controlOrigin;
    this.#options = {
      deploymentId: validateIdentifier('deployment_id', options.deploymentId),
      controlUrl: controlOrigin.origin,
      controlServerName: requireSingleToken(options.controlServerName, 'control server name'),
      gatewayAddress: requireSingleToken(options.gatewayAddress, 'gateway address'),
      gatewayServerName: requireSingleToken(options.gatewayServerName, 'gateway server name'),
      gatewayCaPath: requireAbsolutePath(options.gatewayCaPath, 'gateway CA'),
      deploymentCertificatePath: requireAbsolutePath(options.deploymentCertificatePath, 'deployment certificate'),
      deploymentPrivateKeyPath: requireAbsolutePath(options.deploymentPrivateKeyPath, 'deployment private key'),
      proxyCaPath: requireAbsolutePath(options.proxyCaPath, 'proxy CA'),
      materialRoot: requireAbsolutePath(options.materialRoot, 'session material root'),
      opensslBin: options.opensslBin ?? 'openssl',
    };
  }

  async provision(lineage: SessionChannelLineage): Promise<ProvisionedSessionChannel> {
    this.#requireLineage(lineage);
    if (this.#ownedDirectories.has(lineage.channelId)) {
      throw new Error('NanoCo session channel already has local material');
    }

    fs.mkdirSync(this.#options.materialRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.#options.materialRoot, 0o700);
    const directory = fs.mkdtempSync(path.join(this.#options.materialRoot, `${lineage.channelId}-`));
    fs.chmodSync(directory, 0o700);
    const privateKeyPath = path.join(directory, 'session-key.pem');
    const csrPath = path.join(directory, 'session.csr.pem');
    const certificatePath = path.join(directory, 'session-cert.pem');
    let stage: ConstructorParameters<typeof SessionChannelProvisioningError>[0] = 'key_generation';

    try {
      execFileSync(
        this.#options.opensslBin,
        ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', privateKeyPath],
        { stdio: 'pipe', timeout: REQUEST_TIMEOUT_MS },
      );
      fs.chmodSync(privateKeyPath, 0o600);
      stage = 'csr_generation';
      execFileSync(
        this.#options.opensslBin,
        ['req', '-new', '-key', privateKeyPath, '-subj', '/CN=NanoCo session channel', '-out', csrPath],
        { stdio: 'pipe', timeout: REQUEST_TIMEOUT_MS },
      );
      const csrPem = fs.readFileSync(csrPath, 'utf8');
      stage = 'control_request';
      const response = await this.#provisionRequest({ ...lineage, csrPem });
      stage = 'response_validation';
      const issued = validateGatewayResponse(response, lineage, 1);
      validateCertificateMatchesKey(issued, privateKeyPath);
      stage = 'material_commit';
      fs.writeFileSync(certificatePath, issued.clientCertificatePem, { mode: 0o600 });
      // Both survive for re-adoption, deliberately. The CSR is public-key
      // material (never the key) and the exact bytes the Gateway hashed:
      // `adopt` re-POSTs them so the idempotent read-back matches by
      // construction, not by an argument about signature determinism.
      // `lineage.json` is the five identifiers and nothing else, so a
      // successor host can map a session back to its channel without a seam
      // change. The directory stays 0700; both files are 0600.
      fs.chmodSync(csrPath, 0o600);
      fs.writeFileSync(path.join(directory, 'lineage.json'), `${JSON.stringify(lineage, null, 2)}\n`, {
        mode: 0o600,
      });
      this.#ownedDirectories.set(lineage.channelId, directory);

      return this.#channel(
        issued,
        new SessionChannelMaterials({
          gatewayCaPath: this.#options.gatewayCaPath,
          clientCertificatePath: certificatePath,
          clientPrivateKeyPath: privateKeyPath,
          proxyCaPath: this.#options.proxyCaPath,
        }),
      );
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      // Never propagate OpenSSL arguments, CSR data, response bodies, or key paths.
      const control = error instanceof GatewayControlRequestError ? error : null;
      throw new SessionChannelProvisioningError(stage, {
        status: control?.status,
        code: control?.code,
        transport: control?.transport ?? transportFailureCode(error),
      });
    }
  }

  /**
   * Provision is idempotent for the same lineage + CSR, so short control-plane
   * outages can be absorbed here instead of waiting for the Host's minute
   * sweep. Retry only transport and 5xx failures; identity conflicts and every
   * other answered refusal return immediately.
   */
  async #provisionRequest(body: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#jsonRequest('POST', '/v1/session-channels', body, 201);
      } catch (error) {
        const control = error instanceof GatewayControlRequestError ? error : null;
        const retryable = !!control && (!!control.transport || (control.status !== null && control.status >= 500));
        if (!retryable || attempt >= PROVISION_ATTEMPTS) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, PROVISION_RETRY_BASE_MS * attempt));
      }
    }
  }

  /**
   * Reconstruct a channel a previous host process provisioned, and take
   * ownership of its material — the D4-mandated deliberate widening of the
   * ownership invariant, stated as a rule: adoption is legitimate exactly when
   * this install's 0700 material root holds the private key and the exact CSR
   * the Gateway hashed, AND the Gateway confirms the same five-field identity
   * with that CSR against an Active channel. The confirmation rides the
   * provision endpoint's idempotent read-back: an identical identity plus an
   * identical CSR sha256 returns the stored lease at its CURRENT version; a
   * revoked or mismatched channel answers 409 `channel_conflict`, so a
   * revoked-lease adoption fails closed with nothing seeded.
   *
   * `#requireOwnedChannel` is never bypassed — this seeds the map it checks,
   * and every later renew/revoke/release passes through it unchanged.
   */
  async adopt(lineage: SessionChannelLineage): Promise<ProvisionedSessionChannel> {
    this.#requireLineage(lineage);
    if (this.#ownedDirectories.has(lineage.channelId)) {
      throw new Error('NanoCo session channel is already owned by this provisioner');
    }
    const directory = this.#findMaterialDirectory(lineage.channelId);
    const privateKeyPath = path.join(directory, 'session-key.pem');
    const certificatePath = path.join(directory, 'session-cert.pem');
    let csrPem: string;
    try {
      csrPem = fs.readFileSync(path.join(directory, 'session.csr.pem'), 'utf8');
    } catch {
      // Pre-persistence material (or a partial write): nothing to re-POST, so
      // the read-back cannot be attempted. Path detail stays out of the error.
      throw new Error('NanoCo session channel material has no persisted CSR to adopt with');
    }
    const response = await this.#jsonRequest('POST', '/v1/session-channels', { ...lineage, csrPem }, 201);
    // Idempotent read-back returns the stored lease. After a Host restart that
    // five-minute lease may already be over while the one-day certificate is
    // still valid. Accept that one narrow shape, seed ordinary ownership, and
    // immediately renew through the normal version-checked path below.
    const issued = validateGatewayResponse(response, lineage, 1, { allowExpiredLease: true });
    validateCertificateMatchesKey(issued, privateKeyPath);
    if (issued.clientCertificatePem !== fs.readFileSync(certificatePath, 'utf8')) {
      throw new Error('NanoCo Gateway returned a different certificate than the adopted material holds');
    }
    this.#ownedDirectories.set(lineage.channelId, directory);
    const adopted = this.#channel(
      issued,
      new SessionChannelMaterials({
        gatewayCaPath: this.#options.gatewayCaPath,
        clientCertificatePath: certificatePath,
        clientPrivateKeyPath: privateKeyPath,
        proxyCaPath: this.#options.proxyCaPath,
      }),
    );
    try {
      return issued.leaseExpiresAt <= Math.floor(Date.now() / 1000)
        ? await this.renew(adopted)
        : adopted;
    } catch (error) {
      // A failed immediate renewal must be retryable by the next adoption
      // pass. Keep the on-disk material, but do not leave this process holding
      // an ownership claim for a channel it never returned.
      this.#ownedDirectories.delete(lineage.channelId);
      throw error;
    }
  }

  /**
   * Map a session back to the lineage `provision` persisted beside its
   * material, if exactly that survives on disk. Corrupt or foreign entries are
   * skipped, never thrown on: adoption is opportunistic by design.
   */
  findAdoptableLineage(sessionId: string): SessionChannelLineage | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#options.materialRoot);
    } catch {
      return null;
    }
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(this.#options.materialRoot, entry, 'lineage.json'), 'utf8'),
        ) as Partial<SessionChannelLineage>;
        if (parsed.sessionId !== sessionId) continue;
        const lineage: SessionChannelLineage = {
          deploymentId: validateIdentifier('deployment_id', parsed.deploymentId ?? ''),
          agentId: validateIdentifier('agent_id', parsed.agentId ?? ''),
          sessionId: validateIdentifier('session_id', parsed.sessionId),
          containerInstanceId: validateIdentifier('container_instance_id', parsed.containerInstanceId ?? ''),
          channelId: validateIdentifier('channel_id', parsed.channelId ?? ''),
          ...(parsed.requestCapability
            ? { requestCapability: validateRequestCapability(parsed.requestCapability) }
            : {}),
        };
        if (lineage.deploymentId !== this.#options.deploymentId) continue;
        if (!entry.startsWith(`${lineage.channelId}-`)) continue;
        return lineage;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Exactly one `${materialRoot}/${channelId}-*` directory, or refuse. */
  #findMaterialDirectory(channelId: string): string {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#options.materialRoot);
    } catch {
      throw new Error('NanoCo session material root is not readable');
    }
    const matches = entries.filter((entry) => entry.startsWith(`${channelId}-`));
    if (matches.length !== 1) {
      throw new Error(`NanoCo session channel material is ${matches.length === 0 ? 'absent' : 'ambiguous'} on disk`);
    }
    return path.join(this.#options.materialRoot, matches[0]);
  }

  async renew(channel: ProvisionedSessionChannel): Promise<ProvisionedSessionChannel> {
    this.#requireOwnedChannel(channel);
    try {
      return await this.#renewAt(channel, channel.leaseVersion);
    } catch (error) {
      const failure = classifyGatewayRenewalFailure(error);
      if (failure.kind !== 'stale_version') throw failure;
      // Renewal is a compare-and-swap with no read-back endpoint. A stale
      // version means the swap already committed and its response was lost —
      // the Gateway was killed between the UPDATE and the reply. Exactly one
      // host owns one channel, so the version the server holds is the next one.
      // That inference is what makes a single retry safe here; it does not
      // survive multiple host replicas sharing a channel (deployment doc
      // D6/D10), where a read-back endpoint would be required instead.
      log.warn('NanoCo session channel lease renewal hit a stale version, retrying at the next version', {
        sessionId: channel.lineage.sessionId,
        channelId: channel.lineage.channelId,
        leaseVersion: channel.leaseVersion,
      });
      const retried = await this.#renewAt(channel, channel.leaseVersion + 1).catch((retryError: unknown) => {
        const retryFailure = classifyGatewayRenewalFailure(retryError);
        // A second stale version usually means another owner moved the channel.
        // It can also be a second lost response inside one window — commit then
        // die, twice — which this gives up on rather than walking the version
        // forward indefinitely. Improbable and accepted: the cost is a session
        // that, before this retry existed, the first failure would have killed.
        throw retryFailure.kind === 'stale_version'
          ? new SessionChannelRenewalError('fatal', { status: retryFailure.status, code: retryFailure.code })
          : retryFailure;
      });
      return retried;
    }
  }

  async #renewAt(channel: ProvisionedSessionChannel, expectedLeaseVersion: number): Promise<ProvisionedSessionChannel> {
    const response = await this.#jsonRequest(
      'POST',
      `/v1/session-channels/${channel.lineage.channelId}/renew`,
      { expectedLeaseVersion },
      200,
    );
    const renewed = validateGatewayResponse(response, channel.lineage, expectedLeaseVersion + 1);
    const currentCertificate = fs.readFileSync(channel.materials.clientCertificatePath(), 'utf8');
    if (renewed.clientCertificatePem !== currentCertificate) {
      throw new Error('NanoCo Gateway rotated a certificate during lease-only renewal');
    }
    return this.#channel(renewed, channel.materials);
  }

  async revoke(channel: ProvisionedSessionChannel, _reason: string): Promise<void> {
    this.#requireOwnedChannel(channel);
    await this.#jsonRequest('DELETE', `/v1/session-channels/${channel.lineage.channelId}`, undefined, 204);
  }

  async release(channel: ProvisionedSessionChannel): Promise<void> {
    const directory = this.#ownedDirectories.get(channel.lineage.channelId);
    if (!directory) return;
    this.#requireOwnedChannel(channel);
    this.#ownedDirectories.delete(channel.lineage.channelId);
    fs.rmSync(directory, { recursive: true, force: true });
  }

  toJSON(): string {
    return 'GatewaySessionChannelProvisioner([redacted])';
  }

  [inspect.custom](): string {
    return 'GatewaySessionChannelProvisioner([redacted])';
  }

  #channel(response: GatewayProvisionResponse, materials: SessionChannelMaterials): ProvisionedSessionChannel {
    return {
      lineage: responseLineage(response),
      gatewayAddress: this.#options.gatewayAddress,
      gatewayServerName: this.#options.gatewayServerName,
      expiresAt: new Date(response.leaseExpiresAt * 1000).toISOString(),
      certificateNotAfter: new Date(response.certificateNotAfter * 1000).toISOString(),
      leaseVersion: response.leaseVersion,
      materials,
    };
  }

  #requireLineage(lineage: SessionChannelLineage): void {
    if (lineage.deploymentId !== this.#options.deploymentId) {
      throw new Error('NanoCo session lineage does not belong to this deployment');
    }
    if (lineage.requestCapability !== undefined) {
      validateRequestCapability(lineage.requestCapability);
    }
    for (const [name, value] of Object.entries(lineage)) {
      validateIdentifier(name, value);
    }
  }

  #requireOwnedChannel(channel: ProvisionedSessionChannel): void {
    this.#requireLineage(channel.lineage);
    const directory = this.#ownedDirectories.get(channel.lineage.channelId);
    if (!directory) throw new Error('NanoCo session material is not owned by this provisioner');
    if (
      path.dirname(channel.materials.clientPrivateKeyPath()) !== directory ||
      path.dirname(channel.materials.clientCertificatePath()) !== directory
    ) {
      throw new Error('NanoCo session material path changed after provisioning');
    }
  }

  #jsonRequest(method: string, pathname: string, body: unknown, expectedStatus: number): Promise<unknown> {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = https.request(
        new URL(pathname, this.#controlOrigin),
        {
          method,
          ca: fs.readFileSync(this.#options.gatewayCaPath),
          cert: fs.readFileSync(this.#options.deploymentCertificatePath),
          key: fs.readFileSync(this.#options.deploymentPrivateKeyPath),
          servername: this.#options.controlServerName,
          headers:
            body === undefined
              ? undefined
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': payload.length,
                },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > RESPONSE_LIMIT_BYTES) {
              request.destroy(new Error('NanoCo Gateway response exceeded the limit'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== expectedStatus) {
              reject(
                new GatewayControlRequestError({
                  status: response.statusCode ?? 0,
                  code: parseGatewayErrorCode(Buffer.concat(chunks)),
                }),
              );
              return;
            }
            if (expectedStatus === 204) {
              resolve(undefined);
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new Error('NanoCo Gateway returned invalid JSON'));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new GatewayControlRequestError({ transport: 'timeout' })));
      request.on('error', (error: unknown) => {
        if (error instanceof GatewayControlRequestError) {
          reject(error);
          return;
        }
        const transport = transportFailureCode(error);
        reject(transport ? new GatewayControlRequestError({ transport }) : error);
      });
      request.end(payload);
    });
  }
}

/** Only the Gateway's own short error code survives; the body never does. */
function parseGatewayErrorCode(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { error?: unknown };
    const code = parsed?.error;
    return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/** Node surfaces transport failures as an upper-snake `code`; the shape guard keeps logs low-cardinality. */
function transportFailureCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

function validateGatewayResponse(
  value: unknown,
  expected: SessionChannelLineage,
  minimumLeaseVersion: number,
  options: { allowExpiredLease?: boolean } = {},
): GatewayProvisionResponse {
  if (!value || typeof value !== 'object') throw new Error('Gateway response is not an object');
  const response = value as Partial<GatewayProvisionResponse>;
  const actual = responseLineage(response);
  for (const key of Object.keys(expected) as Array<keyof SessionChannelLineage>) {
    if (actual[key] !== expected[key]) throw new Error(`Gateway changed ${key}`);
  }
  if (actual.requestCapability !== expected.requestCapability) {
    throw new Error('Gateway changed requestCapability');
  }
  if (!/^[0-9a-f]{64}$/i.test(response.certificateSha256 ?? '')) {
    throw new Error('Gateway returned an invalid certificate fingerprint');
  }
  if (
    typeof response.clientCertificatePem !== 'string' ||
    response.clientCertificatePem.length > RESPONSE_LIMIT_BYTES
  ) {
    throw new Error('Gateway returned an invalid client certificate');
  }
  // A minimum, not an equality: a renewal whose response was lost still moved
  // the server's version forward, so the recovery attempt legitimately lands
  // above the requested one. Lease expiry stays the strict check below.
  if (!Number.isSafeInteger(response.leaseVersion) || response.leaseVersion! < minimumLeaseVersion) {
    throw new Error('Gateway returned an invalid lease version');
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(response.leaseExpiresAt) ||
    !Number.isSafeInteger(response.certificateNotAfter) ||
    response.certificateNotAfter! <= now ||
    (!options.allowExpiredLease && response.leaseExpiresAt! <= now) ||
    response.leaseExpiresAt! > response.certificateNotAfter!
  ) {
    throw new Error('Gateway returned invalid session expiry');
  }
  return response as GatewayProvisionResponse;
}

function responseLineage(response: Partial<GatewayProvisionResponse>): SessionChannelLineage {
  const lineage: SessionChannelLineage = {
    deploymentId: response.deploymentId as string,
    agentId: response.agentId as string,
    sessionId: response.sessionId as string,
    containerInstanceId: response.containerInstanceId as string,
    channelId: response.channelId as string,
    ...(response.requestCapability
      ? { requestCapability: validateRequestCapability(response.requestCapability) }
      : {}),
  };
  for (const [name, value] of Object.entries(lineage)) {
    if (typeof value !== 'string') throw new Error(`Gateway response omitted ${name}`);
    validateIdentifier(name, value);
  }
  return lineage as SessionChannelLineage;
}

function validateCertificateMatchesKey(response: GatewayProvisionResponse, privateKeyPath: string): void {
  const certificate = new X509Certificate(response.clientCertificatePem);
  const privateKey = createPrivateKey(fs.readFileSync(privateKeyPath));
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error('Gateway certificate does not match the generated session key');
  }
  if (Date.parse(certificate.validTo) / 1000 < response.certificateNotAfter) {
    throw new Error('Gateway certificate expiry does not cover the claimed lifetime');
  }
}

function requireControlOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('NanoCo Gateway control URL must be an HTTPS origin');
  }
  return url;
}

function validateIdentifier(label: string, value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > IDENTIFIER_MAX_BYTES || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${label} is not a safe identifier`);
  }
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} path must be absolute`);
  }
  return value;
}

function requireSingleToken(value: string, label: string): string {
  if (!value || /\s/.test(value)) throw new Error(`${label} is missing or contains whitespace`);
  return value;
}
