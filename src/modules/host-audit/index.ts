/** Runtime host activity registration. All observers are fail-open by their host registries. */
import '../../audit/migration.js';
import '../../audit/governance-drain.js';

import {
  registerDeliveryAction,
  registerPostDeliveryHook,
} from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import {
  mapFileDelivered,
  mapResponseCompleted,
  mapSkillCreated,
  mapSkillUsed,
} from '../../audit/activity-mappers.js';
import { emitAuditEvent } from '../../audit/emit.js';
import { parseContainerSkillActivity } from '../../audit/runtime-emitters.js';

registerPostDeliveryHook(async (msg, session) => {
  const common = {
    agentId: session.agent_group_id,
    sessionId: session.id,
    channelType: msg.channelType,
    messagingGroupId: session.messaging_group_id,
    activityId: msg.id,
  };
  const responseEvent = mapResponseCompleted(common);
  if (responseEvent) await emitAuditEvent(responseEvent);

  try {
    const content = JSON.parse(msg.content) as Record<string, unknown>;
    const fileEvent = mapFileDelivered({ ...common, files: content.files });
    if (fileEvent) await emitAuditEvent(fileEvent);
  } catch {
    // The response record above remains valid; malformed content is never copied into evidence.
  }
});

registerDeliveryAction(
  'host_audit_activity',
  async (content, session) => {
    const activity = parseContainerSkillActivity(content);
    if (!activity) return;
    const mapSkill = activity.eventType === 'skill_created' ? mapSkillCreated : mapSkillUsed;
    const event = mapSkill({
      agentId: session.agent_group_id,
      sessionId: session.id,
      skillName: activity.activityId,
      transport: 'container',
    });
    if (event) await emitAuditEvent(event);
  },
  unguarded('evidence-only closed structural activity; no privileged side effect'),
);
