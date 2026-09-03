/**
 * migrate-v2 step: sessions
 *
 * For each v1 session folder, create a proper v2 session:
 *   1. Create a sessions row in v2.db (via resolveSession)
 *   2. Initialize the session folder (inbound.db, outbound.db, outbox/)
 *   3. Write session routing so the container knows where to reply
 *   4. Copy v1 .claude/ state into v2's .claude-shared/ directory
 *
 * v1: data/sessions/<folder>/.claude/ (settings, conversation history, skills)
 * v2: data/v2-sessions/<agent_group_id>/.claude-shared/ + session folder
 *
 * v1's agent-runner-src/ is NOT copied — v2 uses a completely different
 * Bun-based agent-runner.
 *
 * Idempotent — reuses existing sessions, does not overwrite files.
 *
 * Usage: pnpm exec tsx setup/migrate-v2/sessions.ts <v1-path>
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH, DATA_DIR } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/connection.js';
import { getAllAgentGroups } from '../../src/db/agent-groups.js';
import { getMessagingGroupsByAgentGroup } from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import '../../src/mailbox/compose.js';
import { outboundDbPath } from '../../src/mailbox/sqlite/paths.js';
import { resolveSession, writeSessionRouting } from '../../src/session-manager.js';

const SKIP_NAMES = new Set(['.DS_Store']);

/** Recursively copy, never overwriting existing files. */
function copyTree(src: string, dst: string): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      written += copyTree(s, d);
      continue;
    }
    // Skip dangling symlinks (e.g. v1's .claude/debug/latest pointer).
    if (entry.isSymbolicLink() && !fs.existsSync(s)) continue;
    if (fs.existsSync(d)) continue;
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}

async function main(): Promise<void> {
  const v1Path = process.argv[2];
  if (!v1Path) {
    console.error('Usage: tsx setup/migrate-v2/sessions.ts <v1-path>');
    process.exit(1);
  }

  const v1SessionsDir = path.join(v1Path, 'data', 'sessions');
  if (!fs.existsSync(v1SessionsDir)) {
    console.log('SKIPPED:no v1 data/sessions/ directory');
    process.exit(0);
  }

  // Init v2 central DB
  const v2DbPath = CENTRAL_DB_PATH;
  if (!fs.existsSync(v2DbPath)) {
    console.error('v2.db not found — run db step first');
    process.exit(1);
  }

  const v2Db = await initDb(v2DbPath);
  await runMigrations(v2Db);

  const agentGroups = await getAllAgentGroups();
  const folderToAg = new Map<string, { id: string; folder: string }>();
  for (const ag of agentGroups) {
    folderToAg.set(ag.folder, ag);
  }

  let sessionsCreated = 0;
  let sessionsReused = 0;
  let sessionsSkipped = 0;
  let filesCopied = 0;

  for (const entry of fs.readdirSync(v1SessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;

    const ag = folderToAg.get(folder);
    if (!ag) {
      sessionsSkipped++;
      continue;
    }

    // Find the messaging groups wired to this agent group
    const messagingGroups = await getMessagingGroupsByAgentGroup(ag.id);
    if (messagingGroups.length === 0) {
      sessionsSkipped++;
      continue;
    }

    // Create a session for each messaging group (v1 had one session per
    // folder, v2 has one per agent_group + messaging_group pair)
    for (const mg of messagingGroups) {
      const { session, created } = await resolveSession(ag.id, mg.id, null, 'shared');

      if (created) {
        // Write routing so the container knows where to reply
        await writeSessionRouting(ag.id, session.id);
        sessionsCreated++;
      } else {
        sessionsReused++;
      }
    }

    // Copy v1 .claude/ state into v2's .claude-shared/ directory
    // This is per-agent-group, shared across all sessions for that group
    const v1ClaudeDir = path.join(v1SessionsDir, folder, '.claude');
    if (fs.existsSync(v1ClaudeDir)) {
      const v2ClaudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
      filesCopied += copyTree(v1ClaudeDir, v2ClaudeDir);

      // v1 containers worked in /workspace/group, v2 works in /workspace/agent.
      // Claude Code stores sessions under projects/<hashed-cwd>/. Copy the v1
      // project dir to the v2 path so Claude Code finds the conversation history.
      const projectsDir = path.join(v2ClaudeDir, 'projects');
      const v1ProjectDir = path.join(projectsDir, '-workspace-group');
      const v2ProjectDir = path.join(projectsDir, '-workspace-agent');
      if (fs.existsSync(v1ProjectDir) && !fs.existsSync(v2ProjectDir)) {
        filesCopied += copyTree(v1ProjectDir, v2ProjectDir);
      }

      // Write the v1 Claude Code session ID as the continuation in outbound.db
      // so the agent-runner resumes the exact same conversation.
      // The session ID is the JSONL filename (without extension) under the
      // project dir.
      const sourceDir = fs.existsSync(v2ProjectDir) ? v2ProjectDir : v1ProjectDir;
      if (fs.existsSync(sourceDir)) {
        const jsonlFiles = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.jsonl'));
        if (jsonlFiles.length > 0) {
          // Use the most recent JSONL file (by mtime from v1)
          const v1SessionId = jsonlFiles
            .map((f) => ({
              name: f.replace('.jsonl', ''),
              mtime: fs.statSync(path.join(sourceDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime)[0].name;

          // Write into each v2 session's outbound.db for this agent group
          const sessions = await getMessagingGroupsByAgentGroup(ag.id);
          for (const mg of sessions) {
            const { session } = await resolveSession(ag.id, mg.id, null, 'shared');
            const obPath = outboundDbPath(ag.id, session.id);
            if (fs.existsSync(obPath)) {
              const ob = new Database(obPath);
              ob.prepare(
                "INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES ('continuation:claude', ?, ?)",
              ).run(v1SessionId, new Date().toISOString());
              ob.close();
            }
          }
        }
      }
    }
  }

  await closeDb();

  console.log(`OK:created=${sessionsCreated},reused=${sessionsReused},skipped=${sessionsSkipped},files=${filesCopied}`);
}

main().catch((err) => {
  console.error(`FAIL:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
