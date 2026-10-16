# Google Gemini Image Generation API - Comprehensive Reference

**Document Date:** February 16, 2026
**Purpose:** Technical reference for integrating Google's image generation capabilities into NanoClaw WhatsApp bot

---

## Table of Contents

1. [API Overview & Available Models](#api-overview--available-models)
2. [How to Call the API](#how-to-call-the-api)
3. [Pricing](#pricing)
4. [Rate Limits & Quotas](#rate-limits--quotas)
5. [Technical Limitations](#technical-limitations)
6. [Image Editing Capabilities](#image-editing-capabilities)
7. [Content Safety & Restrictions](#content-safety--restrictions)
8. [Best Model Choice for WhatsApp Bot](#best-model-choice-for-whatsapp-bot)
9. [Existing MCP Servers](#existing-mcp-servers)
10. [Integration Approach for Node.js](#integration-approach-for-nodejs)
11. [Complete Code Examples](#complete-code-examples)

---

## API Overview & Available Models

Google offers **two distinct approaches** to AI image generation:

### 1. Gemini Native Image Generation (Nano Banana)

Models with built-in multimodal image generation capabilities:

| Model | Model ID | Description | Best For |
|-------|----------|-------------|----------|
| **Gemini 2.5 Flash Image** | `gemini-2.5-flash-image` | Speed and efficiency, optimized for high-volume, low-latency tasks | Personal bots, rapid prototyping |
| **Gemini 3 Pro Image Preview** | `gemini-3-pro-image-preview` | Advanced reasoning for professional asset production, follows complex instructions | High-quality professional outputs |

**Key Features:**
- Text-to-image generation
- Text-and-image-to-image editing
- Multi-turn conversations for iterative refinement
- Google Search grounding for real-time data
- Reference image mixing (up to 14 images with Gemini 3 Pro)
- Advanced reasoning with interim image testing (Gemini 3 Pro only)

### 2. Imagen Dedicated Models

Specialized image generation models:

| Model | Model ID | Description | Speed |
|-------|----------|-------------|-------|
| **Imagen 4 Fast** | `imagen-4.0-fast-generate-001` | Fastest generation | ~15-30 sec |
| **Imagen 4 Standard** | `imagen-4.0-generate-001` | Balanced quality/speed | ~30-60 sec |
| **Imagen 4 Ultra** | `imagen-4.0-ultra-generate-001` | Highest quality | ~45-90 sec |

**Note:** Imagen 3 has been discontinued as of June 2025.

**Resolution Options:**
- **Gemini 3 Pro Image:** 1K, 2K, 4K (uppercase 'K' required)
- **Imagen 4:** 1K, 2K (default: 1K)

**Supported Aspect Ratios:**
`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`

**Output Formats:**
- PNG (primary)
- JPEG
- WebP

**Security Features:**
- All generated images include SynthID watermarking

---

## How to Call the API

### Authentication Methods

1. **API Key (Recommended for Developer API)**
   - Obtain from Google AI Studio: https://aistudio.google.com/apikey
   - Pass via header: `x-goog-api-key: YOUR_API_KEY`

2. **OAuth Bearer Token (Vertex AI only)**
   - Use: `Authorization: Bearer $(gcloud auth print-access-token)`

### REST API Endpoints

#### Gemini Native Image Generation

**Base URL:** `https://generativelanguage.googleapis.com/v1beta`

**Text-to-Image:**
```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Create a picture of a robot holding a skateboard in a cyberpunk city"}
      ]
    }]
  }'
```

**Text + Image to Image (Editing):**
```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Make the background sunset orange"},
        {
          "inline_data": {
            "mime_type": "image/jpeg",
            "data": "BASE64_ENCODED_IMAGE_DATA"
          }
        }
      ]
    }]
  }'
```

**Advanced Configuration (Gemini 3 Pro):**
```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [{"text": "Professional product photo of a smartwatch"}]
    }],
    "generationConfig": {
      "responseModalities": ["TEXT", "IMAGE"],
      "imageConfig": {
        "aspectRatio": "16:9",
        "imageSize": "4K"
      }
    }
  }'
```

#### Imagen API

**Endpoint:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict
```

**Request Structure:**
```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "instances": [{
      "prompt": "A serene mountain landscape at sunset"
    }],
    "parameters": {
      "sampleCount": 4,
      "aspectRatio": "16:9",
      "imageSize": "2K",
      "personGeneration": "allow_adult"
    }
  }'
```

**Response Format:**
```json
{
  "predictions": [{
    "bytesBase64Encoded": "iVBORw0KGgoAAAANSUhEUgA...",
    "mimeType": "image/png"
  }]
}
```

---

## Pricing

### Gemini Native Image Generation

| Model | Standard Pricing | Batch API (50% off) | Free Tier |
|-------|------------------|---------------------|-----------|
| **Gemini 2.5 Flash Image** | $0.30 per image | $0.15 per image | Not available |
| **Gemini 2.0 Flash** (deprecated) | $0.039 per image | $0.0195 per image | Available |
| **Gemini 3 Pro Image** (1K/2K) | $0.134 per image | $0.067 per image | Not available |
| **Gemini 3 Pro Image** (4K) | $0.24 per image | $0.12 per image | Not available |

**Pricing Calculation:**
- Token-based: $30 per 1M output tokens
- Images ≤1024x1024px consume 1290 tokens
- Higher resolutions consume proportionally more tokens

### Imagen Pricing

| Model | Cost per Image | Free Tier |
|-------|---------------|-----------|
| **Imagen 4 Fast** | $0.02 | No |
| **Imagen 4 Standard** | $0.04 | No |
| **Imagen 4 Ultra** | $0.06 | No |

### Batch API

- **Cost Reduction:** 50% off standard pricing
- **Turnaround Time:** Up to 24 hours
- **Best For:** High-volume, non-urgent image generation

**Important Note:** Gemini 2.0 Flash is **deprecated** and will shut down on **March 31, 2026**.

---

## Rate Limits & Quotas

### Free Tier Limits (2026)

**IMPORTANT:** Google drastically reduced free tier limits in December 2025 (50-92% reduction).

| Model | RPM (Requests/Min) | RPD (Requests/Day) | IPM (Images/Min) | Notes |
|-------|-------------------|-------------------|------------------|-------|
| **Gemini 2.5 Pro** | 5 | 100 | - | Text generation |
| **Gemini 2.5 Flash** | 10 | 20-50 | - | Reduced from 250/day |
| **Gemini 2.5 Flash-Lite** | 15 | 1,000 | - | Highest free tier |
| **Imagen Models** | - | - | 2 | Very restrictive |

**Key Constraints:**
- Free tier is **NOT viable for image generation** (only 2 IPM for Imagen)
- Gemini 2.5 Flash Image has **no free tier**
- RPD resets at midnight Pacific Time
- Free tier quotas can change without notice

### Paid Tier Limits

Specific limits are **tier-based** and viewable in Google AI Studio:
- **Tier 1:** Lower limits, pay-as-you-go
- **Tier 2:** Medium limits, requires billing history
- **Tier 3:** Highest limits, enterprise accounts

**Batch API Enqueued Token Limits:**

| Tier | Gemini 3 Pro Image Preview |
|------|---------------------------|
| Tier 1 | 2,000,000 tokens |
| Tier 2 | 270,000,000 tokens |
| Tier 3 | 1,000,000,000 tokens |

**Rate Limit Monitoring:**
- View current limits in Google AI Studio
- Monitor usage via API headers
- Implement exponential backoff for 429 errors

---

## Technical Limitations

### Generation Constraints

| Limitation | Details |
|------------|---------|
| **Prompt Language** | **English only** for Imagen models |
| **Prompt Length** | Max 480 tokens |
| **Images per Request** | 1-4 (default: 4 for Imagen) |
| **Text in Images** | Max 25 characters recommended; quality varies |
| **Reference Images** | Up to 14 total (Gemini 3 Pro): max 6 object images, max 5 human images |

### Content Safety

**Safety Categories:**
1. Harassment
2. Hate speech
3. Sexually explicit content
4. Dangerous content
5. Civic integrity

**Harm Block Thresholds:**
- `BLOCK_LOW_AND_ABOVE` - Most restrictive
- `BLOCK_MEDIUM_AND_ABOVE` - Default
- `BLOCK_ONLY_HIGH` - Least restrictive

**Person Generation Settings:**
- `dont_allow` - No people in images
- `allow_adult` - Adults only (default)
- `allow_all` - All ages (NOT available in EU, UK, CH, MENA)

### Geographic Restrictions

- `allow_all` person generation **unavailable** in: EU, UK, Switzerland, MENA regions
- Some features may have regional availability differences
- Check current restrictions in your region via API documentation

---

## Image Editing Capabilities

### Gemini Native Image Editing

**Supported Operations:**
1. **Style Transfer:** "Make this photo look like a watercolor painting"
2. **Object Addition:** "Add a rainbow in the sky"
3. **Background Changes:** "Change the background to a beach"
4. **Color Adjustments:** "Make the colors more vibrant"
5. **Context-Aware Edits:** Preserves original composition

**How It Works:**
- Send existing image + text instruction via `generateContent` endpoint
- Model understands context and applies edits
- Maintains consistency with original style

**Example Use Case:**
```javascript
// Edit an existing WhatsApp image
const editedImage = await generateContent({
  model: 'gemini-2.5-flash-image',
  contents: [{
    parts: [
      { text: 'Remove the background and make it white' },
      {
        inline_data: {
          mime_type: 'image/jpeg',
          data: base64ImageData
        }
      }
    ]
  }]
});
```

### Limitations

- **No dedicated inpainting/outpainting API** (unlike DALL-E 3 or Stable Diffusion)
- Editing quality depends on prompt clarity
- Complex edits may require multiple iterations
- No mask-based editing (e.g., "edit only this region")

---

## Content Safety & Restrictions

### Safety Filter Configuration

**Default Behavior:**
- All models include automatic content filtering
- Cannot be completely disabled via official API
- Filters apply to both input prompts and output images

**Configurable Safety Settings:**
```json
{
  "safetySettings": [
    {
      "category": "HARM_CATEGORY_HARASSMENT",
      "threshold": "BLOCK_MEDIUM_AND_ABOVE"
    },
    {
      "category": "HARM_CATEGORY_HATE_SPEECH",
      "threshold": "BLOCK_MEDIUM_AND_ABOVE"
    },
    {
      "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "threshold": "BLOCK_ONLY_HIGH"
    },
    {
      "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
      "threshold": "BLOCK_MEDIUM_AND_ABOVE"
    }
  ]
}
```

### Prohibited Content

Google's Generative AI Prohibited Use Policy forbids:
- Illegal activities
- Child safety violations
- Violence and gore
- Sexually explicit content (beyond artistic)
- Hate speech and harassment
- Misinformation in sensitive areas
- Deepfakes without disclosure

### SynthID Watermarking

**All generated images include SynthID watermarks:**
- Imperceptible to human eye
- Detectable by Google's tools
- Cannot be removed (persists through editing)
- Purpose: Track AI-generated content provenance

---

## Best Model Choice for WhatsApp Bot

### Recommendation: **Imagen 4 Fast**

**Rationale:**

| Factor | Imagen 4 Fast | Gemini 2.5 Flash Image | Gemini 3 Pro Image |
|--------|--------------|------------------------|-------------------|
| **Cost** | $0.02/image | $0.30/image | $0.134-$0.24/image |
| **Speed** | 15-30 sec | 30-60 sec | 30-90 sec |
| **Quality** | Good | Good | Excellent |
| **Free Tier** | No | No | No |
| **Complexity** | Simple API | Multi-modal | Advanced features |

**Why Imagen 4 Fast:**
1. **Lowest cost** - 15x cheaper than Gemini 2.5 Flash Image
2. **Fast enough** for WhatsApp users (expect 15-30 sec response)
3. **Dedicated image model** - optimized for this task
4. **Simple API** - easier to integrate
5. **Predictable pricing** - fixed per-image cost vs. token-based

**When to Use Alternatives:**

- **Gemini 2.5 Flash Image:** If you need image editing (send photo + instructions)
- **Gemini 3 Pro Image:** If users demand 4K resolution or complex multi-image compositions
- **Imagen 4 Standard/Ultra:** If quality complaints arise (upgrade path)

**Batch API Consideration:**
- If generating multiple images per request, use Batch API
- Example: User asks for "4 variations of a logo"
- Cost: $0.01/image (50% off) vs. $0.02/image standard

---

## Existing MCP Servers

### Evaluated MCP Servers (February 2026)

| Server | Stars/Activity | Models | Key Features | Recommendation |
|--------|---------------|--------|--------------|----------------|
| **[sanxfxteam/gemini-mcp-server](https://github.com/sanxfxteam/gemini-mcp-server)** | Active | Gemini 2 | Simple, single tool: `generateImage` | Good for basic use |
| **[shinpr/mcp-image](https://github.com/shinpr/mcp-image)** | Active | Gemini 3 Pro, 2.0 Flash | Two-stage prompt enhancement, multi-resolution | **Best overall** |
| **[qhdrl12/mcp-server-gemini-image-generator](https://github.com/qhdrl12/mcp-server-gemini-image-generator)** | Active | Gemini Flash | Intelligent filename generation, strict text exclusion | Specialized use case |
| **[maheshcr/image-gen-mcp](https://github.com/maheshcr/image-gen-mcp)** | Active | Multi-provider | Gemini + other providers, cloud storage, cost tracking | If multi-provider needed |
| **[serkanhaslak/gemini-imagen-mcp-server](https://github.com/serkanhaslak/gemini-imagen-mcp-server)** | Active | Imagen 3, 4, 4 Ultra | Claude Code optimized, multiple Imagen variants | **Best for Imagen** |

### Recommended: shinpr/mcp-image

**Why this one:**
- Supports both Gemini 3 Pro Image and Imagen
- Two-stage pipeline: auto-enhances prompts with Gemini 2.0 Flash
- Comprehensive configuration options
- Well-documented with examples
- Active maintenance

**Installation:**
```bash
npm install -y mcp-image
```

**Configuration (for Cursor/Claude):**
```json
{
  "mcpServers": {
    "mcp-image": {
      "command": "npx",
      "args": ["-y", "mcp-image"],
      "env": {
        "GEMINI_API_KEY": "your-api-key",
        "IMAGE_OUTPUT_DIR": "/absolute/path/to/output",
        "SKIP_PROMPT_ENHANCEMENT": "false"
      }
    }
  }
}
```

**Features:**
- Text-to-image generation
- Image editing (context-aware)
- Multi-resolution support (Standard, 2K, 4K)
- 10+ aspect ratios
- Output formats: PNG, JPEG, WebP
- Optional prompt enhancement
- Agent skill mode (prompt guidance without API calls)

---

## Integration Approach for Node.js

### Option 1: Official Google SDK (Recommended)

**Package:** `@google/genai` (latest version: 1.41.0)

**Pros:**
- Official support from Google
- Type-safe TypeScript definitions
- Handles authentication, retries, errors
- Regular updates

**Cons:**
- Larger bundle size
- May include unnecessary features

**Installation:**
```bash
npm install @google/genai
```

**Basic Usage:**
```javascript
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateImage(prompt) {
  const response = await ai.models.generateImages({
    model: 'imagen-4.0-fast-generate-001',
    prompt: prompt,
    config: {
      numberOfImages: 1,
      aspectRatio: '1:1',
      imageSize: '1K'
    }
  });

  // Returns base64-encoded image bytes
  return response.generatedImages[0].image.imageBytes;
}
```

### Option 2: Raw REST Calls

**Package:** `node-fetch` or `axios`

**Pros:**
- Minimal dependencies
- Full control over requests
- Smaller bundle size
- Easier debugging

**Cons:**
- Manual error handling
- Manual retry logic
- No TypeScript types (unless you write them)

**Installation:**
```bash
npm install node-fetch
```

**Basic Usage:**
```javascript
import fetch from 'node-fetch';

async function generateImage(prompt) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: '1:1',
          imageSize: '1K'
        }
      })
    }
  );

  const data = await response.json();
  return Buffer.from(data.predictions[0].bytesBase64Encoded, 'base64');
}
```

### Option 3: Use Existing MCP Server

**Best For:** Quick integration, leveraging existing tools

**Approach:**
1. Install `mcp-image` or `gemini-imagen-mcp-server`
2. Run as subprocess from your Node.js container
3. Communicate via stdio (MCP protocol)

**Pros:**
- Battle-tested code
- Additional features (prompt enhancement, etc.)
- Community support

**Cons:**
- Added complexity (subprocess management)
- MCP protocol overhead
- Less control over implementation

### Recommendation for NanoClaw

**Use Option 1: Official SDK (@google/genai)**

**Reasoning:**
1. **Reliability:** Official support, battle-tested
2. **Maintainability:** Automatic updates, bug fixes
3. **Error Handling:** Built-in retry logic, rate limit handling
4. **Developer Experience:** TypeScript types, better IDE support
5. **Future-Proof:** Will support new features as they're released

**Implementation Strategy:**
```javascript
// /src/tools/imageGeneration.js

import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';

class ImageGenerationTool {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generateImage({ prompt, aspectRatio = '1:1', quality = 'fast' }) {
    const modelMap = {
      fast: 'imagen-4.0-fast-generate-001',
      standard: 'imagen-4.0-generate-001',
      ultra: 'imagen-4.0-ultra-generate-001'
    };

    try {
      const response = await this.ai.models.generateImages({
        model: modelMap[quality],
        prompt,
        config: {
          numberOfImages: 1,
          aspectRatio,
          imageSize: '1K'
        }
      });

      const imageBytes = response.generatedImages[0].image.imageBytes;
      const buffer = Buffer.from(imageBytes, 'base64');

      // Save to temp file for WhatsApp sending
      const filename = `generated_${Date.now()}.png`;
      const filepath = path.join('/tmp', filename);
      await fs.writeFile(filepath, buffer);

      return {
        success: true,
        filepath,
        cost: this.calculateCost(quality),
        model: modelMap[quality]
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        code: error.code
      };
    }
  }

  calculateCost(quality) {
    const prices = { fast: 0.02, standard: 0.04, ultra: 0.06 };
    return prices[quality];
  }
}

export default ImageGenerationTool;
```

**Tool Registration for Claude Agent:**
```javascript
// In your agent container's tool registry

const imageGenTool = new ImageGenerationTool(process.env.GEMINI_API_KEY);

const toolDefinition = {
  name: 'generate_image',
  description: 'Generate an image from a text prompt using Google Imagen 4',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed description of the image to generate (English only)'
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: 'Aspect ratio of the generated image',
        default: '1:1'
      },
      quality: {
        type: 'string',
        enum: ['fast', 'standard', 'ultra'],
        description: 'Quality level (affects cost: fast=$0.02, standard=$0.04, ultra=$0.06)',
        default: 'fast'
      }
    },
    required: ['prompt']
  }
};

// Tool execution handler
async function executeGenerateImage(params) {
  return await imageGenTool.generateImage(params);
}
```

---

## Complete Code Examples

### Example 1: Basic Text-to-Image (Imagen 4 Fast)

```javascript
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateBasicImage() {
  const response = await ai.models.generateImages({
    model: 'imagen-4.0-fast-generate-001',
    prompt: 'A serene Japanese garden with cherry blossoms and a koi pond',
    config: {
      numberOfImages: 1,
      aspectRatio: '16:9',
      imageSize: '1K'
    }
  });

  const imageBytes = response.generatedImages[0].image.imageBytes;
  await fs.writeFile('garden.png', Buffer.from(imageBytes, 'base64'));
  console.log('Image saved to garden.png');
}

generateBasicImage();
```

### Example 2: Image Editing with Gemini 2.5 Flash Image

```javascript
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function editExistingImage() {
  // Read existing image
  const imageBuffer = await fs.readFile('original.jpg');
  const base64Image = imageBuffer.toString('base64');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [{
      parts: [
        { text: 'Change the time of day to sunset and add warm orange tones' },
        {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Image
          }
        }
      ]
    }]
  });

  // Extract image from response
  const imagePart = response.candidates[0].content.parts.find(
    part => part.inline_data
  );

  if (imagePart) {
    await fs.writeFile(
      'edited.png',
      Buffer.from(imagePart.inline_data.data, 'base64')
    );
    console.log('Edited image saved to edited.png');
  }
}

