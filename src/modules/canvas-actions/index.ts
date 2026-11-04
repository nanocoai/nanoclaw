/**
 * Canvas-actions module — host side of the container's canvas tools
 * (plan: slack-native 06/09, D19).
 *
 * Registers two delivery actions:
 *  - `canvas_edit` — section-scoped canvas edits (append / replace_section /
 *    insert_after_section). The op mapping is safe by construction: whole-doc
 *    replace is unrepresentable (see canvas-api.ts CanvasChange).
 *  - `canvas_read` — files.info → HTML download → readable text, returned as
 *    an inbound system row the container tool blocks on.
 *
 * Both run unguarded: they act via the session's OWN bot identity (the same
 * token that delivers this session's ordinary messages), so they can reach
 * exactly what that bot can already reach — no privileged effect, nothing to
 * hold for approval.
 *
 * Registration targets the trunk guard registry (src/guard/, three-arg
 * registerDeliveryAction) — on this branch it resolves after the next
 * main → channels sync; the barrel import stays commented until then.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleCanvasEdit, handleCanvasRead } from './handlers.js';

registerDeliveryAction(
  'canvas_edit',
  handleCanvasEdit,
  unguarded("canvas content edit via the session's own bot identity; no privileged effect"),
);

registerDeliveryAction(
  'canvas_read',
  handleCanvasRead,
  unguarded("read-only canvas fetch via the session's own bot identity; no privileged effect"),
);
