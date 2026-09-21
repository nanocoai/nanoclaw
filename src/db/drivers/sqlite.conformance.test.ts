import Database from 'better-sqlite3';

import { defineDriverConformance } from '../testing/driver-conformance.js';
import { SqliteDriver } from './sqlite.js';

defineDriverConformance('SQLite', {
  create(options) {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    return new SqliteDriver(raw, options?.watchdogMs);
  },
});
