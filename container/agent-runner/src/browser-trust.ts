/**
 * Chromium trust for the credential gateway's CA.
 *
 * A gateway that terminates TLS hands the container its CA through
 * NODE_EXTRA_CA_CERTS (Node/Bun) and SSL_CERT_FILE (curl, git, OpenSSL).
 * Chromium reads neither: on Linux it trusts only the system roots plus the
 * user's NSS database at ~/.pki/nssdb. Without this import, every page the
 * agent browser opens through the gateway fails with ERR_CERT_AUTHORITY_INVALID.
 *
 * The database lives in the container's ephemeral HOME and is rebuilt on every
 * spawn, so it always matches the CA the current gateway mounted.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type Run = (cmd: string, args: string[]) => void;

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const defaultRun: Run = (cmd, args) => {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
};

export function trustGatewayCaForChromium(
  opts: {
    caPath?: string;
    home?: string;
    run?: Run;
    log?: (msg: string) => void;
  } = {},
): number {
  const caPath = opts.caPath ?? process.env.NODE_EXTRA_CA_CERTS;
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const run = opts.run ?? defaultRun;
  const log = opts.log ?? (() => {});
  if (!caPath || !fs.existsSync(caPath)) return 0;

  const certs = fs.readFileSync(caPath, 'utf8').match(PEM_BLOCK) ?? [];
  if (certs.length === 0) return 0;

  const nssDir = path.join(home, '.pki', 'nssdb');
  const db = `sql:${nssDir}`;
  try {
    fs.mkdirSync(nssDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(nssDir, 'cert9.db'))) {
      run('certutil', ['-N', '-d', db, '--empty-password']);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ca-'));
    try {
      certs.forEach((pem, i) => {
        const file = path.join(tmp, `${i}.pem`);
        fs.writeFileSync(file, pem + '\n');
        // Same nickname on every spawn: re-adding replaces rather than duplicates.
        run('certutil', ['-A', '-d', db, '-n', `nanoclaw-gateway-ca-${i}`, '-t', 'C,,', '-i', file]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    log(`Trusted ${certs.length} gateway CA certificate(s) for Chromium`);
    return certs.length;
  } catch (err) {
    // Never fatal: the agent still runs, only browser HTTPS through the gateway fails.
    log(`Could not add gateway CA to Chromium trust: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
