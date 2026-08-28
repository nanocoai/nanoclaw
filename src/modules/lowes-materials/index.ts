/**
 * Lowe's purchase-history and preferred-materials catalog for Maintenance
 * Coordinator.
 *
 * Not an approval-flow module in the self-mod/lease-manager sense -- no
 * guard-wrapped delivery actions here. Its only self-registration
 * obligation is the migration: registerMigration() must run before
 * runMigrations() does, which import order into the modules barrel
 * (src/modules/index.ts) guarantees, same as every other registry-based
 * module.
 *
 * CLI resources (src/cli/resources/lowes-*.ts, preferred-materials.ts)
 * self-register through the CLI resource registry, not this barrel.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleLowesMaterials } from '../../db/migrations/module-lowes-materials.js';

registerMigration(moduleLowesMaterials);
