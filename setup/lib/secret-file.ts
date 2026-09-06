import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Run an operation with a private one-use secret file, then remove it. */
export async function withSecretFile<T>(secret: string, operation: (filePath: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-secret-'));
  const filePath = path.join(directory, 'value');
  let fd: number | undefined;

  try {
    fs.chmodSync(directory, 0o700);
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, secret, { encoding: 'utf8' });
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = undefined;
    return await operation(filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(filePath, { force: true });
    fs.rmdirSync(directory);
  }
}

export function childEnvWithoutSetupSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe = { ...env };
  for (const key of [
    'NANOCLAW_ANTHROPIC_AUTH_TOKEN',
    'NANOCLAW_ONECLI_API_TOKEN',
    'NANOCLAW_REGISTRY_ENROLL_CODE',
    'NANOCLAW_REGISTRY_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ONECLI_API_KEY',
  ])
    delete safe[key];
  return safe;
}
