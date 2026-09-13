---
name: add-wise
description: Add Wise (TransferWise) read-only integration to NanoClaw. Query account balances and transaction history for spending insights. Main group only. Triggers on "add wise", "wise integration", "setup wise", "transferwise".
---

# Add Wise (TransferWise) Integration

This skill adds read-only Wise account access to NanoClaw. The agent can query balances and transaction history through secure IPC (the API token never enters the container). Only available in the main group.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need a Wise Personal API Token with read-only scope.
>
> Get one at: https://wise.com/settings/api-tokens
>
> 1. Log in to Wise
> 2. Go to Settings → API tokens
> 3. Create a new **Personal** token
> 4. Only grant **Read** access (no write permissions needed)
>
> Once you have your token, we'll configure it securely.

Wait for user to confirm they have a token before continuing.

---

## Implementation

### Step 1: Add Config Entry

Read `src/config.ts` and add `'WISE_API_TOKEN'` to the `readEnvFile` call, then export it:

```typescript
const envConfig = readEnvFile([..., 'WISE_API_TOKEN']);

export const WISE_API_TOKEN =
  process.env.WISE_API_TOKEN || envConfig.WISE_API_TOKEN || '';
```

### Step 2: Create Wise Service

Create `src/wise-service.ts` — an HTTP client using native `fetch`. No external dependencies needed.

```typescript
import { WISE_API_TOKEN } from './config.js';
import { logger } from './logger.js';

const BASE_URL = 'https://api.wise.com';

interface WiseProfile {
  id: number;
  type: string;
  fullName?: string;
}

interface WiseBalance {
  id: number;
  currency: string;
  amount: { value: number; currency: string };
  reservedAmount: { value: number; currency: string };
  cashAmount: { value: number; currency: string };
}

let cachedProfiles: WiseProfile[] | null = null;

function getToken(): string {
  if (!WISE_API_TOKEN) throw new Error('WISE_API_TOKEN is not configured');
  return WISE_API_TOKEN;
}

async function wiseGet(path: string): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Wise API ${res.status} ${url}: ${body}`);
  }
  return res.json();
}

export async function getProfiles(): Promise<WiseProfile[]> {
  if (cachedProfiles) return cachedProfiles;
  const profiles = (await wiseGet('/v1/profiles')) as WiseProfile[];
  cachedProfiles = profiles;
  logger.debug({ count: profiles.length }, 'Wise profiles fetched');
  return profiles;
}

export async function getBalances(profileId: number): Promise<WiseBalance[]> {
  const balances = (await wiseGet(
    `/v4/profiles/${profileId}/balances?types=STANDARD`,
  )) as WiseBalance[];
  logger.debug({ profileId, count: balances.length }, 'Wise balances fetched');
  return balances;
}

export async function getTransfers(
  profileId: number,
  startDate: string,
  endDate: string,
  limit = 100,
  offset = 0,
): Promise<unknown> {
  const params = new URLSearchParams({
    profile: String(profileId),
    createdDateStart: startDate,
    createdDateEnd: endDate,
    limit: String(limit),
    offset: String(offset),
  });
  const transfers = await wiseGet(`/v1/transfers?${params}`);
  logger.debug({ profileId, limit, offset }, 'Wise transfers fetched');
  return transfers;
}

