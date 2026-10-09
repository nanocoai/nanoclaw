---
name: add-remotion
description: Add programmatic video generation to NanoClaw using Remotion and AWS Lambda. Renders MP4 videos from React components, serverless on Lambda. Agent can create and deliver videos directly in chat.
---

# Add Remotion Video Generation

Programmatic video generation for NanoClaw using [Remotion](https://www.remotion.dev/) and AWS Lambda. Videos are React components — write code, get MP4. Rendering is serverless (~$0.005–0.05 per short video). The rendered file is delivered directly to the chat.

**Battle-tested:** Production-proven on NanoClaw V2 since April 2026. 20+ videos rendered including showcase reels, product demos, and social media content.

## Features

- **React-based compositions** — full React/TypeScript for video content, animations, and transitions
- **AWS Lambda rendering** — serverless, no GPU needed, parallel frame rendering
- **TTS narration** — OpenAI gpt-4o-mini-tts integration for voice-over generation
- **CLI tool** — `remotion-render <CompositionId> <output-path>` wraps the full Lambda render + S3 download pipeline
- **Per-group project** — Remotion project lives in the agent group's workspace, compositions are per-agent

## Prerequisites

- Node.js 18+ (already present in NanoClaw)
- AWS account with IAM access
- ffprobe (bundled with Remotion's compositor package)

## Phase 1: Apply Code Changes

### Merge the skill branch

```bash
# From NanoClaw root
git fetch origin skill/remotion-v2
git merge origin/skill/remotion-v2 --no-edit || {
  # If lock file conflicts:
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json 2>/dev/null
  git merge --continue --no-edit
}
```

This adds:
- `container/skills/remotion/SKILL.md` — container-level instructions the agent reads at runtime
- `tools/remotion-render` — CLI that wraps Lambda render + S3 download
- `aws-policies/remotion-policy.json` — minimal IAM policy for the Remotion user

### Initialize the Remotion project

Create the Remotion project in the agent group's workspace:

```bash
GROUP_DIR="groups/main"  # or whichever group
mkdir -p "$GROUP_DIR/remotion/src" "$GROUP_DIR/remotion/public" "$GROUP_DIR/remotion/drafts"
cd "$GROUP_DIR/remotion"
npm init -y
npm install remotion @remotion/cli @remotion/lambda react react-dom
npm install -D @types/react typescript
```

Create `remotion.config.ts`:
```ts
import { Config } from "@remotion/cli/config";
Config.setImageFormat("jpeg");
Config.setOverwriteOutput(true);
```

Create `src/index.ts`:
```ts
import { registerRoot } from "remotion";
import { Root } from "./Root";
registerRoot(Root);
```

Create `src/Root.tsx`:
```tsx
import React from "react";
import { Composition } from "remotion";

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="Starter"
        component={() => (
          <div style={{
            flex: 1, backgroundColor: "#0d1117", display: "flex",
            justifyContent: "center", alignItems: "center",
            fontFamily: "monospace", color: "#58a6ff", fontSize: 48
          }}>
            Hello from NanoClaw
          </div>
        )}
        durationInFrames={150}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
```

Validate the install:
```bash
npx remotion studio --help
```

## Phase 2: AWS Setup

### Create IAM user

Use `AskUserQuestion` to check if the user already has AWS credentials for Remotion.

If not, walk them through:

1. Go to [AWS IAM console](https://console.aws.amazon.com/iam)
2. Create user `remotion-render` with programmatic access
3. Attach the policy from `aws-policies/remotion-policy.json` (create as custom policy)
4. Download credentials CSV

### Configure credentials

Add to `.env`:
```bash
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
AWS_REGION=us-west-1
```

### Deploy Lambda function

```bash
cd groups/main/remotion
npx remotion lambda functions deploy
SITE_URL=$(npx remotion lambda sites create src/index.ts --site-name=nanoclaw-main 2>&1 | grep -E 'https://' | tail -1)
echo "REMOTION_SERVE_URL=$SITE_URL"
cd ../../..
```

Add the serve URL to `.env`:
```bash
REMOTION_SERVE_URL=<url-from-above>
REMOTION_AWS_BUCKET=<bucket-name-from-deploy-output>
```

### Lambda concurrency

AWS free-tier accounts have a Lambda concurrency cap of 10. The `remotion-render` tool defaults to `--frames-per-lambda=60`, which keeps short videos under the cap. If the user has a higher quota, they can adjust `REMOTION_FRAMES_PER_LAMBDA` in `.env`.

## Phase 3: Verify

### Test render

```bash
remotion-render Starter groups/main/remotion/drafts/test-$(date +%s).mp4
```

This should deploy the site bundle, trigger a Lambda render, download the MP4, and print the file path. Open it and confirm it plays.

### Restart NanoClaw

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

The agent will now have the `container/skills/remotion/SKILL.md` instructions available and the `remotion-render` tool in PATH.

## Phase 4: Container mounts

Add the Remotion tools and project to the agent group's container config. In `groups/<group>/container.json`, add:

```json
{
  "additionalMounts": [
    { "hostPath": "tools/remotion-render", "containerPath": "tools/remotion-render" }
  ],
  "envVars": {
    "REMOTION_SERVE_URL": "${REMOTION_SERVE_URL}",
    "REMOTION_AWS_BUCKET": "${REMOTION_AWS_BUCKET}",
    "REMOTION_FRAMES_PER_LAMBDA": "${REMOTION_FRAMES_PER_LAMBDA:-60}"
  }
}
```

The Remotion project directory (`groups/<group>/remotion/`) is already mounted at `/workspace/group/remotion/` by default.

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot find module '@remotion/lambda'` | npm install didn't run | `cd groups/<group>/remotion && npm install` |
| `AWS_ACCESS_KEY_ID not set` | Credentials not in .env | Check .env, restart NanoClaw |
| `TooManyRequestsException` | Lambda concurrency cap | Increase `REMOTION_FRAMES_PER_LAMBDA` (e.g., 120 or 200) |
| `No function named remotion-render-*` | Lambda not deployed | Re-run `npx remotion lambda functions deploy` |
| `No site with name "nanoclaw-main"` | Site deleted or first run | Re-run `npx remotion lambda sites create src/index.ts --site-name=nanoclaw-main` |
| Render hangs | Lambda timeout (default 120s) | Check CloudWatch logs; use shorter composition or increase timeout in Lambda config |
| Poor audio sync | TTS duration mismatch | Use ffprobe to measure WAV duration, add BUFFER=80 frames between segments |
