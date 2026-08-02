import { z } from 'zod';

const sourceKey = z.string().min(1).max(500);
const receiptId = z.string().min(1).max(200);
const intakeId = z.string().min(1).max(200);
const receiptField = z.enum(['vendor', 'date', 'total', 'currency', 'category', 'notes']);
const item = z
  .object({
    description: z.string().min(1).max(500),
    quantity: z.number().finite().nullable(),
    amount: z.number().finite().nullable(),
  })
  .strict();

export const toolSchemas = {
  submit_receipt_media: z
    .object({
      sourceKey,
      attachmentPaths: z.array(z.string().min(1)).min(1).max(10),
      text: z.string().max(20_000).optional(),
      batchKey: z.string().min(1).max(500).optional(),
    })
    .strict(),
  submit_text_expense: z
    .object({
      sourceKey,
      text: z.string().min(1).max(20_000),
      batchKey: z.string().min(1).max(500).optional(),
    })
    .strict(),
  get_pending_intakes: z.object({}).strict(),
  clarify_intake: z.object({ intakeId, field: receiptField, value: z.unknown() }).strict(),
  update_receipt: z
    .object({
      receiptId,
      changes: z
        .object({
          vendor: z.string().min(1).max(500).optional(),
          date: z.string().optional(),
          total: z.number().finite().positive().optional(),
          currency: z.string().length(3).optional(),
          categoryId: z.string().max(200).nullable().optional(),
          notes: z.string().max(2_000).nullable().optional(),
          items: z.array(item).max(200).optional(),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, 'At least one change is required'),
    })
    .strict(),
  trash_receipt: z.object({ receiptId }).strict(),
  restore_receipt: z.object({ receiptId }).strict(),
  list_recent_receipts: z
    .object({
      page: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(50).optional(),
      days: z.number().int().positive().max(90).optional(),
    })
    .strict(),
  get_spending_summary: z
    .object({
      startDate: z.string().min(1),
      endDate: z.string().min(1),
      categoryId: z.string().max(200).optional(),
    })
    .strict(),
} as const;

export type ToolName = keyof typeof toolSchemas;
export type ToolInput<T extends ToolName = ToolName> = z.infer<(typeof toolSchemas)[T]>;

export function parseToolInput<T extends ToolName>(name: T, input: unknown): ToolInput<T> {
  return toolSchemas[name].parse(input) as ToolInput<T>;
}
