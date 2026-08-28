/**
 * Read-only order-level Lowe's Pro purchase history (from the Pro CSV
 * export) -- see src/db/migrations/module-lowes-materials.ts. No item-level
 * detail; use lowes-purchase-line-items for that.
 */
import { registerResource } from '../crud.js';

registerResource({
  name: 'lowes-purchase-order',
  plural: 'lowes-purchase-orders',
  table: 'lowes_purchase_orders',
  description: "One transaction from the Lowe's Pro order history export (order-level, no item detail).",
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated id.', generated: true },
    { name: 'purchase_date', type: 'string', description: 'Transaction date.', required: true },
    { name: 'purchased_from', type: 'string', description: 'In-Store / lowes.com / LowesPro.' },
    { name: 'fulfillment_type', type: 'string', description: 'Carry With / Return / Truck Delivery / etc.' },
    { name: 'store_number', type: 'string', description: "Lowe's store number." },
    { name: 'store_location', type: 'string', description: 'Store city/name.' },
    { name: 'fulfillment_status', type: 'string', description: 'Sold / Returned / etc.' },
    {
      name: 'po_code_raw',
      type: 'string',
      description: 'The "PO Number" field as typed at checkout -- informally used as a property tag.',
    },
    { name: 'order_number', type: 'string', description: 'Order #/Trans. #.' },
    { name: 'invoice_number', type: 'string', description: 'Invoice number.' },
    { name: 'tax', type: 'number', description: 'Tax amount.' },
    { name: 'order_total', type: 'number', description: 'Order total (negative for returns).' },
    { name: 'is_return', type: 'number', description: '1 if this row represents a return/credit.' },
    { name: 'original_order_ref', type: 'string', description: 'For a return row, the original order this reverses.' },
    { name: 'purchaser_name', type: 'string', description: 'Purchaser name, when present.' },
    { name: 'purchaser_email', type: 'string', description: 'Purchaser email, when present.' },
    {
      name: 'raw_row_json',
      type: 'json',
      description: 'Full original CSV row, catch-all for anything not modeled above.',
      required: true,
    },
    { name: 'source', type: 'string', description: 'Always "lowes_pro_csv".', default: 'lowes_pro_csv' },
    { name: 'imported_at', type: 'string', description: 'When this row was imported.', generated: true },
    { name: 'created_at', type: 'string', description: 'Row creation time.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});
