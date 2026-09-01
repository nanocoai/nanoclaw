#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const POLICY_PATHS = [
  'templates/engineering-agent/policies/policy.json',
  'templates/personal-assistant/policies/policy.json',
];

export function withoutAppCeiling(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('template policy must be a JSON object');
  }
  const { apps: _historicalAppCeiling, ...preserved } = policy;
  return preserved;
}

export function rewritePolicy(path) {
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify(withoutAppCeiling(policy), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const path of POLICY_PATHS) rewritePolicy(path);
}
