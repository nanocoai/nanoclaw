import { describe, it, expect } from 'vitest';

import { getLaunchdLabel, getSystemdUnit } from '../install-slug.js';
import { formatTransportError } from './transport-errors.js';

describe('formatTransportError', () => {
  it('renders per-install service names on ENOENT, not the bare v1 names', () => {
    const out = formatTransportError(new Error('connect ENOENT /tmp/nanoclaw.sock'));

    // Regression for #2484: pre-fix, this string was a hardcoded
    // `com.nanoclaw` / `nanoclaw`, which doesn't match the actual
    // v2 per-install slug-suffixed unit and label.
    expect(out).toContain(`gui/$(id -u)/${getLaunchdLabel()}`);
    expect(out).toContain(`systemctl --user restart ${getSystemdUnit()}`);
    expect(out).not.toMatch(/gui\/\$\(id -u\)\/com\.nanoclaw\b(?!-v2)/);
    expect(out).not.toMatch(/systemctl --user restart nanoclaw\b(?!-v2)/);
  });

  it('renders the same on ECONNREFUSED', () => {
    const out = formatTransportError(new Error('connect ECONNREFUSED'));
    expect(out).toContain(getLaunchdLabel());
    expect(out).toContain(getSystemdUnit());
  });

  it('falls back to a generic transport error for other failures', () => {
    const out = formatTransportError(new Error('some unrelated failure'));
    expect(out).toBe('ncl: transport error: some unrelated failure\n');
    expect(out).not.toContain('launchctl');
    expect(out).not.toContain('systemctl');
  });
});
