#!/usr/bin/env pnpm exec tsx
/**
 * X Integration - Quote Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123","comment":"My thoughts"}' | pnpm exec tsx quote.ts
 */

import { getBrowserContext, navigateToTweet, runScript, validateContent, config, ScriptResult } from '../lib/browser.js';

interface QuoteInput {
  tweetUrl: string;
  comment: string;
}

async function quoteTweet(input: QuoteInput): Promise<ScriptResult> {
  const { tweetUrl, comment } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  const validationError = validateContent(comment, 'Comment');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    // Click retweet button to open menu
    const tweet = page.locator('article[data-testid="tweet"]').first();
    const retweetButton = tweet.locator('[data-testid="retweet"]');
    await retweetButton.waitFor({ timeout: config.timeouts.elementWait });
    await retweetButton.click();
    await page.waitForTimeout(config.timeouts.afterClick);

    // Click quote option
    const quoteOption = page.getByRole('menuitem').filter({ hasText: /Quote/i });
    await quoteOption.waitFor({ timeout: config.timeouts.elementWait });
    await quoteOption.click();
    await page.waitForTimeout(config.timeouts.afterClick * 1.5);

    // Find dialog with aria-modal="true"
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await dialog.waitFor({ timeout: config.timeouts.elementWait });

    // Fill comment
    const quoteInput = dialog.locator('[data-testid="tweetTextarea_0"]');
    await quoteInput.waitFor({ timeout: config.timeouts.elementWait });
    await quoteInput.click();
    await page.waitForTimeout(config.timeouts.afterClick / 2);
    await quoteInput.fill(comment);
    await page.waitForTimeout(config.timeouts.afterFill);

    // Click submit button
    const submitButton = dialog.locator('[data-testid="tweetButton"]');
    await submitButton.waitFor({ timeout: config.timeouts.elementWait });

    const isDisabled = await submitButton.getAttribute('aria-disabled');
    if (isDisabled === 'true') {
      return { success: false, message: 'Submit button disabled. Content may be empty or exceed character limit.' };
    }

    await submitButton.click();
    await page.waitForTimeout(config.timeouts.afterSubmit);

    return {
      success: true,
      message: `Quote tweet posted: ${comment.slice(0, 50)}${comment.length > 50 ? '...' : ''}`
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<QuoteInput>(quoteTweet);
