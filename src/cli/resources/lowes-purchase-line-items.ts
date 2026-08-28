/**
 * Read-only item-level Lowe's purchase history, extracted from 130 Lowe's
 * receipt emails -- see src/db/migrations/module-lowes-materials.ts. The
 * only source with genuine per-purchase product detail (item#/model#,
 * quantity, price) rather than order totals.
 */
import { registerResource } from '../crud.js';

registerResource({
  name: 'lowes-purchase-line-item',
  plural: 'lowes-purchase-line-items',
  table: 'lowes_purchase_line_items',
  description: "One line item from a parsed Lowe's receipt email.",
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated id.', generated: true },
    { name: 'purchase_date', type: 'string', description: 'Purchase date.', required: true },
    { name: 'order_number', type: 'string', description: 'Order #.' },
    { name: 'transaction_number', type: 'string', description: 'Transaction #.' },
    { name: 'store_location', type: 'string', description: 'Store city/name.' },
    { name: 'store_number', type: 'string', description: 'Store number.' },
    { name: 'po_code_raw', type: 'string', description: 'Customer/PO code as typed at checkout.' },
    { name: 'description_raw', type: 'string', description: 'Receipt line description, verbatim.', required: true },
    {
      name: 'identifier_type',
      type: 'string',
      description: "'item_number' or 'model_number' -- older vs. newer receipt style.",
      required: true,
    },
    {
      name: 'identifier_value',
      type: 'string',
      description: "The actual Lowe's Item # or Model # value.",
      required: true,
    },
    { name: 'quantity', type: 'number', description: 'Quantity purchased on this line.' },
    { name: 'price_shown', type: 'number', description: 'Price shown on the receipt for this line.' },
    { name: 'source_format', type: 'string', description: 'Note on which receipt-email format this was parsed from.' },
    {
      name: 'gmail_message_id',
      type: 'string',
      description: 'Source Gmail message id, for traceability back to the original receipt email.',
    },
    { name: 'source', type: 'string', description: 'Always "receipt_email".', default: 'receipt_email' },
    { name: 'imported_at', type: 'string', description: 'When this row was imported.', generated: true },
    { name: 'created_at', type: 'string', description: 'Row creation time.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});
