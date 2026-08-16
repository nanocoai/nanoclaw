import { CONFIG, envVarFor, flagFor, type Entry } from './lib/setup-config.js';
import './providers/index.js';
import { listSetupProviderChoices } from './providers/registry.js';

function catalogEntry(entry: Entry) {
  return {
    key: entry.key,
    envVar: envVarFor(entry),
    flag: flagFor(entry),
    kind: entry.type,
    label: entry.label,
    help: entry.help,
    group: entry.group ?? null,
    secret: entry.secret ?? false,
    default: entry.default ?? null,
    options:
      entry.key === 'agentProvider'
        ? listSetupProviderChoices()
        : entry.type === 'enum'
          ? entry.options
          : entry.type === 'boolean'
            ? [true, false]
            : [],
    validation:
      entry.type === 'string' || entry.type === 'url'
        ? (entry.validation ?? null)
        : entry.type === 'integer'
          ? { min: entry.min ?? null, max: entry.max ?? null }
          : null,
  };
}

process.stdout.write(
  `${JSON.stringify(
    { preseeds: CONFIG.filter((entry) => entry.surface === 'flag+ui' || entry.preseed).map(catalogEntry) },
    null,
    2,
  )}\n`,
);
