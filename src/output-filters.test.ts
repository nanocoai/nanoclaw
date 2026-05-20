import { describe, it, expect } from 'vitest';

import {
  MODEL_REFUSAL_PATTERN,
  shouldFilterProgress,
  isModelRefusal,
} from './output-filters.js';

// --- shouldFilterProgress ---

describe('shouldFilterProgress', () => {
  it('过滤 thinking 类型', () => {
    expect(shouldFilterProgress('thinking')).toBe(true);
  });

  it('不过滤 tool_use 类型', () => {
    expect(shouldFilterProgress('tool_use')).toBe(false);
  });

  it('不过滤 undefined', () => {
    expect(shouldFilterProgress(undefined)).toBe(false);
  });

  it('不过滤空字符串', () => {
    expect(shouldFilterProgress('')).toBe(false);
  });

  it('不过滤其他类型', () => {
    expect(shouldFilterProgress('progress')).toBe(false);
    expect(shouldFilterProgress('status')).toBe(false);
  });
});

// --- isModelRefusal / MODEL_REFUSAL_PATTERN ---

describe('isModelRefusal', () => {
  // 应被拦截的文本（完整短句，无后续内容）
  const refusals = [
    'No response requested.',
    'no response requested.',
    "I don't have a response",
    "I don't have a response.",
    "I don't have any response",
    "I don't have a reply",
    "I don't have any reply",
    "I don't have any reply.",
    "i don't have response",
    'Not applicable',
    'Not applicable.',
    'not applicable',
    'NOT APPLICABLE',
  ];

  for (const text of refusals) {
    it(`拦截: "${text.slice(0, 50)}"`, () => {
      expect(isModelRefusal(text)).toBe(true);
    });
  }

  // 不应被拦截的文本
  const allowed = [
    '好的，我来帮你处理',
    'Here is the result',
    'The file was updated successfully',
    '没问题',
    'Done.',
    // 包含关键词但不是开头的
    'The user said no response requested',
    'This is not applicable to the case',
    // 空字符串
    '',
    // Codex review 指出的误拦截场景：拒绝词开头但后面有正常内容
    'Not applicable here because the config has changed',
    "I don't have a response from the server yet, but I'm retrying",
    'No response requested. The user simply approved.',
  ];

  for (const text of allowed) {
    it(`放行: "${text.slice(0, 60)}"`, () => {
      expect(isModelRefusal(text)).toBe(false);
    });
  }
});

describe('MODEL_REFUSAL_PATTERN 正则边界', () => {
  it('必须是完整短句才匹配（有尾部锚定）', () => {
    expect(MODEL_REFUSAL_PATTERN.test('No response requested.')).toBe(true);
    // 后面跟了更多文本 — 不匹配
    expect(MODEL_REFUSAL_PATTERN.test('No response requested. But here is more')).toBe(false);
  });

  it('必须是文本开头才匹配', () => {
    expect(MODEL_REFUSAL_PATTERN.test('Prefix: No response requested.')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(MODEL_REFUSAL_PATTERN.test('NO RESPONSE REQUESTED.')).toBe(true);
    expect(MODEL_REFUSAL_PATTERN.test('Not Applicable')).toBe(true);
  });

  it('多行文本中只匹配独立一行', () => {
    // multiline flag (m) 使 ^ $ 匹配行首行尾
    expect(MODEL_REFUSAL_PATTERN.test('Some intro\nNo response requested.\nMore text')).toBe(false);
    // 但如果第一行就是拒绝文本
    expect(MODEL_REFUSAL_PATTERN.test('No response requested.\nMore text')).toBe(false);
  });
});
