import { execFileSync } from 'node:child_process';

try {
  // Inspect the daemon, which may be remote or run in a VM. The workstation's
  // process.arch does not identify the platform that will run these containers.
  const info = JSON.parse(
    execFileSync('docker', ['info', '--format', '{{json .}}'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  // The pinned 11.10.0 image publishes only linux/amd64 (plus provenance).
  if (info.OSType !== 'linux' || !['amd64', 'x86_64'].includes(info.Architecture)) {
    throw new Error('unsupported platform');
  }
  execFileSync('docker', ['compose', 'version'], { timeout: 15_000, stdio: 'ignore' });
} catch {
  console.error(
    'The bundled Mattermost evaluation server requires a Linux AMD64 Docker daemon and Docker Compose. No local resources were created. On ARM64, select an existing Mattermost server or use an AMD64 Docker host; NanoClaw can connect to that server from ARM64.',
  );
  process.exitCode = 1;
}