editExistingImage();
```

### Example 3: Batch Generation with Cost Tracking

```javascript
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

async function generateBatch(prompts) {
  const results = [];
  let totalCost = 0;

  for (const prompt of prompts) {
    try {
      const response = await ai.models.generateImages({
        model: 'imagen-4.0-fast-generate-001',
        prompt,
        config: { numberOfImages: 1 }
      });

      const imageBytes = response.generatedImages[0].image.imageBytes;
      const filename = `batch_${Date.now()}_${results.length}.png`;

      await fs.writeFile(filename, Buffer.from(imageBytes, 'base64'));

      results.push({
        prompt,
        filename,
        success: true,
        cost: 0.02
      });

      totalCost += 0.02;
    } catch (error) {
      results.push({
        prompt,
        success: false,
        error: error.message
      });
    }

    // Rate limiting: wait 1 second between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`Generated ${results.filter(r => r.success).length}/${prompts.length} images`);
  console.log(`Total cost: $${totalCost.toFixed(2)}`);

  return results;
}

generateBatch([
  'A futuristic cityscape at night',
  'A tropical beach at sunrise',
  'A cozy mountain cabin in winter'
]);
```

### Example 4: WhatsApp Integration (NanoClaw Specific)

```javascript
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';

class WhatsAppImageGenerator {
  constructor(apiKey, outputDir = '/tmp') {
    this.ai = new GoogleGenAI({ apiKey });
    this.outputDir = outputDir;
    this.costTracker = { total: 0, count: 0 };
  }

  async handleImageRequest(message, userPhone) {
    const prompt = this.extractPrompt(message.text);

    if (!prompt) {
      return {
        type: 'text',
        content: 'Please provide an image description. Example: "Generate an image of a sunset beach"'
      };
    }

    // Send "typing" indicator
    await this.sendTypingIndicator(userPhone);

    try {
      const result = await this.generateImage(prompt);

      // Track usage
      this.costTracker.total += result.cost;
      this.costTracker.count++;

      return {
        type: 'image',
        filepath: result.filepath,
        caption: `Generated with ${result.model}\nCost: $${result.cost}\nTotal today: $${this.costTracker.total.toFixed(2)} (${this.costTracker.count} images)`
      };
    } catch (error) {
      return {
        type: 'text',
        content: `Image generation failed: ${error.message}`
      };
    }
  }

  async generateImage(prompt, options = {}) {
    const {
      quality = 'fast',
      aspectRatio = '1:1',
      imageSize = '1K'
    } = options;

    const modelMap = {
      fast: 'imagen-4.0-fast-generate-001',
      standard: 'imagen-4.0-generate-001',
      ultra: 'imagen-4.0-ultra-generate-001'
    };

    const response = await this.ai.models.generateImages({
      model: modelMap[quality],
      prompt,
      config: {
        numberOfImages: 1,
        aspectRatio,
        imageSize
      }
    });

    const imageBytes = response.generatedImages[0].image.imageBytes;
    const buffer = Buffer.from(imageBytes, 'base64');

    const filename = `whatsapp_${Date.now()}.png`;
    const filepath = path.join(this.outputDir, filename);
    await fs.writeFile(filepath, buffer);

    const costMap = { fast: 0.02, standard: 0.04, ultra: 0.06 };

    return {
      filepath,
      cost: costMap[quality],
      model: modelMap[quality]
    };
  }

  extractPrompt(text) {
    // Remove common command prefixes
    const cleaned = text
      .replace(/^(generate|create|make|draw)\s+(an?\s+)?image\s+(of\s+)?/i, '')
      .trim();

    return cleaned.length > 5 ? cleaned : null;
  }

  async sendTypingIndicator(phone) {
    // Implement WhatsApp "typing" indicator
    // This depends on your WhatsApp API implementation
  }

  getUsageStats() {
    return {
      totalCost: this.costTracker.total,
      imageCount: this.costTracker.count,
      averageCost: this.costTracker.count > 0
        ? this.costTracker.total / this.costTracker.count
        : 0
    };
  }

  resetDailyStats() {
    this.costTracker = { total: 0, count: 0 };
  }
}

export default WhatsAppImageGenerator;
```

### Example 5: Error Handling & Retry Logic

```javascript
import { GoogleGenAI } from '@google/genai';

class RobustImageGenerator {
  constructor(apiKey) {
    this.ai = new GoogleGenAI({ apiKey });
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second
  }

  async generateWithRetry(prompt, options = {}) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.ai.models.generateImages({
          model: 'imagen-4.0-fast-generate-001',
          prompt,
          config: {
            numberOfImages: 1,
            ...options
          }
        });
      } catch (error) {
        lastError = error;

        // Handle specific error types
        if (error.code === 'SAFETY_FILTER') {
          throw new Error('Content violates safety policies. Please modify your prompt.');
        }

        if (error.code === 'QUOTA_EXCEEDED') {
          throw new Error('Daily quota exceeded. Please try again tomorrow.');
        }

        if (error.code === 'RATE_LIMIT') {
          // Exponential backoff
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          console.log(`Rate limited. Retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
          await this.sleep(delay);
          continue;
        }

        // Network errors - retry
        if (error.code === 'NETWORK_ERROR' && attempt < this.maxRetries) {
          console.log(`Network error. Retrying... (attempt ${attempt}/${this.maxRetries})`);
          await this.sleep(this.retryDelay);
          continue;
        }

        // Unknown error - don't retry
        throw error;
      }
    }

    throw new Error(`Failed after ${this.maxRetries} attempts: ${lastError.message}`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default RobustImageGenerator;
```

---

## Summary & Quick Reference

### Quick Decision Matrix

| Use Case | Recommended Model | Cost | Speed |
|----------|------------------|------|-------|
| Personal WhatsApp bot | Imagen 4 Fast | $0.02 | 15-30s |
| High-quality outputs | Imagen 4 Ultra | $0.06 | 45-90s |
| Image editing | Gemini 2.5 Flash Image | $0.30 | 30-60s |
| 4K professional assets | Gemini 3 Pro Image | $0.24 | 30-90s |
| Batch processing | Imagen 4 Fast (Batch) | $0.01 | 24h |

### API Endpoints Quick Reference

```
# Imagen 4 (Recommended for NanoClaw)
POST https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict

# Gemini 2.5 Flash Image
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent

# Gemini 3 Pro Image
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent
```

### Essential npm Packages

```bash
# Official SDK (Recommended)
npm install @google/genai

# Alternative: REST calls
npm install node-fetch

# MCP Server (if using)
npm install -g mcp-image
```

### Environment Variables

```bash
GEMINI_API_KEY=your_api_key_here
IMAGE_OUTPUT_DIR=/absolute/path/to/output
SKIP_PROMPT_ENHANCEMENT=false  # For MCP server
```

### Cost Optimization Tips

1. **Use Imagen 4 Fast** for 99% of use cases ($0.02 vs $0.30)
2. **Enable Batch API** for non-urgent requests (50% savings)
3. **Implement caching** for repeated prompts
4. **Set daily quotas** per user to prevent abuse
5. **Monitor usage** with cost tracking

### Safety Best Practices

1. **Validate prompts** before sending to API
2. **Implement rate limiting** per user
3. **Log all requests** for audit trail
4. **Handle safety filter rejections** gracefully
5. **Set appropriate `personGeneration`** for your region

---

## Additional Resources

### Official Documentation
- Gemini API Overview: https://ai.google.dev/gemini-api/docs
- Image Generation Guide: https://ai.google.dev/gemini-api/docs/image-generation
- Imagen API: https://ai.google.dev/gemini-api/docs/imagen
- Pricing Page: https://ai.google.dev/gemini-api/docs/pricing
- Rate Limits: https://ai.google.dev/gemini-api/docs/rate-limits

### Tools & Resources
- Google AI Studio: https://aistudio.google.com/
- API Key Generation: https://aistudio.google.com/apikey
- Gemini Cookbook (GitHub): https://github.com/google-gemini/cookbook
- Official SDK (npm): https://www.npmjs.com/package/@google/genai

### Community MCP Servers
- mcp-image: https://github.com/shinpr/mcp-image
- gemini-imagen-mcp-server: https://github.com/serkanhaslak/gemini-imagen-mcp-server
- gemini-mcp-server: https://github.com/sanxfxteam/gemini-mcp-server

### Monitoring & Debugging
- View API quotas: Google AI Studio → Settings → Quotas
- Error codes reference: https://ai.google.dev/gemini-api/docs/error-codes
- Status page: https://status.cloud.google.com/

---

**Last Updated:** February 16, 2026
**Next Review:** Check for updates monthly (new models, pricing changes, etc.)
