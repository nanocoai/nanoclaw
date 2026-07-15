# Channel Isolation Model

NanoClaw decouples messaging channels from agent groups. When you connect a channel (Discord, Telegram, Slack, GitHub, etc.), you decide how it relates to your existing agents. There are three isolation levels.

## The Three Levels

### 1. Shared Session

Multiple channels feed into the same conversation. The agent sees all messages from all channels in one thread.

**What's shared:** Everything — workspace, memory, CLAUDE.md, and the conversation itself. A GitHub PR comment and a Slack message appear side by side in the agent's context.

**Example:** A Slack channel paired with GitHub webhooks. The agent receives PR review requests via GitHub and discusses them in Slack — all in one session. When someone comments on a PR, the agent can reference the earlier Slack discussion about that feature.

**When to use:** When one channel feeds context into another. Webhook/notification channels (GitHub, Linear) paired with a chat channel (Slack, Discord) are the classic case.

**Technical:** Both messaging groups are wired to the same agent group with `session_mode: 'agent-shared'`. Session resolution looks up by agent group ID only, ignoring the messaging group — so all channels converge on one session.

---

### 2. Same Agent, Separate Sessions

Multiple channels share the same agent (same workspace, memory, personality) but have independent conversations.

**What's shared:** Workspace, memory, CLAUDE.md, and all persistent state. If you tell the agent something in one session, it can save that to memory and recall it in another. The agent's personality, knowledge, and tools are identical across sessions.

**What's separate:** The conversation thread. Messages from one channel don't appear in the other channel's session. Each channel has its own context window and conversation history.

**Example:** You have three Telegram chats with your agent — one for a side project, one for personal tasks, one for work. All three share the same agent workspace. If you ask it to remember your API key naming convention in the project chat, it may recall that convention in the work chat too. But the conversations themselves are independent.

**When to use:** When you're the primary (or sole) participant across channels and you want a unified agent identity. This is the most common setup for personal use across multiple platforms or multiple groups within one platform.

**Technical:** Multiple messaging groups are wired to the same agent group with `session_mode: 'shared'` (or `'per-thread'`). Each messaging group gets its own session, but they all run in the same agent group folder.

---

### 3. Separate Agent Groups

Each channel gets its own agent with its own workspace, memory, and personality. Nothing is shared.

**What's shared:** Nothing. The agents don't know about each other. Different CLAUDE.md, different memory, different workspace, different conversation history.

**Example:** You have a Telegram group with a friend and a Discord server for a team project. The friend shouldn't know what you discuss with your team, and vice versa. Each gets its own agent with its own memory and personality.

**When to use:** When different people are involved, or when the information in one channel should never leak to another. This is the right choice whenever there's a privacy or confidentiality boundary between channels.

**Technical:** Each channel is wired to a different agent group, each with its own folder under `groups/`. Separate containers, separate session databases, separate everything.

---

## How to Decide

The key question: **Are you okay with any and every piece of information from one channel being available in the other?**

- **No** → Separate agent groups (level 3)
- **Yes, and the channels should see each other's messages** → Shared session (level 1)
- **Yes, but the conversations should be independent** → Same agent, separate sessions (level 2)

### Rules of Thumb

| Scenario | Recommended Level |
|----------|------------------|
| Just you, multiple platforms (Telegram + Discord + Slack) | Same agent, separate sessions |
| Just you, multiple groups on one platform (3 Telegram chats) | Same agent, separate sessions |
| Webhook channel + chat channel (GitHub + Slack) | Shared session |
| Channel with friend A and channel with friend B | Separate agent groups |
| Personal channel and work channel | Separate agent groups |
| Team channel with different access levels | Separate agent groups |

### When in Doubt

If the participants are the same across channels → same agent group is usually fine.

If different people are involved → separate agent groups. Information will cross-pollinate through agent memory if you don't.

## Entity Model

```
agent_groups (workspace, memory, CLAUDE.md, personality)
    ↕ many-to-many
messaging_groups (a specific channel/chat/group on a platform)
    via
messaging_group_agents (session_mode, engage_mode, engage_pattern, sender_scope, ignored_message_policy, priority, threads)
```

Wiring-creation defaults for engage mode/pattern, thread policy, and unknown-sender policy come from the channel adapter's declaration (per DM/group context), overridable per wiring at creation — see [setup-wiring.md](setup-wiring.md#channel-defaults-two-level-model) and [api-details.md](api-details.md#channel-defaults).

- **Shared session:** multiple messaging_groups → same agent_group, `session_mode = 'agent-shared'`
- **Same agent, separate sessions:** multiple messaging_groups → same agent_group, `session_mode = 'shared'`
- **Separate agents:** each messaging_group → different agent_group
