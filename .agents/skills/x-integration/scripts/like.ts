#!/usr/bin/env pnpm exec tsx
/**
 * X Integration - Like Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123"}' | pnpm exec tsx like.ts
 */

import { getBrowserContext, navigateToTweet, runScript, config, ScriptResult } from '../lib/browser.js';

interface LikeInput {
  tweetUrl: string;
}

async function likeTweet(input: LikeInput): Promise<ScriptResult> {
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
    const unlikeButton = tweet.locator('[data-testid="unlike"]');
    const likeButton = tweet.locator('[data-testid="like"]');

    // Check if already liked
    const alreadyLiked = await unlikeButton.isVisible().catch(() => false);
    if (alreadyLiked) {
      return { success: true, message: 'Tweet already liked' };
    }

    await likeButton.waitFor({ timeout: config.timeouts.elementWait });
    await likeButton.click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Verify
    const nowLiked = await unlikeButton.isVisible().catch(() => false);
    if (nowLiked) {
      return { success: true, message: 'Like successful' };
    }

    return { success: false, message: 'Like action completed but could not verify success' };

  } finally {
    if (context) await context.close();
  }
}

runScript<LikeInput>(likeTweet);
