/**
 * The one place that turns an opaque document reference into a validated,
 * on-disk PDF path. Called independently by both the precheck (fast reject
 * before any work starts) and the handler itself (never trusts precheck's
 * result transitively -- same discipline as lease-manager-generate/apply.ts
 * re-checking what request.ts's precheck already checked). Fails closed on
 * every branch: any missing row, missing file, wrong extension, or path
 * escaping the configured Drafts directory is a rejection, never a
 * best-effort allow.
 *
 * Ported from old commit 59de60dc, adapted from sync
 * `getDb().prepare(sql).get(...)` to the current async DbDriver
 * (`await getDb().get(sql, ...)`) -- no behavior change.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../../db/connection.js';
import { DRAFTS_DIR_WSL } from './config.js';

export interface ResolvedDocument {
  id: string;
  generationRequestId: string;
  filePath: string;
  propertyAddress: string;
}

export type ResolveResult = { ok: true; document: ResolvedDocument } | { ok: false; reason: string };

interface DocumentRow {
  id: string;
  generation_request_id: string;
  file_path: string;
  property_address: string;
}

export async function resolveAndValidateDocument(documentReference: unknown): Promise<ResolveResult> {
  if (typeof documentReference !== 'string' || !documentReference.trim()) {
    return { ok: false, reason: 'document_reference is required and must be a non-empty string.' };
  }

  const row = await getDb().get<DocumentRow>(
    'SELECT id, generation_request_id, file_path, property_address FROM lease_generated_documents WHERE id = ?',
    documentReference,
  );
  if (!row) {
    // Deliberately generic: never confirm/deny whether a caller-supplied
    // string happens to look like a real path or a real (but wrong) id.
    return { ok: false, reason: 'Unknown document reference -- no registered, verified document matches it.' };
  }

  if (path.extname(row.file_path).toLowerCase() !== '.pdf') {
    return { ok: false, reason: 'Registered document is not a PDF.' };
  }

  let realFile: string;
  let realDraftsDir: string;
  try {
    realDraftsDir = fs.realpathSync(DRAFTS_DIR_WSL);
    realFile = fs.realpathSync(row.file_path);
  } catch (e) {
    return {
      ok: false,
      reason: `Could not resolve the document on disk: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!realFile.startsWith(realDraftsDir + path.sep)) {
    return { ok: false, reason: 'Registered document does not resolve inside the configured Drafts directory.' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch (e) {
    return { ok: false, reason: `Document file is missing: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'Registered document path is not a regular file.' };
  }

  return {
    ok: true,
    document: {
      id: row.id,
      generationRequestId: row.generation_request_id,
      filePath: realFile,
      propertyAddress: row.property_address,
    },
  };
}
