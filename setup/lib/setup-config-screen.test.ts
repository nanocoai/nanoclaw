import { describe, expect, it, vi } from 'vitest';

const { select } = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('@clack/prompts', () => ({}));
vi.mock('./bright-select.js', () => ({ brightSelect: select }));
vi.mock('./runner.js', () => ({ ensureAnswer: (value: unknown) => value }));

import { runAdvancedScreen } from './setup-config-screen.js';

describe('advanced gateway selection', () => {
  it('uses catalog-provided gateway options', async () => {
    select.mockResolvedValueOnce('gatewayProvider').mockResolvedValueOnce('onecli').mockResolvedValueOnce('__done__');

    const result = await runAdvancedScreen(
      { gatewayProvider: 'iron-proxy' },
      { gatewayProvider: [{ value: 'onecli', label: 'OneCLI' }] },
    );

    expect(result.gatewayProvider).toBe('onecli');
    expect(select.mock.calls[1][0].options).toContainEqual({ value: 'onecli', label: 'OneCLI' });
  });
});
