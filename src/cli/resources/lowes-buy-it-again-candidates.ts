/**
 * Read-only "Buy It Again" candidate catalog from Lowe's own recurring-
 * purchase recommendation export -- see
 * src/db/migrations/module-lowes-materials.ts. A recommendation snapshot,
 * not a purchase ledger -- kept structurally separate from
 * lowes-purchase-line-items even though the semantics overlap.
 */
import { registerResource } from '../crud.js';

registerResource({
  name: 'lowes-buy-it-again-candidate',
  plural: 'lowes-buy-it-again-candidates',
  table: 'lowes_buy_it_again_candidates',
  description:
    'One product from Lowe\'s "Buy It Again" export -- a recurring/recommended product candidate, not a preferred material until explicitly approved.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated id.', generated: true },
    { name: 'brand', type: 'string', description: 'Product brand.' },
    { name: 'title', type: 'string', description: 'Product title/description.', required: true },
    { name: 'model_number', type: 'string', description: "Lowe's Model #." },
    {
      name: 'lowes_item_number',
      type: 'string',
      description: "Lowe's Item # -- unique per product in this export.",
      required: true,
    },
    { name: 'price_observed', type: 'number', description: 'Price shown in the export.' },
    {
      name: 'review_count_shown',
      type: 'string',
      description: 'The number shown near price on the page -- likely a review count, not independently confirmed.',
    },
    {
      name: 'snapshot_source_column',
      type: 'string',
      description: "Which of the export's 5 parallel columns this came from, for traceability.",
    },
    { name: 'source', type: 'string', description: 'Always "buy_it_again_export".', default: 'buy_it_again_export' },
    { name: 'imported_at', type: 'string', description: 'When this row was imported.', generated: true },
    { name: 'created_at', type: 'string', description: 'Row creation time.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
});
