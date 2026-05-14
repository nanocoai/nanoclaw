#!/usr/bin/env node
/**
 * NanoClaw 日志查询工具
 * 解析 nanoclaw.log (ndjson) 并按条件过滤
 * 零依赖，纯 Node.js
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const LOG_DIR = '/Users/dajay/AI_Workspace/nanoclaw/logs';
const GROUPS_DIR = '/Users/dajay/AI_Workspace/nanoclaw/groups';

const LEVEL_NUM = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

// ── ANSI 颜色 ────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
};

// ── 参数解析 ──────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  since: '',
  until: '',
  group: '',
  level: '',
  grep: '',
  trace: '',
  last: 50,
  all: false,
  raw: false,
  count: false,
  stats: false,
  agentLogs: '',
};

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--since':   opts.since = args[++i]; break;
    case '--until':   opts.until = args[++i]; break;
    case '--group':   opts.group = args[++i]; break;
    case '--level':   opts.level = args[++i]; break;
    case '--grep':    opts.grep = args[++i]; break;
    case '--trace':   opts.trace = args[++i]; break;
    case '--last':    opts.last = parseInt(args[++i], 10) || 50; break;
    case '--all':     opts.all = true; break;
    case '--raw':     opts.raw = true; break;
    case '--count':   opts.count = true; break;
    case '--stats':   opts.stats = true; break;
    case '--agent-logs': opts.agentLogs = args[++i]; break;
    case '-h': case '--help':
      console.log(`用法: node query.js [选项]

选项:
  --since <time>     时间窗口起点 (ISO 8601 或 "5min", "1h", "2d")
  --until <time>     时间窗口终点
  --group <name>     按 groupFolder 过滤
  --level <level>    最低日志级别 (debug/info/warn/error/fatal)
  --grep <pattern>   msg 字段正则匹配
  --trace <id>       按 traceId 过滤
  --last <n>         输出最后 N 条 (默认 50)
  --all              包含所有轮转归档
  --raw              输出原始 JSON
  --count            只输出匹配条数
  --stats            按级别统计
  --agent-logs <grp> 查看 agent 运行日志`);
      process.exit(0);
  }
}

// ── 时间解析 ──────────────────────────────────────────────
function parseTime(input) {
  if (!input) return null;

  // ISO 格式直接解析
  if (/^\d{4}-\d{2}-\d{2}T/.test(input)) {
    return new Date(input);
  }

  // 短格式相对时间: "5min", "1h", "2d", "30s"
  const shortMatch = input.match(/^(\d+)\s*(s|sec|min|m|h|hr|d|day)s?$/i);
  if (shortMatch) {
    const num = parseInt(shortMatch[1], 10);
    const unit = shortMatch[2].toLowerCase();
    const ms = { s: 1000, sec: 1000, min: 60000, m: 60000, h: 3600000, hr: 3600000, d: 86400000, day: 86400000 };
    return new Date(Date.now() - num * (ms[unit] || 60000));
  }

  // "N minutes/hours/days ago"
  const agoMatch = input.match(/(\d+)\s*(minute|min|hour|hr|day|second|sec)s?\s*ago/i);
  if (agoMatch) {
    const num = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].toLowerCase();
    const ms = { minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, second: 1000, sec: 1000 };
    return new Date(Date.now() - num * (ms[unit] || 60000));
  }

  // 兜底尝试
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

const sinceTime = parseTime(opts.since);
const untilTime = parseTime(opts.until);

// ── Agent 运行日志模式 ────────────────────────────────────
if (opts.agentLogs) {
  const logDir = path.join(GROUPS_DIR, opts.agentLogs, 'logs');
  if (!fs.existsSync(logDir)) {
    console.error(`错误: 目录不存在 ${logDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(logDir)
    .filter(f => f.startsWith('agent-') && f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, opts.last);

  console.log(`=== Agent 运行日志: ${opts.agentLogs} (最近 ${files.length} 条) ===\n`);

  for (const f of files) {
    const content = fs.readFileSync(path.join(logDir, f), 'utf8').slice(0, 500);
    const duration = content.match(/Duration:\s*(\S+)/)?.[1] || '?';
    const exitCode = content.match(/Exit Code:\s*(\S+)/)?.[1] || '?';
    const status = exitCode === '0' ? `${C.green}✓${C.reset}` : `${C.red}✗ (exit=${exitCode})${C.reset}`;
    console.log(`  ${f}  ${duration}  ${status}`);
  }
  process.exit(0);
}

// ── 构建文件列表 ──────────────────────────────────────────
const files = [path.join(LOG_DIR, 'nanoclaw.log')];
if (opts.all) {
  for (let i = 1; i <= 10; i++) {
    const f = path.join(LOG_DIR, `nanoclaw.log.${i}`);
    if (fs.existsSync(f)) files.push(f);
  }
}

const existingFiles = files.filter(f => fs.existsSync(f));
if (existingFiles.length === 0) {
  console.error('错误: 未找到日志文件');
  process.exit(1);
}

// ── 过滤函数 ──────────────────────────────────────────────
const minLevel = LEVEL_NUM[opts.level] || 0;
const grepRe = opts.grep ? new RegExp(opts.grep, 'i') : null;

function matchEntry(entry) {
  // 级别过滤
  if (minLevel > 0) {
    const entryLevel = typeof entry.level === 'number' ? entry.level : (LEVEL_NUM[entry.level] || 0);
    if (entryLevel < minLevel) return false;
  }

  // 时间过滤
  if (sinceTime && entry.time < sinceTime.toISOString()) return false;
  if (untilTime && entry.time >= untilTime.toISOString()) return false;

  // 群组过滤
  if (opts.group && entry.groupFolder) {
    if (entry.groupFolder !== opts.group && !entry.groupFolder.includes(opts.group)) return false;
  } else if (opts.group && !entry.groupFolder) {
    return false;
  }

  // traceId 过滤
  if (opts.trace && entry.traceId !== opts.trace) return false;

  // msg 正则
  if (grepRe && !grepRe.test(String(entry.msg || ''))) return false;

  return true;
}

// ── 格式化输出 ────────────────────────────────────────────
function formatEntry(entry) {
  if (opts.raw) return JSON.stringify(entry);

  const time = (entry.time || '').slice(11, 19);
  const level = entry.level || '?';
  const trace = (entry.traceId || '-').slice(0, 8);
  const group = entry.groupFolder || '-';
  const msg = entry.msg || '';

  let levelStr;
  if (level === 'error' || level === 'fatal') {
    levelStr = `${C.red}${level}${C.reset}`;
  } else if (level === 'warn') {
    levelStr = `${C.yellow}${level}${C.reset}`;
  } else if (level === 'debug') {
    levelStr = `${C.gray}${level}${C.reset}`;
  } else {
    levelStr = `${C.green}${level}${C.reset}`;
  }

  return `${C.gray}${time}${C.reset} [${levelStr}] ${C.cyan}${trace}${C.reset} ${group} | ${msg}`;
}

// ── 主逻辑：流式读取 ─────────────────────────────────────
async function main() {
  // 归档文件倒序（旧→新），当前文件最后
  const sortedFiles = [...existingFiles].reverse();

  const results = [];
  const stats = { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 };
  let totalMatched = 0;

  for (const filePath of sortedFiles) {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!matchEntry(entry)) continue;

      totalMatched++;

      if (opts.stats) {
        const lvl = typeof entry.level === 'string' ? entry.level : 'info';
        stats[lvl] = (stats[lvl] || 0) + 1;
        continue;
      }

      if (opts.count) continue;

      // 保留最新的 N 条（ring buffer）
      results.push(entry);
      if (results.length > opts.last * 2) {
        // 定期裁剪，避免内存爆炸
        results.splice(0, results.length - opts.last);
      }
    }
  }

  // 输出
  if (opts.stats) {
    console.log('=== 日志级别统计 ===');
    if (sinceTime) console.log(`时间范围: ${sinceTime.toISOString()} 起`);
    if (untilTime) console.log(`         至 ${untilTime.toISOString()}`);
    if (opts.group) console.log(`群组: ${opts.group}`);
    console.log('');
    for (const [lvl, count] of Object.entries(stats)) {
      if (count > 0) {
        console.log(`  ${lvl.padEnd(8)} ${count}`);
      }
    }
    console.log(`\n  总计: ${totalMatched} 条`);
    return;
  }

  if (opts.count) {
    console.log(totalMatched);
    return;
  }

  // 取最后 N 条
  const output = results.slice(-opts.last);
  for (const entry of output) {
    console.log(formatEntry(entry));
  }

  if (output.length === 0) {
    console.log('（无匹配结果）');
  }
}

main().catch(err => {
  console.error('查询出错:', err.message);
  process.exit(1);
});
