/**
 * Registration for automatic Slack app provisioning — the default Slack
 * experience.
 *
 * This shim is the only piece of the feature on the wizard's boot path;
 * it always registers. The flow itself (slack-auto.ts
 * plus the provisioning core it bootstraps from the channels branch — the
 * module's permanent home is the add-slack channel payload, at
 * src/provisioning/slack-app.ts on an installed tree) loads via dynamic
 * import only when the wizard actually invokes the Slack pre-step. No
 * fetch, no import, nothing runs unless Slack is chosen.
 *
 * The register function is injected by the caller so this module has zero
 * runtime imports — no import cycle with the registry.
 */
import type { ChannelPreStep } from './companions.js';

export function registerSlackAutoProvision(register: (channel: string, step: ChannelPreStep) => void): void {
  register('slack', async (agentName) => {
    const { maybeAutoProvisionSlack } = await import('./slack-auto.js');
    return maybeAutoProvisionSlack(agentName);
  });
}