export async function getActivities(
  profileId: number,
  since: string,
  until: string,
  size = 100,
  nextCursor?: string,
): Promise<unknown> {
  const params = new URLSearchParams({
    since,
    until,
    size: String(size),
  });
  if (nextCursor) params.set('nextCursor', nextCursor);
  const activities = await wiseGet(
    `/v1/profiles/${profileId}/activities?${params}`,
  );
  logger.debug({ profileId, size }, 'Wise activities fetched');
  return activities;
}
```

### Step 3: Add Wise IPC Handler

Read `src/ipc.ts` and add:

1. Import the wise service at the top:
```typescript
import * as wiseService from './wise-service.js';
```

2. Add `handleWiseIpc()` function before `processTaskIpc()`:
```typescript
async function handleWiseIpc(
  data: { type: string; requestId?: string; [key: string]: unknown },
  sourceGroup: string,
  isMain: boolean,
): Promise<boolean> {
  if (!data.type.startsWith('wise_') || !data.requestId) return false;

  if (!isMain) {
    logger.warn({ sourceGroup, type: data.type }, 'Unauthorized Wise IPC attempt blocked');
    return true; // Consumed but rejected
  }

  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'wise_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${data.requestId}.json`);

  let result: object;
  try {
    switch (data.type) {
      case 'wise_get_balances': {
        const profiles = await wiseService.getProfiles();
        if (profiles.length === 0) throw new Error('No Wise profiles found');
        const balances = await wiseService.getBalances(profiles[0].id);
        result = { profileId: profiles[0].id, balances };
        break;
      }
      case 'wise_get_transfers': {
        const profiles = await wiseService.getProfiles();
        if (profiles.length === 0) throw new Error('No Wise profiles found');
        const transfers = await wiseService.getTransfers(
          profiles[0].id,
          data.startDate as string,
          data.endDate as string,
          (data.limit as number) || 100,
          (data.offset as number) || 0,
        );
        result = { transfers };
        break;
      }
      case 'wise_get_activities': {
        const profiles = await wiseService.getProfiles();
        if (profiles.length === 0) throw new Error('No Wise profiles found');
        const activities = await wiseService.getActivities(
          profiles[0].id,
          data.since as string,
          data.until as string,
          (data.size as number) || 100,
          data.nextCursor as string | undefined,
        );
        result = { activities };
        break;
      }
      default:
        return false;
    }
    const output = JSON.stringify({ success: true, ...result });
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, resultPath);
    logger.info({ type: data.type, sourceGroup, requestId: data.requestId }, 'Wise IPC handled');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = JSON.stringify({ success: false, error: errorMsg });
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, output);
    fs.renameSync(tempPath, resultPath);
    logger.error({ type: data.type, sourceGroup, err }, 'Wise IPC error');
  }
  return true;
}
```

3. In `processTaskIpc()`, call `handleWiseIpc` after the email handler:
```typescript
if (await handleEmailIpc(data, sourceGroup)) return;
if (await handleWiseIpc(data, sourceGroup, isMain)) return;
```

### Step 4: Add Agent-Side MCP Tools

Read `container/agent-runner/src/ipc-mcp-stdio.ts` and add 2 Wise tools before the transport startup. Gate them behind `if (isMain)` so they only appear for the main group.

Add helpers inside the `if (isMain)` block:
```typescript
if (isMain) {
  const WISE_RESULTS_DIR = path.join(IPC_DIR, 'wise_results');

  function waitForWiseResult(requestId: string, timeoutMs = 60000): Promise<object> {
    return new Promise((resolve, reject) => {
      const resultPath = path.join(WISE_RESULTS_DIR, `${requestId}.json`);
      const start = Date.now();
      const poll = () => {
        if (fs.existsSync(resultPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            fs.unlinkSync(resultPath);
            if (data.success === false) reject(new Error(data.error || 'Unknown Wise error'));
            else resolve(data);
          } catch (err) { reject(err); }
          return;
        }
        if (Date.now() - start > timeoutMs) { reject(new Error('Wise IPC timeout')); return; }
        setTimeout(poll, 1000);
      };
      poll();
    });
  }

  function writeWiseIpc(data: object): string {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, { ...data, requestId });
    return requestId;
  }

  // Then add 3 tools: wise_get_balances, wise_get_transfers, wise_get_activities
}
```

Tools:
- `wise_get_balances` — No params. Auto-resolves profile. Returns all currency balances with balance IDs.
- `wise_get_transfers` — Params: `start_date` (ISO 8601), `end_date` (ISO 8601), optional `limit` (number, default 100), `offset` (number, default 0). Returns outgoing transfers.
- `wise_get_activities` — Params: `since` (ISO 8601), `until` (ISO 8601), optional `size` (1-100, default 100), `next_cursor` (string). Returns all activity including card payments, conversions, deposits, withdrawals, fees.

### Step 5: Update Group CLAUDE.md

Add a Wise section to `groups/main/CLAUDE.md`:

```markdown
## Wise (TransferWise)

