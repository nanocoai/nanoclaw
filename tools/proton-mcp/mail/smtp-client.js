/**
 * SMTP client for Proton Bridge
 * Handles send and reply operations via nodemailer
 */

import nodemailer from 'nodemailer';
import { getMessageHeaders, getMessage as getFullMessage } from './imap-client.js';

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.smtp_host || '127.0.0.1',
    port: config.smtp_port || 1025,
    secure: false,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: { rejectUnauthorized: false },
  });
}

export async function sendMessage(config, { to, subject, body, html, cc, bcc, attachments }) {
  const transporter = createTransporter(config);

  const mailOpts = {
    from: config.username,
    to,
    cc,
    bcc,
    subject,
    attachments,
  };
  if (html) {
    mailOpts.html = html;
    if (body) mailOpts.text = body; // plain text fallback
  } else {
    mailOpts.text = body;
  }

  const info = await transporter.sendMail(mailOpts);
  return { success: true, message_id: info.messageId };
}

export async function forwardMessage(config, { originalMessageId, to, body, cc, bcc }) {
  const original = await getFullMessage(config, originalMessageId);

  const fwdSubject = original.subject.startsWith('Fwd:')
    ? original.subject
    : `Fwd: ${original.subject}`;

  const fwdBody = `${body || ''}\n\n---------- Forwarded message ----------\nFrom: ${original.from}\nDate: ${original.date}\nSubject: ${original.subject}\nTo: ${original.to}\n\n${original.body}`;

  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.username,
    to,
    cc,
    bcc,
    subject: fwdSubject,
    text: fwdBody,
  });

  return { success: true, message_id: info.messageId };
}

export async function replyMessage(config, { originalMessageId, body, cc, bcc, replyAll, attachments }) {
  const headers = await getMessageHeaders(config, originalMessageId);

  const replySubject = headers.subject.startsWith('Re:')
    ? headers.subject
    : `Re: ${headers.subject}`;

  // Build References chain: existing refs + original Message-ID
  const refsList = [...(headers.references || []), headers.messageId].filter(Boolean);
  const referencesStr = refsList.join(' ');

  // Reply-all: include original To and CC recipients (excluding ourselves)
  let to = headers.from;
  if (replyAll) {
    const allRecipients = [headers.from, headers.to, headers.cc].filter(Boolean).join(', ');
    // Remove our own address to avoid sending to ourselves
    const ownAddr = config.username.toLowerCase();
    to = allRecipients
      .split(/,\s*/)
      .filter((addr) => !addr.toLowerCase().includes(ownAddr))
      .join(', ') || headers.from;
  }

  const transporter = createTransporter(config);

  const info = await transporter.sendMail({
    from: config.username,
    to,
    cc,
    bcc,
    subject: replySubject,
    text: body,
    inReplyTo: headers.messageId,
    references: referencesStr,
    attachments,
  });

  return { success: true, message_id: info.messageId };
}
