import { execSync } from 'node:child_process';
import path from 'node:path';

export function resolveNanoclawRoot(argv: string[] = process.argv.slice(2)): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--nanoclaw-root' && argv[i + 1]) {
      return path.resolve(argv[++i]);
    }
  }

  if (process.env.NANOCLAW_ROOT) {
    return path.resolve(process.env.NANOCLAW_ROOT);
  }

  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      encoding: 'utf8',
      cwd: process.cwd(),
    }).trim();
    const absCommon = path.isAbsolute(commonDir)
      ? commonDir
      : path.resolve(process.cwd(), commonDir);
    return path.dirname(absCommon);
  } catch {
    return process.cwd();
  }
}
