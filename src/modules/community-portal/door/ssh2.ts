/**
 * The SSH protocol library, loaded on first need.
 *
 * `ssh2` is the one dependency the door adds to the host. A host that never
 * enables remote access never loads it: the server, the host key and the
 * session handler ask for it here, and the door brings it in the moment it
 * first listens or mints a host key. ssh2 is a CommonJS module, so only its
 * default export is reachable from Node ESM.
 */
import type ssh2 from 'ssh2';

export type Ssh2 = typeof ssh2;

let loaded: Ssh2 | undefined;
let loading: Promise<Ssh2> | undefined;

/** Load (once) and return the library. */
export function loadSsh2(): Promise<Ssh2> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import('ssh2').then((module) => {
    loaded = module.default;
    return loaded;
  });
  return loading;
}

/**
 * The library, once loaded. The door's server loads it before it accepts a
 * connection, so a session handler may call this synchronously; anything
 * else must `await loadSsh2()` first.
 */
export function ssh2Loaded(): Ssh2 {
  if (!loaded) throw new Error('the SSH library is not loaded yet; the door loads it before it listens');
  return loaded;
}
