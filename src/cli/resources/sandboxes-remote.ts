/**
 * `ncl sandboxes remote …` — the door's operator verbs, spread into the
 * sandboxes resource. All hostOnly: enabling remote access, and deciding
 * which terminal keys may land in a sandbox, is a host-side act.
 */
import {
  addDoorKey,
  approveDoorKey,
  disableDoor,
  doorStatus,
  enableDoor,
  listDoorKeys,
  revokeDoorKey,
  type DoorSummary,
} from '../../code-mode/door/index.js';
import type { KeyStore } from '../../code-mode/door/keys.js';
import { validateAccountName } from '../../code-mode/door/name.js';
import type { CustomOperation } from '../crud.js';

function positional(args: Record<string, unknown>, flag: string): string | undefined {
  const value = args[flag] ?? args.id;
  return value === undefined || value === true ? undefined : String(value);
}

function renderSummary(data: unknown): string {
  const s = data as DoorSummary;
  const door = s.door;
  const lines = [
    s.enabled ? `Remote terminal access is enabled for "${s.name}".` : 'Remote terminal access is disabled.',
  ];
  if (s.enabled) {
    if (s.host) lines.push(`  address     ssh ${s.host}`);
    if (s.previousName) lines.push(`  renamed     from "${s.previousName}" — your address changed`);
    lines.push(
      `  door        127.0.0.1:${s.doorPort} — ${door.running ? `running (pid ${door.pid})` : 'not running'}${
        'failure' in door && door.failure ? ` — ${door.failure}` : ''
      }`,
      ...(s.host
        ? []
        : ['              loopback only; reachable over the network once the account link relays terminals']),
      `  host key    ${s.hostKeyFingerprint} (ed25519)`,
      `  keys        ${s.keys.approved} approved here, ${s.keys.browser} approved in the browser, ${s.keys.pending} pending` +
        (s.keys.approved + s.keys.browser === 0
          ? ' — add one: ncl sandboxes remote keys add ~/.ssh/id_ed25519.pub'
          : ''),
      `  approvals   ${s.approvalUrl}`,
    );
  }
  return lines.join('\n');
}

function renderKeys(data: unknown): string {
  const store = data as KeyStore;
  const browser = store.mirror?.fingerprints ?? [];
  if (store.approved.length === 0 && store.pending.length === 0 && browser.length === 0) {
    return 'no terminal keys — add one: ncl sandboxes remote keys add ~/.ssh/id_ed25519.pub';
  }
  const lines: string[] = [];
  if (store.approved.length) {
    lines.push('APPROVED');
    for (const k of store.approved) lines.push(`  ${k.fingerprint}  ${k.label}  since ${k.approvedAt}`);
  }
  if (browser.length) {
    lines.push('APPROVED IN THE BROWSER');
    for (const fingerprint of browser) lines.push(`  ${fingerprint}`);
  }
  if (store.pending.length) {
    lines.push('PENDING (approve with: ncl sandboxes remote keys approve <fingerprint>)');
    for (const k of store.pending)
      lines.push(`  ${k.fingerprint}  from ${k.source ?? 'remote'}  first seen ${k.firstSeenAt}`);
  }
  return lines.join('\n');
}

export const remoteOperations: Record<string, CustomOperation> = {
  'remote enable': {
    access: 'open',
    hostOnly: true,
    description:
      'Enable remote terminal access to this machine’s sandboxes (host operators only).\n' +
      'Usage: ncl sandboxes remote enable [--name <account-name>]. The name (3–32 lowercase letters, digits ' +
      'and single hyphens) becomes this machine’s address and names the default sandbox a remote terminal ' +
      'lands in; when omitted, the account assigns one and the command prints the address. Generates a host ' +
      'key once, starts a loopback OpenSSH listener owned by the host, and keeps it running across host ' +
      'restarts until `remote disable`.',
    examples: ['ncl sandboxes remote enable', 'ncl sandboxes remote enable --name my-machine'],
    handler: async (args) => {
      const name = positional(args, 'name');
      return enableDoor(name === undefined ? {} : { name: validateAccountName(name) });
    },
    formatHuman: renderSummary,
  },
  'remote disable': {
    access: 'open',
    hostOnly: true,
    description:
      'Disable remote terminal access: stop the loopback listener and keep it stopped across restarts ' +
      '(host operators only). Approved keys are kept.\nUsage: ncl sandboxes remote disable',
    handler: async () => disableDoor(),
    formatHuman: renderSummary,
  },
  'remote status': {
    access: 'open',
    hostOnly: true,
    description: 'Show remote terminal access state, the listener, and key counts (host operators only).',
    handler: async () => doorStatus(),
    formatHuman: renderSummary,
  },
  'remote keys list': {
    access: 'open',
    hostOnly: true,
    description:
      'List terminal keys: approved ones land in a sandbox, pending ones are waiting for approval ' +
      '(host operators only).\nUsage: ncl sandboxes remote keys list',
    handler: async () => listDoorKeys(),
    formatHuman: renderKeys,
  },
  'remote keys add': {
    access: 'open',
    hostOnly: true,
    description:
      'Approve a terminal public key directly (host operators only).\n' +
      'Usage: ncl sandboxes remote keys add <public-key-or-file> [--label <text>]. Accepts an OpenSSH ' +
      'public key line or the path of a .pub file.',
    examples: ['ncl sandboxes remote keys add ~/.ssh/id_ed25519.pub --label laptop'],
    handler: async (args) => {
      const key = positional(args, 'key');
      if (!key) throw new Error('usage: ncl sandboxes remote keys add <public-key-or-file> [--label <text>]');
      return addDoorKey(key, args.label === undefined ? undefined : String(args.label));
    },
    formatHuman: (data) => `approved ${(data as { fingerprint: string }).fingerprint}`,
  },
  'remote keys approve': {
    access: 'open',
    hostOnly: true,
    description:
      'Approve a key that is waiting after connecting once (host operators only).\n' +
      'Usage: ncl sandboxes remote keys approve <fingerprint> [--label <text>]',
    handler: async (args) => {
      const fingerprint = positional(args, 'fingerprint');
      if (!fingerprint) throw new Error('usage: ncl sandboxes remote keys approve <fingerprint>');
      return approveDoorKey(fingerprint, args.label === undefined ? undefined : String(args.label));
    },
    formatHuman: (data) => `approved ${(data as { fingerprint: string }).fingerprint}`,
  },
  'remote keys revoke': {
    access: 'open',
    hostOnly: true,
    description:
      'Revoke a key approved on this machine and end its sessions; its next connection lands in the ' +
      'waiting room again (host operators only). Keys approved in the browser are revoked there.\n' +
      'Usage: ncl sandboxes remote keys revoke <fingerprint>',
    handler: async (args) => {
      const fingerprint = positional(args, 'fingerprint');
      if (!fingerprint) throw new Error('usage: ncl sandboxes remote keys revoke <fingerprint>');
      return revokeDoorKey(fingerprint);
    },
    formatHuman: (data) => `revoked ${(data as { fingerprint: string }).fingerprint}`,
  },
};
