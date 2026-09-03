// Shared, UI-free driver policy for `nc:operator` blocks — presentation derived
// from DOCUMENT STRUCTURE, never from authored presentation attrs.
//
// The apply engine (scripts/skill-apply.ts) only DECLARES and EMITS: it renders
// an operator block's text and awaits the consumer's `onEvent` before evaluating
// the next directive. Whether that block needs a human BARRIER (a confirm before
// the next side-effecting step runs) and whether its text carries a URL worth
// offering to open are judgments about the skill DOCUMENT — the same judgment
// for every consumer that renders live (the setup wizard, an agent relaying over
// chat). This module is that judgment, built on the shared parser, with no
// clack/TTY baggage — a consumer imports it instead of duplicating the policy.
//
// Two exports:
//   • gatePolicy(md)       → per operator line: does the block need a confirm
//                            after rendering, and with which flavor of wording?
//   • extractOfferUrl(text) → the first offerable URL in a RENDERED operator
//                            body (template placeholders excluded), or undefined.

import { parseDirectives, type Directive } from './skill-directives.js';

/**
 * The wording flavor a barrier confirm should carry, derived from the barrier
 * directive's effect:
 *   • 'readiness' — the next step is an `effect:step` (a pairing code, a QR
 *     device-link): the block describes FUTURE action ("a code is about to
 *     appear"), so the confirm asks for readiness before it starts.
 *   • 'completed' — anything else: the block describes work the human must have
 *     FINISHED (an Azure app that must exist before the manifest bakes it in),
 *     so the confirm asks whether the steps above are done.
 */
export type ConfirmFlavor = 'readiness' | 'completed';

export interface GateDecision {
  /** Confirm after rendering this operator block? */
  needsConfirm: boolean;
  /** Wording flavor for the confirm — meaningful only when `needsConfirm`. */
  flavor: ConfirmFlavor;
}

// A directive's `when:<var>=<value>` guard, parsed. Malformed (no `=`) ⇒ treated
// as unguarded — conservative, and lint is the authoring gate anyway.
function guardOf(d: Directive): { v: string; value: string } | undefined {
  if (typeof d.attrs.when !== 'string') return undefined;
  const eq = d.attrs.when.indexOf('=');
  if (eq < 1) return undefined;
  return { v: d.attrs.when.slice(0, eq).trim(), value: d.attrs.when.slice(eq + 1).trim() };
}

/**
 * The natural-barrier gate policy: for each `nc:operator` directive, decide
 * whether the consumer should hold for a human confirm after rendering it —
 * keyed by the directive's opening-fence line (the `line` the engine's operator
 * event carries).
 *
 * Rules (normative — the §5.1 seam spec):
 *   1. Scan forward through subsequent directives, skipping ONLY those whose
 *      `when:` guard is INCOMPATIBLE with this operator's own guard — same var,
 *      different value. No guard, or an identical guard, is compatible
 *      (different-var guards are conservatively compatible too). This makes
 *      mutually-exclusive branches gate on their OWN next action.
 *   2. Next compatible directive is another `operator` → no confirm — the
 *      chain's LAST operator carries the barrier. (Operators are NOT skipped-
 *      and-scanned-past: that would make the earlier block of a chain inherit
 *      the later block's barrier and double-confirm.)
 *   3. Next compatible directive is a `prompt` → no confirm (the prompt is the
 *      barrier — the human can't paste a token before doing the steps).
 *   4. No such directive (end of document) → no confirm (a final handoff block).
 *   5. Anything else (`run`, `copy`, `dep`, `append`, `env-set`,
 *      `json-merge`) → confirm, with the flavor derived from that barrier
 *      directive's effect (`effect:step` → readiness, else completed).
 *
 * Known limitation (lint-warned upstream): an UNGUARDED operator followed by
 * guarded directives of more than one branch value keys its decision off a
 * directive that may be runtime-skipped. No in-tree skill authors this.
 */
export function gatePolicy(md: string): Map<number, GateDecision> {
  const directives = parseDirectives(md);
  const out = new Map<number, GateDecision>();
  directives.forEach((d, i) => {
    if (d.kind !== 'operator') return;
    const own = guardOf(d);
    let barrier: Directive | undefined;
    for (let j = i + 1; j < directives.length; j++) {
      const g = guardOf(directives[j]);
      if (own && g && own.v === g.v && own.value !== g.value) continue; // incompatible branch — skip
      barrier = directives[j];
      break;
    }
    if (!barrier || barrier.kind === 'operator' || barrier.kind === 'prompt') {
      out.set(d.line, { needsConfirm: false, flavor: 'completed' });
    } else {
      out.set(d.line, { needsConfirm: true, flavor: barrier.attrs.effect === 'step' ? 'readiness' : 'completed' });
    }
  });
  return out;
}

// A URL candidate in prose. The char class stops at whitespace, `)`, `>`, `]` —
// deliberately NOT at `<`, so a template placeholder like
// `https://<your-public-host>/webhook/slack` yields a candidate that still
// CONTAINS `<` and gets excluded below (instead of a nonsense truncated offer).
const URL_CANDIDATE = /https?:\/\/[^\s)>\]]+/g;

/**
 * The first *offerable* URL in a rendered operator body, or undefined.
 *
 * A candidate matches `https?://…` up to whitespace/`)`/`>`/`]`, then:
 *   • trailing sentence punctuation is stripped (so "In https://portal.azure.com,
 *     search…" offers the clean URL, not one with a comma glued on);
 *   • candidates containing `<` or `{{` are EXCLUDED — template placeholders
 *     (`https://<your-public-host>/…`) and unsubstituted `{{vars}}` are authored
 *     shapes, not real destinations;
 *   • the survivor must parse via `new URL()` with a non-empty host.
 *
 * Scheme-less mentions (`api.slack.com/apps`) and non-http schemes (`sgnl://…`)
 * never match — the offer is only for pages a browser can open.
 */
export function extractOfferUrl(text: string): string | undefined {
  for (const m of text.matchAll(URL_CANDIDATE)) {
    const candidate = m[0].replace(/[.,;:!?'"]+$/, '');
    if (candidate.includes('<') || candidate.includes('{{')) continue;
    try {
      if (!new URL(candidate).hostname) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return undefined;
}
