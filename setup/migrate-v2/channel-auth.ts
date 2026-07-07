/**
 * migrate-v2 step: channel-auth
 *
 * Copy channel auth state from v1 to v2 for selected channels.
 * Handles both env keys and on-disk auth files (Baileys, Matrix, etc.)
 * per the CHANNEL_AUTH_REGISTRY.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/channel-auth.ts <v1-path> <channel1> [channel2...]
 */
import fs from 'fs';
import path from 'path';

import { CHANNEL_AUTH_REGISTRY } from './shared.js';

function parseEnv(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }
  return out;
}

function appendEnvKey(envPath: string, key: string, value: string): boolean {
  const existing = parseEnv(envPath);
  if (existing.has(key)) return false;

  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (content && !content.endsWith('\n')) content += '\n';
  content += `${key}=${value}\n`;
  fs.writeFileSync(envPath, content);
  return true;
}

function copyGlob(v1Root: string, v2Root: string, relativePath: string): string[] {
  const src = path.join(v1Root, relativePath);
  if (!fs.existsSync(src)) return [];

  const copied: string[] = [];
  const stat = fs.statSync(src);

  if (stat.isFile()) {
    const dst = path.join(v2Root, relativePath);
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(relativePath);
    }
  } else if (stat.isDirectory()) {
    const dst = path.join(v2Root, relativePath);
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const sub = path.join(relativePath, entry.name);
      copied.push(...copyGlob(v1Root, v2Root, sub));
    }
  }

  return copied;
}

function main(): void {
  const args = process.argv.slice(2);
  const v1Path = args[0];
  const channels = args.slice(1);

  if (!v1Path || channels.length === 0) {
    console.error('Usage: tsx setup/migrate-v2/channel-auth.ts <v1-path> <channel1> [channel2...]');
    process.exit(1);
  }

  const v1EnvPath = path.join(v1Path, '.env');
  const v2EnvPath = path.join(process.cwd(), '.env');
  const v1Env = parseEnv(v1EnvPath);

  let envKeysCopied = 0;
  let filesCopied = 0;
  let channelsProcessed = 0;
  const missing: string[] = [];

  for (const channel of channels) {
    const spec = CHANNEL_AUTH_REGISTRY[channel];
    if (!spec) {
      // Unknown channel — just try copying env keys with common naming
      channelsProcessed++;
      continue;
    }

    // Copy env keys
    for (const key of spec.v1EnvKeys) {
      const value = v1Env.get(key);
      if (value) {
        if (appendEnvKey(v2EnvPath, key, value)) {
          envKeysCopied++;
        }
      }
    }

    // Check required v2 keys — report missing ones
    const v2Env = parseEnv(v2EnvPath);
    for (const req of spec.requiredV2Keys) {
      if (!v2Env.has(req.key)) {
        missing.push(`${channel}:${req.key} (${req.where})`);
      }
    }

    // Copy on-disk auth files
    for (const candidate of spec.candidatePaths) {
      const copied = copyGlob(v1Path, process.cwd(), candidate);
      filesCopied += copied.length;
    }

    channelsProcessed++;
  }

  console.log(`OK:channels=${channelsProcessed},env_keys=${envKeysCopied},files=${filesCopied}`);
  if (missing.length > 0) {
    console.log(`MISSING:${missing.join(',')}`);
  }
}

main();
