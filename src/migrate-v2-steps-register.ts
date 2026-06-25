/**
 * Install-overlay append point for migrate-v2 post-seed steps.
 *
 * Core ships this EMPTY. `setup/migrate-v2/db.ts` imports it for side effects so
 * that, when an overlay is installed, its step module's top-level
 * `registerMigrateV2Step(...)` runs before the seed loop completes.
 *
 * A downstream installer appends (idempotent grep-then-append) a side-effect
 * import of its own step module, e.g.:
 *   import './modules/my-overlay/migrate-v2-step.js';
 * which registers a carry-over step + any column migration it needs.
 * With no overlay installed, migrate-v2 runs with zero registered steps.
 */
export {};
