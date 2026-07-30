import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { gatePolicy, extractOfferUrl, type GateDecision } from './skill-policy.js';
import { parseDirectives } from './skill-directives.js';

// The parity fixtures are the REAL in-tree channel skills: the policy's whole
// claim is that it reproduces (and deliberately extends — the readiness pauses,
// the discord confirm) the barrier behavior the authored `gate` attrs encoded,
// from document structure alone. Keyed by operator ORDER, not line number, so
// the assertions survive unrelated prose edits.
const loadSkill = (channel: string): string =>
  readFileSync(join(process.cwd(), `.claude/skills/add-${channel}/SKILL.md`), 'utf8');

/** The gate decisions for a skill's operator blocks, in document order. */
function decisions(md: string): GateDecision[] {
  const gates = gatePolicy(md);
  return parseDirectives(md)
    .filter((d) => d.kind === 'operator')
    .map((d) => gates.get(d.line)!);
}

/** The rendered-ish body (raw, un-substituted) of the nth operator block. */
function operatorBody(md: string, n: number): string {
  const ops = parseDirectives(md).filter((d) => d.kind === 'operator');
  return ops[n].body.join('\n');
}

describe('gatePolicy — §5.1 parity table (real skills)', () => {
  it('teams: one gate — the install-in-Teams operator pauses before the DM-open fetches', () => {
    // Operators in order (CLI-first flow): prerequisites, the detected-owner
    // note, the wire-declined note (when:wire_owner=no), install-in-Teams.
    // The finish-wiring handoff is prose only — the wizard wires inline from
    // the resolved vars.
    const d = decisions(loadSkill('teams'));
    expect(d).toHaveLength(4);
    expect(d.map((g) => g.needsConfirm)).toEqual([
      false, // prereqs → prompt public_url (prompt is the barrier)
      false, // detected-owner note → prompt wire_owner (prompt is the barrier)
      false, // wire-declined note → install operator (last operator of the chain carries the barrier)
      true, //  install-in-Teams → the DM-open effect:fetch chain
    ]);
    // Completed-work flavor (fetch/external, not effect:step).
    expect(d[3].flavor).toBe('completed');
  });

  it('telegram: the pairing operator gains a readiness pause before the effect:step', () => {
    const d = decisions(loadSkill('telegram'));
    expect(d.map((g) => g.needsConfirm)).toEqual([false, true]); // BotFather → prompt; pairing → step
    expect(d[1].flavor).toBe('readiness'); // "a 4-digit code is about to appear"
  });

  it('signal: readiness pause before the QR device-link step', () => {
    const d = decisions(loadSkill('signal'));
    expect(d.map((g) => g.needsConfirm)).toEqual([true]);
    expect(d[0].flavor).toBe('readiness');
  });

  it('whatsapp: each auth-method operator skips the OTHER branch and gates on its own step', () => {
    const d = decisions(loadSkill('whatsapp'));
    // shared-number ban warning → shared_confirm prompt (natural barrier);
    // qr operator skips the pairing-code operator + step (guard-incompatible)
    // and gates on the qr effect:step; pairing-code likewise; the dedicated
    // chat-number block and the shared-mode closing note are prompt-followed
    // or terminal.
    expect(d.map((g) => g.needsConfirm)).toEqual([false, true, true, false, false]);
    expect(d[1].flavor).toBe('readiness');
    expect(d[2].flavor).toBe('readiness');
  });

  it('imessage: guard-compatibility — the local block skips the remote-only prompts and gates on the local configure run', () => {
    const d = decisions(loadSkill('imessage'));
    // local (when:mode=local) → skips remote operator + 2 remote prompts →
    // run effect:external when:mode=local ⇒ confirm ("stop and wait" restored);
    // remote (when:mode=remote) → prompt server_url (identical guard) ⇒ no confirm.
    expect(d.map((g) => g.needsConfirm)).toEqual([true, false]);
    expect(d[0].flavor).toBe('completed');
  });

  it('discord: the invite operator gains a confirm before the DM resolve (effect:fetch)', () => {
    const d = decisions(loadSkill('discord'));
    expect(d.map((g) => g.needsConfirm)).toEqual([false, true]);
    expect(d[1].flavor).toBe('completed');
  });

  it('slack: all three operators are prompt-followed — no confirm, unchanged', () => {
    // socket-create (guard-skips its webhook twin, lands on the bot_token
    // prompt), webhook-create (bot_token prompt), event-delivery (owner_handle
    // prompt in Resolve) — every barrier is a natural prompt barrier.
    expect(decisions(loadSkill('slack')).map((g) => g.needsConfirm)).toEqual([false, false, false]);
  });
});

