import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip04 from 'nostr-tools/nip04';
import * as nip59 from 'nostr-tools/nip59';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface NostrChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class NostrChannel implements Channel {
  name = 'nostr';

  private pool: SimplePool | null = null;
  private opts: NostrChannelOpts;
  private privateKey: Uint8Array;
  private publicKey: string;
  private userPubkey: string;
  private relays: string[];
  private subscriptionClosers: Array<{ close: () => void }> = [];

  constructor(
    privateKeyHex: string,
    userPubkeyHex: string,
    relays: string[],
    opts: NostrChannelOpts,
  ) {
    this.privateKey = hexToBytes(privateKeyHex);
    this.publicKey = getPublicKey(this.privateKey);
    this.userPubkey = userPubkeyHex;
    this.relays = relays;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.pool = new SimplePool();

    // Subscribe to gift-wrapped events (kind 1059) addressed to us (NIP-17)
    const subGiftWrap = this.pool.subscribe(this.relays,
      { kinds: [1059], '#p': [this.publicKey] },
    {
      onevent: (event: any) => {
        this.handleGiftWrap(event).catch((err) => {
          logger.error({ err: err.message }, 'Error handling Nostr gift wrap');
        });
      },
    });

    this.subscriptionClosers.push(subGiftWrap);

    // Subscribe to NIP-04 encrypted DMs (kind 4) addressed to us
    const subNip04 = this.pool.subscribe(this.relays,
      { kinds: [4], '#p': [this.publicKey] },
    {
      onevent: (event: any) => {
        this.handleNip04DM(event).catch((err) => {
          logger.error({ err: err.message }, 'Error handling Nostr NIP-04 DM');
        });
      },
    });

    this.subscriptionClosers.push(subNip04);

    // If user pubkey is configured, pre-register the chat so it's
    // ready to receive messages immediately without manual IPC registration.
    // This also stores metadata so the orchestrator knows about the chat.
    if (this.userPubkey) {
      const chatJid = `nostr:${this.userPubkey}`;
      this.opts.onChatMetadata(chatJid, new Date().toISOString(), undefined, 'nostr', false);
    }

    logger.info(
      { pubkey: this.publicKey, userPubkey: this.userPubkey || '(any)', relays: this.relays },
      'Nostr channel connected',
    );
    console.log(`\n  Nostr bot pubkey: ${this.publicKey}`);
    if (this.userPubkey) {
      console.log(`  Nostr user pubkey: ${this.userPubkey}`);
    }
    console.log(`  Nostr relays: ${this.relays.join(', ')}\n`);
  }

  private async handleGiftWrap(event: any): Promise<void> {
    // Unwrap: gift wrap → seal → rumor
    let rumor: any;
    try {
      rumor = nip59.unwrapEvent(event, this.privateKey);
    } catch (err) {
      logger.debug({ err }, 'Failed to unwrap Nostr event, ignoring');
      return;
    }

    // Only handle kind 14 (DMs)
    if (rumor.kind !== 14) return;

    // Skip our own messages (sent from another client)
    if (rumor.pubkey === this.publicKey) return;

    const senderPubkey: string = rumor.pubkey;

    // Validate sender: if userPubkey is configured, only accept DMs
    // from that specific user. This prevents random people from triggering the agent.
    if (this.userPubkey && senderPubkey !== this.userPubkey) {
      logger.debug(
        { sender: senderPubkey, expected: this.userPubkey },
        'Nostr DM from unexpected sender, ignoring',
      );
      return;
    }

    const chatJid = `nostr:${senderPubkey}`;
    const content: string = rumor.content || '';
    const timestamp = new Date((rumor.created_at || 0) * 1000).toISOString();
    const msgId: string = rumor.id || `${senderPubkey}-${rumor.created_at}`;

    // Use truncated hex pubkey as display name (first 8 + last 4 chars)
    const senderName = `${senderPubkey.slice(0, 8)}...${senderPubkey.slice(-4)}`;

    // Store chat metadata for discovery (all validated DMs, even unregistered)
    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'nostr', false);

    // Only deliver message for registered chats
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Nostr chat');
      return;
    }

    // Skip empty messages
    if (!content.trim()) return;

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderPubkey,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, sender: senderName, content: content.slice(0, 200) },
      'Nostr DM stored',
    );
  }

  private async handleNip04DM(event: any): Promise<void> {
    const senderPubkey: string = event.pubkey;

    // Skip our own messages
    if (senderPubkey === this.publicKey) return;

    // Validate sender
    if (this.userPubkey && senderPubkey !== this.userPubkey) {
      logger.debug(
        { sender: senderPubkey, expected: this.userPubkey },
        'Nostr NIP-04 DM from unexpected sender, ignoring',
      );
      return;
    }

    let content: string;
    try {
      content = nip04.decrypt(this.privateKey, senderPubkey, event.content);
    } catch (err) {
      logger.debug({ err }, 'Failed to decrypt NIP-04 DM, ignoring');
      return;
    }

    const chatJid = `nostr:${senderPubkey}`;
    const timestamp = new Date((event.created_at || 0) * 1000).toISOString();
    const msgId: string = event.id || `${senderPubkey}-${event.created_at}`;
    const senderName = `${senderPubkey.slice(0, 8)}...${senderPubkey.slice(-4)}`;

    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'nostr', false);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Nostr chat');
      return;
    }

    if (!content.trim()) return;

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderPubkey,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName, content: content.slice(0, 200) }, 'Nostr NIP-04 DM stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.pool) {
      logger.warn('Nostr pool not initialized');
      return;
    }

    try {
      const recipientPubkey = jid.replace(/^nostr:/, '');

      // Look up recipient's preferred relays (kind 10050) — fall back to our relays
      const targetRelays = await this.getRecipientRelays(recipientPubkey);

      // Send as NIP-04 (kind 4) for compatibility with clients like Damus
      const encrypted = nip04.encrypt(this.privateKey, recipientPubkey, text);
      const event = {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: encrypted,
        pubkey: this.publicKey,
      };

      // Sign and publish
      const signed = finalizeEvent(event, this.privateKey);
      await Promise.all(this.pool.publish(targetRelays, signed));

      logger.info({ jid, length: text.length }, 'Nostr DM sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Nostr DM');
    }
  }

  private async getRecipientRelays(pubkey: string): Promise<string[]> {
    if (!this.pool) return this.relays;

    try {
      // Query kind 10050 (NIP-17 relay preferences) from our connected relays
      const event = await this.pool.get(this.relays, {
        kinds: [10050],
        authors: [pubkey],
      });

      if (event) {
        const relays = event.tags
          .filter((t: string[]) => t[0] === 'relay')
          .map((t: string[]) => t[1])
          .filter(Boolean);
        if (relays.length > 0) return relays;
      }
    } catch (err) {
      logger.debug({ pubkey, err }, 'Failed to fetch recipient relays');
    }

    // Fall back to our own relays
    return this.relays;
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('nostr:');
  }

  async disconnect(): Promise<void> {
    for (const sub of this.subscriptionClosers) {
      sub.close();
    }
    this.subscriptionClosers = [];
    if (this.pool) {
      this.pool.close(this.relays);
      this.pool = null;
    }
    logger.info('Nostr channel stopped');
  }

  /**
   * Generate a new Nostr keypair. Returns hex-encoded private key and public key.
   * Used during interactive setup when the user doesn't have a key.
   */
  static generateKeypair(): { privateKey: string; publicKey: string } {
    const sk = generateSecretKey();
    return {
      privateKey: bytesToHex(sk),
      publicKey: getPublicKey(sk),
    };
  }
}
