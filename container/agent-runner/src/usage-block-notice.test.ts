/**
 * A budget that enforces correctly used to present as an agent that stops
 * talking: the Gateway answered 429, every client retried it silently, and
 * nothing reached the person. The Gateway now refuses with 403 so the turn
 * ends (nanoco-gw#152); these pin what the person then reads.
 */
import { describe, expect, it } from 'bun:test';

import { usageBlockNotice } from './usage-block-notice.js';

const problem = (code: string) =>
  'API Error: 403 {"type":"https://nanoco.ai/problems/usage-enforcement",'
  + `"title":"Usage enforcement blocked the request","status":403,"code":"${code}"}`;

describe('usageBlockNotice', () => {
  it('says a spent monthly budget in a sentence, and when it lifts', () => {
    const notice = usageBlockNotice(problem('usage_budget_reached'));
    expect(notice).toContain('monthly usage budget');
    expect(notice).toContain('next month');
    expect(notice).not.toContain('403');
    expect(notice).not.toContain('usage_budget_reached');
  });

  it('distinguishes the rolling cap, which clears on its own', () => {
    const notice = usageBlockNotice(problem('usage_cap_reached'));
    expect(notice).toContain('usage cap');
    expect(notice).toContain('ages out');
    expect(notice).not.toContain('next month');
  });

  /**
   * The enforcement contract keeps totals, limits and prices out of the
   * response. A notice built from it must not invent them either.
   */
  it('names no figure, because the refusal carries none', () => {
    for (const code of ['usage_budget_reached', 'usage_cap_reached']) {
      expect(usageBlockNotice(problem(code))).not.toMatch(/\d/u);
    }
  });

  it('leaves every other failure alone', () => {
    expect(usageBlockNotice('API Error: 500 upstream unavailable')).toBeNull();
    expect(usageBlockNotice('API Error: 403 {"code":"policy_denied"}')).toBeNull();
    expect(usageBlockNotice('')).toBeNull();
  });

  /**
   * The code is matched wherever it sits, because the runtime decides how much
   * of the body survives into the turn's error text.
   */
  it('finds the reason code in a truncated or reworded rendering', () => {
    expect(usageBlockNotice('403 usage_budget_reached')).toContain('monthly usage budget');
    expect(usageBlockNotice('request failed: usage_cap_reached ...')).toContain('usage cap');
  });
});
