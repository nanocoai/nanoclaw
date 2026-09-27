import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getInstallSlug } from '../../../../src/install-slug.js';
import { LABELS } from '../../../../src/drivers/types.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';
import { installStep, installCommand, InstallCommandFailure } from './install-command.js';
import { buildManagedProxy, hasFrontProxy } from './build-managed-proxy.js';
import { controlPaths, installControl, removeControl, storeModelCredential } from './control.js';
import { readAllowedHostsFile, validateAllowedHost } from '../payload/src/gateway-providers/iron-proxy-allowlist.js';

const pins = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'versions.json'), 'utf8'),
) as Record<string, string>;
let IMAGE = '';

function readProjectEnv(projectRoot: string): Record<string, string> {
  const file = path.join(projectRoot, '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

export function statePaths(projectRoot = process.cwd()) {
  const env = readProjectEnv(projectRoot);
  const materialRoot =
    process.env.NANOCLAW_SESSION_MATERIAL_ROOT ||
    env.NANOCLAW_SESSION_MATERIAL_ROOT ||
    path.join(projectRoot, 'data', 'session-materials');
  const root = path.join(materialRoot, 'iron-proxy');
  const shared = path.join(root, 'shared');
  const approvalDir = path.join(root, 'approval');
  return {
    materialRoot,
    root,
    shared,
    approvalDir,
    approvalSocket: path.join(os.tmpdir(), `nanoclaw-iron-socket-${getInstallSlug(projectRoot)}`, 'approval.sock'),
    caCert: path.join(shared, 'ca.crt'),
    caKey: path.join(shared, 'ca.key'),
    secretFile: path.join(shared, 'upstream-secret'),
    configFile: path.join(shared, 'config.yaml'),
    frontConfigFile: path.join(shared, 'front.json'),
    identityKey: path.join(shared, 'workload-identity.key'),
    allowedHosts: path.join(shared, 'allowed-hosts.json'),
    agentCaCert: path.join(projectRoot, 'data', 'gateway-trust', 'iron-proxy', 'ca.crt'),
    containerName: `nanoclaw-iron-proxy-${getInstallSlug(projectRoot)}`,
  };
}

export function readAllowedHosts(projectRoot: string): string[] {
  return readAllowedHostsFile(statePaths(projectRoot).allowedHosts);
}

function writeAllowedHosts(hosts: readonly string[], projectRoot: string): void {
  const file = statePaths(projectRoot).allowedHosts;
  fs.writeFileSync(file, `${JSON.stringify([...new Set(hosts.map(validateAllowedHost))].sort(), null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

async function docker(args: string[], stdout = false): Promise<string> {
  return installCommand('docker', args, {
    label: `Iron Proxy: Docker ${args[0]}`,
    timeoutMs: 180_000,
    capture: stdout,
    failureHint: 'Check Docker and access to the pinned image, then retry.',
  });
}

async function ensureCA(projectRoot: string): Promise<void> {
  const paths = statePaths(projectRoot);
  const hasCert = fs.existsSync(paths.caCert);
  const hasKey = fs.existsSync(paths.caKey);
  if (hasCert !== hasKey) throw new Error(`Iron Proxy CA is incomplete under ${paths.shared}`);
  if (!hasCert) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    await docker([
      'run',
      '--rm',
      ...(uid == null ? [] : ['--user', `${uid}:${gid ?? uid}`]),
      '-v',
      `${paths.shared}:/out`,
      IMAGE,
      'generate-ca',
      '-outdir',
      '/out',
      '-name',
      `NanoClaw Iron Proxy ${getInstallSlug(projectRoot)}`,
      '-expiry-hours',
      '87600',
    ]);
  }
  fs.chmodSync(paths.caCert, 0o644);
  fs.chmodSync(paths.caKey, 0o600);
  fs.mkdirSync(path.dirname(paths.agentCaCert), { recursive: true });
  fs.copyFileSync(paths.caCert, paths.agentCaCert);
  fs.chmodSync(paths.agentCaCert, 0o644);
}

function ensureIdentityKey(projectRoot: string): void {
  const file = statePaths(projectRoot).identityKey;
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32), { mode: 0o600 });
  if (fs.statSync(file).size < 32) throw new Error(`Iron Proxy identity key is invalid: ${file}`);
  fs.chmodSync(file, 0o600);
}

export function centralHostGatewayArgs(platform = process.platform): string[] {
  return platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : [];
}

export function centralInstallLabel(projectRoot = process.cwd()): string {
  return `nanoclaw-install=${getInstallSlug(projectRoot)}`;
}

async function startCentralProxy(projectRoot: string): Promise<void> {
  IMAGE = readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_IMAGE || IMAGE;
  const managed = !!readProjectEnv(projectRoot).NANOCLAW_IRON_CONTROL_URL;
  const paths = statePaths(projectRoot);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  try {
    await docker(['rm', '-f', paths.containerName]);
  } catch (error) {
    if (error instanceof InstallCommandFailure && error.interrupted) throw error;
    // First install has no previous provider-owned container.
  }
  await docker([
    'run',
    '-d',
    '--name',
    paths.containerName,
    ...(managed
      ? ['--network', controlPaths(projectRoot).network, '--env-file', controlPaths(projectRoot).proxyEnvironment]
      : []),
    '--label',
    centralInstallLabel(projectRoot),
    '--label',
    `${LABELS.role}=gateway`,
    ...(uid == null ? [] : ['--user', `${uid}:${gid ?? uid}`]),
    ...centralHostGatewayArgs(),
    '--restart',
    'unless-stopped',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '-v',
    `${paths.configFile}:/etc/iron-proxy/config.yaml:ro`,
    '-v',
    `${paths.frontConfigFile}:/etc/iron-proxy/front.json:ro`,
    '-v',
    `${paths.caCert}:/etc/iron-proxy/ca.crt:ro`,
    '-v',
    `${paths.caKey}:/etc/iron-proxy/ca.key:ro`,
    ...(managed ? [] : ['-v', `${paths.secretFile}:/run/secrets/upstream:ro`]),
    '-v',
    `${paths.identityKey}:/run/secrets/workload-identity-key:ro`,
    '-v',
    `${paths.approvalDir}:/run/nanoclaw-gateway:ro`,
    ...(process.platform === 'darwin'
      ? [
          '-v',
          `${path.join(paths.shared, 'approval-client.crt')}:/run/secrets/approval-client.crt:ro`,
          '-v',
          `${path.join(paths.shared, 'approval-client.key')}:/run/secrets/approval-client.key:ro`,
        ]
      : []),
    IMAGE,
    '-config',
    '/etc/iron-proxy/config.yaml',
  ]);
}

export async function configureCredential(
  credential: { secret: string; authEnv: string; modelHost: string; baseUrl?: string },
  projectRoot = process.cwd(),
): Promise<void> {
  if (!['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(credential.authEnv)) {
    throw new Error(`Unsupported Iron Proxy auth env: ${credential.authEnv}`);
  }
  if (!credential.secret || /[\r\n]/.test(credential.secret)) throw new Error('Credential must be one non-empty line');
  const paths = statePaths(projectRoot);
  if (readProjectEnv(projectRoot).NANOCLAW_IRON_CONTROL_URL) {
    await storeModelCredential(credential.secret, credential.modelHost, projectRoot, credential.authEnv);
  } else {
    fs.writeFileSync(paths.secretFile, credential.secret, { mode: 0o600 });
    fs.chmodSync(paths.secretFile, 0o600);
  }
  upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', credential.authEnv, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_MODEL_HOST', validateAllowedHost(credential.modelHost), projectRoot);
  if (credential.baseUrl) upsertEnvVar('ANTHROPIC_BASE_URL', credential.baseUrl, projectRoot);
}

export async function run(args: string[], projectRoot = process.cwd()): Promise<void> {
  if (args.includes('--remove')) {
    try {
      await docker(['rm', '-f', statePaths(projectRoot).containerName]);
    } catch (error) {
      if (error instanceof InstallCommandFailure && error.interrupted) throw error;
      // Already absent is the desired removal state.
    }
    await removeControl(projectRoot);
    return;
  }
  const managed = args.includes('--with-control') || !!readProjectEnv(projectRoot).NANOCLAW_IRON_CONTROL_URL;
  const localIndex = args.indexOf('--local-image');
  if (managed || localIndex < 0) {
    IMAGE = await buildManagedProxy();
    if (managed) await installControl(projectRoot);
    upsertEnvVar('NANOCLAW_IRON_PROXY_IMAGE', IMAGE, projectRoot);
  }
  const localImage = localIndex >= 0 ? args[localIndex + 1] : readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_IMAGE;
  if (localImage && (localIndex >= 0 || localImage.startsWith('sha256:'))) {
    const inspected = JSON.parse(await docker(['image', 'inspect', localImage], true))[0];
    if (inspected.Config.Labels?.['org.opencontainers.image.revision'] !== pins['iron-proxy-commit']) {
      throw new Error('Local image was not built from the pinned Iron Proxy commit');
    }
    if (!hasFrontProxy(inspected)) throw new Error('Iron Proxy requires the bundled NanoClaw approval front proxy');
    IMAGE = inspected.Id;
  }
  if (
    !/^sha256:[0-9a-f]{64}$/.test(IMAGE) &&
    !/^ghcr\.io\/[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(IMAGE)
  ) {
    throw new Error('Iron Proxy skill does not contain an exact image digest');
  }
  const paths = statePaths(projectRoot);
  fs.mkdirSync(paths.shared, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.approvalDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.shared, 0o700);
  fs.chmodSync(paths.approvalDir, 0o700);
  const allowIndex = args.indexOf('--allow-host');
  const allowed = readAllowedHosts(projectRoot);
  if (allowIndex >= 0) {
    if (!args[allowIndex + 1]) throw new Error('--allow-host requires a hostname or *.domain');
    allowed.push(validateAllowedHost(args[allowIndex + 1]));
  }
  writeAllowedHosts(allowed, projectRoot);
  if (!IMAGE.startsWith('sha256:')) await docker(['pull', IMAGE]);
  await ensureCA(projectRoot);
  ensureIdentityKey(projectRoot);
  if (process.platform === 'darwin') {
    const port =
      readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_APPROVAL_PORT ||
      String(19000 + (parseInt(getInstallSlug(projectRoot), 16) % 10000));
    upsertEnvVar('NANOCLAW_IRON_PROXY_APPROVAL_PORT', port, projectRoot);
    for (const name of ['server', 'client']) {
      const base = path.join(paths.shared, `approval-${name}`);
      if (fs.existsSync(`${base}.crt`) && fs.existsSync(`${base}.key`)) continue;
      const extensions = `${base}.ext`;
      fs.writeFileSync(
        extensions,
        `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\nsubjectAltName=DNS:host.docker.internal,IP:127.0.0.1\n`,
      );
      execFileSync(
        'openssl',
        [
          'req',
          '-new',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          `${base}.key`,
          '-out',
          `${base}.csr`,
          '-subj',
          `/CN=NanoClaw Approval ${name}`,
        ],
        { stdio: 'ignore', timeout: 30_000 },
      );
      fs.chmodSync(`${base}.key`, 0o600);
      execFileSync(
        'openssl',
        [
          'x509',
          '-req',
          '-in',
          `${base}.csr`,
          '-CA',
          paths.caCert,
          '-CAkey',
          paths.caKey,
          '-set_serial',
          name === 'server' ? '11' : '12',
          '-out',
          `${base}.crt`,
          '-days',
          '365',
          '-extfile',
          extensions,
        ],
        { stdio: 'ignore', timeout: 30_000 },
      );
      fs.rmSync(`${base}.csr`);
      fs.rmSync(extensions);
    }
  }
  if (!fs.existsSync(paths.secretFile)) fs.writeFileSync(paths.secretFile, 'not-configured', { mode: 0o600 });
  fs.chmodSync(paths.secretFile, 0o600);

  upsertEnvVar('NANOCLAW_IRON_PROXY_IMAGE', IMAGE, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CA_CERT', paths.caCert, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CA_KEY', paths.caKey, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_SECRET_FILE', paths.secretFile, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CONFIG_FILE', paths.configFile, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_IDENTITY_KEY', paths.identityKey, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_CONTAINER', paths.containerName, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_APPROVAL_SOCKET', paths.approvalSocket, projectRoot);
  upsertEnvVar('NANOCLAW_IRON_PROXY_ALLOWED_HOSTS', paths.allowedHosts, projectRoot);
  upsertEnvVar('NANOCLAW_EGRESS_LOCKDOWN', 'true', projectRoot);
  if (!readProjectEnv(projectRoot).NANOCLAW_EGRESS_NETWORK) {
    upsertEnvVar('NANOCLAW_EGRESS_NETWORK', `nanoclaw-egress-${getInstallSlug(projectRoot)}`, projectRoot);
  }
  if (!readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_AUTH_ENV) {
    upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', 'ANTHROPIC_API_KEY', projectRoot);
  }
  if (!readProjectEnv(projectRoot).NANOCLAW_IRON_PROXY_MODEL_HOST) {
    upsertEnvVar(
      'NANOCLAW_IRON_PROXY_MODEL_HOST',
      new URL(getProviderModelEndpoint('claude', 'api')).hostname,
      projectRoot,
    );
  }
  const provider = await import('../../../../src/gateway-providers/iron-proxy.js');
  const settings = provider.readIronProxySettings(process.env, projectRoot);
  if (managed) {
    const existingSecret = fs.readFileSync(paths.secretFile, 'utf8').trim();
    if (existingSecret && existingSecret !== 'not-configured') {
      await storeModelCredential(existingSecret, settings.modelHost, projectRoot, settings.authEnv);
      fs.writeFileSync(paths.secretFile, 'not-configured', { mode: 0o600 });
    }
  }
  fs.writeFileSync(paths.configFile, provider.ironProxyConfig(settings), { mode: 0o600 });
  fs.chmodSync(paths.configFile, 0o600);
  fs.writeFileSync(paths.frontConfigFile, provider.ironFrontConfig(settings), { mode: 0o600 });
  fs.chmodSync(paths.frontConfigFile, 0o600);
  await startCentralProxy(projectRoot);
  console.log(`Central Iron Proxy ${pins['iron-proxy-commit']} is ready.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void installStep(() => run(process.argv.slice(2))).then((ok) => {
    if (!ok) process.exitCode = 1;
  });
}
