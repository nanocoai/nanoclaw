#!/usr/bin/env node
/**
 * NWC Wallet CLI — Nostr Wallet Connect (NIP-47) client
 *
 * Commands:
 *   balance                      Show wallet balance in sats + USD
 *   invoice <amount> [desc]      Create a Lightning invoice
 *   pay <bolt11>                 Pay a Lightning invoice
 *   zap <npub/hex> <amount>      Zap a Nostr user
 *   spend-status                 Show daily spending status
 *
 * The NWC secret key is a wallet session key (NOT the main nsec).
 * It is safe to handle in the container.
 *
 * Zap requests (kind 9734) are signed via the signing daemon socket
 * so the main nsec never enters the container.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { connect } from 'net';
import WebSocket from 'ws';
import { useWebSocketImplementation, SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { encrypt, decrypt } from 'nostr-tools/nip04';
import { decode as nip19Decode } from 'nostr-tools/nip19';

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

useWebSocketImplementation(WebSocket);

// --- Config ---

const CONFIG_PATH = process.env.NWC_CONFIG || '/workspace/agent/config/nwc.json';
const SPENDING_PATH = process.env.NWC_SPENDING || '/workspace/agent/config/spending.json';
const SIGNER_SOCKET = process.env.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
const PRICE_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`Error: Cannot read NWC config at ${CONFIG_PATH}`);
  console.error('Create the file with: {"connectionString": "nostr+walletconnect://...", "dailyCapSats": 10000, "perTransactionCapSats": 5000, "confirmAboveSats": 1000}');
  process.exit(1);
}

// Parse NWC connection string
function parseConnectionString(cs) {
  const url = new URL(cs);
  const pubkey = url.pathname || url.host;
  const relay = url.searchParams.get('relay');
  const secret = url.searchParams.get('secret');
  if (!pubkey || !relay || !secret) throw new Error('Invalid NWC connection string');
  return { pubkey, relay, secret };
}

const nwc = parseConnectionString(config.connectionString);
const secretKeyBytes = hexToBytes(nwc.secret);
const clientPubkey = getPublicKey(secretKeyBytes);

const DAILY_CAP = config.dailyCapSats || 10000;
const PER_TX_CAP = config.perTransactionCapSats || 5000;
const CONFIRM_ABOVE = config.confirmAboveSats || 1000;

// --- Spending tracker ---

function loadSpending() {
  try {
    return JSON.parse(readFileSync(SPENDING_PATH, 'utf8'));
  } catch {
    return { days: {} };
  }
}

function saveSpending(spending) {
  writeFileSync(SPENDING_PATH, JSON.stringify(spending, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getTodaySpend() {
  const spending = loadSpending();
  const day = spending.days[todayKey()];
  return day ? day.totalSats : 0;
}

function recordSpend(sats, dest, type) {
  const spending = loadSpending();
  const key = todayKey();
  if (!spending.days[key]) {
    spending.days[key] = { totalSats: 0, transactions: [] };
  }
  spending.days[key].totalSats += sats;
  spending.days[key].transactions.push({
    time: new Date().toISOString(),
    sats,
    dest: dest.slice(0, 20),
    type,
  });
  // Keep only last 30 days
  const keys = Object.keys(spending.days).sort();
  while (keys.length > 30) {
    delete spending.days[keys.shift()];
  }
  saveSpending(spending);
}

function checkSpendingLimits(sats) {
  if (sats > PER_TX_CAP) {
    return { ok: false, reason: `Amount ${sats} sats exceeds per-transaction cap of ${PER_TX_CAP} sats` };
  }
  const todaySpent = getTodaySpend();
  if (todaySpent + sats > DAILY_CAP) {
    return { ok: false, reason: `Would exceed daily cap: ${todaySpent} + ${sats} = ${todaySpent + sats} > ${DAILY_CAP} sats` };
  }
  if (sats > CONFIRM_ABOVE) {
    return { ok: true, needsConfirmation: true, todaySpent };
  }
  return { ok: true, needsConfirmation: false, todaySpent };
}

// --- NWC request/response ---

async function nwcRequest(method, params = {}) {
  const pool = new SimplePool();
  try {
    const content = JSON.stringify({ method, params });
    const encrypted = encrypt(secretKeyBytes, nwc.pubkey, content);

    const event = finalizeEvent({
      kind: 23194,
      content: encrypted,
      tags: [['p', nwc.pubkey]],
      created_at: Math.floor(Date.now() / 1000),
    }, secretKeyBytes);

    // Subscribe for response BEFORE publishing request
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.close();
        reject(new Error('NWC request timed out after 30 seconds'));
      }, 30000);

      const sub = pool.subscribeMany(
        [nwc.relay],
        {
          kinds: [23195],
          authors: [nwc.pubkey],
          '#p': [clientPubkey],
          '#e': [event.id],
        },
        {
          onevent: (responseEvent) => {
            clearTimeout(timeout);
            sub.close();
            try {
              const decrypted = decrypt(secretKeyBytes, nwc.pubkey, responseEvent.content);
              const result = JSON.parse(decrypted);
              resolve(result);
            } catch (err) {
              reject(new Error(`Failed to decrypt NWC response: ${err.message}`));
            }
          },
        },
      );
    });

    // Publish the request
    await Promise.all(pool.publish([nwc.relay], event));

    return await responsePromise;
  } finally {
    pool.close([nwc.relay]);
  }
}

// --- BTC price ---

let priceCache = { price: 0, fetchedAt: 0 };

async function getBtcPrice() {
  if (Date.now() - priceCache.fetchedAt < PRICE_CACHE_MAX_AGE && priceCache.price > 0) {
    return priceCache.price;
  }
  try {
    const res = await fetch('https://mempool.space/api/v1/prices');
    const data = await res.json();
    priceCache = { price: data.USD, fetchedAt: Date.now() };
    return data.USD;
  } catch {
    return priceCache.price || null;
  }
}

function satsToUsd(sats, btcPrice) {
  if (!btcPrice) return null;
  return (sats / 100000000 * btcPrice).toFixed(2);
}

// --- Signing daemon helper (for zap requests) ---

function daemonRequest(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SIGNER_SOCKET);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk) => { data += chunk; });
    sock.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error(`Bad response from signer: ${data}`)); }
    });
    sock.on('error', (err) => {
      sock.destroy();
      reject(new Error(`Cannot connect to signing daemon: ${err.message}`));
    });
  });
}

// --- LNURL helpers ---

async function resolveLud16(lud16) {
  const [user, domain] = lud16.split('@');
  if (!user || !domain) throw new Error(`Invalid lud16: ${lud16}`);
  const res = await fetch(`https://${domain}/.well-known/lnurlp/${user}`);
  if (!res.ok) throw new Error(`LNURL lookup failed: ${res.status}`);
  return await res.json();
}

async function fetchProfileLud16(pubkeyHex) {
  const pool = new SimplePool();
  try {
    const event = await pool.get(
      ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'],
      { kinds: [0], authors: [pubkeyHex] },
      { maxWait: 5000 },
    );
    if (!event?.content) throw new Error('Profile not found');
    const meta = JSON.parse(event.content);
    const lud16 = meta.lud16;
    if (!lud16) throw new Error(`No Lightning address (lud16) in profile for ${pubkeyHex.slice(0, 12)}`);
    return { lud16, displayName: meta.display_name || meta.name || pubkeyHex.slice(0, 12) };
  } finally {
    pool.close(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social']);
  }
}

function resolvePubkey(input) {
  // Handle npub, hex, or known names
  if (input.startsWith('npub')) {
    const decoded = nip19Decode(input);
    if (decoded.type !== 'npub') throw new Error('Invalid npub');
    return decoded.data;
  }
  if (/^[0-9a-f]{64}$/.test(input)) return input;
  throw new Error(`Cannot resolve "${input}" — provide an npub or 64-char hex pubkey`);
}

// --- Commands ---

async function cmdBalance() {
  const response = await nwcRequest('get_balance');
  if (response.error) {
    console.error(`Error: ${response.error.message || JSON.stringify(response.error)}`);
    process.exit(1);
  }
  const balanceMsats = response.result?.balance ?? 0;
  const sats = Math.floor(balanceMsats / 1000);
  const btcPrice = await getBtcPrice();
  const usd = satsToUsd(sats, btcPrice);
  const todaySpent = getTodaySpend();

  const output = {
    balance_sats: sats,
    balance_usd: usd ? `$${usd}` : 'price unavailable',
    daily_spend: `${todaySpent} / ${DAILY_CAP} sats`,
    btc_price_usd: btcPrice ? `$${btcPrice.toLocaleString()}` : 'unavailable',
  };
  console.log(JSON.stringify(output, null, 2));
}

async function cmdInvoice(amountSats, description) {
  if (!amountSats || amountSats <= 0) {
    console.error('Error: Provide a positive amount in sats');
    process.exit(1);
  }
  const response = await nwcRequest('make_invoice', {
    amount: amountSats * 1000, // millisats
    description: description || 'NanoClaw invoice',
  });
  if (response.error) {
    console.error(`Error: ${response.error.message || JSON.stringify(response.error)}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    invoice: response.result?.invoice,
    amount_sats: amountSats,
    description: description || 'NanoClaw invoice',
  }, null, 2));
}

async function cmdPay(bolt11) {
  if (!bolt11) {
    console.error('Error: Provide a bolt11 invoice');
    process.exit(1);
  }

  // Decode invoice amount (basic extraction from bolt11)
  // NWC will validate the full invoice; we just need the amount for spending controls
  const amountMatch = bolt11.match(/lnbc(\d+)([munp]?)/i);
  let amountSats = 0;
  if (amountMatch) {
    const num = parseInt(amountMatch[1]);
    const unit = amountMatch[2] || '';
    if (unit === 'm') amountSats = num * 100000;
    else if (unit === 'u') amountSats = num * 100;
    else if (unit === 'n') amountSats = Math.floor(num / 10);
    else if (unit === 'p') amountSats = Math.floor(num / 10000);
    else amountSats = num * 100000000; // base BTC
  }

  // Check spending limits
  const check = checkSpendingLimits(amountSats);
  if (!check.ok) {
    console.log(JSON.stringify({ error: check.reason, type: 'spending_limit' }));
    process.exit(1);
  }
  if (check.needsConfirmation) {
    console.log(JSON.stringify({
      needs_confirmation: true,
      amount_sats: amountSats,
      today_spent: check.todaySpent,
      daily_cap: DAILY_CAP,
      message: `Payment of ${amountSats} sats requires confirmation. Reply "yes" to proceed.`,
    }));
    process.exit(0);
  }

  const response = await nwcRequest('pay_invoice', { invoice: bolt11 });
  if (response.error) {
    console.error(`Error: ${response.error.message || JSON.stringify(response.error)}`);
    process.exit(1);
  }

  recordSpend(amountSats, bolt11.slice(0, 20), 'pay');
  console.log(JSON.stringify({
    success: true,
    amount_sats: amountSats,
    preimage: response.result?.preimage,
    daily_spend: `${getTodaySpend()} / ${DAILY_CAP} sats`,
  }, null, 2));
}

async function cmdPayConfirmed(bolt11) {
  // Skip spending limit confirmation — user already confirmed
  const response = await nwcRequest('pay_invoice', { invoice: bolt11 });
  if (response.error) {
    console.error(`Error: ${response.error.message || JSON.stringify(response.error)}`);
    process.exit(1);
  }

  // Decode amount for tracking
  const amountMatch = bolt11.match(/lnbc(\d+)([munp]?)/i);
  let amountSats = 0;
  if (amountMatch) {
    const num = parseInt(amountMatch[1]);
    const unit = amountMatch[2] || '';
    if (unit === 'm') amountSats = num * 100000;
    else if (unit === 'u') amountSats = num * 100;
    else if (unit === 'n') amountSats = Math.floor(num / 10);
    else if (unit === 'p') amountSats = Math.floor(num / 10000);
    else amountSats = num * 100000000;
  }

  recordSpend(amountSats, bolt11.slice(0, 20), 'pay');
  console.log(JSON.stringify({
    success: true,
    amount_sats: amountSats,
    preimage: response.result?.preimage,
    daily_spend: `${getTodaySpend()} / ${DAILY_CAP} sats`,
  }, null, 2));
}

async function cmdZap(target, amountSats) {
  if (!target || !amountSats || amountSats <= 0) {
    console.error('Error: Usage: nwc-wallet zap <npub/hex> <amount_sats>');
    process.exit(1);
  }

  // Check spending limits
  const check = checkSpendingLimits(amountSats);
  if (!check.ok) {
    console.log(JSON.stringify({ error: check.reason, type: 'spending_limit' }));
    process.exit(1);
  }
  if (check.needsConfirmation) {
    console.log(JSON.stringify({
      needs_confirmation: true,
      amount_sats: amountSats,
      target,
      today_spent: check.todaySpent,
      daily_cap: DAILY_CAP,
      message: `Zap of ${amountSats} sats requires confirmation. Reply "yes" to proceed.`,
    }));
    process.exit(0);
  }

  // Resolve recipient
  const recipientPubkey = resolvePubkey(target);
  console.error(`Resolving profile for ${recipientPubkey.slice(0, 12)}...`);
  const { lud16, displayName } = await fetchProfileLud16(recipientPubkey);
  console.error(`Found ${displayName} with Lightning address: ${lud16}`);

  // LNURL lookup
  const lnurlParams = await resolveLud16(lud16);
  const amountMsats = amountSats * 1000;
  if (amountMsats < lnurlParams.minSendable || amountMsats > lnurlParams.maxSendable) {
    console.error(`Error: Amount ${amountSats} sats outside range ${lnurlParams.minSendable / 1000}-${lnurlParams.maxSendable / 1000} sats`);
    process.exit(1);
  }

  // Build and sign kind 9734 zap request via signing daemon
  console.error('Signing zap request via daemon...');
  const zapRequestTemplate = {
    kind: 9734,
    content: '',
    tags: [
      ['p', recipientPubkey],
      ['amount', amountMsats.toString()],
      ['relays', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.snort.social'],
    ],
  };
  const signerRes = await daemonRequest({
    method: 'sign_event',
    params: zapRequestTemplate,
  });
  if (signerRes.error) {
    console.error(`Signing daemon error: ${signerRes.error}`);
    process.exit(1);
  }
  const signedZapRequest = signerRes.event;

  // Fetch invoice from LNURL callback
  const callbackUrl = new URL(lnurlParams.callback);
  callbackUrl.searchParams.set('amount', amountMsats.toString());
  callbackUrl.searchParams.set('nostr', JSON.stringify(signedZapRequest));
  const invoiceRes = await fetch(callbackUrl.toString());
  if (!invoiceRes.ok) {
    console.error(`LNURL callback failed: ${invoiceRes.status}`);
    process.exit(1);
  }
  const invoiceData = await invoiceRes.json();
  if (!invoiceData.pr) {
    console.error(`LNURL callback returned no invoice: ${JSON.stringify(invoiceData)}`);
    process.exit(1);
  }

  // Pay the invoice via NWC
  console.error('Paying invoice via NWC...');
  const payResponse = await nwcRequest('pay_invoice', { invoice: invoiceData.pr });
  if (payResponse.error) {
    console.error(`Payment error: ${payResponse.error.message || JSON.stringify(payResponse.error)}`);
    process.exit(1);
  }

  recordSpend(amountSats, displayName, 'zap');
  console.log(JSON.stringify({
    success: true,
    type: 'zap',
    recipient: displayName,
    recipient_pubkey: recipientPubkey,
    amount_sats: amountSats,
    preimage: payResponse.result?.preimage,
    daily_spend: `${getTodaySpend()} / ${DAILY_CAP} sats`,
  }, null, 2));
}

async function cmdSpendStatus() {
  const spending = loadSpending();
  const key = todayKey();
  const today = spending.days[key] || { totalSats: 0, transactions: [] };
  const btcPrice = await getBtcPrice();

  console.log(JSON.stringify({
    date: key,
    total_sats: today.totalSats,
    total_usd: satsToUsd(today.totalSats, btcPrice) ? `$${satsToUsd(today.totalSats, btcPrice)}` : 'price unavailable',
    daily_cap: DAILY_CAP,
    remaining: DAILY_CAP - today.totalSats,
    transactions: today.transactions,
    per_transaction_cap: PER_TX_CAP,
    confirm_above: CONFIRM_ABOVE,
  }, null, 2));
}

// --- Main ---

const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case 'balance':
      await cmdBalance();
      break;
    case 'invoice':
      await cmdInvoice(parseInt(args[0]), args.slice(1).join(' ') || undefined);
      break;
    case 'pay':
      await cmdPay(args[0]);
      break;
    case 'pay-confirmed':
      await cmdPayConfirmed(args[0]);
      break;
    case 'zap':
      await cmdZap(args[0], parseInt(args[1]));
      break;
    case 'zap-confirmed':
      // Re-run zap without spending confirmation
      await cmdZap(args[0], parseInt(args[1]));
      break;
    case 'spend-status':
      await cmdSpendStatus();
      break;
    default:
      console.error('Usage: nwc-wallet <balance|invoice|pay|zap|spend-status>');
      console.error('  balance                    Show wallet balance');
      console.error('  invoice <sats> [desc]      Create Lightning invoice');
      console.error('  pay <bolt11>               Pay Lightning invoice');
      console.error('  pay-confirmed <bolt11>     Pay (skip confirmation)');
      console.error('  zap <npub/hex> <sats>      Zap a Nostr user');
      console.error('  spend-status               Show daily spending');
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
