---
name: nano-banana
description: Add AI image generation to NanoClaw using Google's Imagen API. Users can ask the agent to generate images via WhatsApp. Supports model selection (fast/standard/ultra) with cost-aware defaults.
---

# Nano Banana: AI Image Generation

This skill adds AI image generation and image sending to NanoClaw. After implementation, users can ask the agent to generate images (e.g., "generate an image of a sunset") and receive them as WhatsApp media messages.

**Architecture:**
```
User (WhatsApp) → Agent (container) → generate_image MCP tool → Gemini API
                                    → send_image MCP tool → IPC → Host → WhatsApp.sendImage()
```

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool.

## Prerequisites

**Use the AskUserQuestion tool** to present this:

> You'll need a Google Gemini API key for image generation.
>
> Get one at: https://aistudio.google.com/apikey
>
> Cost: Imagen 4 Fast = $0.02/image, Standard = $0.04, Ultra = $0.06
>
> Once you have your API key, we'll configure it.

Wait for user to confirm they have an API key before continuing.

---

## Implementation

### Step 1: Add `@google/genai` to Container Dependencies

Read `container/agent-runner/package.json` and add `@google/genai` to dependencies:

```json
"@google/genai": "^1.41.0"
```

Then install:

```bash
cd container/agent-runner && npm install
```

---

### Step 2: Pass GEMINI_API_KEY as a Container Secret

**File: `src/container-runner.ts`** — Find the `readSecrets()` function and add `'GEMINI_API_KEY'` to the keys array:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']);
}
```

**File: `container/agent-runner/src/index.ts`** — Find the MCP server configuration in `runQuery()` where `mcpServers.nanoclaw.env` is defined. Add `GEMINI_API_KEY` to the env object:

```typescript
env: {
  NANOCLAW_CHAT_JID: containerInput.chatJid,
  NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
  NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
  GEMINI_API_KEY: sdkEnv.GEMINI_API_KEY || '',
},
```

---

### Step 3: Add `generate_image` and `send_image` MCP Tools

**File: `container/agent-runner/src/ipc-mcp-stdio.ts`**

Add the import at the top (alongside existing imports):

```typescript
import { GoogleGenAI } from '@google/genai';
```

Add a `MEDIA_DIR` constant alongside existing directory constants:

```typescript
const MEDIA_DIR = path.join(IPC_DIR, 'media');
```

Add the following two tools before the `// Start the stdio transport` line at the bottom of the file:

```typescript
const IMAGEN_MODELS: Record<string, string> = {
  fast: 'imagen-4.0-generate-preview-06-06',
  standard: 'imagen-4.0-generate-preview-06-06',
  ultra: 'imagen-4.0-ultra-generate-preview-06-06',
};

const IMAGEN_COST: Record<string, number> = {
  fast: 0.02,
  standard: 0.04,
  ultra: 0.06,
};

server.tool(
  'generate_image',
  `Generate images using Google's Imagen model. Returns file paths to generated images.

COST: fast=$0.02, standard=$0.04, ultra=$0.06 per image.
Default to "fast" unless the user explicitly requests higher quality.

