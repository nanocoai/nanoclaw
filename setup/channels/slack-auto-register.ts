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
 * Registration also declares the Slack agents companion skills. `/add-slack`
 * alone is the base experience (one bot, DM/channel chat); the agents
 * feature — child bots provisioned from `create_agent`, shared a2a rooms,
 * canvases, DM onboarding — ships in the `slack-a2a-rooms` and
 * `slack-agent-flow` skills on the channels branch. Declaring them HERE, at
 * wizard boot, is load-bearing: the wizard imports the companion registry
 * once, so a registration appended to the registry file mid-run is invisible
 * to the process that would apply it. The channel flow materializes the
 * skill directories from the channels branch when this checkout doesn't
 * carry them.
 *
 * The register functions are injected by the caller (companions.ts passes
 * `registerChannelPreStep` / `registerCompanionSkills`) so this module has
 * zero runtime imports — no import cycle with the registry.
 */
import type { ChannelPreStep } from './companions.js';

/**
 * Applied in order after `/add-slack`: the room admission policy first (the
 * flow's prerequisite), then the create_agent → provisioned-bot flow.
 */
export const SLACK_AGENTS_COMPANION_SKILLS = ['slack-a2a-rooms', 'slack-agent-flow'] as const;

export function registerSlackAutoProvision(
  register: (channel: string, step: ChannelPreStep) => void,
  registerCompanions: (channel: string, skills: readonly string[]) => void,
): void {
  register('slack', async (agentName) => {
    const { maybeAutoProvisionSlack } = await import('./slack-auto.js');
    return maybeAutoProvisionSlack(agentName);
  });
  registerCompanions('slack', SLACK_AGENTS_COMPANION_SKILLS);
}
