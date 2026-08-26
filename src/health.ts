import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type HealthResource = {
  state: 'loaded' | 'empty';
  count: number;
};

export type HostHealth = {
  status: 'healthy' | 'unhealthy';
  checkoutRoot: string;
  process: {
    pid: number;
    ppid: number;
    executable: string;
    script: string;
    cwd: string;
  };
  resources: {
    groups: HealthResource;
    policies: HealthResource;
    skills: HealthResource;
  };
};

type CountRow = { count: number };

/** Collect the host-owned health model used by both `ncl health` and setup. */
export function collectHostHealth(projectRoot: string = process.cwd(), db?: Database.Database): HostHealth {
  const checkoutRoot = path.resolve(projectRoot);
  const processIdentity = {
    pid: process.pid,
    ppid: process.ppid,
    executable: process.execPath,
    script: process.argv[1] ? path.resolve(process.cwd(), process.argv[1]) : '',
    cwd: process.cwd(),
  };
  let ownedDb: Database.Database | undefined;
  let healthy = processIdentity.pid > 0 && processIdentity.cwd === checkoutRoot;
  let groups = 0;
  let policies = 0;
  try {
    const connection = db ?? (ownedDb = new Database(path.join(checkoutRoot, 'data', 'v2.db'), { readonly: true }));
    if (!hasTable(connection, 'agent_groups')) {
      healthy = false;
    } else {
      groups = count(connection, 'agent_groups');
      if (hasTable(connection, 'agent_message_policies')) {
        policies = count(connection, 'agent_message_policies');
      } else {
        healthy = false;
      }
    }
  } catch {
    healthy = false;
  } finally {
    ownedDb?.close();
  }

  const skills = countInstalledSkills(checkoutRoot);
  return {
    status: healthy ? 'healthy' : 'unhealthy',
    checkoutRoot,
    process: processIdentity,
    resources: {
      groups: resource(groups),
      policies: resource(policies),
      skills: resource(skills),
    },
  };
}

/** The default root is kept here for callers that already import src/config. */
export function collectConfiguredHostHealth(db?: Database.Database): HostHealth {
  return collectHostHealth(process.cwd(), db);
}

function resource(count: number): HealthResource {
  return { state: count > 0 ? 'loaded' : 'empty', count };
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1').get('table', name) !== undefined;
}

function count(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
  return Number.isInteger(row.count) && row.count >= 0 ? row.count : 0;
}

function countInstalledSkills(root: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(path.join(root, 'data', 'v2-sessions'), { withFileTypes: true })) {
      if (!entry.isSymbolicLink() && entry.isDirectory()) {
        total += countGroupSkills(path.join(root, 'data', 'v2-sessions', entry.name, '.claude-shared', 'skills'));
      }
    }
  } catch {
    // A checkout can legitimately have no group session directory yet.
  }
  return total;
}

function countGroupSkills(location: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(location, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    // Shared skills are container-resolving symlinks; template skills are real
    // directories. Both forms are loaded entries in this per-group store.
    if (entry.isSymbolicLink()) {
      total++;
      continue;
    }
    if (!entry.isDirectory()) continue;
    const child = path.join(location, entry.name);
    try {
      if (fs.statSync(path.join(child, 'SKILL.md')).isFile()) total++;
    } catch {
      // Ignore incomplete directories.
    }
  }
  return total;
}
