import { describe } from 'vitest';

import { defineDriverConformance } from '../../testing/driver-conformance.js';
import type { PostgresDbConfig } from './config.js';
import { PostgresDriver } from './index.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

describe.skipIf(!TEST_DB_URL)('PostgreSQL integration', () => {
  let sequence = 0;
  defineDriverConformance('PostgreSQL', {
    create: ({ watchdogMs } = {}) => {
      sequence += 1;
      return PostgresDriver.create(
        {
          path: '',
          url: TEST_DB_URL,
          migrateUrl: '',
          schema: `nc_test_conformance_${process.pid}_${sequence}`,
          passwordFile: '',
          statementTimeoutMs: 30_000,
          hostLock: false,
        } satisfies PostgresDbConfig,
        { role: 'test' },
        watchdogMs,
      );
    },
  });
});
