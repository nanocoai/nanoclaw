import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';

const LOCK_DIR = '/workspace/agent/.nanoco-materialize.lock.d';

export async function withWorkspaceDirectoryLock<T>(
  lockDir: string,
  operation: () => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`workspace materializer lock timed out: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function runMaterializer(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit' });
    const terminate = (): void => { child.kill('SIGTERM'); };
    const interrupt = (): void => { child.kill('SIGINT'); };
    process.once('SIGTERM', terminate);
    process.once('SIGINT', interrupt);
    child.once('error', reject);
    child.once('close', (code) => {
      process.off('SIGTERM', terminate);
      process.off('SIGINT', interrupt);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const script = process.argv[2];
  if (!script?.startsWith('/')) throw new Error('workspace materializer script must be absolute');
  process.exitCode = await withWorkspaceDirectoryLock(LOCK_DIR, () => runMaterializer(script));
}

if (process.argv[1]?.endsWith('/workspace-materializer-lock.js')) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
