---
name: add-agentmail
description: Add AgentMail email integration to NanoClaw. Create inboxes, send, read, and reply to emails via IPC. API key stays on the host. Triggers on "add agentmail", "add email", "setup agentmail", "agentmail integration".
---

# Add AgentMail Email Integration

This skill adds email capabilities to NanoClaw using the AgentMail API. The agent can create inboxes, send emails, read emails, and reply — all through secure IPC (the API key never enters the container).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need an AgentMail API key.
>
> Get one at: https://www.agentmail.to
>
> 1. Sign up or log in
> 2. Go to your dashboard → API Keys
> 3. Create a new API key
>
> Once you have your API key, we'll configure it securely.

Wait for user to confirm they have an API key before continuing.

---

## Implementation

### Step 1: Install AgentMail SDK

Check if already installed:

```bash
npm ls agentmail 2>/dev/null || npm install agentmail
```

This is a host-only dependency — it is NOT added to the container Dockerfile.

### Step 2: Add Config Entry

Read `src/config.ts` and add `'AGENTMAIL_API_KEY'` to the `readEnvFile` call, then export it:

```typescript
const envConfig = readEnvFile([..., 'AGENTMAIL_API_KEY']);

export const AGENTMAIL_API_KEY =
  process.env.AGENTMAIL_API_KEY || envConfig.AGENTMAIL_API_KEY || '';
```

### Step 3: Create Email Service

Create `src/email-service.ts` — a thin wrapper around the AgentMail SDK:

```typescript
import fs from 'fs';
import path from 'path';
import { AgentMailClient } from 'agentmail';
import { AGENTMAIL_API_KEY, DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface EmailGuardrails {
  maxPerHour: number;       // 0 = unlimited
  allowedDomains: string[]; // empty = all allowed
}

const DEFAULT_GUARDRAILS: EmailGuardrails = { maxPerHour: 0, allowedDomains: [] };
const sendTimestamps: number[] = [];

function loadGuardrails(): EmailGuardrails {
  const configPath = path.join(DATA_DIR, 'email-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return {
        maxPerHour: raw.maxPerHour ?? DEFAULT_GUARDRAILS.maxPerHour,
        allowedDomains: raw.allowedDomains ?? DEFAULT_GUARDRAILS.allowedDomains,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load email guardrails config');
  }
  return DEFAULT_GUARDRAILS;
}

function checkRateLimit(): void {
  const guardrails = loadGuardrails();
  if (guardrails.maxPerHour <= 0) return;
  const now = Date.now();
  while (sendTimestamps.length > 0 && sendTimestamps[0] < now - 3600000) sendTimestamps.shift();
  if (sendTimestamps.length >= guardrails.maxPerHour) {
    throw new Error(`Rate limit exceeded: ${guardrails.maxPerHour} emails per hour`);
  }
}

function checkDomain(to: string | string[]): void {
  const guardrails = loadGuardrails();
  if (guardrails.allowedDomains.length === 0) return;
  const recipients = Array.isArray(to) ? to : [to];
  for (const addr of recipients) {
    const domain = addr.split('@')[1]?.toLowerCase();
    if (!domain || !guardrails.allowedDomains.includes(domain)) {
      throw new Error(`Domain "${domain}" not in allowed domains: ${guardrails.allowedDomains.join(', ')}`);
    }
  }
}

function getClient(): AgentMailClient {
  if (!AGENTMAIL_API_KEY) throw new Error('AGENTMAIL_API_KEY is not configured');
  return new AgentMailClient({ apiKey: AGENTMAIL_API_KEY });
}

export async function createInbox(displayName?: string) {
  const client = getClient();
  const inbox = await client.inboxes.create(displayName ? { displayName } : undefined);
  const address = `${inbox.inboxId}@agentmail.to`;
  logger.info({ inboxId: inbox.inboxId, address }, 'Email inbox created');
  return { inboxId: inbox.inboxId, address };
}

export async function deleteInbox(inboxId: string) {
  const client = getClient();
  await client.inboxes.delete(inboxId);
  logger.info({ inboxId }, 'Email inbox deleted');
  return { success: true };
}

export async function sendEmail(inboxId: string, to: string | string[], subject: string, text: string, html?: string) {
  checkRateLimit();
  checkDomain(to);
  const client = getClient();
  const result = await client.inboxes.messages.send(inboxId, { to, subject, text, html });
  sendTimestamps.push(Date.now());
  logger.info({ inboxId, to, subject }, 'Email sent');
  return { messageId: result.messageId, threadId: result.threadId };
}

export async function readEmails(inboxId: string, limit?: number) {
  const client = getClient();
  const response = await client.inboxes.messages.list(inboxId, { limit: limit || 20 });
  const messages = [];
  for (const item of response.messages || []) {
    try {
      const full = await client.inboxes.messages.get(inboxId, item.messageId);
      messages.push({
        messageId: full.messageId, threadId: full.threadId,
        from: full.from, to: full.to,
        subject: full.subject, text: full.text || full.extractedText,
        timestamp: full.timestamp.toISOString(),
      });
    } catch {
      messages.push({
        messageId: item.messageId, threadId: item.threadId,
        from: item.from, to: item.to, subject: item.subject,
        text: undefined, timestamp: item.timestamp.toISOString(),
      });
    }
  }
  logger.info({ inboxId, count: messages.length }, 'Emails read');
  return messages;
}

export async function replyEmail(inboxId: string, messageId: string, text: string, html?: string) {
  checkRateLimit();
  const client = getClient();
  const result = await client.inboxes.messages.reply(inboxId, messageId, { text, html });
  sendTimestamps.push(Date.now());
  logger.info({ inboxId, messageId }, 'Email reply sent');
  return { messageId: result.messageId, threadId: result.threadId };
}
```

