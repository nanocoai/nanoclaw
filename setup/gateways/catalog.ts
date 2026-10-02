import fs from 'node:fs';
import path from 'node:path';

export interface GatewayCatalogEntry {
  kind: string;
  label: string;
  description: string;
  skillPath: string;
  default?: boolean;
}

export interface GatewayCatalog {
  default: string;
  gateways: GatewayCatalogEntry[];
}

function validateManifest(value: unknown, skillPath: string): GatewayCatalogEntry {
  if (!value || typeof value !== 'object') throw new Error(`Invalid gateway manifest: ${skillPath}`);
  const entry = value as Partial<GatewayCatalogEntry>;
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.kind ?? '') ||
    !entry.label?.trim() ||
    !entry.description?.trim() ||
    (entry.default !== undefined && typeof entry.default !== 'boolean')
  ) {
    throw new Error(`Invalid gateway manifest: ${skillPath}`);
  }
  return { ...entry, skillPath } as GatewayCatalogEntry;
}

export function loadGatewayCatalog(projectRoot = process.cwd()): GatewayCatalog {
  const skillsRoot = path.join(projectRoot, '.claude', 'skills');
  const gateways = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const skillPath = path.join(skillsRoot, entry.name);
      const manifest = path.join(skillPath, 'gateway.json');
      if (!fs.existsSync(manifest)) return [];
      if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) throw new Error(`Gateway skill is missing: ${entry.name}`);
      return [validateManifest(JSON.parse(fs.readFileSync(manifest, 'utf8')), skillPath)];
    });

  const kinds = new Set<string>();
  for (const gateway of gateways) {
    if (kinds.has(gateway.kind)) throw new Error(`Duplicate gateway kind: ${gateway.kind}`);
    kinds.add(gateway.kind);
  }
  const defaults = gateways.filter((gateway) => gateway.default);
  if (defaults.length !== 1) throw new Error(`Expected exactly one default gateway, found ${defaults.length}`);
  gateways.sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)) || a.label.localeCompare(b.label));
  return { default: defaults[0].kind, gateways };
}
