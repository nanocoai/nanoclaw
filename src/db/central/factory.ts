import type { CentralDbBackend } from '../../config.js';
import { SeekDbCentralDb } from './seekdb.js';
import { SqliteCentralDb } from './sqlite.js';
import type { ICentralDb, SeekDbCentralDbOptions, SqliteCentralDbOptions } from './types.js';

export function createCentralDb(
  backend: CentralDbBackend,
  options: SqliteCentralDbOptions | SeekDbCentralDbOptions,
): ICentralDb {
  if (backend === 'seekdb') {
    return new SeekDbCentralDb(options as SeekDbCentralDbOptions);
  }
  return new SqliteCentralDb(options as SqliteCentralDbOptions);
}