PROMPT TIPS:
- Use English only (Imagen works best with English prompts)
- Be descriptive and specific
- Max 480 tokens for the prompt
- Negative prompts are not supported`,
  {
    prompt: z.string().describe('Description of the image to generate (English, max 480 tokens)'),
    model: z.enum(['fast', 'standard', 'ultra']).default('fast').describe('Quality tier: fast=$0.02, standard=$0.04, ultra=$0.06'),
    aspect_ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).default('1:1').describe('Aspect ratio (1:1 square, 9:16 portrait, 16:9 landscape)'),
    number_of_images: z.number().int().min(1).max(4).default(1).describe('Number of images to generate (1-4)'),
  },
  async (args) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: 'text' as const, text: 'GEMINI_API_KEY is not configured. Ask the admin to add it to .env.' }],
        isError: true,
      };
    }

    const modelName = IMAGEN_MODELS[args.model];
    const costPerImage = IMAGEN_COST[args.model];

    try {
      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateImages({
        model: modelName,
        prompt: args.prompt,
        config: {
          numberOfImages: args.number_of_images,
          aspectRatio: args.aspect_ratio,
        },
      });

      if (!response.generatedImages || response.generatedImages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No images were generated. The prompt may have been filtered by safety checks. Try rephrasing.' }],
          isError: true,
        };
      }

      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      const results: Array<{ path: string; model: string; cost: number }> = [];

      for (let i = 0; i < response.generatedImages.length; i++) {
        const img = response.generatedImages[i];
        if (!img.image?.imageBytes) continue;

        const filename = `gen_${Date.now()}_${i}.png`;
        const filepath = path.join(MEDIA_DIR, filename);
        const buffer = Buffer.from(img.image.imageBytes, 'base64');
        fs.writeFileSync(filepath, buffer);
        results.push({ path: filepath, model: args.model, cost: costPerImage });
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Images were generated but contained no data. Try again.' }],
          isError: true,
        };
      }

      const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
      const summary = results.map((r, i) => `Image ${i + 1}: ${r.path}`).join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Generated ${results.length} image(s) with ${args.model} model.\nCost: $${totalCost.toFixed(2)}\n\n${summary}\n\nUse send_image to send each image to the chat.`,
        }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('SAFETY') || message.includes('safety')) {
        return {
          content: [{ type: 'text' as const, text: `Image generation was blocked by safety filters. Try rephrasing the prompt.\n\nError: ${message}` }],
          isError: true,
        };
      }
      if (message.includes('QUOTA') || message.includes('quota') || message.includes('429')) {
        return {
          content: [{ type: 'text' as const, text: `Rate limit or quota exceeded. Wait a moment and try again.\n\nError: ${message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Image generation failed: ${message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'send_image',
  `Send an image to the current chat. Works with any image file (generated or otherwise).
The image must be a file path accessible in the container (e.g., from generate_image output or downloaded via Bash).`,
  {
    image_path: z.string().describe('Absolute path to the image file'),
    caption: z.string().optional().describe('Optional caption to send with the image'),
  },
  async (args) => {
    if (!fs.existsSync(args.image_path)) {
      return {
        content: [{ type: 'text' as const, text: `Image file not found: ${args.image_path}` }],
        isError: true,
      };
    }

    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    // Copy to media dir if not already there
    let mediaFilename: string;
    if (args.image_path.startsWith(MEDIA_DIR)) {
      mediaFilename = path.basename(args.image_path);
    } else {
      mediaFilename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(args.image_path) || '.png'}`;
      fs.copyFileSync(args.image_path, path.join(MEDIA_DIR, mediaFilename));
    }

    const data: Record<string, string | undefined> = {
      type: 'send_image',
      chatJid,
      mediaPath: `media/${mediaFilename}`,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Image queued for sending${args.caption ? ` with caption: "${args.caption}"` : ''}.` }],
    };
  },
);
```

---

### Step 4: Handle `send_image` IPC Messages on the Host

**File: `src/ipc.ts`** — Add `sendImage` to the `IpcDeps` interface:

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendImage: (jid: string, image: Buffer, caption?: string) => Promise<void>;
  // ...rest of existing fields
}
```

**File: `src/ipc.ts`** — In `processIpcFiles()`, find the block that handles `data.type === 'message'` inside the messages directory loop. Add an `else if` branch right after it:

```typescript
} else if (data.type === 'send_image' && data.chatJid && data.mediaPath) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    const mediaFile = path.join(ipcBaseDir, sourceGroup, data.mediaPath);
    if (fs.existsSync(mediaFile)) {
      const imageBuffer = fs.readFileSync(mediaFile);
      await deps.sendImage(data.chatJid, imageBuffer, data.caption);
      // Clean up media file after sending
      try { fs.unlinkSync(mediaFile); } catch { /* ignore */ }
      logger.info(
        { chatJid: data.chatJid, sourceGroup, mediaPath: data.mediaPath },
        'IPC image sent',
      );
    } else {
      logger.warn(
        { mediaFile, sourceGroup },
        'IPC send_image: media file not found',
      );
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC send_image attempt blocked',
    );
  }
}
```

---

### Step 5: Add `sendImage` to WhatsApp Channel

**File: `src/channels/whatsapp.ts`** — Add this method to the `WhatsAppChannel` class, right after the existing `sendMessage` method:

```typescript
async sendImage(jid: string, image: Buffer, caption?: string): Promise<void> {
  const msg: { image: Buffer; caption?: string } = { image };
  if (caption) {
    msg.caption = ASSISTANT_HAS_OWN_NUMBER
      ? caption
      : `${ASSISTANT_NAME}: ${caption}`;
  }

  if (!this.connected) {
    logger.warn({ jid }, 'WA disconnected, cannot send image (no queue for media)');
    return;
  }
  try {
    await this.sock.sendMessage(jid, msg);
    logger.info({ jid, hasCaption: !!caption, size: image.length }, 'Image sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send image');
  }
}
```

---

### Step 6: Add `sendImage` to Channel Interface

**File: `src/types.ts`** — Add to the `Channel` interface alongside the existing `setTyping?`:

```typescript
// Optional: send image with optional caption
sendImage?(jid: string, image: Buffer, caption?: string): Promise<void>;
```

---

### Step 7: Wire `sendImage` in the Orchestrator

**File: `src/index.ts`** — Find the `startIpcWatcher({...})` call and add `sendImage` to the deps object:

```typescript
startIpcWatcher({
  sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
  sendImage: (jid, image, caption) =>
    whatsapp.sendImage ? whatsapp.sendImage(jid, image, caption) : Promise.resolve(),
  registeredGroups: () => registeredGroups,
  // ...rest of existing deps
});
```

---

### Step 8: Create IPC Media Directory

**File: `src/container-runner.ts`** — In `buildVolumeMounts()`, find where `messages`, `tasks`, and `input` directories are created and add `media`:

```typescript
fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'media'), { recursive: true });
```

**File: `container/Dockerfile`** — Find the `mkdir -p` line that creates workspace directories and add `/workspace/ipc/media`:

```dockerfile
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/ipc/media
```

---

### Step 9: Create the Agent Skill File

Create `container/skills/nano-banana/SKILL.md` — this is the skill the agent sees inside the container:

```markdown
---
name: nano-banana
description: Generate and send AI images. Use when the user asks to generate, create, or make an image/picture/photo.
---

