import { describe, expect, it } from 'vitest';

import { FINALIZING_TOOLS, isFinalizingOnly } from './finalizing-tools.js';

describe('isFinalizingOnly', () => {
  it('空数组（无跟随工具，end_turn 纯文本）返回 false', () => {
    expect(isFinalizingOnly([])).toBe(false);
  });

  it('只跟一个 TodoWrite 返回 true', () => {
    expect(isFinalizingOnly(['TodoWrite'])).toBe(true);
  });

  it('跟多个 TodoWrite 返回 true', () => {
    expect(isFinalizingOnly(['TodoWrite', 'TodoWrite'])).toBe(true);
  });

  it('跟实质工具 Read 返回 false', () => {
    expect(isFinalizingOnly(['Read'])).toBe(false);
  });

  it('跟实质工具 Bash 返回 false', () => {
    expect(isFinalizingOnly(['Bash'])).toBe(false);
  });

  it('跟实质工具 Edit 返回 false', () => {
    expect(isFinalizingOnly(['Edit'])).toBe(false);
  });

  it('跟实质工具 Grep 返回 false', () => {
    expect(isFinalizingOnly(['Grep'])).toBe(false);
  });

  it('收尾工具后又跟实质工具（回退场景）返回 false', () => {
    expect(isFinalizingOnly(['TodoWrite', 'Read'])).toBe(false);
  });

  it('实质工具在前、收尾工具在后返回 false', () => {
    expect(isFinalizingOnly(['Read', 'TodoWrite'])).toBe(false);
  });

  it('白名单初始只含 TodoWrite', () => {
    expect(FINALIZING_TOOLS.has('TodoWrite')).toBe(true);
    expect(FINALIZING_TOOLS.has('Read')).toBe(false);
    expect(FINALIZING_TOOLS.size).toBe(1);
  });
});