describe('gatePolicy — rules on synthetic fixtures', () => {
  const fence = (info: string, body: string): string => `\`\`\`${info}\n${body}\n\`\`\`\n`;

  it('end of document → no confirm (a final handoff block)', () => {
    const md = `# t\n${fence('nc:operator', 'All done — go DM the bot.')}`;
    expect(decisions(md)).toEqual([{ needsConfirm: false, flavor: 'completed' }]);
  });

  it('operator chain: only the LAST operator of a chain carries the barrier', () => {
    const md = `# t\n${fence('nc:operator', 'first block')}${fence('nc:operator', 'second block')}${fence('nc:run effect:external', 'do-it')}`;
    expect(decisions(md).map((g) => g.needsConfirm)).toEqual([false, true]);
  });

  it('confirm fires for ALL non-prompt/non-operator barriers — even an env-set', () => {
    const md = `# t\n${fence('nc:prompt v', 'Value?')}${fence('nc:operator', 'go get v')}${fence('nc:env-set', 'K={{v}}')}`;
    expect(decisions(md)).toEqual([{ needsConfirm: true, flavor: 'completed' }]);
  });

  it('flavor: an effect:step barrier is a readiness pause, anything else completed-work', () => {
    const step = `# t\n${fence('nc:operator', 'a code is about to appear')}${fence('nc:run effect:step capture:x=X', 'pair')}`;
    expect(decisions(step)[0]).toEqual({ needsConfirm: true, flavor: 'readiness' });
    const run = `# t\n${fence('nc:operator', 'finish the portal steps')}${fence('nc:run effect:check', 'true')}`;
    expect(decisions(run)[0]).toEqual({ needsConfirm: true, flavor: 'completed' });
  });

  it('guard-compatibility: same-var/different-value directives are skipped; different-var guards are compatible', () => {
    // Mutually-exclusive branch: the m=a operator skips the m=b prompt+run and
    // gates on its OWN run.
    const branch =
      `# t\n${fence('nc:prompt m', 'mode?')}` +
      fence('nc:operator when:m=a', 'branch a steps') +
      fence('nc:prompt other when:m=b', 'b only') +
      fence('nc:run effect:external when:m=b', 'b-run') +
      fence('nc:run effect:external when:m=a', 'a-run');
    expect(decisions(branch)).toEqual([{ needsConfirm: true, flavor: 'completed' }]);
    // Different-var guard = compatible (conservative): the prompt is the barrier.
    const diffVar =
      `# t\n${fence('nc:prompt m', 'mode?')}` +
      fence('nc:operator when:m=a', 'branch a steps') +
      fence('nc:prompt other when:x=y', 'unrelated guard');
    expect(decisions(diffVar).map((g) => g.needsConfirm)).toEqual([false]);
  });
});

// §5.2 URL-offer inventory — every operator body in the tree, plus the
// normative negative fixture (slack's placeholder URL).
describe('extractOfferUrl — §5.2 inventory', () => {
  it('teams: raw bodies stay offer-free — the install link is a {{var}} until substitution', () => {
    const md = loadSkill('teams');
    // The install block's URL is {{install_link}} in the AUTHORED body — no
    // candidate matches here; the offer materializes at runtime from the
    // rendered body (proven in run-channel-skill.test.ts's fresh-create case).
    expect(operatorBody(md, 3)).toContain('{{install_link}}');
    expect(extractOfferUrl(operatorBody(md, 0))).toBeUndefined(); // prereqs
    expect(extractOfferUrl(operatorBody(md, 1))).toBeUndefined(); // detected-owner note
    expect(extractOfferUrl(operatorBody(md, 2))).toBeUndefined(); // wire-declined note (entra link is schemeless on purpose)
    expect(extractOfferUrl(operatorBody(md, 3))).toBeUndefined(); // install-in-Teams
  });

  it('slack — the <your-public-host> placeholder is EXCLUDED (normative negative fixture)', () => {
    const md = loadSkill('slack');
    const body = operatorBody(md, 2); // event-delivery block (after the two create-app variants)
    expect(body).toContain('https://<your-public-host>/webhook/slack'); // fixture still authored as a placeholder
    expect(extractOfferUrl(body)).toBeUndefined(); // slack stays offer-free
  });

  it('slack :69 — a scheme-less mention (api.slack.com/apps) never matches', () => {
    expect(extractOfferUrl(operatorBody(loadSkill('slack'), 0))).toBeUndefined();
  });

  it('discord: the developers-portal block gains an offer; imessage: photon.codes', () => {
    expect(extractOfferUrl(operatorBody(loadSkill('discord'), 0))).toBe('https://discord.com/developers/applications');
    expect(extractOfferUrl(operatorBody(loadSkill('imessage'), 1))).toBe('https://photon.codes');
  });

  it('signal: a non-http scheme (sgnl://…) never matches', () => {
    expect(extractOfferUrl(operatorBody(loadSkill('signal'), 0))).toBeUndefined();
  });

  it('an unsubstituted {{var}} in the URL is excluded; the substituted form offers', () => {
    // The telegram/discord shape once their URLs live in the prose: rendered
    // text has the var substituted; a defer path could surface the raw form.
    expect(extractOfferUrl('Open https://t.me/{{bot_username}} in Telegram now.')).toBeUndefined();
    expect(extractOfferUrl('Open https://t.me/my_helper_bot in Telegram now.')).toBe('https://t.me/my_helper_bot');
  });

  it('strips trailing sentence punctuation and stops at ), ], >', () => {
    expect(extractOfferUrl('Visit https://example.com.')).toBe('https://example.com');
    expect(extractOfferUrl('(see https://example.com/docs) for details')).toBe('https://example.com/docs');
    expect(extractOfferUrl('nothing to open here')).toBeUndefined();
  });

  it('returns the FIRST offerable URL, skipping earlier excluded candidates', () => {
    expect(extractOfferUrl('Set https://<host>/hook then read https://docs.example.com/setup.')).toBe(
      'https://docs.example.com/setup',
    );
  });
});
