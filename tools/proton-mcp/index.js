#!/usr/bin/env node
/**
 * Proton MCP Server — Phase 4: Mail + Pass + Drive + VPN
 *
 * Mail: Connects to Proton Bridge via IMAP/SMTP and exposes mail tools.
 * Pass: Wraps pass-cli for credential vault and TOTP operations.
 * Drive: Wraps rclone protondrive backend for backup and file operations.
 * VPN: Checks VPN status via external IP lookup.
 */

import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getUnread, listMessages, getMessage, searchMessages, getThread, markMessage, starMessage, deleteMessage, moveMessage, listFolders, listMessagesInFolder, getAttachments } from './mail/imap-client.js';
import { sendMessage, replyMessage, forwardMessage } from './mail/smtp-client.js';
import { listVaults, listItems, viewItem, searchItems, createItem, updateItem, trashItem, getTOTP } from './pass/pass-client.js';
import { listFiles, upload, uploadFolder, download, deleteRemote, mkdir } from './drive/drive-client.js';
import { getVpnStatus } from './vpn/vpn-client.js';
import { listEvents, getEvent, createEvent, updateEvent, deleteEvent } from './calendar/calendar-client.js';

// --- Config ---

function loadConfig() {
  // Try bridge.json first
  const configPaths = [
    path.join(process.env.HOME || '/home/node', '.proton-mcp', 'bridge.json'),
    '/home/node/.proton-mcp/bridge.json',
  ];

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch { /* try next */ }
    }
  }

  // Fall back to env vars
  if (process.env.PROTON_BRIDGE_USERNAME && process.env.PROTON_BRIDGE_PASSWORD) {
    return {
      imap_host: process.env.PROTON_BRIDGE_IMAP_HOST || '127.0.0.1',
      imap_port: parseInt(process.env.PROTON_BRIDGE_IMAP_PORT || '1143', 10),
      smtp_host: process.env.PROTON_BRIDGE_SMTP_HOST || '127.0.0.1',
      smtp_port: parseInt(process.env.PROTON_BRIDGE_SMTP_PORT || '1025', 10),
      username: process.env.PROTON_BRIDGE_USERNAME,
      password: process.env.PROTON_BRIDGE_PASSWORD,
    };
  }

  throw new Error(
    'Proton Bridge credentials not found. Create ~/.proton-mcp/bridge.json or set PROTON_BRIDGE_USERNAME and PROTON_BRIDGE_PASSWORD env vars.',
  );
}

// --- MCP Server ---

const server = new McpServer({
  name: 'proton',
  version: '4.0.0',
});

let config;
try {
  config = loadConfig();
} catch (err) {
  config = null;
}

function getConfig() {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

function errorResult(msg) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
}

