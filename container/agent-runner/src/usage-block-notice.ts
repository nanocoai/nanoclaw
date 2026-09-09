/**
 * A spent usage allowance, said in a sentence.
 *
 * The Gateway refuses a request whose owner has spent an allowance and names
 * the reason with a code from the usage-enforcement contract:
 * `usage_budget_reached` for the calendar-month dollar budget,
 * `usage_cap_reached` for the rolling daily token cap. The provider hands that
 * refusal on as the turn's error text, which is an RFC 9457 problem document.
 * Accurate, and unreadable to the person waiting for a reply.
 *
 * That contract carries no totals, limits or prices in the response on
 * purpose, so a notice may name the condition but never the numbers. Those
 * stay in the console, where the person who set the limit can see them.
 *
 * Matching is on the reason code alone. It is a token that contract defines,
 * it appears in no other provider error, and keying on it rather than on the
 * prose around it keeps this working when the runtime changes how it renders
 * an HTTP failure.
 */
const USAGE_BLOCK_NOTICES: ReadonlyArray<readonly [string, string]> = [
  [
    'usage_budget_reached',
    "I've reached the monthly usage budget for this account, so I can't reply right now. "
      + 'An administrator can raise it, and it resets at the start of next month.',
  ],
  [
    'usage_cap_reached',
    "I've reached the usage cap for this account, so I can't reply right now. "
      + 'An administrator can raise it, and it clears as earlier usage ages out.',
  ],
];

/**
 * The plain notice for a turn that failed because an allowance was spent, or
 * null when the text is any other error and must reach the user as it is.
 */
export function usageBlockNotice(text: string): string | null {
  for (const [code, notice] of USAGE_BLOCK_NOTICES) {
    if (text.includes(code)) return notice;
  }
  return null;
}
