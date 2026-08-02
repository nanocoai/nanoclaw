import { z } from 'zod';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const attachmentSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((name) => !/[\\/\0]/.test(name) && name !== '.' && name !== '..'),
    type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
    dataBase64: z.string().refine((value) => BASE64.test(value), 'Invalid base64 attachment'),
  })
  .strict()
  .refine(
    (attachment) => Buffer.byteLength(attachment.dataBase64, 'base64') <= MAX_FILE_BYTES,
    'Attachment exceeds 10 MiB',
  );

export const playboxInboundSchema = z
  .object({
    id: z.string().min(1).max(200),
    senderId: z.string().regex(/^playbox:[a-z0-9_-]+$/),
    senderName: z.string().min(1).max(100),
    text: z.string().max(20_000),
    timestamp: z.iso.datetime(),
    replyToId: z.string().min(1).max(200).optional(),
    attachments: z.array(attachmentSchema).max(10),
  })
  .strict()
  .refine(
    (message) =>
      message.attachments.reduce((sum, attachment) => sum + Buffer.byteLength(attachment.dataBase64, 'base64'), 0) <=
      MAX_TOTAL_BYTES,
    'Attachments exceed 20 MiB',
  );

export type PlayboxInbound = z.infer<typeof playboxInboundSchema>;

export type PlayboxEvent =
  | { type: 'outbound'; id: string; text: string; files: Array<{ name: string; dataBase64: string }> }
  | { type: 'typing'; active: boolean }
  | { type: 'delivery'; inboundId: string; state: 'accepted' | 'rejected' };

export const playboxFaultSchema = z
  .object({
    kind: z.enum(['parser_timeout', 'api_429', 'api_500', 'disconnect']),
    count: z.number().int().positive().max(10).default(1),
  })
  .strict();
export type PlayboxFault = z.infer<typeof playboxFaultSchema>;

export function parsePlayboxInbound(input: unknown): PlayboxInbound {
  return playboxInboundSchema.parse(input);
}
