/**
 * 进度查看 HTTP 服务
 * 为飞书进度卡片的"查看详情"按钮提供局域网可访问的页面
 *
 * 持久化：所有 session 的步骤都写入 SQLite (store/progress.db)，
 * 进程重启后链接仍可访问。
 */
import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

import { logger } from './logger.js';
import { STORE_DIR } from './config.js';
import { handleTaskBoardRequest } from './task-board.js';

export const PROGRESS_SERVER_PORT = parseInt(
  process.env.PROGRESS_SERVER_PORT || '3457',
  10,
);

interface ProgressStep {
  title: string;
  detail?: string;
  /** 步骤进入主进程的时间戳（毫秒） */
  ts?: number;
}

interface ProgressSession {
  steps: ProgressStep[];
  startTime: number;
  completed: boolean;
}

// ---- SQLite 持久化 ----

let db: Database.Database;

function initProgressDb(): void {
  const dbPath = path.join(STORE_DIR, 'progress.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS progress_sessions (
    id TEXT PRIMARY KEY,
    steps TEXT NOT NULL DEFAULT '[]',
    start_time INTEGER NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function dbGet(sessionId: string): ProgressSession | null {
  if (!db) initProgressDb();
  const row = db
    .prepare(
      'SELECT steps, start_time, completed FROM progress_sessions WHERE id = ?',
    )
    .get(sessionId) as
    | { steps: string; start_time: number; completed: number }
    | undefined;
  if (!row) return null;
  try {
    return {
      steps: JSON.parse(row.steps),
      startTime: row.start_time,
      completed: row.completed === 1,
    };
  } catch (err) {
    logger.warn({ err, sessionId }, 'progress DB: steps JSON 解析失败');
    return null;
  }
}

function dbUpsert(sessionId: string, session: ProgressSession): void {
  if (!db) initProgressDb();
  try {
    db.prepare(
      `INSERT INTO progress_sessions (id, steps, start_time, completed, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET steps=excluded.steps, completed=excluded.completed, updated_at=datetime('now')`,
    ).run(
      sessionId,
      JSON.stringify(session.steps),
      session.startTime,
      session.completed ? 1 : 0,
    );
  } catch (err) {
    logger.warn({ err, sessionId }, 'progress DB: 写入失败');
  }
}

function dbDelete(sessionId: string): void {
  if (!db) initProgressDb();
  db.prepare('DELETE FROM progress_sessions WHERE id = ?').run(sessionId);
}

// 内存缓存用于热路径（频繁 patch 时不必每次读 DB）
const sessions = new Map<string, ProgressSession>();
let server: http.Server | null = null;
let _lanIp = '127.0.0.1';

/** 获取第一个非 loopback IPv4 局域网地址 */
export function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

export function getProgressUrl(sessionId: string): string {
  return `http://${_lanIp}:${PROGRESS_SERVER_PORT}/p/${sessionId}`;
}

export function upsertSession(
  sessionId: string,
  steps: ProgressStep[],
  startTime: number,
): void {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.steps = [...steps];
  } else {
    sessions.set(sessionId, { steps: [...steps], startTime, completed: false });
  }
  // 持久化到 SQLite
  dbUpsert(sessionId, sessions.get(sessionId)!);
}

export function completeSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    s.completed = true;
    dbUpsert(sessionId, s);
  } else {
    // 内存没有但 DB 可能有（进程重启后）
    const fromDb = dbGet(sessionId);
    if (fromDb) {
      fromDb.completed = true;
      sessions.set(sessionId, fromDb);
      dbUpsert(sessionId, fromDb);
    }
  }
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
  dbDelete(sessionId);
}

/** @internal - exported for testing */
export function _getSessionForTest(
  sessionId: string,
): { steps: { title: string; detail?: string }[]; completed: boolean } | null {
  return sessions.get(sessionId) ?? null;
}

