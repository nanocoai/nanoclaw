#!/usr/bin/env pnpm exec tsx
/**
 * X Integration - Reply to Tweet
 * Usage: echo '{"tweetUrl":"https://x.com/user/status/123","content":"Great post!"}' | pnpm exec tsx reply.ts
 */

import { getBrowserContext, navigateToTweet, runScript, validateContent, config, ScriptResult } from '../lib/browser.js';

interface ReplyInput {
  tweetUrl: string;
  content: string;
}

async function replyToTweet(input: ReplyInput): Promise<ScriptResult> {
  const { tweetUrl, content } = input;

  if (!tweetUrl) {
    return { success: false, message: 'Please provide a tweet URL' };
  }

  const validationError = validateContent(content, 'Reply');
  if (validationError) return validationError;

  let context = null;
  try {
    context = await getBrowserContext();
    const { page, success, error } = await navigateToTweet(context, tweetUrl);

    if (!success) {
      return { success: false, message: error || 'Navigation failed' };
    }

    // Click reply button
    const tweet = page.locator('article[data-testid="tweet"]').first();
    const replyButton = tweet.locator('[data-testid="reply"]');
    await replyButton.waitFor({ timeout: config.timeouts.elementWait });
    await replyButton.click();
    await page.waitForTimeout(config.timeouts.afterClick * 1.5);

    // Find dialog with aria-modal="true" to avoid matching other dialogs
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await dialog.waitFor({ timeout: config.timeouts.elementWait });

    // Fill reply content
    const replyInput = dialog.locator('[data-testid="tweetTextarea_0"]');
    await replyInput.waitFor({ timeout: config.timeouts.elementWait });
    await replyInput.click();
    await page.waitForTimeout(config.timeouts.afterClick / 2);
    await replyInput.fill(content);
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
      message: `Reply posted: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''}`
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<ReplyInput>(replyToTweet);
