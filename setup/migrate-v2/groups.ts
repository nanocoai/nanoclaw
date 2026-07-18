/**
 * migrate-v2 step: groups
 *
 * Copy v1 group folders into v2.
 *   - v1 CLAUDE.md → v2 CLAUDE.local.md (legacy staging for /migrate-memory)
 *   - v1 container_config → .v1-container-config.json sidecar
 *   - All other files copied (no overwrite)
 *   - Also copies global/ if it exists
 *
 * Idempotent — does not overwrite files that already exist in v2.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/groups.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

const SKIP_NAMES = new Set(['CLAUDE.md', 'logs', '.git', '.DS_Store', 'node_modules']);

/**
 * Copy a directory tree, skipping SKIP_NAMES. Never overwrites existing files.
 *
 * Symlinks are skipped, not followed: v1 group folders sometimes contain
 * container-side paths like `.claude-shared.md → /app/CLAUDE.md` that
 * don't resolve on the host. Following them with `fs.copyFileSync` would
 * crash ENOENT on a broken target and abort the rest of the traversal.
 * v2 uses composed CLAUDE.md fragments anyway — these v1 symlinks have no
 * v2 meaning and don't need to be carried forward.
 */
function copyTree(src: string, dst: string): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isSymbolicLink()) {
      console.log(`SKIP:symlink ${path.relative(process.cwd(), s)}`);
      continue;
    }
    if (entry.isDirectory()) {
      written += copyTree(s, d);
      continue;
    }
    if (fs.existsSync(d)) continue;
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}

function main(): void {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/groups.ts <v1-path>');
    process.exit(1);
  }

  const v1GroupsDir = path.join(v1Path, 'groups');
  const v2GroupsDir = path.join(process.cwd(), 'groups');

  if (!fs.existsSync(v1GroupsDir)) {
    console.log('SKIPPED:no v1 groups/ directory');
    process.exit(0);
  }

  // Get all folders from v1 DB to know which groups are registered
  const v1DbPath = path.join(v1Path, 'store', 'messages.db');
  const registeredFolders = new Set<string>();
  if (fs.existsSync(v1DbPath)) {
    const v1Db = new Database(v1DbPath, { readonly: true, fileMustExist: true });
    const rows = v1Db
      .prepare('SELECT folder, container_config FROM registered_groups')
      .all() as Array<{ folder: string; container_config: string | null }>;
    const containerConfigs = new Map<string, string | null>();
    for (const r of rows) {
      registeredFolders.add(r.folder);
      containerConfigs.set(r.folder, r.container_config);
    }
    v1Db.close();

    // Write container.json from v1 container_config.
    // The additionalMounts shape is identical between v1 and v2.
    for (const [folder, config] of containerConfigs) {
      if (!config) continue;
      const v2Folder = path.join(v2GroupsDir, folder);
      const containerJson = path.join(v2Folder, 'container.json');
      if (fs.existsSync(containerJson)) continue;
      fs.mkdirSync(v2Folder, { recursive: true });
      try {
        const parsed = JSON.parse(config) as Record<string, unknown>;
        fs.writeFileSync(containerJson, JSON.stringify(parsed, null, 2));
      } catch {
        // Unparseable config — write as sidecar for the skill to handle
        fs.writeFileSync(path.join(v2Folder, '.v1-container-config.json'), config);
      }
    }
  }

  // Copy all v1 group folders (registered + global + any extras)
  let foldersCopied = 0;
  let claudesMigrated = 0;
  let filesCopied = 0;

  for (const entry of fs.readdirSync(v1GroupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    const v1Folder = path.join(v1GroupsDir, folder);
    const v2Folder = path.join(v2GroupsDir, folder);

    fs.mkdirSync(v2Folder, { recursive: true });

    // Content-blind staging; /migrate-memory moves and distills it later.
    const v1Claude = path.join(v1Folder, 'CLAUDE.md');
    const v2Local = path.join(v2Folder, 'CLAUDE.local.md');
    if (fs.existsSync(v1Claude) && !fs.existsSync(v2Local)) {
      fs.copyFileSync(v1Claude, v2Local);
      claudesMigrated++;
    }

    // Copy everything else
    filesCopied += copyTree(v1Folder, v2Folder);
    foldersCopied++;
  }

  console.log(`OK:folders=${foldersCopied},claudes=${claudesMigrated},files=${filesCopied}`);
}

main();
