#!/usr/bin/env tsx
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function compareSemver(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Resolve tsx binary once to avoid npx race conditions across migrations
function resolveTsx(): string {
  // Check local node_modules first
  const local = path.resolve('node_modules/.bin/tsx');
  if (fs.existsSync(local)) return local;
  // Fall back to whichever tsx is in PATH
  try {
    return execSync('which tsx', { encoding: 'utf-8' }).trim();
  } catch {
    return 'npx'; // last resort
  }
}

const tsxBin = resolveTsx();

const fromVersion = process.argv[2];
const toVersion = process.argv[3];
const newCorePath = process.argv[4];

if (!fromVersion || !toVersion || !newCorePath) {
  console.error('Usage: tsx scripts/run-migrations.ts <from-version> <to-version> <new-core-path>');
  process.exit(1);
}

interface MigrationResult {
  version: string;
  success: boolean;
  error?: string;
}

const results: MigrationResult[] = [];

// Look for migrations in the new core
const migrationsDir = path.join(newCorePath, 'migrations');

if (!fs.existsSync(migrationsDir)) {
  console.log(JSON.stringify({ migrationsRun: 0, results: [] }, null, 2));
  process.exit(0);
}

// Discover migration directories (version-named)
const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
const migrationVersions = entries
  .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .filter((v) => compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0)
  .sort(compareSemver);

const projectRoot = process.cwd();

for (const version of migrationVersions) {
  const migrationIndex = path.join(migrationsDir, version, 'index.ts');
  if (!fs.existsSync(migrationIndex)) {
    results.push({
      version,
      success: false,
      error: `Migration ${version}/index.ts not found`,
    });
    continue;
  }

  try {
    const tsxArgs = tsxBin.endsWith('npx') ? ['tsx', migrationIndex, projectRoot] : [migrationIndex, projectRoot];
    execFileSync(tsxBin, tsxArgs, {
      stdio: 'pipe',
      cwd: projectRoot,
      timeout: 120_000,
    });
    results.push({ version, success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ version, success: false, error: message });
  }
}

console.log(JSON.stringify({ migrationsRun: results.length, results }, null, 2));

// Exit with error if any migration failed
if (results.some((r) => !r.success)) {
  process.exit(1);
}
