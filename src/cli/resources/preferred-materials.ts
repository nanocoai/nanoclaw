/**
 * Curated, Kirk-approved materials catalog -- see
 * src/db/migrations/module-lowes-materials.ts. Nothing here is ever
 * auto-promoted from purchase history or Buy It Again; a row only reaches
 * status='approved' by explicit human decision. `item_model_source` and
 * `color_or_tint_source` are separate because those two halves of a row
 * often have different evidence (e.g. item/model numbers receipt-verified,
 * tint/formulation Kirk's own knowledge). `receipt_evidence_description`
 * preserves whatever raw receipt wording exists purely as evidence --
 * never treated as the authoritative color/tint/formulation value.
 *
 * create/update are `access: 'approval'` -- an agent may propose a new
 * material or a change to an existing one (e.g. Maintenance Coordinator
 * suggesting a candidate it noticed in purchase history), but the request
 * holds for a real pending_approvals card and only takes effect if Kirk
 * approves it, via the same generic cli_command approval path every other
 * approval-gated CLI command already uses (see src/cli/dispatch.ts). This
 * is what actually enforces "a row only reaches status='approved' by
 * explicit human decision" -- without it, a global-scoped agent could set
 * status='approved' (or edit an already-approved row) directly, since
 * GROUP_SCOPE_RESOURCES only gates group-scoped agents, never global ones
 * (see away-mode-queue.ts's header comment for the same reasoning applied
 * there). The host caller (Kirk / Claude Code over the trusted socket) is
 * unaffected -- `access: 'approval'` only holds agent callers; see
 * src/cli/guard.ts's commandDecide.
 */
import { registerResource } from '../crud.js';

registerResource({
  name: 'preferred-material',
  plural: 'preferred-materials',
  table: 'preferred_materials',
  description:
    'A curated standard material -- e.g. "the paint we normally use for ceilings." Only Kirk-approved rows carry status=approved.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated id.', generated: true },
    {
      name: 'category',
      type: 'string',
      description: 'e.g. "ceiling_paint", "wall_paint", "trim_paint".',
      required: true,
    },
    { name: 'brand', type: 'string', description: 'Product brand.', required: true },
    { name: 'product_line', type: 'string', description: 'e.g. "Ultra", "4000".', updatable: true },
    {
      name: 'sheen_or_type',
      type: 'string',
      description: 'e.g. "Ceiling Paint", "Eggshell", "Semi-Gloss".',
      updatable: true,
    },
    {
      name: 'color_or_tint',
      type: 'string',
      description: 'Operational tint/formulation label, e.g. "Latitude", "High Hide White".',
      updatable: true,
    },
    {
      name: 'color_or_tint_source',
      type: 'string',
      description: "Where color_or_tint came from: 'receipt_history' | 'buy_it_again' | 'kirk_explicit'.",
      default: 'kirk_explicit',
      updatable: true,
    },
    {
      name: 'receipt_evidence_description',
      type: 'string',
      description:
        'Raw receipt text, if any was found (e.g. "5G 4000 EGG WHT BASE A") -- evidence only, never authoritative for color/tint/formulation.',
      updatable: true,
    },
    { name: 'container_size', type: 'string', description: 'e.g. "5-gallon".', updatable: true },
    { name: 'lowes_item_number', type: 'string', description: "Lowe's Item #, when known.", updatable: true },
    {
      name: 'lowes_model_number',
      type: 'string',
      description: "Lowe's Model #, when known -- kept separate from item_number, never merged.",
      updatable: true,
    },
    {
      name: 'item_model_source',
      type: 'string',
      description:
        "Where lowes_item_number/lowes_model_number came from: 'receipt_history' | 'buy_it_again' | 'kirk_explicit'.",
      default: 'kirk_explicit',
      updatable: true,
    },
    {
      name: 'status',
      type: 'string',
      description: "'approved' | 'candidate' | 'deprecated'. Only ever set to 'approved' by explicit human decision.",
      default: 'candidate',
      updatable: true,
    },
    {
      name: 'source',
      type: 'string',
      description: "Overall provenance for this row: 'receipt_history' | 'buy_it_again' | 'kirk_explicit'.",
      required: true,
      updatable: true,
    },
    {
      name: 'confidence_note',
      type: 'string',
      description: 'Free text explaining the reasoning/evidence/caveats behind this row.',
      updatable: true,
    },
    {
      name: 'approved_by',
      type: 'string',
      description: 'Who approved this row, when status=approved.',
      updatable: true,
    },
    { name: 'approved_at', type: 'string', description: 'When this row was approved.', updatable: true },
    { name: 'created_at', type: 'string', description: 'Row creation time.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Last update time.', generated: true, updatable: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
});
