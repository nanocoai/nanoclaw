/**
 * IMAP client for Proton Bridge
 * Handles read operations: list, get, search, unread, thread, mark
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

/**
 * Create a short-lived IMAP connection, run `fn`, then close.
 */
function withImap(config, fn) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.username,
      password: config.password,
      host: config.imap_host || '127.0.0.1',
      port: config.imap_port || 1143,
      tls: false,
      authTimeout: 10000,
    });

    imap.once('ready', () => {
      fn(imap)
        .then((result) => {
          imap.end();
          resolve(result);
        })
        .catch((err) => {
          imap.end();
          reject(err);
        });
    });

    imap.once('error', (err) => reject(new Error(`IMAP connection failed: ${err.message}. Is Proton Bridge running?`)));
    imap.connect();
  });
}

/**
 * Fetch messages by sequence numbers. Returns parsed message objects.
 */
function fetchMessages(imap, seqnos, bodiesOpt = '') {
  return new Promise((resolve, reject) => {
    if (seqnos.length === 0) { resolve([]); return; }

    const messages = [];
    const f = imap.fetch(seqnos, { bodies: bodiesOpt, struct: true });

    f.on('message', (msg, seqno) => {
      let raw = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      });
      msg.once('end', () => {
        messages.push({ seqno, raw });
      });
    });

    f.once('error', reject);
    f.once('end', async () => {
      const parsed = [];
      for (const m of messages) {
        try {
          const mail = await simpleParser(m.raw);
          parsed.push({
            id: m.seqno,
            subject: mail.subject || '(no subject)',
            from: mail.from?.text || 'unknown',
            to: mail.to?.text || '',
            cc: mail.cc?.text || '',
            date: mail.date?.toISOString() || '',
            body: mail.text || mail.html || '',
            message_id_header: mail.messageId || null,
            in_reply_to: mail.inReplyTo || null,
            references: mail.references || [],
            seen: true, // will be overridden by caller if needed
          });
        } catch {
          parsed.push({ id: m.seqno, subject: '(parse error)', from: '', to: '', date: '', body: '', message_id_header: null, in_reply_to: null, references: [], seen: true });
        }
      }
      resolve(parsed);
    });
  });
}

/**
 * Open INBOX and return box info.
 */
function openInbox(imap, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

/**
 * IMAP SEARCH wrapper.
 */
function imapSearch(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results || []);
    });
  });
}

// --- Exported operations ---

export async function getUnread(config) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const uids = await imapSearch(imap, ['UNSEEN']);
    if (uids.length === 0) return { count: 0, messages: [] };

    const recent = uids.slice(-20);
    const messages = await fetchMessages(imap, recent, 'HEADER');
    return {
      count: uids.length,
      messages: messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        date: m.date,
      })),
    };
  });
}

export async function listMessages(config, limit = 10) {
  return withImap(config, async (imap) => {
    const box = await openInbox(imap, true);
    const total = box.messages.total;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    const messages = await fetchMessages(imap, range, 'HEADER');

    // Check which are unseen
    const unseenIds = new Set(await imapSearch(imap, ['UNSEEN']));
    return messages
      .map((m) => ({ ...m, seen: !unseenIds.has(m.id), body: undefined }))
      .reverse();
  });
}

export async function getMessage(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const messages = await fetchMessages(imap, [messageId], '');
    if (messages.length === 0) throw new Error(`Message ${messageId} not found`);
    return messages[0];
  });
}

export async function searchMessages(config, query) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const uids = await imapSearch(imap, [['TEXT', query]]);
    if (uids.length === 0) return [];

    const recent = uids.slice(-10);
    const messages = await fetchMessages(imap, recent, 'HEADER');
    return messages.map((m) => ({ ...m, body: undefined }));
  });
}

export async function getMessageHeaders(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);
    const messages = await fetchMessages(imap, [messageId], 'HEADER');
    if (messages.length === 0) throw new Error(`Message ${messageId} not found`);
    return {
      messageId: messages[0].message_id_header,
      subject: messages[0].subject,
      from: messages[0].from,
      to: messages[0].to,
      cc: messages[0].cc || null,
      references: messages[0].references,
      inReplyTo: messages[0].in_reply_to,
    };
  });
}

