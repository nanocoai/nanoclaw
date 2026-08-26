import { describe, expect, it } from 'vitest';

import { EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER } from './config.js';
import { gatewayNetworkConnectArgs } from './egress-lockdown.js';

describe('gatewayNetworkConnectArgs', () => {
  it('keeps both OneCLI proxy hostnames resolvable under egress lockdown', () => {
    expect(gatewayNetworkConnectArgs()).toEqual([
      'network',
      'connect',
      '--alias',
      'host.docker.internal',
      '--alias',
      'gateway',
      EGRESS_NETWORK,
      ONECLI_GATEWAY_CONTAINER,
    ]);
  });
});
