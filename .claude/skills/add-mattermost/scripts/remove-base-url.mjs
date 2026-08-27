#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const envPath = join(process.cwd(), '.env');
if (!existsSync(envPath)) process.exit(0);

const content = readFileSync(envPath, 'utf8');
writeFileSync(envPath, content.replace(/^MATTERMOST_BASE_URL=.*\n?/m, ''));
