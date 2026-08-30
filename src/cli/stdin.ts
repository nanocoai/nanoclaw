import type { Readable } from 'stream';

export const MAX_AGENT_CREATE_SPEC_STDIN_BYTES = 2 * 1024 * 1024;

/** Read a UTF-8 CLI request body without allowing an unbounded pipe to grow
 * host memory. Exported for transport tests. */
export async function readUtf8StdinBounded(
  input: Readable = process.stdin,
  maxBytes = MAX_AGENT_CREATE_SPEC_STDIN_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error(`stdin payload exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString('utf8');
  if (!value.trim()) throw new Error('stdin payload is empty');
  return value;
}

/** Resolve the CLI's large create-spec transport before dispatch. Mutates the
 * parsed args in place so the normal groups-create handler still sees `spec`. */
export async function resolveCreateSpecStdin(
  command: string,
  args: Record<string, unknown>,
  input: Readable = process.stdin,
): Promise<void> {
  if (!Object.hasOwn(args, 'spec-stdin')) return;
  if (command !== 'groups-create' || args['spec-stdin'] !== true || Object.hasOwn(args, 'spec')) {
    throw new Error('--spec-stdin is only valid as a flag on groups create and cannot be combined with --spec');
  }
  args.spec = await readUtf8StdinBounded(input);
  delete args['spec-stdin'];
}
