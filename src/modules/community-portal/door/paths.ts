/**
 * Door file layout. Everything the door owns lives in one directory
 * (`data/door` on the host): the host key pair, the approved-keys store and
 * the state journal.
 */
import path from 'node:path';

export interface DoorFiles {
  dir: string;
  hostKey: string;
  hostKeyPublic: string;
  keyStore: string;
  state: string;
}

export function doorFiles(dir: string): DoorFiles {
  return {
    dir,
    hostKey: path.join(dir, 'host_ed25519'),
    hostKeyPublic: path.join(dir, 'host_ed25519.pub'),
    keyStore: path.join(dir, 'keys.json'),
    state: path.join(dir, 'state.json'),
  };
}