// --- Tool: get_unread ---
server.tool(
  'mail__get_unread',
  'Get unread emails from Proton Mail inbox',
  {},
  async () => {
    try {
      const result = await getUnread(getConfig());
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: list_messages ---
server.tool(
  'mail__list_messages',
  'List recent emails from Proton Mail inbox',
  {
    limit: z.number().min(1).max(50).optional().describe('Number of messages to fetch (default 10)'),
  },
  async (args) => {
    try {
      const result = await listMessages(getConfig(), args.limit || 10);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: get_message ---
server.tool(
  'mail__get_message',
  'Get a single email by message ID (sequence number). Includes threading headers.',
  {
    message_id: z.number().describe('Message sequence number from list_messages'),
  },
  async (args) => {
    try {
      const result = await getMessage(getConfig(), args.message_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: search_messages ---
server.tool(
  'mail__search_messages',
  'Search emails by keyword in subject and body',
  {
    query: z.string().describe('Search query'),
  },
  async (args) => {
    try {
      const result = await searchMessages(getConfig(), args.query);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: send_message ---
server.tool(
  'mail__send_message',
  'Send an email via Proton Mail. Supports CC, BCC, HTML, and file attachments.',
  {
    to: z.string().describe('Recipient email address(es), comma-separated'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    html: z.string().optional().describe('HTML body (if provided, plain text body becomes fallback)'),
    cc: z.string().optional().describe('CC recipient(s), comma-separated'),
    bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
    attachments: z.array(z.object({
      filename: z.string(),
      path: z.string().optional().describe('Absolute path to file on disk'),
      content: z.string().optional().describe('File content as base64 string'),
      contentType: z.string().optional().describe('MIME type (optional, inferred from filename)'),
    })).optional().describe('Files to attach'),
  },
  async (args) => {
    try {
      const result = await sendMessage(getConfig(), args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: reply_message ---
server.tool(
  'mail__reply_message',
  'Reply to an email, preserving the thread. Set reply_all=true to include all original recipients.',
  {
    message_id: z.number().describe('Sequence number of the message to reply to'),
    body: z.string().describe('Reply body (plain text)'),
    reply_all: z.boolean().optional().describe('Reply to all recipients (default: false, reply to sender only)'),
    cc: z.string().optional().describe('Additional CC recipient(s), comma-separated'),
    bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
    attachments: z.array(z.object({
      filename: z.string(),
      path: z.string().optional(),
      content: z.string().optional(),
      contentType: z.string().optional(),
    })).optional().describe('Files to attach'),
  },
  async (args) => {
    try {
      const result = await replyMessage(getConfig(), {
        originalMessageId: args.message_id,
        body: args.body,
        replyAll: args.reply_all,
        cc: args.cc,
        bcc: args.bcc,
        attachments: args.attachments,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: get_thread ---
server.tool(
  'mail__get_thread',
  'Fetch the full email chain (thread) for a message',
  {
    message_id: z.number().describe('Sequence number of any message in the thread'),
  },
  async (args) => {
    try {
      const result = await getThread(getConfig(), args.message_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: mark_message ---
server.tool(
  'mail__mark_message',
  'Mark an email as read or unread',
  {
    message_id: z.number().describe('Message sequence number'),
    read: z.boolean().describe('true = mark as read, false = mark as unread'),
  },
  async (args) => {
    try {
      const result = await markMessage(getConfig(), args.message_id, args.read);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: forward_message ---
server.tool(
  'mail__forward_message',
  'Forward an email to another recipient',
  {
    message_id: z.number().describe('Sequence number of the message to forward'),
    to: z.string().describe('Recipient email address'),
    body: z.string().optional().describe('Optional message to prepend'),
    cc: z.string().optional().describe('CC recipient(s), comma-separated'),
    bcc: z.string().optional().describe('BCC recipient(s), comma-separated'),
  },
  async (args) => {
    try {
      const result = await forwardMessage(getConfig(), args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return errorResult(err.message);
    }
  },
);

// --- Tool: star_message ---
server.tool(
  'mail__star_message',
  'Star or unstar an email',
  {
    message_id: z.number().describe('Message sequence number'),
    star: z.boolean().describe('true = star, false = unstar'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await starMessage(getConfig(), args.message_id, args.star)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Tool: delete_message ---
server.tool(
  'mail__delete_message',
  'Permanently delete an email from inbox',
  {
    message_id: z.number().describe('Message sequence number'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await deleteMessage(getConfig(), args.message_id)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Tool: move_message ---
server.tool(
  'mail__move_message',
  'Move an email to a different folder (e.g. Trash, Archive, a label)',
  {
    message_id: z.number().describe('Message sequence number'),
    folder: z.string().describe('Destination folder name (use mail__list_folders to see available folders)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await moveMessage(getConfig(), args.message_id, args.folder)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Tool: list_folders ---
server.tool(
  'mail__list_folders',
  'List all mail folders and labels',
  {},
  async () => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await listFolders(getConfig())) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Tool: list_folder_messages ---
server.tool(
  'mail__list_folder_messages',
  'List messages in a specific folder (Sent, Drafts, Trash, or any label)',
  {
    folder: z.string().describe('Folder name (e.g. "Sent", "Trash", "Drafts")'),
    limit: z.number().min(1).max(50).optional().describe('Number of messages (default 10)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await listMessagesInFolder(getConfig(), args.folder, args.limit || 10)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Tool: get_attachments ---
server.tool(
  'mail__get_attachments',
  'Download attachments from an email. Returns base64-encoded content.',
  {
    message_id: z.number().describe('Message sequence number'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await getAttachments(getConfig(), args.message_id)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Pass Tools ---

// pass__list_vaults
server.tool(
  'pass__list_vaults',
  'List available Proton Pass vaults',
  {},
  async () => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await listVaults()) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__list_items — never exposes passwords or TOTP seeds
server.tool(
  'pass__list_items',
  'List credential names in a Proton Pass vault (no passwords returned)',
  {
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const result = await listItems(args.vault);
      const safe = (result.items || []).map((item) => ({
        title: item.content?.title,
        username: item.content?.content?.Login?.username || item.content?.content?.Login?.email,
        urls: item.content?.content?.Login?.urls || [],
        state: item.state,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__search_items — never exposes passwords or TOTP seeds
server.tool(
  'pass__search_items',
  'Search Proton Pass items by keyword (no passwords returned)',
  {
    query: z.string().describe('Search keyword'),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const result = await searchItems(args.query, args.vault);
      const safe = (result.items || []).map((item) => ({
        title: item.content?.title,
        username: item.content?.content?.Login?.username || item.content?.content?.Login?.email,
        urls: item.content?.content?.Login?.urls || [],
        state: item.state,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__get_item — returns full credential (username, password, URLs)
server.tool(
  'pass__get_item',
  'Get a credential from Proton Pass by name. Returns username, password, and URLs.',
  {
    name: z.string().describe('Item title'),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const result = await viewItem(args.name, args.vault);
      const item = result.item;
      const login = item.content?.content?.Login || {};
      return { content: [{ type: 'text', text: JSON.stringify({
        title: item.content?.title,
        username: login.username || login.email,
        password: login.password,
        urls: login.urls || [],
        note: item.content?.note || '',
        has_totp: !!(login.totp_uri),
      }) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__create_item — store new login credential
server.tool(
  'pass__create_item',
  'Store a new login credential in Proton Pass',
  {
    title: z.string().describe('Item title'),
    username: z.string().optional(),
    password: z.string().optional(),
    url: z.string().optional(),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const result = await createItem(args);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__update_item — update existing credential fields
server.tool(
  'pass__update_item',
  'Update an existing credential in Proton Pass',
  {
    name: z.string().describe('Item title to update'),
    username: z.string().optional(),
    password: z.string().optional(),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const { name, vault, ...updates } = args;
      const result = await updateItem(name, updates, vault);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__trash_item — move item to trash
server.tool(
  'pass__trash_item',
  'Move a credential to the trash in Proton Pass',
  {
    name: z.string().describe('Item title to trash'),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      const result = await trashItem(args.name, args.vault);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, result }) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__generate_password — generate a random password
server.tool(
  'pass__generate_password',
  'Generate a random password using Proton Pass',
  {
    length: z.number().optional().describe('Password length (default: 20)'),
  },
  async (args) => {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const bin = process.env.PROTON_PASS_BIN || 'pass-cli';
      const genArgs = ['password', 'generate'];
      if (args.length) genArgs.push(`${args.length}`);
      const { stdout } = await execFileAsync(bin, genArgs, {
        timeout: 10000,
        env: { ...process.env, PROTON_PASS_KEY_PROVIDER: 'fs' },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ password: stdout.trim() }) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// pass__get_totp — generate current TOTP code (most critical tool)
server.tool(
  'pass__get_totp',
  'Generate the current TOTP authentication code for an item in Proton Pass. Use for autonomous 2FA.',
  {
    name: z.string().describe('Item title (must have a TOTP seed stored)'),
    vault: z.string().optional().describe('Vault name (default: NanoClaw)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await getTOTP(args.name, args.vault)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Drive Tools ---

// drive__list
server.tool(
  'drive__list',
  'List files and folders at a path on Proton Drive',
  {
    path: z.string().optional().describe('Remote path (default: root)'),
  },
  async (args) => {
    try {
      const items = await listFiles(args.path || '');
      const safe = items.map(({ Name, IsDir, Size, ModTime }) => ({
        name: Name, type: IsDir ? 'folder' : 'file', size: Size, modified: ModTime,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(safe) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// drive__upload
server.tool(
  'drive__upload',
  'Upload a file to Proton Drive',
  {
    local_path: z.string().describe('Local file path'),
    remote_path: z.string().describe('Remote destination path on Drive'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await upload(args.local_path, args.remote_path)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// drive__upload_folder
server.tool(
  'drive__upload_folder',
  'Upload a folder to Proton Drive (copies all contents recursively)',
  {
    local_path: z.string().describe('Local folder path'),
    remote_path: z.string().describe('Remote destination path on Drive'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await uploadFolder(args.local_path, args.remote_path)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// drive__download
server.tool(
  'drive__download',
  'Download a file or folder from Proton Drive to local path',
  {
    remote_path: z.string().describe('Remote path on Drive'),
    local_path: z.string().describe('Local destination path'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await download(args.remote_path, args.local_path)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// drive__delete
server.tool(
  'drive__delete',
  'Delete a file or folder from Proton Drive',
  {
    remote_path: z.string().describe('Remote path to delete'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await deleteRemote(args.remote_path)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// drive__mkdir
server.tool(
  'drive__mkdir',
  'Create a folder on Proton Drive',
  {
    remote_path: z.string().describe('Remote folder path to create'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await mkdir(args.remote_path)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Calendar Tools ---

// calendar__list_events
server.tool(
  'calendar__list_events',
  'List calendar events in a date range. Can read both Jorgenclaw and Scott calendars.',
  {
    from: z.string().describe('Start date (ISO 8601, e.g. 2026-03-21)'),
    to: z.string().describe('End date (ISO 8601, e.g. 2026-03-28)'),
    calendar_user: z.string().optional().describe('Calendar owner: "jorgenclaw" (default) or "scott"'),
  },
  async (args) => {
    try {
      const events = await listEvents(args.from, args.to, args.calendar_user);
      return { content: [{ type: 'text', text: JSON.stringify(events) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// calendar__get_event
server.tool(
  'calendar__get_event',
  'Get a single calendar event by its UID',
  {
    event_id: z.string().describe('Event UID'),
    calendar_user: z.string().optional().describe('Calendar owner (default: jorgenclaw)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await getEvent(args.event_id, args.calendar_user)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// calendar__create_event
server.tool(
  'calendar__create_event',
  'Create a calendar event. Use for reminders, follow-ups, and deadlines.',
  {
    title: z.string().describe('Event title'),
    start: z.string().describe('Start time (ISO 8601)'),
    end: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional(),
    location: z.string().optional(),
    calendar_user: z.string().optional().describe('Calendar owner (default: jorgenclaw)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await createEvent(args)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// calendar__update_event
server.tool(
  'calendar__update_event',
  'Update an existing calendar event',
  {
    event_id: z.string().describe('Event UID to update'),
    title: z.string().optional(),
    start: z.string().optional().describe('New start time (ISO 8601)'),
    end: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional(),
    location: z.string().optional(),
    calendar_user: z.string().optional().describe('Calendar owner (default: jorgenclaw)'),
  },
  async (args) => {
    try {
      const { event_id: eventId, calendar_user: calendarUser, ...updates } = args;
      return { content: [{ type: 'text', text: JSON.stringify(await updateEvent({ eventId, calendarUser, ...updates })) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// calendar__delete_event
server.tool(
  'calendar__delete_event',
  'Delete a calendar event',
  {
    event_id: z.string().describe('Event UID to delete'),
    calendar_user: z.string().optional().describe('Calendar owner (default: jorgenclaw)'),
  },
  async (args) => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await deleteEvent(args.event_id, args.calendar_user)) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- VPN Tools ---

// vpn__status
server.tool(
  'vpn__status',
  'Check VPN connection status — shows current IP, location, and whether traffic is routed through ProtonVPN',
  {},
  async () => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await getVpnStatus()) }] };
    } catch (err) { return errorResult(err.message); }
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
