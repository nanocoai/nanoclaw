/**
 * Google Chat channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createPrivateKey } from 'crypto';

import { createGoogleChatAdapter } from '@chat-adapter/gchat';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// A JSON.parse error quotes the start of its input, so never let it surface:
// it would put part of the key in the startup log.
function parseCredentials(raw: string): { client_email: string; private_key: string } {
  let parsed: { client_email?: unknown; private_key?: unknown } | undefined;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  const email = parsed?.client_email;
  const key = parsed?.private_key;
  if (typeof email !== 'string' || !email.includes('@') || typeof key !== 'string' || !isRsaKey(key)) {
    throw new Error('GCHAT_CREDENTIALS in .env must be the service account JSON key on one line');
  }
  return { ...parsed, client_email: email, private_key: key };
}

// Google signs service account JWTs with RSA; any other key type fails at first use.
function isRsaKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:';
}

/**
 * Dedicated bot app on a threaded platform. 'mention' (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const GCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/**
 * Card text reaches Google Chat as textParagraph HTML, where `<` and `&` start
 * tags and entities. Entity-escape them so untrusted values in approval cards
 * show as typed.
 */
export function escapeGChatHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The file name comes from the sender. JSON-quote it and show invisible
// characters, line separators and brackets as \uXXXX so it cannot end the note.
function quoteFileName(name: string): string {
  return JSON.stringify(name).replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029[\]]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/**
 * Chat sends a file shared from Google Drive as a Drive id only. Chat's media
 * download refuses Drive files and the app cannot open the sender's Drive, so
 * the agent would see just the name. Tell it why the file is missing.
 */
export function gchatDriveFileNote(raw: Record<string, unknown>): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const event = raw as any;
  // Add-on webhooks nest the message under chat.messagePayload; Pub/Sub does not.
  const attachments: unknown = (event.chat?.messagePayload?.message ?? event.message)?.attachment;
  if (!Array.isArray(attachments)) return null;
  const notes = attachments
    .filter((att) => att?.source === 'DRIVE_FILE' && !att.attachmentDataRef?.resourceName)
    .map((att) => {
      const name = typeof att.contentName === 'string' && att.contentName ? att.contentName : 'file';
      // Google Docs, Sheets, Slides and Drawings have no file to upload until
      // exported. Shortcuts and folders share the MIME prefix but can't be exported.
      const ask = /^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)$/.test(
        String(att.contentType),
      )
        ? 'Ask the sender to export it (for example as PDF) and upload that file into the chat instead.'
        : 'Ask the sender to upload the file into the chat instead (paste or drag it in).';
      return (
        `[Google Drive file ${quoteFileName(name)} was not downloaded: this app can't open files shared ` +
        `from Google Drive. ${ask}]`
      );
    });
  return notes.length > 0 ? notes.join('\n') : null;
}

registerChannelAdapter('gchat', {
  factory: () => {
    const env = readEnvFile([
      'GCHAT_CREDENTIALS',
      'GOOGLE_CHAT_BOT_USER_ID',
      'GOOGLE_CHAT_ENDPOINT_URL',
      'GOOGLE_CHAT_PROJECT_NUMBER',
    ]);
    if (!env.GCHAT_CREDENTIALS) return null;
    const projectNumber = env.GOOGLE_CHAT_PROJECT_NUMBER;
    if (!env.GOOGLE_CHAT_ENDPOINT_URL || !projectNumber || !/^\d+$/.test(projectNumber)) {
      throw new Error(
        'Google Chat needs GOOGLE_CHAT_ENDPOINT_URL and GOOGLE_CHAT_PROJECT_NUMBER (digits) in .env to verify webhooks',
      );
    }
    if (!isHttpsUrl(env.GOOGLE_CHAT_ENDPOINT_URL)) {
      throw new Error('GOOGLE_CHAT_ENDPOINT_URL in .env must be an https URL');
    }
    const credentials = parseCredentials(env.GCHAT_CREDENTIALS);
    const gchatAdapter = createGoogleChatAdapter({
      credentials,
      // Adapters >= 4.40 no longer learn their own id from mentions; without
      // it, @mentions in spaces never count as mentions. Spread, because 4.29
      // has no botUserId option (it learns the id itself).
      ...(env.GOOGLE_CHAT_BOT_USER_ID ? { botUserId: env.GOOGLE_CHAT_BOT_USER_ID } : {}),
      // The adapter only reads Workspace add-on events, and add-on webhooks
      // are signed for the endpoint URL by this per-project service account.
      // Spread, because 4.29 has no workspaceAddOnServiceAccountEmail option.
      ...{
        endpointUrl: env.GOOGLE_CHAT_ENDPOINT_URL,
        workspaceAddOnServiceAccountEmail: `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`,
      },
    });
    return createChatSdkBridge({
      adapter: gchatAdapter,
      // Spread, so an older core without this option still type-checks (and ignores it).
      ...{ escapeCardText: escapeGChatHtml },
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: GCHAT_DEFAULTS,
      extractRawText: gchatDriveFileNote,
    });
  },
  defaults: GCHAT_DEFAULTS,
});
