#!/usr/bin/env pnpm exec tsx
/**
 * X Integration - Retweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | pnpm exec tsx retweet.ts
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';

interface RetweetInput {
  tweetUrl: string;
}

async function retweet(input: RetweetInput): Promise<ScriptResult> {
  const { tweetUrl } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    const tweet = page.locator('article[data-testid="tweet"]').first();
    const unretweetButton = tweet.locator('[data-testid="unretweet"]');
    const retweetButton = tweet.locator('[data-testid="retweet"]');

    // Check if already retweeted
    const alreadyRetweeted = await unretweetButton.isVisible().catch(() => false);
    if (alreadyRetweeted) {
      return { success: true, message: 'Tweet already retweeted' };
    }

    await retweetButton.waitFor({ timeout: config.timeouts.elementWait });
    await retweetButton.click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Click retweet confirm option
    const retweetConfirm = page.locator('[data-testid="retweetConfirm"]');
    await retweetConfirm.waitFor({ timeout: config.timeouts.elementWait });
    await retweetConfirm.click();
    await page.waitForTimeout(config.timeouts.afterClick * 2);

    // Verify
    const nowRetweeted = await unretweetButton.isVisible().catch(() => false);
    if (nowRetweeted) {
      return { success: true, message: 'Retweet successful' };
    }

    return { success: false, message: 'Retweet action completed but could not verify success' };

  } finally {
    if (context) await context.close();
  }
}

runScript<RetweetInput>(retweet);
