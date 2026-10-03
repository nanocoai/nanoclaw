/**
 * hindsight-mcp - Shared tool implementation.
 *
 * Both transports (HTTP + stdio) build their McpServer via createMcpServer().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function encodeBankId(bankId: string): string {
  return encodeURIComponent(bankId);
}

async function hsPost(hindsightUrl: string, path: string, body: unknown) {
  const url = `${hindsightUrl}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Hindsight ${res.status} ${res.statusText}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function hsRetain(
  hindsightUrl: string,
  bankId: string,
  content: string,
  context?: string
) {
  return hsPost(
    hindsightUrl,
    `/v1/default/banks/${encodeBankId(bankId)}/memories`,
    {
      async: false,
      items: [{ content, ...(context ? { context } : {}) }],
    }
  );
}

async function hsRecall(
  hindsightUrl: string,
  bankId: string,
  query: string,
  budget: string
) {
  return hsPost(
    hindsightUrl,
    `/v1/default/banks/${encodeBankId(bankId)}/memories/recall`,
    { query, budget }
  );
}

async function hsReflect(
  hindsightUrl: string,
  bankId: string,
  query: string,
  budget: string
) {
  return hsPost(
    hindsightUrl,
    `/v1/default/banks/${encodeBankId(bankId)}/reflect`,
    { query, budget, include: { facts: {} } }
  );
}

export interface ServerOptions {
  hindsightUrl: string;
  bankPrefix: string;
}

export function createMcpServer(opts: ServerOptions) {
  const { hindsightUrl, bankPrefix } = opts;

  const server = new McpServer({
    name: "hindsight-mcp",
    version: "0.2.0",
  });

  const budgetSchema = z
    .enum(["low", "mid", "high"])
    .default("mid")
    .describe("Effort budget: low / mid / high.");

  server.registerTool(
    "memory_retain",
    {
      title: "Retain a memory",
      description:
        "Store a piece of information in Hindsight. Choose a `group` to " +
        "namespace related memories (e.g. 'trading', 'user-john'). " +
        "@context` is an optional hint (e.g. 'career update').",
      inputSchema: {
        group: z.string().min(1).describe("Namespace within your tenant."),
        content: z.string().min(1).describe("Natural-language memory content."),
        context: z.string().optional().describe("Short context hint."),
      },
    },
    async ({ group, content, context }) => {
      const bankId = `${bankPrefix}:${group}`;
      const result = await hsRetain(hindsightUrl, bankId, content, context);
      return {
        content: [
          {
            type: "text",
            text: `Retained in bank ${bankId}.\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "memory_recall",
    {
      title: "Recall memories",
      description:
        "Semantic recall from a group. Returns relevant memories ranked by " +
        "relevance to the query. Use the same `group` you used when retaining.",
      inputSchema: {
        group: z.string().min(1),
        query: z.string().min(1),
        budget: budgetSchema,
      },
    },
    async ({ group, query, budget }) => {
      const bankId = `${bankPrefix}:${group}`;
      const result = await hsRecall(hindsightUrl, bankId, query, budget);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "memory_reflect",
    {
      title: "Reflect on memories",
      description:
        "Ask Hindsight to synthesize an answer from memories in a group. " +
        "Returns a markdown answer plus the evidence it was based on. " +
        "Heavier than recall; use for open-ended questions.",
      inputSchema: {
        group: z.string().min(1),
        query: z.string().min(1),
        budget: budgetSchema,
      },
    },
    async ({ group, query, budget }) => {
      const bankId = `${bankPrefix}:${group}`;
      const result = await hsReflect(hindsightUrl, bankId, query, budget);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}
