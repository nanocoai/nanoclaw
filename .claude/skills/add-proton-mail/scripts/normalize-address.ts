/**
 * Print an address in the form Proton Mail's adapter matches mail on (its own
 * normalizeAddress: trimmed, NFC, lower case, the domain in ASCII/punycode).
 * The skill stores the owner's address through this, so the stored row and
 * inbound mail can never disagree. Run after step 1 has copied the adapter in.
 *
 *   pnpm exec tsx .claude/skills/add-proton-mail/scripts/normalize-address.ts 'Owner@Bücher.example'
 *   → NORMALIZED=owner@xn--bcher-kva.example
 */
import { normalizeAddress } from '../../../../src/channels/proton-mail.js';

// Marked, so the skill takes this line alone: importing the adapter runs its
// module code, and anything that logs to stdout must not become the address.
process.stdout.write(`NORMALIZED=${normalizeAddress(process.argv[2] ?? '')}\n`);
