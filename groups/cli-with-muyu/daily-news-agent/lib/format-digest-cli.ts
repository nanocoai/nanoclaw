import { formatDigestMessage } from './format-digest.js';

export type DigestCliInput = {
  dateLabel: string;
  qualifiedCount: number;
  entries: Array<{ rank: number; title: string; summary: string; url: string }>;
  emptyMessage?: string;
};

export function parseDigestCliInput(raw: string): DigestCliInput {
  const parsed = JSON.parse(raw) as DigestCliInput;
  if (!parsed.dateLabel || typeof parsed.qualifiedCount !== 'number') {
    throw new Error('dateLabel and qualifiedCount are required');
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error('entries must be an array');
  }
  return parsed;
}

export function formatDigestFromCliInput(input: DigestCliInput): string {
  return formatDigestMessage(input);
}
