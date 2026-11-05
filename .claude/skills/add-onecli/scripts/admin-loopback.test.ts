import { describe, expect, it } from 'vitest';

import { nonLoopbackBindings, withLinuxHostGateway, withLoopbackAdmin } from './setup.js';

// The port and URL lines of the 1.45 compose file, as the installer writes it.
const stock = `services:
  postgres:
    image: postgres:18-alpine
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"
  onecli:
    image: ghcr.io/onecli/onecli:\${ONECLI_VERSION:-latest}
    container_name: onecli
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}:10254"
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}:10255"
    environment:
      APP_URL: \${APP_URL:-http://\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}}
      GATEWAY_API_URL: http://\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}
      INTERNAL_API_URL: http://localhost:10254
`;

describe('withLoopbackAdmin', () => {
  it('moves the admin API, Postgres and the APP_URL default to loopback', () => {
    const next = withLoopbackAdmin(stock)!;
    expect(next).toContain('- "127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    expect(next).toContain('- "127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(next).toContain('APP_URL: ${APP_URL:-http://127.0.0.1:${ONECLI_APP_PORT:-10254}}');
  });

  it('leaves the gateway port and its URL on the bind host', () => {
    const next = withLoopbackAdmin(stock)!;
    expect(next).toContain('- "${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"');
    expect(next).toContain('GATEWAY_API_URL: http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}');
    expect(next.split('\n')).toHaveLength(stock.split('\n').length);
  });

  it('keeps the host mapping setup adds and is a no-op on a second run', () => {
    const next = withLoopbackAdmin(withLinuxHostGateway(stock, 'linux'))!;
    expect(next).toContain('- "host.docker.internal:host-gateway"');
    expect(withLoopbackAdmin(next)).toBe(next);
  });

  it('returns null when a stock line is missing', () => {
    expect(withLoopbackAdmin(stock.replace('${ONECLI_APP_PORT:-10254}:10254"', '9000:10254"'))).toBeNull();
    expect(withLoopbackAdmin(stock.replace(/ {6}APP_URL: .*\n/, ''))).toBeNull();
  });
});

describe('nonLoopbackBindings', () => {
  it('lists bindings off loopback from docker port output', () => {
    expect(nonLoopbackBindings('172.17.0.1:10254\n[::]:10254\n')).toEqual(['172.17.0.1:10254', '[::]:10254']);
  });

  it('returns nothing for loopback-only bindings', () => {
    expect(nonLoopbackBindings('127.0.0.1:10254\n[::1]:10254\n')).toEqual([]);
    expect(nonLoopbackBindings('')).toEqual([]);
  });
});
