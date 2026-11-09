import fs from 'node:fs';
import path from 'node:path';

/** Installation identity comes from config, not gateway uptime or API version. */
export async function detectInstalledOneCLI(root = process.cwd()): Promise<boolean> {
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const value = env.match(/^\s*(?:export\s+)?ONECLI_URL\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!value) return false;
    const unquoted = value.replace(/^(['"])(.*)\1$/, '$2');
    const url = new URL(unquoted);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log((await detectInstalledOneCLI()) ? 'installed' : 'absent');
}
