import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installGateway = vi.fn();
const runGatewayAuth = vi.fn();
vi.mock('./install.js', () => ({ installGateway, runGatewayAuth }));
vi.mock('./selection.js', () => ({
  detectInstalledGateway: () => 'onecli',
  ensureExplicitGatewaySelection: () => 'onecli',
}));

const { run: runGatewayStep } = await import('./step.js');
const { run: runGatewayAuthStep } = await import('./auth-step.js');

// The step runner contract (docs/setup-flow.md): one terminal status block per
// step. Headless drivers parse it and treat a silent zero exit as a failure.
describe('gateway step status blocks', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(String(line));
    });
    installGateway.mockResolvedValue({ kind: 'iron-proxy', label: 'Iron Proxy', skillPath: '/x' });
    delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  });
  afterEach(() => vi.restoreAllMocks());

  it('gateway reports the installed kind', async () => {
    await runGatewayStep(['Iron-Proxy']);
    expect(installGateway).toHaveBeenCalledWith('iron-proxy');
    const block = lines.join('\n');
    expect(block).toContain('=== NANOCLAW SETUP: GATEWAY ===');
    expect(block).toContain('STATUS: success');
    expect(block).toContain('GATEWAY: iron-proxy');
    expect(block).toContain('=== END ===');
  });

  it('gateway-auth reports the gateway and agent provider it authenticated', async () => {
    process.env.NANOCLAW_GATEWAY_PROVIDER = 'iron-proxy';
    await runGatewayAuthStep([]);
    expect(runGatewayAuth).toHaveBeenCalledWith('iron-proxy', 'claude');
    const block = lines.join('\n');
    expect(block).toContain('=== NANOCLAW SETUP: GATEWAY_AUTH ===');
    expect(block).toContain('STATUS: success');
    expect(block).toContain('GATEWAY: iron-proxy');
    expect(block).toContain('PROVIDER: claude');
  });

  it('emits nothing when the install throws, leaving the runner to report failure', async () => {
    installGateway.mockRejectedValueOnce(new Error('skill did not apply'));
    await expect(runGatewayStep(['onecli'])).rejects.toThrow('skill did not apply');
    expect(lines.join('\n')).not.toContain('STATUS: success');
  });
});
