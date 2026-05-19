#!/usr/bin/env pnpm exec tsx
/**
 * X Integration - Authentication Setup
 * Usage: pnpm exec tsx setup.ts
 *
 * Interactive script - opens browser for manual login
 */

import { chromium } from 'playwright';
import * as readline from 'readline';
import fs from 'fs';
import path from 'path';
import { config, cleanupLockFiles } from '../lib/browser.js';

async function setup(): Promise<void> {
  console.log('=== X (Twitter) Authentication Setup ===\n');
  console.log('This will open Chrome for you to log in to X.');
  console.log('Your login session will be saved for automated interactions.\n');
  console.log(`Chrome path: ${config.chromePath}`);
  console.log(`Profile dir: ${config.browserDataDir}\n`);

  // Ensure directories exist
  fs.mkdirSync(path.dirname(config.authPath), { recursive: true });
  fs.mkdirSync(config.browserDataDir, { recursive: true });

  cleanupLockFiles();

  console.log('Launching browser...\n');

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: false,
    viewport: config.viewport,
    args: config.chromeArgs.slice(0, 3), // Use first 3 args for setup (less restrictive)
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  const page = context.pages()[0] || await context.newPage();

  // Navigate to login page
  await page.goto('https://x.com/login');

  console.log('Please log in to X in the browser window.');
  console.log('After you see your home feed, come back here and press Enter.\n');

  // Wait for user to complete login
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  await new Promise<void>(resolve => {
    rl.question('Press Enter when logged in... ', () => {
      rl.close();
      resolve();
    });
  });

  // Verify login by navigating to home and checking for account button
  console.log('\nVerifying login status...');
  await page.goto('https://x.com/home');
  await page.waitForTimeout(config.timeouts.pageLoad);

  const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);

  if (isLoggedIn) {
    // Save auth marker
    fs.writeFileSync(config.authPath, JSON.stringify({
      authenticated: true,
      timestamp: new Date().toISOString()
    }, null, 2));

    console.log('\n✅ Authentication successful!');
    console.log(`Session saved to: ${config.browserDataDir}`);
    console.log('\nYou can now use X integration features.');
  } else {
    console.log('\n❌ Could not verify login status.');
    console.log('Please try again and make sure you are logged in to X.');
  }

  await context.close();
}

setup().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