// ---- HTML 渲染 ----

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPage(session: ProgressSession): string {
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const timeStr =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
      : `${elapsed}s`;

  const stepsJson = JSON.stringify(session.steps);
  const completedJson = session.completed ? 'true' : 'false';

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>进度详情</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f2f2f7;color:#1c1c1e;min-height:100vh}
.header{background:#f7ac00;color:#fff;padding:16px 20px;position:sticky;top:0;z-index:10;transition:background .4s}
.header.done{background:#34c759}
.header h1{font-size:17px;font-weight:600;display:flex;align-items:center;gap:8px}
.header .meta{font-size:13px;opacity:.85;margin-top:3px}
.dot{width:8px;height:8px;border-radius:50%;background:#fff;opacity:.9;flex-shrink:0;animation:pulse 1.5s ease-in-out infinite}
.done .dot{animation:none}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.steps{padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.step{background:#fff;border-radius:10px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.07);animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.step-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.step-title{font-size:14px;line-height:1.4;flex:1}
.step-time{font-size:11px;color:#8e8e93;flex-shrink:0;font-variant-numeric:tabular-nums;padding-top:1px}
.step-detail{font-size:12px;color:#6c6c70;margin-top:6px;white-space:pre-wrap;word-break:break-all;border-top:1px solid #f2f2f7;padding-top:6px}
.empty{text-align:center;color:#8e8e93;padding:40px 0;font-size:14px}
</style>
</head>
<body>
<div class="header" id="hdr">
  <h1><span class="dot" id="dot"></span><span id="status">⏳ 思考中...</span></h1>
  <div class="meta" id="meta">${timeStr} · 0 个步骤</div>
</div>
<div class="steps" id="steps"><div class="empty" id="empty">暂无步骤记录</div></div>
<script>
const initSteps = ${stepsJson};
const initDone = ${completedJson};
let rendered = 0;
let completed = false;

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

function fmtTime(ts){
  if(!ts) return '';
  const d=new Date(ts);
  const p=n=>String(n).padStart(2,'0');
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}

function renderStep(s){
  const d=document.createElement('div');
  d.className='step';
  const t=fmtTime(s.ts);
  d.innerHTML='<div class="step-head"><div class="step-title">'+escHtml(s.title)+'</div>'
    +(t?'<div class="step-time">'+t+'</div>':'')+'</div>'
    +(s.detail?'<div class="step-detail">'+escHtml(s.detail)+'</div>':'');
  return d;
}

function applySteps(steps, done){
  const container=document.getElementById('steps');
  const empty=document.getElementById('empty');
  // 追加新步骤（不重建已有的）
  for(let i=rendered;i<steps.length;i++){
    if(empty){empty.remove()}
    container.appendChild(renderStep(steps[i]));
  }
  rendered=steps.length;
  // 更新 meta
  document.getElementById('meta').textContent='${timeStr} · '+steps.length+' 个步骤';
  // 更新状态
  if(done && !completed){
    completed=true;
    document.getElementById('status').textContent='✅ 已完成';
    document.getElementById('hdr').classList.add('done');
    document.getElementById('dot').style.animation='none';
  }
  // 自动滚动到底部（仅在接近底部时）
  const scrollBottom=document.documentElement.scrollHeight-window.innerHeight-window.scrollY;
  if(scrollBottom<80) window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'});
}

// 初始渲染
applySteps(initSteps, initDone);

// 轮询更新（完成后停止）
if(!initDone){
  const timer=setInterval(async()=>{
    try{
      const r=await fetch(location.href+'?json=1');
      if(!r.ok)return;
      const d=await r.json();
      applySteps(d.steps, d.completed);
      if(d.completed) clearInterval(timer);
    }catch(e){}
  },2000);
}
</script>
</body>
</html>`;
}

// ---- HTTP Server ----

export function startProgressServer(): void {
  if (server) return;
  initProgressDb();
  _lanIp = getLanIp();

  server = http.createServer((req, res) => {
    // 任务账本路由（/board、/api/board）优先拦截，未命中再走进度查看逻辑
    if (handleTaskBoardRequest(req, res)) return;

    const url = req.url ?? '';
    const isJson = url.includes('?json=1');
    const pathPart = url.split('?')[0];
    const match = pathPart.match(/^\/p\/([a-z0-9]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const session = sessions.get(match[1]) || dbGet(match[1]);
    if (!session) {
      if (isJson) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<html><body style="font-family:sans-serif;text-align:center;padding:60px;color:#666">该进度记录已过期或不存在</body></html>',
        );
      }
      return;
    }
    if (isJson) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({ steps: session.steps, completed: session.completed }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPage(session));
  });

  server.listen(PROGRESS_SERVER_PORT, '0.0.0.0', () => {
    logger.info(
      { ip: _lanIp, port: PROGRESS_SERVER_PORT },
      `进度查看服务已启动 http://${_lanIp}:${PROGRESS_SERVER_PORT}`,
    );
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port: PROGRESS_SERVER_PORT },
        '进度查看服务端口被占用，功能将不可用（按钮仍会显示但链接无法访问）',
      );
    } else {
      logger.error({ err }, '进度查看服务启动失败');
    }
    server = null;
  });
}

export function stopProgressServer(): void {
  server?.close();
  server = null;
}
