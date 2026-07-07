// Pluggable parsers for clidash.
//
// discoveryParsers — turn a CLI's "help"-style output into a resource list.
// parseOutput / unwrapPath — turn a CLI's list output into rows.
// All per-CLI knowledge beyond these small functions lives in clidash.config.json.

/**
 * Discovery parsers, keyed by the `discover.parser` name in config.
 * Each receives the raw discovery output and returns
 * [{ name, description, verbs }] for resources that support `list`.
 * They must throw loudly on unrecognized formats — silent empty results
 * would render as silently-stale tabs.
 */
export const discoveryParsers = {
  /**
   * Parses ncl's two-column help format:
   *
   *   Resources:
   *     sessions             Session — the runtime unit. ...
   *                          verbs: list, get
   *   Commands:
   *     help                 ...
   */
  'ncl-help'(text) {
    const lines = String(text).split('\n');
    const start = lines.findIndex((l) => l.trim() === 'Resources:');
    if (start === -1) {
      throw new Error('ncl-help parser: no "Resources:" section in output — format may have changed');
    }
    const resources = [];
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      if (/^\S/.test(line)) break; // next top-level section, e.g. "Commands:"
      const verbsMatch = line.match(/^\s+verbs:\s*(.+)$/);
      if (verbsMatch && current) {
        current.verbs = verbsMatch[1].split(',').map((v) => v.trim()).filter(Boolean);
        continue;
      }
      const resMatch = line.match(/^  (\S+)\s{2,}(\S.*)$/);
      if (resMatch) {
        current = { name: resMatch[1], description: resMatch[2].trim(), verbs: [] };
        resources.push(current);
      }
    }
    return resources.filter((r) => r.verbs.includes('list'));
  },
};

/**
 * Parses a CLI's list output per the config's `output` field.
 * - 'json'      — one JSON document.
 * - 'jsonlines' — one JSON object per line (docker/kubectl style).
 * Thrown errors carry the raw output on `err.raw` so the UI can show it.
 */
export function parseOutput(text, format) {
  if (format === 'json') {
    try {
      return JSON.parse(text);
    } catch (e) {
      const err = new Error(`Invalid JSON output: ${e.message}`);
      err.raw = text;
      throw err;
    }
  }
  if (format === 'jsonlines') {
    const rows = [];
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (e) {
        const err = new Error(`Invalid JSON on line ${i + 1}: ${e.message}`);
        err.raw = text;
        throw err;
      }
    }
    return rows;
  }
  throw new Error(`Unknown output format: ${format}`);
}

/**
 * Follows a dot-path into a response envelope (e.g. 'data' for ncl's
 * {id, ok, data} frame). No path → value passes through unchanged.
 * Missing path throws — a changed envelope must fail loudly.
 */
export function unwrapPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) {
      throw new Error(`Unwrap path "${path}" not found in CLI output (missing "${key}")`);
    }
    cur = cur[key];
  }
  return cur;
}
