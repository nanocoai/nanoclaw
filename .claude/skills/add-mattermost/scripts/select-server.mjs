const [mode, baseUrl = '', configAccess = 'unavailable', container = 'none'] = process.argv.slice(2);

function validUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return /^\/(?:[A-Za-z0-9._~%+-]+\/)*[A-Za-z0-9._~%+-]*$/.test(url.pathname);
  } catch {
    return false;
  }
}

let selection;
if (mode === 'create') {
  selection = {
    base_url: 'http://localhost:8065',
    config_access: 'managed',
    mattermost_container: 'nanoclaw-mattermost-mattermost-1',
  };
} else if (mode === 'enter' && validUrl(baseUrl)) {
  selection = { base_url: baseUrl, config_access: 'unavailable', mattermost_container: 'none' };
} else if (
  mode === 'use' &&
  validUrl(baseUrl) &&
  ['host', 'docker', 'unavailable'].includes(configAccess) &&
  /^(?:none|[A-Za-z0-9][A-Za-z0-9_.-]*)$/.test(container)
) {
  selection = { base_url: baseUrl, config_access: configAccess, mattermost_container: container };
} else {
  process.stderr.write('Invalid Mattermost server selection\n');
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(selection)}\n`);
