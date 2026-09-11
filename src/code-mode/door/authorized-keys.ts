/**
 * The door's AuthorizedKeysCommand: `<doorDir> %f %t %k` → zero or one
 * authorized_keys line on stdout. The fingerprint is recomputed from the key
 * rather than trusted from `%f`; the host answers over the door socket
 * whether it is approved, unknown or the door is disabled. Approved keys are
 * pinned to the landing program, unknown ones to the waiting room; disabled,
 * or a host that does not answer, prints nothing, which the server reports
 * as an ordinary public-key failure.
 */
import { authorize } from './door-client.js';
import { authorizedKeysLine, parsePublicKey } from './keys.js';
import { doorFiles, isMainModule } from './paths.js';
import { readDoorState } from './state.js';

export interface AuthorizedKeysDeps {
  authorize: typeof authorize;
}

export async function runAuthorizedKeys(
  argv: string[],
  out: (line: string) => void,
  deps: AuthorizedKeysDeps = { authorize },
): Promise<number> {
  const [doorDir, , type, base64] = argv;
  if (!doorDir || !type || !base64) return 2;
  let key;
  try {
    key = parsePublicKey(`${type} ${base64}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`authorized-keys: ${error.message}\n`);
    return 1;
  }
  const state = await readDoorState(doorFiles(doorDir).state);
  if (!state?.enabled) return 0;
  let status;
  try {
    status = await deps.authorize(state.hostSocketPath, key.fingerprint);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`authorized-keys: ${error.message}\n`);
    return 0;
  }
  if (status === 'disabled') return 0;
  const line = authorizedKeysLine(status === 'approved' ? 'approved' : 'pending', key, doorDir);
  if (line) out(line);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runAuthorizedKeys(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`authorized-keys: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
