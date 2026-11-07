/**
 * Turn traces module — stores the per-turn traces agent containers send and
 * exposes them through `ncl traces`.
 *
 * `turn_trace` runs unguarded: it only writes an internal, host-only row for
 * the session that sent it, with no side effect outside the trace table.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { registerMigration } from '../../db/migrations/index.js';
import { unguarded } from '../../guard/index.js';
import { applyTurnTrace } from './apply.js';
import { turnTracesTable } from './migration.js';
import './resource.js';

registerMigration(turnTracesTable);

registerDeliveryAction(
  'turn_trace',
  applyTurnTrace,
  unguarded('stores an internal trace row for the sending session; host-only, no other side effect'),
);