### Step 4: Add Email IPC Handlers

Read `src/ipc.ts` and add:

1. Import the email service at the top:
```typescript
import * as emailService from './email-service.js';
```

2. Add `handleEmailIpc()` function before `processTaskIpc()`:
```typescript
async function handleEmailIpc(
  data: { type: string; requestId?: string; [key: string]: unknown },
  sourceGroup: string,
): Promise<boolean> {
  if (!data.type.startsWith('email_') || !data.requestId) return false;

  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'email_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${data.requestId}.json`);

  let result: object;
  try {
    switch (data.type) {
      case 'email_create_inbox':
        result = await emailService.createInbox(data.displayName as string | undefined);
        break;
      case 'email_delete_inbox':
        result = await emailService.deleteInbox(data.inboxId as string);
        break;
      case 'email_send':
        result = await emailService.sendEmail(
          data.inboxId as string, data.to as string | string[],
          data.subject as string, data.text as string, data.html as string | undefined,
        );
        break;
      case 'email_read':
        result = { messages: await emailService.readEmails(data.inboxId as string, data.limit as number | undefined) };
        break;
      case 'email_reply':
        result = await emailService.replyEmail(
          data.inboxId as string, data.messageId as string,
          data.text as string, data.html as string | undefined,
        );
        break;
      default:
        return false;
    }
    const output = JSON.stringify({ success: true, ...result });
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, resultPath);
    logger.info({ type: data.type, sourceGroup, requestId: data.requestId }, 'Email IPC handled');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = JSON.stringify({ success: false, error: errorMsg });
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, resultPath);
    logger.error({ type: data.type, sourceGroup, err }, 'Email IPC error');
  }
  return true;
}
```

3. In `processTaskIpc()`, add the index signature to the data type and call `handleEmailIpc` before the switch:
```typescript
// Add to data type: requestId?: string; [key: string]: unknown;

// First line of processTaskIpc body:
if (await handleEmailIpc(data, sourceGroup)) return;
```

### Step 5: Add Agent-Side MCP Tools

Read `container/agent-runner/src/ipc-mcp-stdio.ts` and add 5 email tools before the transport startup.

Add a `waitForResult` helper that polls `email_results/`:
```typescript
const EMAIL_RESULTS_DIR = path.join(IPC_DIR, 'email_results');

