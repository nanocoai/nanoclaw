# NanoClaw Architecture Diagram

## System Overview

```mermaid
flowchart TB
  subgraph Platforms["Messaging Platforms"]
    P1[Discord]
    P2[Telegram]
    P3[Slack]
    P4[GitHub / Linear]
    P5[WhatsApp / iMessage / Teams / GChat / Matrix / Webex / Email]
  end

  subgraph Host["Host Process (Node)"]
    direction TB
    Bridge["Chat SDK Bridge<br/>(src/channels/chat-sdk-bridge.ts)"]
    Router["Router<br/>(src/router.ts)<br/>platformId + threadId -> messaging_group -> agent_group -> session"]
    SessMgr["Session Manager<br/>(src/session-manager.ts)<br/>creates inbound.db + outbound.db"]
    Runner["Container Runner<br/>(src/container-runner.ts)<br/>OneCLI ensureAgent + spawn"]
    Delivery["Delivery Poller<br/>(src/delivery.ts)<br/>1s active / 60s sweep"]
    Sweep["Host Sweep<br/>(src/host-sweep.ts)<br/>heartbeat, retry, recurrence"]
    Central[("Central DB<br/>data/v2.db<br/>agent_groups<br/>messaging_groups<br/>messaging_group_agents<br/>sessions<br/>pending_approvals")]
  end

  subgraph OneCLI["OneCLI Gateway (0.3.1)"]
    Vault["Agent Vault<br/>secrets + OAuth"]
    Approvals["configureManualApproval<br/>-> pending_approvals"]
  end

  subgraph Session["Per-Session Container (Docker / Apple Container)"]
    direction TB
    PollLoop["Poll Loop<br/>(container/agent-runner)"]
    Provider["Agent providers<br/>(claude, opencode; todo: codex)"]
    MCP["MCP Tools<br/>send_message, send_file, edit_message,<br/>add_reaction, send_card, ask_user_question,<br/>schedule_task, create_agent,<br/>install_packages, add_mcp_server"]
    Skills["Container Skills<br/>(container/skills/)"]
    InDB[("inbound.db<br/>host writes<br/>even seq<br/>messages_in<br/>destinations<br/>processing_ack")]
    OutDB[("outbound.db<br/>container writes<br/>odd seq<br/>messages_out<br/>heartbeat file")]
  end

  subgraph Groups["Agent Group Filesystem (groups/*)"]
    Folder["CLAUDE.md<br/>memory<br/>per-group skills<br/>container_config"]
  end

  P1 & P2 & P3 & P4 & P5 --> Bridge
  Bridge --> Router
  Router --> Central
  Router --> SessMgr
  SessMgr --> InDB
  SessMgr --> Runner
  Runner --> OneCLI
  Runner --> PollLoop
  PollLoop --> InDB
  PollLoop --> Provider
  Provider --> MCP
  Provider --> Skills
  MCP --> OutDB
  OutDB --> Delivery
  Delivery --> Central
  Delivery --> Bridge
  Bridge --> P1 & P2 & P3 & P4 & P5
  Sweep --> InDB
  Sweep --> OutDB
  Sweep --> Central
  Runner -.mounts.-> Folder
  MCP -.approval.-> Approvals
  Approvals --> Central
  Provider -.API calls.-> Vault
```

## Message Flow (inbound -> agent -> outbound)

```mermaid
sequenceDiagram
  participant P as Platform (e.g. Telegram)
  participant B as Chat SDK Bridge
  participant R as Router
  participant SM as Session Manager
  participant IDB as inbound.db
  participant C as Container (agent-runner)
  participant ODB as outbound.db
  participant D as Delivery Poller

  P->>B: new message
  B->>R: routeInbound(platformId, threadId, msg)
  R->>R: resolve messaging_group -> agent_group -> session<br/>(agent-shared | shared | per-thread)
  R->>SM: ensure session + DBs exist
  R->>IDB: INSERT messages_in (even seq)
  R->>C: wake container (docker run / already running)
  C->>IDB: poll messages_in
  C->>C: format xml, stream to selected provider
  C->>ODB: INSERT messages_out (odd seq)<br/>parse <message to="name"> blocks
  D->>ODB: 1s poll (active) / 60s (sweep)
  D->>D: hasDestination() re-validate
  D->>B: deliver via adapter
  B->>P: send message / edit / react / file / card
```

