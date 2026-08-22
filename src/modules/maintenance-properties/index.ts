/**
 * Maintenance Coordinator reference-data migrations: properties, key
 * binders, and the conditional-workday schedule confirmation model.
 *
 * No approval-flow logic of its own -- this module exists purely to
 * self-register its four migrations in the correct dependency order:
 *   1. properties (properties, property_operational_info, travel_times)
 *   2. key-binders (key_binders, key_binder_custody_events, key_binder_state
 *      -- ALTERs property_operational_info, so MUST come after properties;
 *      also references workers(user_id), so this module barrel entry MUST
 *      be imported after maintenance-worker-actions/index.js in
 *      src/modules/index.ts)
 *   3. schedule (maintenance_confirmed_workdays -- no deps)
 *   4. schedule-freshness (maintenance_workday_status_checks -- no deps)
 *
 * Ported from old commit 824318ff's migration files, self-registered via
 * registerMigration() rather than appended to the central migrations[]
 * array.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { moduleMaintenanceProperties } from '../../db/migrations/module-maintenance-properties.js';
import { moduleMaintenanceKeyBinders } from '../../db/migrations/module-maintenance-key-binders.js';
import { moduleMaintenanceSchedule } from '../../db/migrations/module-maintenance-schedule.js';
import { moduleMaintenanceScheduleFreshness } from '../../db/migrations/module-maintenance-schedule-freshness.js';

registerMigration(moduleMaintenanceProperties);
registerMigration(moduleMaintenanceKeyBinders);
registerMigration(moduleMaintenanceSchedule);
registerMigration(moduleMaintenanceScheduleFreshness);
