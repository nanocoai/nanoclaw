/**
 * Narrowly scoped transcript search -- see search.ts. No migration here:
 * this reads a session's already-durable inbound.db, not a new table.
 */
export {
  searchMaintenanceTranscript,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  type TranscriptSearchOptions,
  type TranscriptSearchOutcome,
  type TranscriptSearchResult,
} from './search.js';
