/**
 * Canvas seam — pr-factory-core's optional rendered-document surface.
 *
 * Core itself ships NO canvas implementation: `createCanvas` returns null
 * until a provider registers, and every caller (test plans, test results)
 * falls back to plain text + .md file upload when it does. The `slack-canvas`
 * component registers the real Slack Canvas API client here at import time.
 *
 * Cross-component contract: keep `registerCanvasProvider` / `createCanvas` /
 * `CanvasResult` stable — the slack-canvas component imports them.
 */
import { log } from '../../log.js';

export interface CanvasResult {
  canvasId: string;
  permalink: string;
}

export type CanvasProvider = (title: string, markdown: string, channelId: string) => Promise<CanvasResult | null>;

let provider: CanvasProvider | null = null;

export function registerCanvasProvider(p: CanvasProvider): void {
  provider = p;
}

/**
 * Render markdown as a canvas document shared with the channel. Returns null
 * when no provider is installed or the provider fails — callers fall back to
 * file upload.
 */
export async function createCanvas(title: string, markdown: string, channelId: string): Promise<CanvasResult | null> {
  if (!provider) return null;
  try {
    return await provider(title, markdown, channelId);
    // eslint-disable-next-line no-catch-all/no-catch-all -- canvas is best-effort by contract; every caller has a file-upload fallback
  } catch (err) {
    log.warn('Canvas provider failed — falling back to file upload', { title, err });
    return null;
  }
}