# Image Generation

You have two MCP tools for image generation and sending:

## Workflow

1. Call `generate_image` with the user's prompt
2. Call `send_image` for each generated image

## generate_image

| Parameter | Default | Notes |
|-----------|---------|-------|
| `prompt` | (required) | English only, max 480 tokens. Be descriptive. |
| `model` | `fast` | `fast` $0.02, `standard` $0.04, `ultra` $0.06 |
| `aspect_ratio` | `1:1` | `1:1`, `3:4`, `4:3`, `9:16`, `16:9` |
| `number_of_images` | `1` | 1-4 per call |

## send_image

| Parameter | Notes |
|-----------|-------|
| `image_path` | Absolute path from generate_image output |
| `caption` | Optional description |

## Model Selection

- **Default to `fast`** for all requests ($0.02/image)
- Use `standard` when user says "high quality", "detailed", or "better" ($0.04)
- Use `ultra` only when user explicitly asks for "best quality", "ultra", or "maximum quality" ($0.06)

## Aspect Ratio Selection

- Portraits/people: `3:4` or `9:16`
- Landscapes/scenery: `16:9` or `4:3`
- Logos/icons/general: `1:1`

## Prompt Tips

- Translate non-English requests to English for the prompt
- Add style descriptors: "photorealistic", "digital art", "watercolor", etc.
- Include lighting, composition, and mood details
- Keep prompts focused and specific

## Error Handling

- **Safety filter**: Rephrase and retry. Don't argue with the filter.
- **Quota/rate limit**: Wait a moment and retry.
- **No images returned**: Simplify the prompt and retry.
```

---

### Step 10: Update Test Mocks

If there are test files that mock `IpcDeps` (e.g., `src/ipc-auth.test.ts`), add `sendImage: async () => {}` to the mock deps object to match the updated interface.

---

### Step 11: Configure API Key

Add the Gemini API key to `.env`:

```
GEMINI_API_KEY=<user's key>
```

**Use the AskUserQuestion tool** to present:

> I need to add your Gemini API key to `.env`. Please paste your API key.

---

### Step 12: Build and Rebuild Container

```bash
# Build host TypeScript
npm run build

# Install container deps and rebuild container
cd container/agent-runner && npm install
cd ../..
container builder stop && container builder rm && container builder start
./container/build.sh
```

Verify the package is in the container:

```bash
echo '{}' | container run -i --rm --entrypoint ls nanoclaw-agent:latest /app/node_modules/@google/genai/package.json
```

---

### Step 13: Restart and Test

Restart NanoClaw:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Use the AskUserQuestion tool** to tell the user:

> Image generation is ready! Test it by sending a message to your agent like:
>
> "Generate an image of a cat wearing a top hat"
>
> The agent will call `generate_image`, then `send_image`, and you'll receive the image in WhatsApp.

---

## Troubleshooting

### "GEMINI_API_KEY is not configured"

The key isn't reaching the container. Check:
1. Key is in `.env` (not `.env.example`)
2. `readSecrets()` in `src/container-runner.ts` includes `'GEMINI_API_KEY'`
3. MCP server env in `container/agent-runner/src/index.ts` passes `GEMINI_API_KEY`

### Image generated but not sent to WhatsApp

Check IPC flow:
```bash
# Look for IPC files
ls data/ipc/*/messages/
# Check logs for send_image handling
tail -100 logs/nanoclaw.log | grep -i "image\|media"
```

### Safety filter blocks

Imagen has strict safety filters. The agent should rephrase and retry. Common triggers:
- Prompts mentioning real people
- Violence or explicit content
- Copyright-protected characters

### Container build fails on `@google/genai`

```bash
cd container/agent-runner && rm -rf node_modules package-lock.json && npm install
```

---

## Cost Summary

| Model | Cost/Image | When to Use |
|-------|-----------|-------------|
| Imagen 4 Fast | $0.02 | Default for all requests |
| Imagen 4 Standard | $0.04 | User asks for "high quality" |
| Imagen 4 Ultra | $0.06 | User asks for "best/ultra quality" |

Typical usage: 50 images/month = $1.00 (fast only)

---

## Removing This Feature

1. Remove `@google/genai` from `container/agent-runner/package.json`
2. Remove `generate_image` and `send_image` tools from `ipc-mcp-stdio.ts`
3. Remove `GEMINI_API_KEY` from `readSecrets()` and MCP server env
4. Remove `sendImage` from `IpcDeps`, `ipc.ts` handler, `whatsapp.ts`, `types.ts`, `index.ts`
5. Remove `container/skills/nano-banana/`
6. Remove `GEMINI_API_KEY` from `.env`
7. Rebuild: `npm run build && ./container/build.sh`
