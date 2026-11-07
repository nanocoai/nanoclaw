/**
 * Install-specific defaults for the PR Factory, read once from .env.
 *
 *   PR_FACTORY_DEFAULT_REPO     — repo assumed when an MCP action omits `repo`
 *                                 and used as the activity-log key for
 *                                 non-PR-scoped events. No built-in default:
 *                                 set it to your repo (e.g. acme/widgets) or
 *                                 always pass `repo` explicitly in tool calls.
 *   PR_FACTORY_REPO_MIRROR_DIR  — local clone the handler fast-forwards before
 *                                 each triage so the worker container has
 *                                 current code to search. Optional — when the
 *                                 directory doesn't exist the refresh is a
 *                                 no-op. Default: data/repo-mirror.
 *   PR_FACTORY_REVIEW_SKILL     — optional name of an operator-supplied
 *                                 container skill that owns the triage/review
 *                                 workflow. When set, PR trigger prompts tell
 *                                 the worker to invoke /<skill>; when unset,
 *                                 the worker follows the default triage
 *                                 workflow seeded into its group instructions.
 */
import path from 'path';

import { readEnvFile } from '../../env.js';

const env = readEnvFile(['PR_FACTORY_DEFAULT_REPO', 'PR_FACTORY_REPO_MIRROR_DIR', 'PR_FACTORY_REVIEW_SKILL']);

export const DEFAULT_REPO = process.env.PR_FACTORY_DEFAULT_REPO || env.PR_FACTORY_DEFAULT_REPO || '';

export const REPO_MIRROR_DIR = path.resolve(
  process.env.PR_FACTORY_REPO_MIRROR_DIR || env.PR_FACTORY_REPO_MIRROR_DIR || path.join('data', 'repo-mirror'),
);

export const REVIEW_SKILL = process.env.PR_FACTORY_REVIEW_SKILL || env.PR_FACTORY_REVIEW_SKILL || '';

/**
 * The sentence that points the worker at its triage workflow. Operators who
 * ship their own tuned container skill set PR_FACTORY_REVIEW_SKILL; everyone
 * else gets the default group-instruction workflow seeded by bootstrap.
 */
export function triageDirective(): string {
  return REVIEW_SKILL
    ? `Use the /${REVIEW_SKILL} skill to triage this pull request.`
    : 'Triage this pull request following the PR triage workflow in your group instructions.';
}
