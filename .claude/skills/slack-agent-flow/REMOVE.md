# Remove slack-agent-flow

Reverses everything Apply added. Runtime data the flow created (agent groups,
messaging groups, wirings, `.env` token/instance/room lines, provisioned Slack
apps) is user data and is deliberately left alone — for per-agent teardown of
a provisioned bot, follow the slack-managed-agents skill's teardown section.

1. Delete the barrel registration lines (delete, don't comment out):
   - `import './slack-agent-flow/index.js';`, `import './slack-room-membership/index.js';`,
     `import './canvas-actions/index.js';`, and `import './slack-onboarding/index.js';`
     from `src/modules/index.ts`
   - `import './rooms.js';` and `import './canvas.js';` from
     `container/agent-runner/src/mcp-tools/index.ts`

2. Delete the copied payload files (the flow's own plus the shared feature
   payload it copies from the channels branch):

   ```bash
   rm -rf src/modules/slack-agent-flow src/modules/slack-room-membership \
          src/modules/canvas-actions src/modules/slack-onboarding
   rm -f src/env-file.ts src/env-file.test.ts
   rm -f scripts/slack-agent-flow-finish.ts
   rm -f container/agent-runner/src/mcp-tools/rooms.ts \
         container/agent-runner/src/mcp-tools/rooms.test.ts \
         container/agent-runner/src/mcp-tools/rooms.instructions.md \
         container/agent-runner/src/mcp-tools/create-agent-slack.instructions.md \
         container/agent-runner/src/mcp-tools/canvas.ts \
         container/agent-runner/src/mcp-tools/canvas.instructions.md \
         container/agent-runner/src/mcp-tools/canvas.test.ts
   rm -rf container/skills/slack-construct-agents container/skills/slack-construct \
          container/skills/canvas-work
   rm -f container/skills/welcome/addenda/teams-tour.md \
         container/skills/welcome/addenda/slack.md
   ```

3. Rebuild and restart:

   ```bash
   pnpm run build
   bash setup/lib/restart.sh
   ```

Composed group CLAUDE.md files regenerate on the next container spawn, so the
dropped instructions fragment and welcome addendum disappear from agents
without any manual cleanup.
