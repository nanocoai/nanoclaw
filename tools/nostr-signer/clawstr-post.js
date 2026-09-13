#!/usr/bin/env node
/**
 * clawstr-post — Signs and publishes Nostr events via the signing daemon.
 *
 * Replaces `npx clawstr post` by delegating signing to the daemon socket
 * instead of reading a hex key file. The private key never enters the container.
 *
 * Usage:
 *   clawstr-post post <subclaw> "content"
 *   clawstr-post reply <event-id> "content"
 *   clawstr-post upvote <event-id>
 *   clawstr-post pubkey
 *   clawstr-post sign '{"kind":1,"content":"hello","tags":[]}'
 */

import { connect } from 'net';
import WebSocket from 'ws';

const SOCKET_PATH = process.env.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
const DEFAULT_RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://purplepag.es').split(',');

// --- Socket helpers ---

function daemonRequest(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`Bad response from signer: ${data}`)); }
    });
    sock.on('error', (err) => reject(new Error(`Cannot connect to signing daemon at ${SOCKET_PATH}: ${err.message}`)));
  });
}

async function signEvent(kind, content, tags) {
  const res = await daemonRequest({
    method: 'sign_event',
    params: { kind, content, tags },
  });
  if (res.error) throw new Error(res.error);
  return res.event;
}

async function getPubkey() {
  const res = await daemonRequest({ method: 'get_public_key' });
  if (res.error) throw new Error(res.error);
  return res.pubkey;
}

// --- Relay publishing (lightweight, no dependencies) ---

async function publishToRelays(event) {
  const results = [];
  const promises = DEFAULT_RELAYS.map(async (url) => {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 10000);
        ws.on('open', () => {
          ws.send(JSON.stringify(['EVENT', event]));
        });
        ws.on('message', (msg) => {
          const parsed = JSON.parse(msg.toString());
          if (parsed[0] === 'OK' && parsed[1] === event.id) {
            clearTimeout(timeout);
            if (parsed[2]) {
              results.push(url);
            }
            ws.close();
            resolve();
          }
        });
        ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
      });
    } catch (e) {
      // relay failed, skip
    }
  });
  await Promise.allSettled(promises);
  return results;
}

// --- Commands ---

async function cmdPost(subclaw, content) {
  if (!subclaw || !content) {
    console.error('Usage: clawstr-post post <subclaw> "content"');
    process.exit(1);
  }
  let name = subclaw.replace(/^(https:\/\/clawstr\.com)?\/c\//, '').replace(/^\/+/, '');
  const subclawUrl = `https://clawstr.com/c/${name}`;
  const tags = [
    ['I', subclawUrl], ['K', 'web'],
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(1111, content, tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.log(`${subclawUrl}/post/${event.id}`);
    console.error(`Posted to ${relays.length} relay(s)`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdReply(eventId, subclaw, content) {
  if (!eventId || !subclaw || !content) {
    console.error('Usage: clawstr-post reply <event-id> <subclaw> "content"');
    process.exit(1);
  }
  const subclawUrl = `https://clawstr.com/c/${subclaw}`;
  const postUrl = `https://clawstr.com/c/${subclaw}/post/${eventId}`;
  const tags = [
    ['I', subclawUrl], ['K', 'web'],
    ['i', postUrl], ['k', '1111'],
    ['e', eventId, '', 'reply'],
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(1111, content, tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.log(event.id);
    console.error(`Reply published to ${relays.length} relay(s)`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdUpvote(eventId, authorPubkey) {
  if (!eventId) {
    console.error('Usage: clawstr-post upvote <event-id> [author-pubkey]');
    process.exit(1);
  }
  const tags = [
    ['e', eventId],
    ...(authorPubkey ? [['p', authorPubkey]] : []),
    ['L', 'agent'], ['l', 'ai', 'agent'],
    ['client', 'clawstr-cli'],
  ];
  const event = await signEvent(7, '+', tags);
  const relays = await publishToRelays(event);
  if (relays.length > 0) {
    console.error(`Upvoted (${relays.length} relay(s))`);
  } else {
    console.error('Failed to publish to any relay');
    process.exit(1);
  }
}

async function cmdSign(jsonStr) {
  if (!jsonStr) {
    console.error('Usage: clawstr-post sign \'{"kind":1,"content":"...","tags":[]}\'');
    process.exit(1);
  }
  const params = JSON.parse(jsonStr);
  const event = await signEvent(params.kind, params.content, params.tags || []);
  console.log(JSON.stringify(event));
}

// --- Main ---

const [,, cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case 'post':    await cmdPost(args[0], args.slice(1).join(' ')); break;
    case 'reply':   await cmdReply(args[0], args[1], args.slice(2).join(' ')); break;
    case 'upvote':  await cmdUpvote(args[0], args[1]); break;
    case 'pubkey':  console.log(await getPubkey()); break;
    case 'sign':    await cmdSign(args[0]); break;
    default:
      console.error('Commands: post, reply, upvote, pubkey, sign');
      console.error('Example: clawstr-post post ai-freedom "Hello from the daemon!"');
      process.exit(1);
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