You have access to Wise account data via MCP tools:
- `wise_get_balances` — Get all currency balances (no params needed)
- `wise_get_transfers` — Get outgoing transfers within a date range (params: `start_date`, `end_date`, optional `limit`, `offset`)
- `wise_get_activities` — Get all account activity including card payments, conversions, deposits, fees (params: `since`, `until`, optional `size`, `next_cursor`)

Use `wise_get_balances` for current balances, `wise_get_activities` for card spending and full activity, and `wise_get_transfers` for outgoing transfers only.
```

### Step 6: Configure API Token

**Use the AskUserQuestion tool** to ask:

> Please provide your Wise API token. I'll add it to your `.env` file securely.

Add to `.env`:
```
WISE_API_TOKEN=<token>
```

Also add to `.env.example`:
```
# Wise (TransferWise) — read-only personal API token
WISE_API_TOKEN=
```

**IMPORTANT:** Verify the token does NOT leak to the container:
- `readSecrets()` in `src/container-runner.ts` only reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
- The `.env` file is not mounted into containers
- `data/env/env` should NOT contain `WISE_API_TOKEN`

### Step 7: Build and Restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 8: Test

Tell the user:

> Wise is ready! Test it by sending a message to your main group:
>
> "What are my Wise balances?"
>
> Then try:
>
> "Show me my EUR spending this month"

Monitor the logs:

```bash
tail -f logs/nanoclaw.log | grep -i wise
```

---

## API Endpoints Used

All read-only. Base URL: `https://api.wise.com`

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/profiles` | List profiles (cached after first call) |
| `GET /v4/profiles/{id}/balances?types=STANDARD` | All currency balances |
| `GET /v1/transfers?profile={id}` | Outgoing transfer history (with date/limit/offset params) |
| `GET /v1/profiles/{id}/activities` | All activity: card payments, conversions, deposits, fees (with since/until/size params) |

---

## Security

- `WISE_API_TOKEN` stays on the host — never enters the container
- Agent interacts with Wise only through IPC tools
- Read-only scope: no transfers, no modifications possible
- Only available to the main group (authorization check on host side)
- Even if prompt-injected, the agent cannot extract the API token

---

## Key Files

| File | Purpose |
|------|---------|
| `src/config.ts` | `WISE_API_TOKEN` config |
| `src/wise-service.ts` | Host-side Wise API client |
| `src/ipc.ts` | `handleWiseIpc()` — processes Wise IPC requests |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Agent-side MCP tools (gated by `isMain`) |
| `groups/main/CLAUDE.md` | Documents available Wise tools for the agent |

---

## Troubleshooting

### "WISE_API_TOKEN is not configured"
Token missing from `.env`. Add it and restart the service.

### Wise API 401/403
Token is invalid or expired. Generate a new one at https://wise.com/settings/api-tokens

### Wise API 429
Rate limited by Wise. Wait a few minutes and try again.

### IPC timeout (60s)
Host may not be running or IPC watcher isn't processing. Check:
```bash
tail -f logs/nanoclaw.log
```

### "No Wise profiles found"
The token may not have profile access. Verify it has read scope.

---

## Removing Wise

1. Delete `src/wise-service.ts`
2. Remove `WISE_API_TOKEN` from `src/config.ts`
3. Remove `handleWiseIpc()` and its call from `src/ipc.ts`
4. Remove the Wise tools block from `container/agent-runner/src/ipc-mcp-stdio.ts`
5. Remove `WISE_API_TOKEN` from `.env`
6. Remove the Wise section from `groups/main/CLAUDE.md`
7. Rebuild:
   ```bash
   npm run build
   ./container/build.sh
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
