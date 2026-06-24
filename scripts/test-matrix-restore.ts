/**
 * End-to-end test for the Matrix 4S/SSSS crypto-store restore path.
 *
 * Requires a local Synapse homeserver with a pre-created test user.
 * See the setup instructions at the top of the test runner section below.
 *
 * Run:
 *   TEST_MATRIX_BASE_URL=http://localhost:8008 \
 *   TEST_MATRIX_USERNAME=nanoclaw-test \
 *   TEST_MATRIX_PASSWORD=<password> \
 *   TEST_MATRIX_RECOVERY_KEY=<passphrase> \
 *   npx tsx scripts/test-matrix-restore.ts
 *
 * Phases:
 *   1. First start — bootstrap cross-signing + 4S, verify green shield state
 *   2. Wipe crypto store
 *   3. Restart — restore from account data, verify device is still cross-signed
 */
import { rmSync, existsSync } from 'node:fs';
import {
  MatrixClient,
  MatrixAuth,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
} from 'matrix-bot-sdk';

const STORE_SQLITE = 0;

const BASE_URL = process.env.TEST_MATRIX_BASE_URL!;
const USERNAME = process.env.TEST_MATRIX_USERNAME ?? 'nanoclaw-test';
const PASSWORD = process.env.TEST_MATRIX_PASSWORD!;
const RECOVERY_KEY = process.env.TEST_MATRIX_RECOVERY_KEY!;
const CRYPTO_STORE = '/tmp/nanoclaw-test-crypto';
const FS_STORE = '/tmp/nanoclaw-test-store.json';

// Fetch the access token once at startup — kept across crypto-store wipes.
let ACCESS_TOKEN = '';

function wipeCryptoOnly() {
  if (existsSync(CRYPTO_STORE)) rmSync(CRYPTO_STORE, { recursive: true });
  if (existsSync(FS_STORE)) rmSync(FS_STORE);
  console.log('[wipe] crypto store and fs store deleted');
}

async function makeClient() {
  const storage = new SimpleFsStorageProvider(FS_STORE);
  const crypto = new RustSdkCryptoStorageProvider(CRYPTO_STORE, STORE_SQLITE);

  const client = new MatrixClient(BASE_URL, ACCESS_TOKEN, storage, crypto);
  await client.crypto!.prepare(await client.getJoinedRooms());
  return client;
}

