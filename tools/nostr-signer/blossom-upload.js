#!/usr/bin/env node
/**
 * blossom-upload — Upload files to Blossom server with BUD-11 Nostr auth.
 *
 * Signs a kind:24242 authorization event via the signing daemon,
 * then PUTs the file to the Blossom server.
 *
 * Usage:
 *   blossom-upload <file>                    Upload a file
 *   blossom-upload <file> --mirror           Mirror from URL instead of uploading bytes
 *   blossom-upload --delete <sha256>         Delete a blob by hash
 *
 * Output: the blob URL on success (e.g., https://blossom.jorgenclaw.ai/<sha256>)
 */

import { connect } from 'net';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { basename, extname } from 'path';

const BLOSSOM_SERVER = process.env.BLOSSOM_SERVER || 'https://blossom.jorgenclaw.ai';
const SIGNER_SOCKET = process.env.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';

function daemonRequest(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SIGNER_SOCKET);
    let data = '';
    sock.on('connect', () => sock.write(JSON.stringify(payload)));
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error(`Bad signer response: ${data.slice(0, 200)}`)); }
    });
    sock.on('error', (err) => reject(new Error(`Signer: ${err.message}`)));
  });
}

async function signAuthEvent(content, tags) {
  const res = await daemonRequest({
    method: 'sign_event',
    params: { kind: 24242, content, tags },
  });
  if (res.error) throw new Error(res.error);
  return res.event;
}

function sha256hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function upload(filePath) {
  const fileBuffer = readFileSync(filePath);
  const hash = sha256hex(fileBuffer);
  const size = statSync(filePath).size;
  const name = basename(filePath);
  const now = Math.floor(Date.now() / 1000);

  const authEvent = await signAuthEvent(
    `Upload ${name}`,
    [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', String(now + 300)],
    ]
  );

  const res = await fetch(`${BLOSSOM_SERVER}/upload`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body}`);
  }

  const result = await res.json();
  console.log(result.url || `${BLOSSOM_SERVER}/${hash}`);
  return result;
}

async function mirror(url) {
  const now = Math.floor(Date.now() / 1000);

  const authEvent = await signAuthEvent(
    `Mirror ${url}`,
    [
      ['t', 'upload'],
      ['expiration', String(now + 300)],
    ]
  );

  const res = await fetch(`${BLOSSOM_SERVER}/mirror`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mirror failed (${res.status}): ${body}`);
  }

  const result = await res.json();
  console.log(result.url || `${BLOSSOM_SERVER}/${result.sha256}`);
  return result;
}

async function deleteBlob(hash) {
  const now = Math.floor(Date.now() / 1000);

  const authEvent = await signAuthEvent(
    `Delete ${hash}`,
    [
      ['t', 'delete'],
      ['x', hash],
      ['expiration', String(now + 300)],
    ]
  );

  const res = await fetch(`${BLOSSOM_SERVER}/${hash}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Nostr ${btoa(JSON.stringify(authEvent))}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Delete failed (${res.status}): ${body}`);
  }

  console.log(`Deleted ${hash}`);
}

// --- Main ---
const args = process.argv.slice(2);

try {
  if (args.includes('--delete')) {
    const hash = args.find(a => a !== '--delete');
    if (!hash) { console.error('Usage: blossom-upload --delete <sha256>'); process.exit(1); }
    await deleteBlob(hash);
  } else if (args.includes('--mirror')) {
    const url = args.find(a => a !== '--mirror');
    if (!url) { console.error('Usage: blossom-upload <url> --mirror'); process.exit(1); }
    await mirror(url);
  } else if (args[0]) {
    await upload(args[0]);
  } else {
    console.error('Usage: blossom-upload <file>');
    console.error('       blossom-upload <url> --mirror');
    console.error('       blossom-upload --delete <sha256>');
    process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
