---
name: remotion
description: Create and render MP4 videos from React components using Remotion and AWS Lambda. Use when the user asks to make a video, animation, or visual content.
allowed-tools:
  - Bash(remotion-render *)
  - Bash(cd /workspace/group/remotion && npx remotion *)
  - Bash(ffprobe *)
---

# Remotion Video Generation

You can create programmatic MP4 videos using Remotion (React-based video framework) rendered on AWS Lambda.

## How it works

1. **Compositions** are React components in `/workspace/group/remotion/src/`
2. Each composition is registered in `src/Root.tsx` via `<Composition>`
3. The `remotion-render` CLI renders a composition on Lambda and downloads the MP4

## Creating a video

### 1. Write the composition

Create a new `.tsx` file in `/workspace/group/remotion/src/`:

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, spring, Audio, Img, staticFile } from "remotion";

export const MyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Animations use interpolate() and spring()
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <div style={{ flex: 1, backgroundColor: "#0d1117", opacity }}>
      {/* Video content here */}
    </div>
  );
};
```

### 2. Register it

Add to `src/Root.tsx`:
```tsx
<Composition id="MyVideo" component={MyVideo} durationInFrames={300} fps={30} width={1920} height={1080} />
```

### 3. Render

```bash
remotion-render MyVideo /workspace/group/remotion/drafts/my-video.mp4
```

## Audio / narration

Generate TTS narration using OpenAI:
```bash
curl -s https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini-tts","input":"Your narration text","voice":"echo","speed":1.15,"response_format":"wav"}' \
  -o /workspace/group/remotion/public/narration.wav
```

Use `<Audio src={staticFile("narration.wav")} />` in the composition. Measure duration with ffprobe to calculate frame counts:
```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 /workspace/group/remotion/public/narration.wav
```

## Proven settings

- **TTS:** gpt-4o-mini-tts "echo" voice at 1.15x speed, WAV format (never MP3 — Lambda needs WAV)
- **Timeline:** BUFFER=80 frames between segments, OVERLAP=10 frames for cross-dissolves
- **Aspect ratios:** 1920x1080 (landscape), 1080x1920 (portrait/reels), 1080x1080 (square/social)
- **Lambda:** `--frames-per-lambda=60` default (safe for 10 concurrency cap)

## Output

All rendered videos go to `/workspace/group/remotion/drafts/`. To deliver to the user, use `send_message` with the file path — the host will attach it to the chat.

## Important

- Always save compositions before rendering — `remotion-render` deploys the site bundle from disk
- Keep videos under 60 seconds for reliable Lambda rendering within timeout
- Use `staticFile()` for assets in `public/`, not relative paths
- The `remotion-render` tool handles site deployment, Lambda invocation, and S3 download automatically