async function bootstrapPhase() {
  console.log('\n=== Phase 1: Bootstrap ===');
  wipeCryptoOnly();

  const client = await makeClient();
  const machine = (client.crypto as any).engine?.machine;
  const engine = (client.crypto as any).engine;

  if (!engine?.bootstrapCrossSigning) {
    throw new Error('Patch not applied — bootstrapCrossSigning missing');
  }

  // Cross-signing bootstrap
  const whoami = await (await fetch(`${BASE_URL}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  })).json() as { user_id: string };
  const uiaCallback = async (uia: any) => ({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: whoami.user_id },
    password: PASSWORD,
    session: uia.session,
  });
  await engine.bootstrapCrossSigning(uiaCallback, false);

  const cs1 = await machine.crossSigningStatus();
  console.log(`[phase1] crossSigningStatus after bootstrap: hasMaster=${cs1.hasMaster} hasSelfSigning=${cs1.hasSelfSigning}`);
  if (!cs1.hasMaster || !cs1.hasSelfSigning) throw new Error('Bootstrap failed — not cross-signed');

  // 4S bootstrap — patch the engine temporarily to trace what happens
  const origBootstrap = engine.bootstrapSecretStorageFromPassphrase.bind(engine);
  try {
    await origBootstrap(RECOVERY_KEY);
    console.log('[phase1] bootstrapSecretStorageFromPassphrase returned without throwing');
  } catch (err: any) {
    throw new Error(`4S bootstrap threw: ${err.message}`);
  }
  const bk1 = await machine.getBackupKeys();
  console.log(`[phase1] backup keys after 4S: version=${bk1.backupVersion ?? 'none'} decryptionKey=${bk1.decryptionKey ? 'present' : 'none'}`);
  if (!bk1.backupVersion) throw new Error('4S bootstrap failed — no backup version');

  console.log('[phase1] ✅ Bootstrap complete');
  client.stop?.();
  return bk1.backupVersion;
}

async function restorePhase(expectedBackupVersion: string) {
  console.log('\n=== Phase 2: Wipe crypto store + delete old device session ===');
  wipeCryptoOnly();

  // After losing the crypto store, the old device session is unusable (its OTKs
  // are on the server but we no longer have the private keys). Delete the old
  // device and re-login to get a fresh session before restoring from 4S.
  const deleteResp = await fetch(`${BASE_URL}/_matrix/client/v3/logout`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`[phase2] logout status: ${deleteResp.status}`);

  // Re-login to get a fresh device
  const auth = new MatrixAuth(BASE_URL);
  const loginResp = await auth.passwordLogin(USERNAME, PASSWORD, undefined, 'TESTBOT-RESTORE');
  ACCESS_TOKEN = loginResp.accessToken;
  console.log(`[phase2] New device after re-login: ${loginResp.deviceId}`);

  console.log('\n=== Phase 3: Restore cross-signing keys from 4S ===');

  const client = await makeClient();
  const machine = (client.crypto as any).engine?.machine;
  const engine = (client.crypto as any).engine;

  // Confirm keys are gone after wipe
  const csBefore = await machine.crossSigningStatus();
  console.log(`[phase3] crossSigningStatus after wipe: hasMaster=${csBefore.hasMaster} hasSelfSigning=${csBefore.hasSelfSigning}`);

  if (csBefore.hasMaster && csBefore.hasSelfSigning) {
    throw new Error('Unexpected: crypto store not fully wiped, cross-signing still present');
  }

  if (!engine?.restoreSecretsFromSecretStorage) {
    throw new Error('Patch not applied — restoreSecretsFromSecretStorage missing');
  }

  // Restore from 4S
  try {
    await engine.restoreSecretsFromSecretStorage(RECOVERY_KEY);
  } catch (err: any) {
    console.error('[phase3] restoreSecretsFromSecretStorage threw:', err?.message ?? err);
    throw err;
  }

  const csAfter = await machine.crossSigningStatus();
  console.log(`[phase3] crossSigningStatus after restore: hasMaster=${csAfter.hasMaster} hasSelfSigning=${csAfter.hasSelfSigning}`);
  if (!csAfter.hasMaster || !csAfter.hasSelfSigning) throw new Error('Restore failed — not cross-signed after restore');

  const bkAfter = await machine.getBackupKeys();
  console.log(`[phase3] backup keys after restore: version=${bkAfter.backupVersion ?? 'none'}`);
  if (bkAfter.backupVersion !== expectedBackupVersion) {
    throw new Error(`Backup version mismatch: expected ${expectedBackupVersion}, got ${bkAfter.backupVersion}`);
  }

  console.log('[phase3] ✅ Restore complete — same backup version, device re-cross-signed');
  client.stop?.();
}

async function main() {
  if (!BASE_URL) throw new Error('TEST_MATRIX_BASE_URL is required');
  if (!PASSWORD) throw new Error('TEST_MATRIX_PASSWORD is required');
  if (!RECOVERY_KEY) throw new Error('TEST_MATRIX_RECOVERY_KEY is required');

  // Login once — token reused across phases.
  console.log('[setup] Logging in as test bot...');
  const auth = new MatrixAuth(BASE_URL);
  const resp = await auth.passwordLogin(USERNAME, PASSWORD, undefined, 'TESTBOT');
  ACCESS_TOKEN = resp.accessToken;
  console.log(`[setup] Got access token (device: ${resp.deviceId})`);

  const backupVersion = await bootstrapPhase();
  await restorePhase(backupVersion);

  // Cleanup
  wipeCryptoOnly();
  console.log('\n✅ All phases passed');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  wipeCryptoOnly();
  process.exit(1);
});
