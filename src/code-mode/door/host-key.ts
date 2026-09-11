/**
 * The door's host key: one ed25519 pair under the door directory, generated
 * in-process the first time and kept across disable. A key an earlier build
 * generated with ssh-keygen loads the same way (OpenSSH format either way).
 * The fingerprint is the `SHA256:…` form `ssh-keygen -lf` prints, so what
 * the account service shows and what the client's first-connect prompt
 * shows are one and the same.
 */
import fs from 'node:fs';
// ssh2 is a CommonJS module: only its default export is reachable from Node ESM.
import ssh2, { type ParsedKey } from 'ssh2';

import { fingerprintOf } from './keys.js';
import type { DoorFiles } from './paths.js';

const { utils } = ssh2;

export interface HostKey {
  /** The private key file's contents, as the server wants them. */
  privateKey: string;
  /** `<type> <base64>` — the public key line. */
  publicKey: string;
  fingerprint: string;
  type: string;
}

function firstKey(parsed: ReturnType<typeof utils.parseKey>): ParsedKey {
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) throw new Error(`the door host key is unreadable: ${key.message}`, { cause: key });
  if (!key) throw new Error('the door host key file holds no key');
  return key;
}

export async function ensureHostKey(files: DoorFiles): Promise<HostKey> {
  await fs.promises.mkdir(files.dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(files.hostKey)) {
    const pair = utils.generateKeyPairSync('ed25519', { comment: 'nanoclaw-door' });
    const privateText = pair.private.endsWith('\n') ? pair.private : `${pair.private}\n`;
    await fs.promises.writeFile(files.hostKey, privateText, { mode: 0o600 });
    await fs.promises.writeFile(files.hostKeyPublic, `${pair.public}\n`, { mode: 0o644 });
  }
  const privateKey = await fs.promises.readFile(files.hostKey, 'utf8');
  const key = firstKey(utils.parseKey(privateKey));
  if (!key.isPrivateKey()) throw new Error('the door host key file holds a public key only');
  const blob = key.getPublicSSH();
  const publicKey = `${key.type} ${blob.toString('base64')}`;
  if (!fs.existsSync(files.hostKeyPublic)) {
    await fs.promises.writeFile(files.hostKeyPublic, `${publicKey} nanoclaw-door\n`, { mode: 0o644 });
  }
  return { privateKey, publicKey, fingerprint: fingerprintOf(blob), type: key.type };
}
