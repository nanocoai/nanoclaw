/**
 * Registers a document as delivery-eligible. Called exactly once, host-side,
 * by lease-manager-generate/apply.ts immediately after its own independent
 * "does the file actually exist" check passes -- nothing else ever inserts a
 * row here, so a row's mere existence in `lease_generated_documents` IS the
 * verification signal the delivery path checks for. No tenant name/PII
 * column -- property address is enough to identify which lease this is
 * without carrying tenant identity into a table the delivery path also
 * reads.
 *
 * Ported from old commit 59de60dc, adapted from sync
 * `getDb().prepare(sql).run(...)` to the current async DbDriver
 * (`await getDb().run(sql, ...)`) -- no behavior change.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';

export interface RegisterGeneratedDocumentInput {
  generationRequestId: string;
  filePath: string;
  propertyAddress: string;
}

/** Returns the opaque reference token -- the only identifier ever handed to an agent. */
export async function registerGeneratedDocument(input: RegisterGeneratedDocumentInput): Promise<string> {
  const id = randomUUID();
  await getDb().run(
    `INSERT INTO lease_generated_documents (id, generation_request_id, file_path, property_address, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    input.generationRequestId,
    input.filePath,
    input.propertyAddress,
    new Date().toISOString(),
  );
  return id;
}
