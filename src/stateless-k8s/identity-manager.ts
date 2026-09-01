import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

interface IssuedChannel {
  deploymentId: string;
  agentId: string;
  sessionId: string;
  containerInstanceId: string;
  channelId: string;
  clientCertificatePem: string;
  leaseExpiresAt: number;
  certificateNotAfter: number;
  leaseVersion: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const origin = new URL(required('NANOCO_IDENTITY_CLAIM_URL'));
  if (origin.protocol !== 'https:' || origin.pathname !== '/') throw new Error('claim URL must be an HTTPS origin');
  const servername = required('NANOCO_IDENTITY_SERVER_NAME');
  const ca = fs.readFileSync(required('NANOCO_IDENTITY_GATEWAY_CA'));
  const claimFile = process.env.NANOCO_IDENTITY_CLAIM_FILE?.trim();
  const claim = claimFile ? fs.readFileSync(claimFile, 'utf8').trim() : required('NANOCO_IDENTITY_CLAIM');
  if (!claim || /\s/.test(claim)) throw new Error('invalid Gateway identity claim');
  const directory = required('NANOCO_IDENTITY_DIR');
  const expected = {
    deploymentId: required('NANOCO_IDENTITY_DEPLOYMENT_ID'),
    agentId: required('NANOCO_IDENTITY_AGENT_ID'),
    sessionId: required('NANOCO_IDENTITY_SESSION_ID'),
    containerInstanceId: required('NANOCO_IDENTITY_CONTAINER_INSTANCE_ID'),
    channelId: required('NANOCO_IDENTITY_CHANNEL_ID'),
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // On Kubernetes this directory IS the mount root of a pod-private tmpfs
  // `emptyDir`, created by kubelet and owned by uid 0. `fsGroup` makes it
  // group-writable for the run-as identity but does not transfer ownership, and
  // chmod demands ownership (or CAP_FOWNER), so the hardening call that is
  // correct on a host filesystem fails here with `EPERM: operation not
  // permitted, chmod '/run/nanoco/identity'` and takes the session with it.
  //
  // Enforce the mode where we own the directory, and treat EPERM as acceptable
  // where we do not: confidentiality here rests on the volume MOUNT LIST — only
  // this container and the egress sidecar mount it, never the agent — plus the
  // 0600 modes on the key, CSR, certificate and lease written below. Granting
  // CAP_FOWNER instead would buy the directory bit by handing extra privilege
  // to the one container that handles the session private key.
  try {
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EPERM') throw error;
  }
  const keyPath = path.join(directory, 'session-key.pem');
  const csrPath = path.join(directory, 'session.csr.pem');
  const certPath = path.join(directory, 'session-cert.pem');
  const statePath = path.join(directory, 'lease.json');
  if (!fs.existsSync(keyPath)) {
    execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', keyPath], { stdio: 'ignore' });
    fs.chmodSync(keyPath, 0o600);
  }
  execFileSync('openssl', ['req', '-new', '-key', keyPath, '-subj', '/CN=NanoCo session channel', '-out', csrPath], { stdio: 'ignore' });
  const issued = validateIssued(await postJson(origin, servername, ca, '/v1/session-channel-claims/redeem', {
    claim,
    csrPem: fs.readFileSync(csrPath, 'utf8'),
  }), expected);
  commit(certPath, statePath, issued);

  let current = issued;
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await postJson(origin, servername, ca, '/v1/session-channel-claims/revoke', { claim });
    } catch {
      // The certificate and claim are bounded; pod teardown must not hang on Gateway reachability.
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());

  while (!stopping) {
    const delay = Math.max(1_000, Math.floor((current.leaseExpiresAt * 1_000 - Date.now()) / 2));
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (stopping) break;
    current = validateIssued(await postJson(origin, servername, ca, '/v1/session-channel-claims/renew', {
      claim,
      expectedLeaseVersion: current.leaseVersion,
    }), expected);
    commit(certPath, statePath, current);
  }
}

function validateIssued(value: unknown, expected: Record<string, string>): IssuedChannel {
  if (!value || typeof value !== 'object') throw new Error('invalid Gateway identity response');
  const issued = value as IssuedChannel;
  for (const [key, expectedValue] of Object.entries(expected)) {
    if ((issued as unknown as Record<string, unknown>)[key] !== expectedValue) throw new Error(`Gateway changed ${key}`);
  }
  if (!issued.clientCertificatePem?.includes('BEGIN CERTIFICATE')) throw new Error('Gateway returned no certificate');
  if (!Number.isSafeInteger(issued.leaseVersion) || issued.leaseVersion < 1) throw new Error('Gateway returned an invalid lease');
  if (!Number.isSafeInteger(issued.leaseExpiresAt) || issued.leaseExpiresAt * 1_000 <= Date.now()) throw new Error('Gateway returned an expired lease');
  return issued;
}

function commit(certPath: string, statePath: string, issued: IssuedChannel): void {
  const certNext = `${certPath}.next`;
  fs.writeFileSync(certNext, issued.clientCertificatePem, { mode: 0o600 });
  fs.renameSync(certNext, certPath);
  const stateNext = `${statePath}.next`;
  fs.writeFileSync(stateNext, JSON.stringify({ leaseVersion: issued.leaseVersion, leaseExpiresAt: issued.leaseExpiresAt }), { mode: 0o600 });
  fs.renameSync(stateNext, statePath);
}

async function postJson(origin: URL, servername: string, ca: Buffer, requestPath: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(requestPath, origin), {
      method: 'POST',
      servername,
      ca,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: 10_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Gateway identity request failed (${response.statusCode ?? 0})`));
          return;
        }
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Gateway identity request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

void main().catch((error) => {
  console.error(`identity manager failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
