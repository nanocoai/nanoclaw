/**
 * Away Mode structured decision requests -- see ./request.ts and ./resolve.ts.
 * Importing this registers the approval-resolved observer + approve-path
 * notify handler at module load time (mirrors every other module's
 * self-registering index.ts).
 *
 * Also self-registers the away_mode_sessions/away_mode_queue migrations
 * via registerMigration() -- sessions MUST register first, since
 * away_mode_queue.session_id references away_mode_sessions(id). Import
 * order (not registerMigration() call order within this file, which is
 * the same thing here) is what registerMigration() preserves
 * deterministically -- see src/db/migrations/registry.test.ts's
 * FK-dependency ordering test.
 *
 * Ported from old commit 0fb28c04 -- only addition versus the old file is
 * the migration self-registration, matching the current registerMigration()
 * architecture.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleAwayModeSessions } from '../../db/migrations/module-away-mode-sessions.js';
import { moduleAwayModeQueue } from '../../db/migrations/module-away-mode-queue.js';
import './resolve.js';

registerMigration(moduleAwayModeSessions);
registerMigration(moduleAwayModeQueue);

export { requestAwayModeDecision } from './request.js';
