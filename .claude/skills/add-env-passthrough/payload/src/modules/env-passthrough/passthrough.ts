/**
 * Env passthrough selection — pure logic, no NanoClaw imports.
 *
 * Given the operator's list of variable names and the values found for them,
 * decide which ones may ride into an agent container. Refusals are reported,
 * never thrown: one bad entry must not stop the container from spawning.
 */

/** `.env` key holding the comma- or space-separated list of names to forward. */
export const PASSTHROUGH_LIST_KEY = 'CONTAINER_ENV_PASSTHROUGH';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names NanoClaw, the credential gateway, or the runtime own. Forwarding them
 * would fight the code that sets them, so they are refused outright.
 */
const RESERVED_RE =
  /^(NANOCLAW_|ANTHROPIC_|CLAUDE_|LD_|DYLD_)|^(PATH|HOME|USER|SHELL|PWD|TZ|NODE_OPTIONS|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY)$/i;

export interface PassthroughSkip {
  name: string;
  reason: 'invalid-name' | 'reserved-name' | 'secret-shaped' | 'unset';
}

export interface PassthroughResult {
  env: Record<string, string>;
  skipped: PassthroughSkip[];
}

/** Split the raw `.env` value into unique names, keeping first-seen order. */
export function parsePassthroughList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

/**
 * @param names    the operator's list (see {@link parsePassthroughList})
 * @param values   the values found for those names
 * @param isSecret true when a key/value pair looks like a credential — such a
 *                 pair is never forwarded, whatever the operator listed
 */
export function selectPassthrough(
  names: string[],
  values: Record<string, string | undefined>,
  isSecret: (key: string, value: string) => boolean,
): PassthroughResult {
  const env: Record<string, string> = {};
  const skipped: PassthroughSkip[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) {
      skipped.push({ name, reason: 'invalid-name' });
    } else if (RESERVED_RE.test(name)) {
      skipped.push({ name, reason: 'reserved-name' });
    } else {
      const value = values[name];
      if (value === undefined || value === '') skipped.push({ name, reason: 'unset' });
      else if (isSecret(name, value)) skipped.push({ name, reason: 'secret-shaped' });
      else env[name] = value;
    }
  }
  return { env, skipped };
}
