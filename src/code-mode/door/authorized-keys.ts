/**
 * The door's AuthorizedKeysCommand: `<doorDir> %f %t %k` → zero or one
 * authorized_keys line on stdout. The fingerprint is recomputed from the key
 * rather than trusted from `%f`, the store is updated (pending admissions
 * and the rate limit live there), and a refused key prints nothing, which the
 * server reports as an ordinary public-key failure.
 */
import { admitKey, authorizedKeysLine, parsePublicKey, readKeyStore, writeKeyStore } from './keys.js';
import { doorFiles, isMainModule } from './paths.js';

export async function runAuthorizedKeys(
  argv: string[],
  out: (line: string) => void,
  now: Date = new Date(),
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
  const files = doorFiles(doorDir);
  const result = admitKey(await readKeyStore(files.keyStore), key, now);
  if (result.changed) await writeKeyStore(files.keyStore, result.store);
  const line = authorizedKeysLine(result.verdict, key, doorDir);
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
