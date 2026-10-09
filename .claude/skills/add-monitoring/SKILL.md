---
name: add-monitoring
description: Add structured log shipping and monitoring to NanoClaw. Supports Axiom, Datadog, or local Grafana/Loki stack for operational visibility when running NanoClaw 24/7.
---

# Add Logging and Monitoring

This skill adds structured log shipping to NanoClaw for operational visibility. Since NanoClaw already uses Pino for structured JSON logging, this skill configures a transport to ship logs to a monitoring platform.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Initial Questions

Ask the user:

> Which monitoring platform do you want to use?
>
> **Option A: Axiom** (recommended for simplicity)
> - Free tier: 500MB/month ingest
> - No infrastructure to manage
> - Great query and dashboard UI
>
> **Option B: Datadog**
> - Free tier: 5GB/month for logs
> - Rich alerting and APM
> - More complex setup
>
> **Option C: Local Loki + Grafana**
> - Free and self-hosted
> - Requires Docker Compose
> - Good if you want everything local

Store their choice and proceed to the appropriate section.

---

## Option A: Axiom

### Step 1: Create Axiom Account

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool:**

> Set up Axiom:
>
> 1. Sign up at https://axiom.co (free tier available)
> 2. Create a new dataset called `nanoclaw`
> 3. Go to **Settings → API Tokens → New Token**
> 4. Create a token with **Ingest** permission for the `nanoclaw` dataset
> 5. Copy the token
>
> Do you have your API token and dataset name?

Wait for user to provide the token and dataset name.

### Step 2: Install Axiom Transport

Read `package.json` and add the Axiom pino transport:

```json
"dependencies": {
  ...existing dependencies...
  "@axiomhq/pino": "^1.3.0"
}
```

Install:

```bash
npm install
```

### Step 3: Configure Logger

Read `src/logger.ts` and replace it with:

```typescript
import pino from 'pino';

const transports: pino.TransportMultiOptions['targets'] = [
  // Console output (pretty-printed for local dev)
  {
    target: 'pino-pretty',
    options: { colorize: true },
    level: process.env.LOG_LEVEL || 'info',
  },
];

// Axiom remote logging (if configured)
if (process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET) {
  transports.push({
    target: '@axiomhq/pino',
    options: {
      dataset: process.env.AXIOM_DATASET,
      token: process.env.AXIOM_TOKEN,
    },
    level: 'info', // Ship info and above to Axiom
  });
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets: transports },
});
```

### Step 4: Add Environment Variables

Add to `.env`:

```bash
echo "AXIOM_TOKEN=<token_from_user>" >> .env
echo "AXIOM_DATASET=nanoclaw" >> .env
```

### Step 5: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 6: Verify

Tell the user:

> Axiom logging is active! Verify by:
>
> 1. Send a test message to trigger the agent
> 2. Go to https://app.axiom.co and open the `nanoclaw` dataset
> 3. You should see log entries appearing within a few seconds
>
> Useful queries in Axiom:
> - `level:error` - Show only errors
> - `msg:"Container completed"` - Track agent runs
> - `msg:"Message sent"` - Track sent messages

---

## Option B: Datadog

### Step 1: Get Datadog API Key

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool:**

> Set up Datadog:
>
> 1. Sign up at https://www.datadoghq.com (free tier available)
> 2. Go to **Organization Settings → API Keys**
> 3. Create a new API key and copy it
> 4. Note your Datadog site (e.g., `datadoghq.com`, `datadoghq.eu`)
>
> Do you have your API key and site?

### Step 2: Install Datadog Transport

Read `package.json` and add the Datadog transport:

```json
"dependencies": {
  ...existing dependencies...
  "pino-datadog-transport": "^1.5.0"
}
```

Install:

```bash
npm install
```

### Step 3: Configure Logger

Read `src/logger.ts` and replace it with:

```typescript
import pino from 'pino';

const transports: pino.TransportMultiOptions['targets'] = [
  {
    target: 'pino-pretty',
    options: { colorize: true },
    level: process.env.LOG_LEVEL || 'info',
  },
];

if (process.env.DD_API_KEY) {
  transports.push({
    target: 'pino-datadog-transport',
    options: {
      ddClientConf: {
        authMethods: {
          apiKeyAuth: process.env.DD_API_KEY,
        },
      },
      ddServerConf: {
        site: process.env.DD_SITE || 'datadoghq.com',
      },
      service: 'nanoclaw',
      ddsource: 'nodejs',
    },
    level: 'info',
  });
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets: transports },
});
```

### Step 4: Add Environment Variables

Add to `.env`:

```bash
echo "DD_API_KEY=<api_key_from_user>" >> .env
echo "DD_SITE=datadoghq.com" >> .env  # or datadoghq.eu, etc.
```

### Step 5: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Option C: Local Loki + Grafana

### Step 1: Start Loki and Grafana

Create `docker-compose.monitoring.yml` in the project root:

```yaml
version: '3.8'
services:
  loki:
    image: grafana/loki:2.9.0
    ports:
      - "3100:3100"
    volumes:
      - loki-data:/loki

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=nanoclaw
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  loki-data:
  grafana-data:
```

Start the stack:

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

### Step 2: Install Loki Transport

Read `package.json` and add:

```json
"dependencies": {
  ...existing dependencies...
  "pino-loki": "^2.3.1"
}
```

Install:

```bash
npm install
```

### Step 3: Configure Logger

Read `src/logger.ts` and replace it with:

```typescript
import pino from 'pino';

const transports: pino.TransportMultiOptions['targets'] = [
  {
    target: 'pino-pretty',
    options: { colorize: true },
    level: process.env.LOG_LEVEL || 'info',
  },
];

if (process.env.LOKI_HOST) {
  transports.push({
    target: 'pino-loki',
    options: {
      host: process.env.LOKI_HOST,
      labels: { app: 'nanoclaw' },
      batching: true,
      interval: 5,
    },
    level: 'info',
  });
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { targets: transports },
});
```

### Step 4: Add Environment Variables

```bash
echo "LOKI_HOST=http://localhost:3100" >> .env
```

### Step 5: Configure Grafana

Tell the user:

> 1. Open Grafana at http://localhost:3000
> 2. Log in with admin / nanoclaw
> 3. Go to **Connections → Data sources → Add data source**
> 4. Select **Loki**
> 5. Set URL to `http://loki:3100`
> 6. Click **Save & test**
> 7. Go to **Explore** and query `{app="nanoclaw"}`

### Step 6: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Troubleshooting

### Logs not appearing in monitoring platform

- Check that environment variables are set correctly
- Look for transport errors in console output
- Verify network connectivity to the monitoring endpoint
- Check `npm ls` to ensure the transport package is installed

### High log volume / costs

Adjust log levels:
- Set `LOG_LEVEL=warn` in `.env` for less verbose logging
- Or configure the transport level separately (the examples above ship `info` and above)

### Local Loki: "connection refused"

- Verify Docker containers are running: `docker compose -f docker-compose.monitoring.yml ps`
- Check Loki health: `curl http://localhost:3100/ready`

---

## Removing Monitoring

1. Remove the transport package:
   ```bash
   npm uninstall @axiomhq/pino  # or pino-datadog-transport or pino-loki
   ```

2. Revert `src/logger.ts` to its original content:
   ```typescript
   import pino from 'pino';

   export const logger = pino({
     level: process.env.LOG_LEVEL || 'info',
     transport: { target: 'pino-pretty', options: { colorize: true } },
   });
   ```

3. Remove monitoring env vars from `.env`

4. For local Loki: `docker compose -f docker-compose.monitoring.yml down -v`

5. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
