#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf8');
  writeFileSync(
    envPath,
    content.replace(/^MATTERMOST_(?:BASE_URL|BOT_TOKEN|CALLBACK_URL|CALLBACK_SECRET)=.*\n?/gm, ''),
  );
}
