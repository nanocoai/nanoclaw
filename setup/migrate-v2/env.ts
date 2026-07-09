/**
 * migrate-v2 step: env
 *
 * Copy every key from v1 .env into v2 .env. Never overwrites existing v2
 * keys. Idempotent — re-running skips keys already present.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/env.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    out.set(key, line);
  }
  return out;
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/env.ts <v1-path>');
    process.exit(1);
  }

  const v1EnvPath = path.join(v1Path, '.env');
  if (!fs.existsSync(v1EnvPath)) {
    console.log('SKIPPED:no v1 .env');
    process.exit(0);
  }

  const v2EnvPath = path.join(process.cwd(), '.env');
  const v1Lines = parseEnv(fs.readFileSync(v1EnvPath, 'utf-8'));
  const v2Text = fs.existsSync(v2EnvPath) ? fs.readFileSync(v2EnvPath, 'utf-8') : '';
  const v2Lines = parseEnv(v2Text);

  const copied: string[] = [];
  const skipped: string[] = [];
  const appended: string[] = [];

  const BLOCK_START = '# ── migrated from v1 ──';
  const alreadyMigrated = v2Text.includes(BLOCK_START);

  for (const [key, raw] of v1Lines) {
    if (v2Lines.has(key)) {
      skipped.push(key);
      continue;
    }
    copied.push(key);
    appended.push(raw);
  }

  if (appended.length > 0) {
    let result = v2Text;
    if (result && !result.endsWith('\n')) result += '\n';
    if (!alreadyMigrated) result += `\n${BLOCK_START}\n`;
    result += appended.join('\n') + '\n';
    fs.writeFileSync(v2EnvPath, result);
  }

  console.log(`OK:copied=${copied.length},skipped=${skipped.length}`);
  if (copied.length > 0) console.log(`COPIED:${copied.join(',')}`);
}

main();