export async function getThread(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);

    // 1. Fetch the starting message to get its threading headers
    const startMsgs = await fetchMessages(imap, [messageId], '');
    if (startMsgs.length === 0) throw new Error(`Message ${messageId} not found`);

    // 2. Collect all Message-IDs in the thread
    const refIds = [
      startMsgs[0].message_id_header,
      ...(startMsgs[0].references || []),
      startMsgs[0].in_reply_to,
    ].filter(Boolean);

    // 3. Search INBOX for each referenced Message-ID
    const allSeqnos = new Set([messageId]);
    for (const id of refIds) {
      const results = await imapSearch(imap, [['HEADER', 'Message-ID', id]]);
      results.forEach(n => allSeqnos.add(n));
    }

    // 4. Fetch all matching messages
    const seqnoArray = [...allSeqnos];
    const threadMsgs = await fetchMessages(imap, seqnoArray, '');

    // 5. Sort chronologically
    return threadMsgs.sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

export async function markMessage(config, messageId, read) {
  return withImap(config, async (imap) => {
    await openInbox(imap, false);
    await new Promise((resolve, reject) => {
      const action = read ? '+FLAGS' : '-FLAGS';
      imap.store(messageId, action, ['\\Seen'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, read };
  });
}

export async function starMessage(config, messageId, star) {
  return withImap(config, async (imap) => {
    await openInbox(imap, false);
    await new Promise((resolve, reject) => {
      const action = star ? '+FLAGS' : '-FLAGS';
      imap.store(messageId, action, ['\\Flagged'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, starred: star };
  });
}

export async function deleteMessage(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, false);
    await new Promise((resolve, reject) => {
      imap.store(messageId, '+FLAGS', ['\\Deleted'], (err) => {
        if (err) reject(err); else resolve();
      });
    });
    await new Promise((resolve, reject) => {
      imap.expunge((err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, deleted: true };
  });
}

export async function moveMessage(config, messageId, destFolder) {
  return withImap(config, async (imap) => {
    await openInbox(imap, false);
    await new Promise((resolve, reject) => {
      imap.move(messageId, destFolder, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    return { success: true, message_id: messageId, moved_to: destFolder };
  });
}

export async function listFolders(config) {
  return withImap(config, async (imap) => {
    return new Promise((resolve, reject) => {
      imap.getBoxes((err, boxes) => {
        if (err) reject(err);
        else {
          const folders = [];
          function walk(obj, prefix = '') {
            for (const [name, box] of Object.entries(obj)) {
              const fullName = prefix ? `${prefix}${box.delimiter}${name}` : name;
              folders.push({ name: fullName, delimiter: box.delimiter });
              if (box.children) walk(box.children, fullName);
            }
          }
          walk(boxes);
          resolve(folders);
        }
      });
    });
  });
}

function openBox(imap, folder, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, readOnly, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

export async function listMessagesInFolder(config, folder, limit = 10) {
  return withImap(config, async (imap) => {
    const box = await openBox(imap, folder, true);
    const total = box.messages.total;
    if (total === 0) return [];

    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    const messages = await fetchMessages(imap, range, 'HEADER');
    return messages
      .map((m) => ({ ...m, body: undefined }))
      .reverse();
  });
}

export async function getAttachments(config, messageId) {
  return withImap(config, async (imap) => {
    await openInbox(imap, true);

    return new Promise((resolve, reject) => {
      const f = imap.fetch([messageId], { bodies: '', struct: true });
      let raw = '';

      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
        });
      });

      f.once('error', reject);
      f.once('end', async () => {
        try {
          const mail = await simpleParser(raw);
          const attachments = (mail.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            content: a.content.toString('base64'),
          }));
          resolve(attachments);
        } catch (err) {
          reject(err);
        }
      });
    });
  });
}
