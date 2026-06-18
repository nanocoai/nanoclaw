/**
 * Install-overlay append point for migrate-v2 post-seed steps.
 *
 * Core ships this EMPTY. `setup/migrate-v2/db.ts` imports it for side effects so
 * that, when an overlay is installed, its step module's top-level
 * `registerMigrateV2Step(...)` runs before the seed loop completes.
 *
 * The `/add-taskflow` installer appends (idempotent grep-then-append):
 *   import './modules/taskflow/migrate-v2-main-control.js';
 * which registers the is_main_control carry-over step + its column migration.
 * Pristine core (no overlay) runs migrate-v2 with zero registered steps.
 */
export {};
