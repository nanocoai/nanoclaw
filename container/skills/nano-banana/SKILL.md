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
