/**
 * PDF text extraction via the `pdftotext` system binary.
 *
 * Host-side preprocessing — called by the chat-sdk-bridge after downloading
 * a PDF attachment, before the row is written into the session inbound DB.
 * Extracted text is stored on the attachment as `extractedText` for the
 * formatter to render inline; on failure `pdfExtractionError` carries the
 * reason.
 *
 * Doing this on the host (vs. inside the container) keeps the agent's tool
 * surface small — every container would otherwise have to either spawn
 * pdftotext itself or run a JS PDF parser. Both cost more than running it
 * once on the host and shipping plain text.
 *
 * Soft-fails when pdftotext isn't installed; the formatter will render the
 * error message instead of just dropping the attachment.
 */
import { spawn } from 'child_process';
import { Writable } from 'stream';

import { log } from './log.js';

/** Cap on extracted text size — keeps very large PDFs from bloating prompts. */
const MAX_EXTRACTED_BYTES = 250_000; // ~ 60-80 pages of dense text

/** Cap on input PDF size — guards against huge files exhausting RAM. */
const MAX_PDF_INPUT_BYTES = 50 * 1024 * 1024;

export class PdfExtractionError extends Error {
  readonly kind: 'too-large' | 'binary-missing' | 'spawn-failed' | 'nonzero-exit' | 'empty-output';
  constructor(kind: PdfExtractionError['kind'], message: string) {
    super(message);
    this.kind = kind;
    this.name = 'PdfExtractionError';
  }
}

export interface PdfExtractOptions {
  /** Override for the binary path (defaults to `pdftotext` on $PATH). */
  binary?: string;
  /**
   * Override for the `spawn` implementation. Tests inject a stub so we
   * don't have to actually have pdftotext installed to exercise the
   * branching logic.
   */
  spawnImpl?: typeof spawn;
  /** Hard timeout for the spawn (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Run `pdftotext -layout -nopgbrk -enc UTF-8 - -` with the PDF bytes piped
 * in on stdin and the extracted text read back from stdout. Returns the
 * text on success; throws `PdfExtractionError` on failure.
 *
 * `-layout` preserves the visual flow (columns, tables) better than the
 * default reflow mode, which collapses everything into one stream. Better
 * for the agent reading code or structured documents.
 */
export async function extractPdfText(pdf: Buffer, opts: PdfExtractOptions = {}): Promise<string> {
  if (pdf.length === 0) {
    throw new PdfExtractionError('too-large', 'Empty PDF buffer');
  }
  if (pdf.length > MAX_PDF_INPUT_BYTES) {
    throw new PdfExtractionError(
      'too-large',
      `PDF exceeds extraction limit (${pdf.length} > ${MAX_PDF_INPUT_BYTES} bytes)`,
    );
  }

  const spawnImpl = opts.spawnImpl ?? spawn;
  const binary = opts.binary ?? 'pdftotext';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, ['-layout', '-nopgbrk', '-enc', 'UTF-8', '-', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reject(new PdfExtractionError('spawn-failed', `Failed to spawn ${binary}: ${msg}`));
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = '';
    let bytesWritten = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new PdfExtractionError('binary-missing', `${binary} not installed`));
      } else {
        reject(new PdfExtractionError('spawn-failed', `pdftotext spawn error: ${err.message}`));
      }
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      // Hard-cap the extracted output to avoid prompt blowup on massive docs.
      // Bytes past the cap are dropped; we still let pdftotext run to
      // completion so we get a clean exit code rather than EPIPE.
      if (bytesWritten < MAX_EXTRACTED_BYTES) {
        const remaining = MAX_EXTRACTED_BYTES - bytesWritten;
        if (chunk.length <= remaining) {
          chunks.push(chunk);
          bytesWritten += chunk.length;
        } else {
          chunks.push(chunk.subarray(0, remaining));
          bytesWritten = MAX_EXTRACTED_BYTES;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new PdfExtractionError('nonzero-exit', `pdftotext timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(
          new PdfExtractionError('nonzero-exit', `pdftotext exited ${code}: ${stderr.slice(0, 300) || '(no stderr)'}`),
        );
        return;
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        reject(new PdfExtractionError('empty-output', 'pdftotext produced no text'));
        return;
      }
      log.debug('Extracted PDF text', { bytesIn: pdf.length, bytesOut: text.length });
      resolve(text);
    });

    // Pipe the PDF bytes to stdin. Catch EPIPE in case pdftotext exits
    // early (corrupt file, missing magic header) before we finish writing.
    const stdin = child.stdin as Writable | null;
    if (stdin) {
      stdin.on('error', () => {
        /* swallow EPIPE — the close handler reports the real error */
      });
      stdin.end(pdf);
    }
  });
}

export function isPdfMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return m === 'application/pdf' || m === 'application/x-pdf';
}
