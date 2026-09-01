import type { Readable } from 'stream';

import { bundleFromDir } from '../templates/bundle.js';

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

/** Resolve the CLI's client-side transports before dispatch. Mutates the
 * parsed args in place so the server-side handler only ever sees the value.
 *
 * Two transports, one resolver, because the ncl client calls exactly one hook
 * here and a second reach-in into client.ts for a second flag would be the
 * wrong trade:
 *   groups create --spec-stdin        → args.spec   (the create-spec body)
 *   templates put --from-dir <dir>    → args.bundle (the directory, packed by
 *                                        the CLIENT, which is the process that
 *                                        can see it — a staged release on the
 *                                        node, a seed script's temp dir)
 *   templates put --bundle-stdin      → args.bundle (a pre-packed bundle)
 */
export async function resolveCreateSpecStdin(
  command: string,
  args: Record<string, unknown>,
  input: Readable = process.stdin,
): Promise<void> {
  if (command === 'templates-put') {
    const fromDir = args['from-dir'];
    const bundleStdin = Object.hasOwn(args, 'bundle-stdin');
    if (fromDir !== undefined && bundleStdin) throw new Error('--from-dir and --bundle-stdin cannot be combined');
    if (fromDir !== undefined) {
      if (typeof fromDir !== 'string' || !fromDir) throw new Error('--from-dir needs a directory');
      args.bundle = JSON.stringify(bundleFromDir(fromDir));
      delete args['from-dir'];
    } else if (bundleStdin) {
      if (args['bundle-stdin'] !== true || Object.hasOwn(args, 'bundle')) {
        throw new Error('--bundle-stdin is a flag and cannot be combined with --bundle');
      }
      args.bundle = await readUtf8StdinBounded(input);
      delete args['bundle-stdin'];
    }
    return;
  }
  if (!Object.hasOwn(args, 'spec-stdin')) return;
  if (command !== 'groups-create' || args['spec-stdin'] !== true || Object.hasOwn(args, 'spec')) {
    throw new Error('--spec-stdin is only valid as a flag on groups create and cannot be combined with --spec');
  }
  args.spec = await readUtf8StdinBounded(input);
  delete args['spec-stdin'];
}
