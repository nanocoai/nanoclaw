import { endpointName, OVERPASS_ENDPOINTS } from "../src/api/endpoints.js";

const OVERPASS_PROXY_TIMEOUT_MS = 12_000;

function sendJson(response: { status: (code: number) => { json: (payload: unknown) => void } }, status: number, payload: unknown) {
  response.status(status).json(payload);
}

async function postToEndpoint(endpoint: string, query: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OVERPASS_PROXY_TIMEOUT_MS);

  try {
    return await fetch(endpoint, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "StreetWindShadowMap/0.1 (+https://winds-beta.vercel.app)",
      },
      body: new URLSearchParams({ data: query }),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(
  request: { method?: string; body?: { query?: string } | string },
  response: { status: (code: number) => { json: (payload: unknown) => void } },
) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed." });
  }

  let query = "";

  if (typeof request.body === "string") {
    try {
      query = ((JSON.parse(request.body) as { query?: string }).query ?? "").trim();
    } catch {
      return sendJson(response, 400, { error: "Expected JSON body with query." });
    }
  } else {
    query = request.body?.query?.trim() ?? "";
  }

  if (!query.includes("[out:json]") || query.length > 8_000) {
    return sendJson(response, 400, { error: "Invalid Overpass query." });
  }

  const errors: string[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    let upstreamResponse: Response;

    try {
      upstreamResponse = await postToEndpoint(endpoint, query);
    } catch (error) {
      errors.push(`${endpointName(endpoint)}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text().catch(() => "");
      const suffix = detail ? ` ${detail.replace(/\s+/g, " ").slice(0, 180)}` : "";
      errors.push(`${endpointName(endpoint)}: HTTP ${upstreamResponse.status}${suffix}`);
      continue;
    }

    const text = await upstreamResponse.text();

    try {
      return sendJson(response, 200, {
        endpoint,
        errors,
        payload: JSON.parse(text),
      });
    } catch {
      errors.push(`${endpointName(endpoint)}: invalid JSON response`);
    }
  }

  return sendJson(response, 502, {
    error: "All Overpass endpoints failed.",
    errors,
  });
}
