/**
 * scripts/lib/plugins-config.ts — read/validate/write the
 * `container.json:plugins` block, with safety checks for the operator
 * skills (`/add-marketplace`, `/remove-marketplace`, `/install-plugin`,
 * `/uninstall-plugin`).
 *
 * All mutations route through `updateContainerConfig()` so concurrent
 * writers (multiple operator skills, self-mod approval handlers) are
 * serialized via the file lock established in PR 1.
 */
import {
  readContainerConfig,
  updateContainerConfig,
  type ExtraKnownMarketplaceSource,
} from '../../src/container-config.js';
import { parseMarketplaceSource } from './marketplace-source-validator.js';

/**
 * Add or update a marketplace entry in `container.json:plugins.marketplaces`.
 * Idempotent — running with the same source is a no-op (returns
 * `{ added: false, replaced: false }`). Updating with a different source
 * replaces the entry (returns `{ added: false, replaced: true }`).
 */
export async function addMarketplace(
  folder: string,
  name: string,
  source: ExtraKnownMarketplaceSource,
): Promise<{ added: boolean; replaced: boolean }> {
  validateMarketplaceName(name);
  let added = false;
  let replaced = false;
  await updateContainerConfig(folder, (cfg) => {
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.marketplaces) cfg.plugins.marketplaces = {};
    const existing = cfg.plugins.marketplaces[name];
    if (!existing) {
      added = true;
    } else if (JSON.stringify(existing.source) !== JSON.stringify(source)) {
      replaced = true;
    }
    cfg.plugins.marketplaces[name] = { source };
  });
  return { added, replaced };
}

/**
 * Remove a marketplace entry. Refuses if any plugin in
 * `enabled` references this marketplace — operator must
 * `/uninstall-plugin` those first.
 *
 * Returns `{ removed: false }` if the marketplace wasn't registered.
 */
export async function removeMarketplace(
  folder: string,
  name: string,
): Promise<{ removed: boolean; blockedBy: string[] }> {
  // Reference check first (read-only path).
  const cfg = readContainerConfig(folder);
  const enabled = cfg.plugins?.enabled ?? {};
  const referencingKeys: string[] = [];
  for (const key of Object.keys(enabled)) {
    const at = key.lastIndexOf('@');
    if (at > 0 && key.slice(at + 1) === name) {
      referencingKeys.push(key);
    }
  }
  if (referencingKeys.length > 0) {
    return { removed: false, blockedBy: referencingKeys };
  }

  let removed = false;
  await updateContainerConfig(folder, (c) => {
    if (c.plugins?.marketplaces?.[name]) {
      delete c.plugins.marketplaces[name];
      removed = true;
    }
  });
  return { removed, blockedBy: [] };
}

export function listMarketplaces(folder: string): Record<string, { source: ExtraKnownMarketplaceSource }> {
  const cfg = readContainerConfig(folder);
  return cfg.plugins?.marketplaces ?? {};
}

/**
 * Enable a plugin. The plugin spec is `<plugin-name>@<marketplace-name>`.
 * If `inlineSource` is provided, the marketplace is registered (or
 * updated) atomically with the enable — convenience for the
 * "register and install in one shot" flow.
 *
 * If the marketplace isn't registered and no `inlineSource` is provided,
 * throws.
 */
export async function installPlugin(
  folder: string,
  pluginSpec: string,
  inlineSource?: ExtraKnownMarketplaceSource,
): Promise<{ wasEnabled: boolean; marketplaceAdded: boolean }> {
  const { name, marketplace } = parsePluginSpec(pluginSpec);
  let wasEnabled = false;
  let marketplaceAdded = false;
  await updateContainerConfig(folder, (cfg) => {
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.marketplaces) cfg.plugins.marketplaces = {};
    if (!cfg.plugins.enabled) cfg.plugins.enabled = {};

    // Register marketplace if needed (and inline source provided).
    if (!cfg.plugins.marketplaces[marketplace]) {
      if (!inlineSource) {
        throw new Error(
          `Marketplace "${marketplace}" is not registered for this group. Run /add-marketplace first, or pass --source to register inline.`,
        );
      }
      cfg.plugins.marketplaces[marketplace] = { source: inlineSource };
      marketplaceAdded = true;
    } else if (inlineSource) {
      // Update if inline source provided and differs.
      if (JSON.stringify(cfg.plugins.marketplaces[marketplace].source) !== JSON.stringify(inlineSource)) {
        cfg.plugins.marketplaces[marketplace] = { source: inlineSource };
        marketplaceAdded = true;
      }
    }

    if (cfg.plugins.enabled[pluginSpec] !== true) {
      cfg.plugins.enabled[pluginSpec] = true;
      wasEnabled = true;
    }

    // Sanity unused — keeps pluginName reachable in TS without an unused-var warning.
    void name;
  });
  return { wasEnabled, marketplaceAdded };
}

/**
 * Disable a plugin. Removes the entry from `enabled`. The marketplace
 * registration stays so other plugins from it can still be enabled.
 */
export async function uninstallPlugin(
  folder: string,
  pluginSpec: string,
): Promise<{ wasDisabled: boolean }> {
  // Validate format up front so a typo doesn't silently no-op.
  parsePluginSpec(pluginSpec);
  let wasDisabled = false;
  await updateContainerConfig(folder, (cfg) => {
    if (cfg.plugins?.enabled?.[pluginSpec] !== undefined) {
      delete cfg.plugins.enabled[pluginSpec];
      wasDisabled = true;
    }
  });
  return { wasDisabled };
}

export function listEnabledPlugins(
  folder: string,
): Record<string, boolean | string[] | { [k: string]: unknown }> {
  const cfg = readContainerConfig(folder);
  return cfg.plugins?.enabled ?? {};
}

/**
 * Parse `<plugin-name>@<marketplace-name>` into its components. Throws
 * with a clear message on malformed input.
 */
export function parsePluginSpec(spec: string): { name: string; marketplace: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Plugin spec must be in "name@marketplace" format; got "${spec}"`);
  }
  const name = spec.slice(0, at);
  const marketplace = spec.slice(at + 1);
  validateMarketplaceName(marketplace);
  if (!name) throw new Error(`Plugin name cannot be empty in spec "${spec}"`);
  return { name, marketplace };
}

function validateMarketplaceName(name: string): void {
  // Match the SDK's marketplace-name validation: non-empty, no spaces,
  // no `/`, no `\`, no `..`. Some reserved names are also rejected
  // upstream, but we leave that to the SDK.
  if (!name) throw new Error('Marketplace name cannot be empty');
  if (/[\s/\\]/.test(name)) {
    throw new Error(`Marketplace name "${name}" contains invalid characters (no spaces, slashes, or backslashes)`);
  }
  if (name === '..' || name === '.') {
    throw new Error(`Marketplace name "${name}" is reserved`);
  }
}
