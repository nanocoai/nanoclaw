import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'container-memory',
  up(db: Database.Database) {
    // Per-group memory cap, in MiB. NULL = no explicit limit (runtime default).
    // Wired into spawn args as `-m <N>MiB` for Docker / `-m <N>MiB` for Apple
    // Container (both accept the same syntax). Set ≥2048 for groups whose
    // agent uses Chromium (agent-browser) to prevent OOM kills.
    db.prepare('ALTER TABLE container_configs ADD COLUMN memory_mb INTEGER').run();
  },
};
