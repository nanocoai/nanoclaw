/**
 * Attachments on cross-session copies (fan echoes and backfill rows).
 *
 * A message's files are staged in its own session's inbox
 * (`inbox/<folder>/<file>`, relative to that session's /workspace). A copy of
 * the message in another session is read by a different container, which
 * mounts only its own session folder, so it needs its own copy of each file.
 * The files are copied into the target session's `inbox/<echo-row-folder>/`
 * and the row lists them in the formatter's usual `attachments` shape.
 *
 * Both session folders are mounted writable into containers, so either side
 * can turn `inbox` or a message folder into a symlink at any time. Both are
 * opened as AnchoredDirs (symlinks refused) and the files are copied through
 * those descriptors, the same way as agent-route.ts forwards files (CWE-59).
 *
 * A file that cannot be copied (missing, unsafe, past the size cap) stays on
 * the row by name, without a path, so the agent still knows it was there.
 */
import { AnchoredDir, copyRegularFile } from '../../anchored-dir.js';
import { inboxFolderName, isSafeAttachmentName } from '../../attachment-safety.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import { ECHO_ATTACHMENT_MAX_BYTES } from './config.js';

/** What an echo row says about a file. Never carries base64 data. */
export interface EchoAttachment {
  type: string;
  name: string;
  mimeType?: string;
  size?: number;
  url?: string;
  /** Relative to the TARGET session's /workspace. */
  localPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a parsed content's `attachments` lists at least one file. */
export function hasAttachments(attachments: unknown): boolean {
  return Array.isArray(attachments) && attachments.some(isRecord);
}

function describeAttachment(raw: Record<string, unknown>): EchoAttachment {
  const name =
    typeof raw.name === 'string' && raw.name
      ? raw.name
      : typeof raw.filename === 'string' && raw.filename
        ? raw.filename
        : 'attachment';
  const meta: EchoAttachment = { type: typeof raw.type === 'string' && raw.type ? raw.type : 'file', name };
  if (typeof raw.mimeType === 'string') meta.mimeType = raw.mimeType;
  if (typeof raw.size === 'number') meta.size = raw.size;
  if (typeof raw.url === 'string') meta.url = raw.url;
  return meta;
}

/** `inbox/<folder>/<file>` → its two names, or null for any other shape. */
function parseInboxPath(localPath: unknown): { folder: string; filename: string } | null {
  if (typeof localPath !== 'string') return null;
  const parts = localPath.split('/');
  if (parts.length !== 3 || parts[0] !== 'inbox') return null;
  const [, folder, filename] = parts;
  if (!isSafeAttachmentName(folder) || !isSafeAttachmentName(filename)) return null;
  return { folder, filename };
}

/**
 * Copy the staged files of a source message into the target session's inbox
 * under the echo row's own folder, and return the row's `attachments`. Both
 * sessions belong to `agentGroupId` (echoes never leave their agent group).
 * Never throws; the caller writes the row whatever this returns.
 */
export function copyEchoAttachments(args: {
  agentGroupId: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** Id of the echo row being written; names the target inbox folder. */
  targetMessageId: string;
  /** The source row's parsed `attachments`. */
  attachments: unknown;
}): EchoAttachment[] {
  if (!Array.isArray(args.attachments)) return [];
  const result: EchoAttachment[] = [];
  const targetFolder = inboxFolderName(args.targetMessageId);
  const sources = new Map<string, AnchoredDir | null>();
  // Opened lazily, so a row whose files all fail to copy creates no folder.
  let target: AnchoredDir | null | undefined;
  let budget = ECHO_ATTACHMENT_MAX_BYTES;

  try {
    for (const raw of args.attachments) {
      if (!isRecord(raw)) continue;
      const meta = describeAttachment(raw);
      result.push(meta);

      const source = parseInboxPath(raw.localPath);
      if (!source) {
        if (raw.localPath !== undefined) {
          log.warn('Echo attachment has an unexpected source path, not copied', {
            sourceSessionId: args.sourceSessionId,
            localPath: raw.localPath,
          });
        }
        continue;
      }
      if (targetFolder === null || target === null) continue;

      try {
        let sourceDir = sources.get(source.folder);
        if (sourceDir === undefined) {
          sourceDir = AnchoredDir.open(sessionDir(args.agentGroupId, args.sourceSessionId), ['inbox', source.folder]);
          sources.set(source.folder, sourceDir);
        }
        if (!sourceDir) continue;

        // The cap guards disk use, not a trust boundary: both sessions belong
        // to the same agent group, so the size is read once, before the copy.
        const stat = sourceDir.lstat(source.filename);
        if (!stat.isFile()) throw new Error('not a regular file');
        if (stat.size > budget) {
          log.info('Echo attachment past the size cap, named but not copied', {
            targetSessionId: args.targetSessionId,
            filename: source.filename,
            size: stat.size,
          });
          continue;
        }

        if (target === undefined) {
          try {
            target = AnchoredDir.open(
              sessionDir(args.agentGroupId, args.targetSessionId),
              ['inbox', targetFolder],
              true,
            );
          } catch (err) {
            target = null;
            throw err;
          }
          if (!target) continue;
        }
        // Exclusive create on the target: never follows or overwrites an entry.
        copyRegularFile(sourceDir, source.filename, target, source.filename);
        budget -= stat.size;
        meta.localPath = `inbox/${targetFolder}/${source.filename}`;
        // eslint-disable-next-line no-catch-all/no-catch-all -- one bad file must not drop the row or its other files
      } catch (err) {
        log.warn('Echo attachment not copied', {
          sourceSessionId: args.sourceSessionId,
          targetSessionId: args.targetSessionId,
          filename: source.filename,
          err,
        });
      }
    }
  } finally {
    for (const dir of sources.values()) dir?.close();
    target?.close();
  }
  return result;
}
