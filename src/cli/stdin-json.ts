/** Maximum structured CLI input accepted from stdin (64 KiB, measured as UTF-8 bytes). */
export const MAX_STDIN_JSON_BYTES = 64 * 1024;

export type StdinJsonStream = AsyncIterable<string | Uint8Array>;

/** Expected validation failure caused by the contents of `--stdin-json`. */
export class StdinJsonInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StdinJsonInputError';
  }
}

/**
 * Read one bounded JSON object from stdin and merge it with argv-derived args.
 * A key may come from exactly one source so shell-visible flags cannot be
 * silently replaced by piped data.
 */
export async function readStdinJsonArgs(
  stream: StdinJsonStream,
  argvArgs: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const source = await readBounded(stream);
  const stdinArgs = parseJsonObject(source);
  assertNoKeyConflicts(stdinArgs, argvArgs);
  // Safe to spread: assertNoKeyConflicts rejected "__proto__" and every
  // overlapping key, so this is a plain disjoint merge.
  return { ...argvArgs, ...stdinArgs };
}

/**
 * Accumulate the stream into a single UTF-8 string, enforcing the size limit.
 *
 * The limit is defined in bytes, and stdin yields chunks as either strings or
 * raw bytes depending on how the stream was configured upstream. Each chunk is
 * therefore normalized to a Buffer and the running total counts
 * `buffer.byteLength` — the true encoded size — rather than string length,
 * where a multibyte character (e.g. "ש", 2 bytes) would count as 1.
 *
 * Decoding to text happens exactly once, after the whole input is collected:
 * a chunk boundary can fall in the middle of a multibyte character, so
 * decoding chunk-by-chunk could corrupt the character that straddles the
 * split. The limit check runs before buffering grows past the cap, so an
 * oversized (or unbounded) pipe is rejected without being read to the end.
 */
async function readBounded(stream: StdinJsonStream): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_STDIN_JSON_BYTES) {
      throw new StdinJsonInputError(`--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, byteLength).toString('utf8');
}

/** Parse the input, requiring exactly one JSON object — not an array, scalar, or null. */
function parseJsonObject(source: string): Record<string, unknown> {
  if (source.trim().length === 0) {
    throw new StdinJsonInputError('--stdin-json input is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new StdinJsonInputError('--stdin-json input is not valid JSON', { cause: err });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StdinJsonInputError('--stdin-json input must be one JSON object');
  }

  return parsed as Record<string, unknown>;
}

/** Match the key normalization applied by command parsers in crud.ts. */
function canonicalArgKey(key: string): string {
  return key.replace(/-/g, '_');
}

/**
 * Reject any stdin key that could collide with another arg after the merge.
 *
 * Command parsers (crud.ts) normalize `-` to `_` in arg keys, so `group-id`
 * and `group_id` are the same argument downstream. Two keys that are distinct
 * here but identical after normalization would silently overwrite each other
 * past this point — so every such alias is a hard conflict, whether the pair
 * is stdin-vs-argv or two stdin keys.
 *
 * `__proto__` is rejected outright as a prototype-pollution guard: parsed
 * args flow into downstream handlers that copy them by plain assignment.
 */
function assertNoKeyConflicts(
  stdinArgs: Readonly<Record<string, unknown>>,
  argvArgs: Readonly<Record<string, unknown>>,
): void {
  const argvKeysByCanonical = new Map<string, string>();
  for (const key of Object.keys(argvArgs)) {
    const canonical = canonicalArgKey(key);
    if (!argvKeysByCanonical.has(canonical)) argvKeysByCanonical.set(canonical, key);
  }

  const stdinKeysByCanonical = new Map<string, string>();
  for (const key of Object.keys(stdinArgs)) {
    if (key === '__proto__') {
      throw new StdinJsonInputError('--stdin-json key "__proto__" is not allowed');
    }

    if (Object.prototype.hasOwnProperty.call(argvArgs, key)) {
      throw new StdinJsonInputError(`--stdin-json key "${key}" is also supplied on argv`);
    }

    const canonical = canonicalArgKey(key);
    const argvKey = argvKeysByCanonical.get(canonical);
    if (argvKey !== undefined) {
      throw new StdinJsonInputError(
        `--stdin-json key "${key}" conflicts with argv key "${argvKey}" after CLI key normalization`,
      );
    }

    const priorStdinKey = stdinKeysByCanonical.get(canonical);
    if (priorStdinKey !== undefined) {
      throw new StdinJsonInputError(
        `--stdin-json keys "${priorStdinKey}" and "${key}" conflict after CLI key normalization`,
      );
    }
    stdinKeysByCanonical.set(canonical, key);
  }
}
