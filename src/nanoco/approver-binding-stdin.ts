import type { Readable } from 'stream';

const MAX_APPROVER_BINDING_STDIN_BYTES = 4096;

/** Move one bounded host-control binding off argv before the CLI frame is sent. */
export async function resolveApproverBindingStdin(
  command: string,
  args: Record<string, unknown>,
  input: Readable = process.stdin,
): Promise<void> {
  if (!Object.hasOwn(args, 'binding-stdin')) return;
  if (
    command !== 'nanoco-approver-bindings-set' ||
    args['binding-stdin'] !== true ||
    Object.hasOwn(args, 'spec')
  ) {
    throw new Error(
      '--binding-stdin is only valid as a flag on nanoco-approver-bindings set',
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_APPROVER_BINDING_STDIN_BYTES) {
      throw new Error('approver binding stdin payload is too large');
    }
    chunks.push(buffer);
  }
  const spec = Buffer.concat(chunks).toString('utf8');
  if (!spec.trim()) throw new Error('approver binding stdin payload is empty');

  args.spec = spec;
  delete args['binding-stdin'];
}
