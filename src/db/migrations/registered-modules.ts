/**
 * Module migrations, in one place.
 *
 * Every module that contributes a `module:<owner>:<name>` migration registers
 * it at import time. The host loads those modules through its own barrels;
 * the standalone migration command (scripts/migrate.ts) does not, so it
 * imports this file to see the same set. A module that registers a migration
 * appends its import here — the host and the command then agree on what
 * "current" means.
 */
import '../../code-mode/index.js';
