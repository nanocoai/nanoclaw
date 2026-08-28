import type { Migration } from './index.js';

/**
 * Per-group policy for provider-native web search.
 *
 * NULL = preserve the provider's default behavior. `disabled` asks providers
 * that expose a native web-search tool to remove it, allowing an explicitly
 * configured MCP search provider to be the only web-search route.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-web-search-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN web_search_mode TEXT;`);
  },
};
