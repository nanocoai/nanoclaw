/**
 * The module-registration barrel the MIGRATE PROCESS shares with the host.
 *
 * TODO(upstream/nanoclaw: module-migrations-on-validate-dialects) — this file
 * and the one-line import it earns in `scripts/migrate.ts` belong in trunk. A
 * recipe skill carries them because the gap they close is trunk's, not any
 * composition's: it opens the moment a module registers a migration and the
 * central DB is not SQLite, whatever skills produced either half.
 *
 * `registerMigration` puts a migration in the registry at IMPORT time, so WHICH
 * migrations exist is a property of an import graph — and the host and
 * `scripts/migrate.ts` do not share one. `src/index.ts` imports every module
 * barrel; the migrate script imports config, the connection and the registry,
 * and nothing that reaches a module. On SQLite that gap is invisible:
 * `runMigrations` in 'auto' mode means MIGRATE there, so the host quietly
 * applies at boot whatever the migrate step never saw. On every other dialect
 * 'auto' means VALIDATE — the host registers the module migrations, finds them
 * pending, throws, and exits 1 on a box whose deploy step had just printed
 * "Central DB migrations are current."
 *
 * This file is that shared graph. `scripts/migrate.ts` imports it for side
 * effects; every module that calls `registerMigration` appends its own
 * side-effect import below. `src/index.ts` keeps its own imports untouched —
 * the host's registry does not change here, and this barrel only has to REACH
 * the same modules, not own the way the host reaches them.
 *
 * The order of the imports below is this barrel's own and need not equal
 * `src/index.ts`'s. A module owns its own tables by construction, registry
 * uniqueness is keyed on `name`, and the `version` column is an applied-order
 * number rather than an identity. What may NOT differ between the two graphs is
 * the SET — that is what validate mode compares, and `registered-modules.test.ts`
 * is what keeps a module from registering outside this file.
 *
 * THE MARKER REGION BELOW IS THE SEAM, and it is load-bearing rather than
 * decorative. A module appends with `nc:append … at:module-registrations`,
 * which REFUSES when the region is absent (engine/skill-apply.ts: `append
 * marker "…" not found`) and bounces the bake. The markerless spelling would
 * instead CREATE this file — `appendFileSync` on a missing path — so a
 * composition that forgot this skill would compose green carrying a one-line
 * barrel nothing imports, and exit 1 at boot on any validate dialect. That is
 * precisely the failure this file exists to close, recreated by its own fix.
 * Do not remove the region, and do not append without `at:`.
 */
// >>> module-registrations
import '../../dev-env/index.js';
import '../../code-mode/index.js';
import '../../audit/migration.js';
import '../../modules/single-active-host/index.js';
import '../../modules/process-split/dm-delegation.js';
import '../../modules/process-split/cli-delegation.js';
// <<< module-registrations
export {};
