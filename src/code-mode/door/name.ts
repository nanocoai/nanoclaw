/**
 * The account name chosen at `ncl sandboxes remote enable --name <name>`.
 *
 * It becomes a DNS label once the network side allocates an address for it,
 * and the default sandbox created on first landing is named after it — so it
 * must satisfy both grammars: a DNS label (lowercase letters, digits and
 * hyphens, 3–32 characters, no leading, trailing or double hyphen) that is
 * also a legal sandbox name, and not a word the address space keeps for
 * itself.
 */
export const ACCOUNT_NAME_MIN = 3;
export const ACCOUNT_NAME_MAX = 32;

const ACCOUNT_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const RESERVED_ACCOUNT_NAMES: ReadonlySet<string> = new Set([
  // the group folder layout
  'global',
  // common service labels
  'access',
  'account',
  'admin',
  'api',
  'app',
  'apps',
  'auth',
  'dashboard',
  'dev',
  'docs',
  'help',
  'login',
  'mail',
  'registry',
  'relay',
  'smtp',
  'sso',
  'staging',
  'status',
  'test',
  'vault',
  'www',
  // the terminal address space and its verbs
  'approve',
  'attach',
  'cell',
  'demo',
  'door',
  'ipv6',
  'list',
  'ls',
  'nanoclaw',
  'nanoco',
  'new',
  'ns1',
  'ns2',
  'portal',
  'remote',
  'rename',
  'sandbox',
  'sandboxes',
  'ssh',
  'terminal',
  'v6',
]);

export function accountNameError(name: string): string | undefined {
  if (name.length < ACCOUNT_NAME_MIN || name.length > ACCOUNT_NAME_MAX) {
    return `name must be ${ACCOUNT_NAME_MIN}–${ACCOUNT_NAME_MAX} characters`;
  }
  if (!ACCOUNT_NAME.test(name) || name.includes('--')) {
    return 'name must use lowercase letters, digits and single hyphens only, and cannot start or end with a hyphen';
  }
  if (RESERVED_ACCOUNT_NAMES.has(name)) return `'${name}' is reserved`;
  return undefined;
}

export function validateAccountName(name: string): string {
  const problem = accountNameError(name);
  if (problem) throw new Error(`invalid account name "${name}" — ${problem}`);
  return name;
}