## Named Destinations + Agent-to-Agent

```mermaid
flowchart LR
  subgraph AgentA["Agent Group A (main)"]
    A_out["output:<br/>&lt;message to='slack'&gt;...&lt;/message&gt;<br/>&lt;message to='browser-agent'&gt;...&lt;/message&gt;<br/>&lt;internal&gt;scratchpad&lt;/internal&gt;"]
  end

  subgraph Dests["inbound.db.destinations (per agent)"]
    D1["slack -> messaging_group 42"]
    D2["browser-agent -> agent_group 7<br/>(bidirectional row)"]
    D3["github -> messaging_group 13"]
  end

  subgraph AgentB["Agent Group B (browser sub-agent)"]
    B_session["own inbound.db / outbound.db<br/>inherited destination back to A"]
  end

  Slack[Slack channel]
  GitHub[GitHub PR thread]

  A_out -->|parse + lookup| Dests
  D1 -->|deliver| Slack
  D2 -->|write to B's inbound.db| B_session
  D3 -->|deliver| GitHub
  B_session -.reply via 'parent'.-> Dests
```

## Entity Model + Isolation Levels

```mermaid
erDiagram
  agent_groups ||--o{ messaging_group_agents : wired
  messaging_groups ||--o{ messaging_group_agents : wired
  agent_groups ||--o{ sessions : runs
  messaging_groups ||--o{ sessions : context
  agent_groups ||--o{ agent_destinations : owns
  agent_groups ||--o{ pending_approvals : requests

  agent_groups {
    int id
    string name
    string folder
    string agent_provider
    json container_config
  }
  messaging_groups {
    int id
    string channel_type
    string platform_id
    string name
    bool is_group
    string unknown_sender_policy "strict | request_approval | public"
  }
  users {
    string id PK "namespaced <channel>:<handle>"
    string kind
    string display_name
  }
  user_roles {
    string user_id FK
    string role "owner | admin"
    string agent_group_id FK "null = global"
  }
  agent_group_members {
    string user_id FK
    string agent_group_id FK
  }
  user_dms {
    string user_id FK
    string channel_type
    string messaging_group_id FK
  }
  messaging_group_agents {
    int messaging_group_id
    int agent_group_id
    string session_mode "agent-shared | shared | per-thread"
    json trigger_rules
    int priority
  }
  sessions {
    int id
    int agent_group_id
    int messaging_group_id
    string sdk_session_id
    string status
  }
```

### Isolation Level Cheatsheet

| Level | `session_mode` | What's shared | Example |
|---|---|---|---|
| 1. Shared session | `agent-shared` | Workspace + memory + conversation | Slack + GitHub webhooks in one thread |
| 2. Same agent, separate sessions | `shared` / `per-thread` | Workspace + memory only | One agent across 3 Telegram chats |
| 3. Separate agent groups | (different `agent_group_id`) | Nothing | Personal vs work channels |

## Two-DB Split (why)

```mermaid
flowchart LR
  subgraph Mount["/workspace (volume mounted into container)"]
    In[("inbound.db")]
    Out[("outbound.db")]
    HB["/.heartbeat (file touch)"]
  end

  Host[Host process] -->|"writes only<br/>(even seq)"| In
  Host -->|reads| Out
  Container[agent-runner] -->|reads| In
  Container -->|"writes only<br/>(odd seq)"| Out
  Container -->|touch every poll| HB
  HostSweep[Host sweep] -->|stat mtime| HB
  HostSweep -->|reads processing_ack| In

  note1["Each file has exactly ONE writer.<br/>Eliminates SQLite cross-process write contention.<br/>Collision-free seq numbering."]
```