function waitForResult(requestId: string, timeoutMs = 60000): Promise<object> {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(EMAIL_RESULTS_DIR, `${requestId}.json`);
    const start = Date.now();
    const poll = () => {
      if (fs.existsSync(resultPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          if (data.success === false) reject(new Error(data.error || 'Unknown email error'));
          else resolve(data);
        } catch (err) { reject(err); }
        return;
      }
      if (Date.now() - start > timeoutMs) { reject(new Error('Email IPC timeout')); return; }
      setTimeout(poll, 1000);
    };
    poll();
  });
}

function writeEmailIpc(data: object): string {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, { ...data, requestId });
  return requestId;
}
```

Then add the 5 tools:
- `email_create_inbox` — Create a new email inbox
- `email_delete_inbox` — Delete an inbox
- `email_send` — Send an email (params: inbox_id, to, subject, text, html?)
- `email_read` — Read recent emails (params: inbox_id, limit?)
- `email_reply` — Reply to an email thread (params: inbox_id, message_id, text, html?)

Each tool writes an IPC request via `writeEmailIpc`, then awaits `waitForResult`.

### Step 6: Configure API Key

**Use the AskUserQuestion tool** to ask:

> Please provide your AgentMail API key. I'll add it to your `.env` file securely.

Add to `.env`:
```
AGENTMAIL_API_KEY=<key>
```

**IMPORTANT:** Verify the key does NOT leak to the container:
- `readSecrets()` in `src/container-runner.ts` only reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
- The `.env` file is not mounted into containers
- `data/env/env` should NOT contain `AGENTMAIL_API_KEY`

### Step 7: Build and Restart

```bash
npm run build
```

Wait for clean compilation, then restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 8: Test

Tell the user:

> AgentMail is ready! Test it by sending a message:
>
> "Create a new email inbox"
>
> Then try:
>
> "Send an email to yourself from that inbox"

Monitor the logs:

```bash
tail -f logs/nanoclaw.log | grep -i email
```

---

## Optional Guardrails

Create `data/email-config.json` to set limits:

```json
{
  "maxPerHour": 50,
  "allowedDomains": ["example.com"]
}
```

- `maxPerHour`: Max outgoing emails per hour (0 = unlimited)
- `allowedDomains`: Restrict recipients to these domains (empty = all)

---

## Security

- `AGENTMAIL_API_KEY` stays on the host — never enters the container
- Agent interacts with email only through IPC tools
- Even if prompt-injected, the agent cannot extract the API key
- Guardrails (rate limiting, domain allowlist) enforce limits on the host side

---

## Key Files

| File | Purpose |
|------|---------|
| `src/config.ts` | `AGENTMAIL_API_KEY` config |
| `src/email-service.ts` | Host-side AgentMail SDK wrapper |
| `src/ipc.ts` | `handleEmailIpc()` — processes email IPC requests |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Agent-side MCP tools + `waitForResult` poller |

---

## Troubleshooting

### "AGENTMAIL_API_KEY is not configured"
Key missing from `.env`. Add it and restart the service.

### IPC timeout (60s)
Host may not be running or IPC watcher isn't processing. Check:
```bash
tail -f logs/nanoclaw.log
```

### Rate limit exceeded
Adjust `maxPerHour` in `data/email-config.json` or wait for the sliding window to reset.

### Domain not allowed
The recipient's domain isn't in `allowedDomains`. Update `data/email-config.json`.

---

## Removing AgentMail

1. Delete `src/email-service.ts`
2. Remove `AGENTMAIL_API_KEY` from `src/config.ts`
3. Remove `handleEmailIpc()` and its call from `src/ipc.ts`
4. Remove the 5 email tools + helpers from `container/agent-runner/src/ipc-mcp-stdio.ts`
5. Remove `AGENTMAIL_API_KEY` from `.env`
6. Optionally: `npm uninstall agentmail`
7. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
