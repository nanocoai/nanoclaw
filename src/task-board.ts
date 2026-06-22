/**
 * 任务账本可视化后台（只读）
 *
 * 把 store/messages.db 里的 task_ledger_* 四张表（任务 / 执行清单 / 测试用例 / 过程事件）
 * 渲染成局域网可访问的 Web 页面，复用进度查看服务的 3457 端口。
 *
 * MVP 范围：纯只读可视化，不提供任何写入入口（任务录入由 agent 通过 MCP 工具完成）。
 * 风格：参考 Claude 官网（暖米白底 + 珊瑚橙点缀 + 衬线标题）。
 */
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';

import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

// ---- 只读 DB 连接 ----

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.join(STORE_DIR, 'messages.db');
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }
  return db;
}

// ---- 类型 ----

interface TaskRow {
  id: string;
  title: string;
  project: string;
  task_type: string;
  status: string;
  priority: string;
  description: string | null;
  desired_outcome: string | null;
  acceptance_criteria: string;
  owner_group: string;
  chat_jid: string | null;
  created_by: string | null;
  artifact_root: string | null;
  prd_path: string | null;
  spec_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ChecklistRow {
  id: string;
  title: string;
  status: string;
  position: number;
  notes: string | null;
}

interface TestCaseRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  evidence: string | null;
  position: number;
}

interface EventRow {
  event_type: string;
  summary: string;
  details: string | null;
  actor_group: string | null;
  actor_sender: string | null;
  created_at: string;
}

// ---- 状态机定义 ----

const STAGE_ORDER = [
  'draft',
  'draft_prd',
  'effect_locked',
  'e2e_defined',
  'tests_planned',
  'implementing',
  'verifying',
  'done',
] as const;

const STAGE_LABEL: Record<string, string> = {
  draft: '草稿',
  draft_prd: 'PRD',
  effect_locked: '锁效果',
  e2e_defined: '定E2E',
  tests_planned: '排测试',
  implementing: '实现',
  verifying: '验证',
  done: '完成',
};

// 旁路状态（不在主线顺序内）→ 中文标签
const STATUS_LABEL: Record<string, string> = {
  ...STAGE_LABEL,
  ready: '就绪',
  in_progress: '进行中',
  blocked: '阻塞',
  review: '评审',
  testing: '测试中',
  cancelled: '已取消',
};

const TYPE_LABEL: Record<string, string> = {
  bug: 'Bug',
  feature: '功能',
  refactor: '重构',
  review: '评审',
  e2e: 'E2E',
  research: '研究',
  ops: '运维',
  other: '其他',
};

const CHECKLIST_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  done: '完成',
  blocked: '阻塞',
  skipped: '跳过',
};

const TESTCASE_LABEL: Record<string, string> = {
  pending: '待测',
  passed: '通过',
  failed: '失败',
  blocked: '阻塞',
  skipped: '跳过',
};

function statusLabel(s: string): string {
  return STATUS_LABEL[s] ?? s;
}

/** 状态对应的徽章配色类名（CSS class 后缀） */
function statusTone(s: string): string {
  if (s === 'done') return 'done';
  if (s === 'blocked' || s === 'cancelled') return 'warn';
  if (
    STAGE_ORDER.includes(s as never) ||
    s === 'in_progress' ||
    s === 'review' ||
    s === 'testing'
  )
    return 'active';
  return 'idle';
}

// ---- 数据查询 ----

interface TaskListItem extends TaskRow {
  checklist_done: number;
  checklist_total: number;
  test_passed: number;
  test_total: number;
}

function queryTasks(project?: string, status?: string): TaskListItem[] {
  const d = getDb();
  const where: string[] = [];
  const args: string[] = [];
  if (project && project !== 'all') {
    where.push('project = ?');
    args.push(project);
  }
  if (status && status !== 'all') {
    where.push('status = ?');
    args.push(status);
  }
  const sql =
    'SELECT * FROM task_ledger_tasks' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY updated_at DESC';
  const tasks = d.prepare(sql).all(...args) as TaskRow[];

  // 一次性聚合子表统计，避免 N+1
  const clStats = d
    .prepare(
      `SELECT task_id, SUM(status='done') AS done, COUNT(*) AS total
       FROM task_ledger_checklist GROUP BY task_id`,
    )
    .all() as { task_id: string; done: number; total: number }[];
  const tcStats = d
    .prepare(
      `SELECT task_id, SUM(status='passed') AS passed, COUNT(*) AS total
       FROM task_ledger_test_cases GROUP BY task_id`,
    )
    .all() as { task_id: string; passed: number; total: number }[];
  const clMap = new Map(clStats.map((r) => [r.task_id, r]));
  const tcMap = new Map(tcStats.map((r) => [r.task_id, r]));

  return tasks.map((t) => ({
    ...t,
    checklist_done: clMap.get(t.id)?.done ?? 0,
    checklist_total: clMap.get(t.id)?.total ?? 0,
    test_passed: tcMap.get(t.id)?.passed ?? 0,
    test_total: tcMap.get(t.id)?.total ?? 0,
  }));
}

function queryProjects(): string[] {
  const d = getDb();
  const rows = d
    .prepare('SELECT DISTINCT project FROM task_ledger_tasks ORDER BY project')
    .all() as { project: string }[];
  return rows.map((r) => r.project);
}

interface TaskDetail {
  task: TaskRow;
  checklist: ChecklistRow[];
  testCases: TestCaseRow[];
  events: EventRow[];
}

function queryTaskDetail(id: string): TaskDetail | null {
  const d = getDb();
  const task = d
    .prepare('SELECT * FROM task_ledger_tasks WHERE id = ?')
    .get(id) as TaskRow | undefined;
  if (!task) return null;
  const checklist = d
    .prepare(
      'SELECT id,title,status,position,notes FROM task_ledger_checklist WHERE task_id = ? ORDER BY position, created_at',
    )
    .all(id) as ChecklistRow[];
  const testCases = d
    .prepare(
      'SELECT id,title,description,status,evidence,position FROM task_ledger_test_cases WHERE task_id = ? ORDER BY position, created_at',
    )
    .all(id) as TestCaseRow[];
  const events = d
    .prepare(
      'SELECT event_type,summary,details,actor_group,actor_sender,created_at FROM task_ledger_events WHERE task_id = ? ORDER BY created_at',
    )
    .all(id) as EventRow[];
  return { task, checklist, testCases, events };
}

// ---- HTML 工具 ----

function escHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseCriteria(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// Claude 官网风格的公共样式
const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  background:#f5f4ef;color:#1f1e1c;line-height:1.55;-webkit-font-smoothing:antialiased}
.serif{font-family:'Georgia','Times New Roman',ui-serif,serif}
a{color:inherit;text-decoration:none}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
.topbar{display:flex;align-items:baseline;gap:12px;margin-bottom:8px}
.topbar h1{font-size:26px;font-weight:600;letter-spacing:-.01em}
.topbar .sub{font-size:13px;color:#8a857c}
.accent{color:#cc6b4f}
.badge{display:inline-flex;align-items:center;font-size:12px;padding:2px 9px;border-radius:20px;font-weight:500;white-space:nowrap}
.badge.done{background:#e3efe4;color:#3f7d4a}
.badge.warn{background:#f7e3da;color:#bf5536}
.badge.active{background:#fbeee4;color:#cc6b4f}
.badge.idle{background:#eceae3;color:#8a857c}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:5px;background:#eceae3;color:#6b665e}
`;

// ---- 列表页 ----

function renderListPage(project: string, status: string): string {
  const tasks = queryTasks(project, status);
  const projects = queryProjects();
  const allStatuses = [
    'all',
    ...STAGE_ORDER,
    'in_progress',
    'blocked',
    'review',
    'testing',
    'cancelled',
  ];

  const projOpts = ['all', ...projects]
    .map(
      (p) =>
        `<option value="${escHtml(p)}"${p === project ? ' selected' : ''}>${p === 'all' ? '全部项目' : escHtml(p)}</option>`,
    )
    .join('');

  const statusTabs = allStatuses
    .map((s) => {
      const label = s === 'all' ? '全部' : statusLabel(s);
      const active = s === status ? ' tab-on' : '';
      return `<a class="tab${active}" href="/board?project=${encodeURIComponent(project)}&status=${encodeURIComponent(s)}">${escHtml(label)}</a>`;
    })
    .join('');

  const cards = tasks.length
    ? tasks
        .map((t) => {
          const cl = t.checklist_total
            ? `清单 ${t.checklist_done}/${t.checklist_total}`
            : '';
          const tc = t.test_total
            ? `用例 ${t.test_passed}/${t.test_total}`
            : '';
          const stats = [cl, tc].filter(Boolean).join(' · ');
          return `<a class="card" href="/board/task/${encodeURIComponent(t.id)}">
  <div class="card-top">
    <span class="card-title">${escHtml(t.title)}</span>
    <span class="badge ${statusTone(t.status)}">${escHtml(statusLabel(t.status))}</span>
  </div>
  <div class="card-meta">
    <span class="tag">${escHtml(t.project)}</span>
    <span class="tag">${escHtml(TYPE_LABEL[t.task_type] ?? t.task_type)}</span>
    ${t.priority && t.priority !== 'normal' ? `<span class="tag">${escHtml(t.priority)}</span>` : ''}
    ${stats ? `<span class="card-stats">${escHtml(stats)}</span>` : ''}
    <span class="card-time">${escHtml(fmtTime(t.updated_at))}</span>
  </div>
</a>`;
        })
        .join('')
    : '<div class="empty">当前筛选条件下暂无任务</div>';

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务账本</title>
<style>${BASE_CSS}
.filters{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0 14px}
select{font-size:13px;padding:6px 10px;border:1px solid #ddd9d0;border-radius:8px;background:#fff;color:#1f1e1c}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}
.tab{font-size:12px;padding:5px 12px;border-radius:18px;background:#eceae3;color:#6b665e;transition:.15s}
.tab:hover{background:#e0ddd4}
.tab-on{background:#cc6b4f;color:#fff}
.card{display:block;background:#fff;border:1px solid #eae7df;border-radius:12px;padding:16px 18px;margin-bottom:10px;transition:.15s}
.card:hover{border-color:#cc6b4f;box-shadow:0 2px 12px rgba(204,107,79,.08);transform:translateY(-1px)}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.card-title{font-size:15.5px;font-weight:600}
.card-meta{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;font-size:12px;color:#8a857c}
.card-stats{color:#cc6b4f;font-weight:500}
.card-time{margin-left:auto;font-variant-numeric:tabular-nums}
.empty{text-align:center;color:#8a857c;padding:60px 0;font-size:14px}
.count{font-size:13px;color:#8a857c;margin-left:4px}
</style></head>
<body><div class="wrap">
<div class="topbar">
  <h1 class="serif">任务<span class="accent">账本</span></h1>
  <span class="sub">PRD · 验收 · E2E · Bug · 过程证据</span>
</div>
<div class="filters">
  <form method="get" action="/board" id="pf">
    <input type="hidden" name="status" value="${escHtml(status)}">
    <select name="project" onchange="document.getElementById('pf').submit()">${projOpts}</select>
  </form>
  <span class="count">${tasks.length} 个任务</span>
</div>
<div class="tabs">${statusTabs}</div>
${cards}
</div></body></html>`;
}

// ---- 详情页 ----

function renderProgressBar(status: string): string {
  const idx = STAGE_ORDER.indexOf(status as never);
  const isBypass = idx === -1;
  const nodes = STAGE_ORDER.map((stage, i) => {
    let cls = 'pnode';
    if (!isBypass) {
      if (i < idx) cls += ' pdone';
      else if (i === idx) cls += ' pcur';
    }
    return `<div class="${cls}"><span class="pdot"></span><span class="plabel">${STAGE_LABEL[stage]}</span></div>`;
  }).join('<div class="pline"></div>');

  const bypassNote = isBypass
    ? `<div class="bypass">当前状态：<span class="badge ${statusTone(status)}">${escHtml(statusLabel(status))}</span>（不在主线流程上）</div>`
    : '';
  return `<div class="progress">${nodes}</div>${bypassNote}`;
}

function renderDetailPage(detail: TaskDetail): string {
  const { task, checklist, testCases, events } = detail;
  const criteria = parseCriteria(task.acceptance_criteria);

  const overview = `
<section class="block">
  <h2>概览</h2>
  <div class="kv"><span class="k">目标效果</span><span class="v">${task.desired_outcome ? escHtml(task.desired_outcome) : '<i>未填写</i>'}</span></div>
  <div class="kv"><span class="k">描述</span><span class="v">${task.description ? escHtml(task.description) : '<i>未填写</i>'}</span></div>
  <div class="kv"><span class="k">所属群</span><span class="v mono">${escHtml(task.owner_group)}</span></div>
  <div class="kv"><span class="k">创建 / 更新</span><span class="v">${escHtml(fmtTime(task.created_at))} → ${escHtml(fmtTime(task.updated_at))}</span></div>
  ${task.completed_at ? `<div class="kv"><span class="k">完成于</span><span class="v">${escHtml(fmtTime(task.completed_at))}</span></div>` : ''}
</section>`;

  const timeline = events.length
    ? `<section class="block"><h2>过程时间线 <span class="cnt">${events.length}</span></h2>
<div class="timeline">${events
        .map(
          (e) => `<div class="tl-item">
  <div class="tl-dot"></div>
  <div class="tl-body">
    <div class="tl-head"><span class="tl-type">${escHtml(e.event_type)}</span><span class="tl-time">${escHtml(fmtTime(e.created_at))}</span></div>
    <div class="tl-summary">${escHtml(e.summary)}</div>
    ${e.details ? `<div class="tl-details">${escHtml(e.details)}</div>` : ''}
    ${e.actor_sender || e.actor_group ? `<div class="tl-actor">${escHtml(e.actor_sender || e.actor_group || '')}</div>` : ''}
  </div>
</div>`,
        )
        .join('')}</div></section>`
    : '';

  const criteriaBlock = criteria.length
    ? `<section class="block"><h2>验收标准 <span class="cnt">${criteria.length}</span></h2>
<ul class="crit">${criteria.map((c) => `<li>${escHtml(c)}</li>`).join('')}</ul></section>`
    : '';

  const testBlock = testCases.length
    ? `<section class="block"><h2>E2E / 验收用例 <span class="cnt">${testCases.length}</span></h2>
<div class="cases">${testCases
        .map(
          (tc) => `<div class="case">
  <div class="case-head"><span class="case-title">${escHtml(tc.title)}</span><span class="badge ${tc.status === 'passed' ? 'done' : tc.status === 'failed' ? 'warn' : 'idle'}">${escHtml(TESTCASE_LABEL[tc.status] ?? tc.status)}</span></div>
  ${tc.description ? `<div class="case-desc">${escHtml(tc.description)}</div>` : ''}
  ${tc.evidence ? `<div class="case-evi">证据：${escHtml(tc.evidence)}</div>` : ''}
</div>`,
        )
        .join('')}</div></section>`
    : '';

  const checklistBlock = checklist.length
    ? `<section class="block"><h2>执行清单 <span class="cnt">${checklist.filter((c) => c.status === 'done').length}/${checklist.length}</span></h2>
<ul class="cklist">${checklist
        .map(
          (
            c,
          ) => `<li class="ck ck-${escHtml(c.status)}"><span class="ck-mark">${c.status === 'done' ? '✓' : c.status === 'blocked' ? '!' : c.status === 'skipped' ? '–' : '○'}</span>
  <span class="ck-title">${escHtml(c.title)}</span>
  <span class="tag">${escHtml(CHECKLIST_LABEL[c.status] ?? c.status)}</span>
  ${c.notes ? `<span class="ck-notes">${escHtml(c.notes)}</span>` : ''}</li>`,
        )
        .join('')}</ul></section>`
    : '';

  const artifacts: string[] = [];
  if (task.prd_path)
    artifacts.push(
      `<div class="kv"><span class="k">PRD</span><span class="v mono">${escHtml(task.prd_path)}</span></div>`,
    );
  if (task.spec_path)
    artifacts.push(
      `<div class="kv"><span class="k">Spec</span><span class="v mono">${escHtml(task.spec_path)}</span></div>`,
    );
  if (task.artifact_root)
    artifacts.push(
      `<div class="kv"><span class="k">产物目录</span><span class="v mono">${escHtml(task.artifact_root)}</span></div>`,
    );
  const artifactBlock = artifacts.length
    ? `<section class="block"><h2>产物 / 证据</h2>${artifacts.join('')}</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(task.title)} · 任务账本</title>
<style>${BASE_CSS}
.back{font-size:13px;color:#8a857c;display:inline-block;margin-bottom:14px}
.back:hover{color:#cc6b4f}
.head h1{font-size:23px;font-weight:600;letter-spacing:-.01em;margin-bottom:8px}
.head-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:22px}
.progress{display:flex;align-items:center;background:#fff;border:1px solid #eae7df;border-radius:12px;padding:18px 16px;overflow-x:auto}
.pnode{display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0;min-width:54px}
.pdot{width:14px;height:14px;border-radius:50%;background:#dcd8cf;border:2px solid #dcd8cf}
.plabel{font-size:11px;color:#a8a298;white-space:nowrap}
.pline{flex:1;height:2px;background:#e6e2d9;min-width:18px}
.pnode.pdone .pdot{background:#9cc6a3;border-color:#9cc6a3}
.pnode.pdone .plabel{color:#6b665e}
.pnode.pcur .pdot{background:#cc6b4f;border-color:#cc6b4f;box-shadow:0 0 0 4px rgba(204,107,79,.18)}
.pnode.pcur .plabel{color:#cc6b4f;font-weight:600}
.bypass{margin-top:12px;font-size:13px;color:#6b665e}
.block{background:#fff;border:1px solid #eae7df;border-radius:12px;padding:18px 20px;margin-top:16px}
.block h2{font-size:15px;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.cnt{font-size:12px;color:#cc6b4f;font-weight:500}
.kv{display:flex;gap:14px;padding:7px 0;border-top:1px solid #f2f0ea;font-size:13.5px}
.kv:first-of-type{border-top:none}
.kv .k{flex-shrink:0;width:96px;color:#8a857c}
.kv .v{flex:1;white-space:pre-wrap;word-break:break-word}
.kv .v i{color:#b8b2a8}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#6b665e}
.crit{list-style:none}
.crit li{padding:8px 0 8px 22px;position:relative;border-top:1px solid #f2f0ea;font-size:13.5px}
.crit li:first-child{border-top:none}
.crit li:before{content:'◆';position:absolute;left:2px;color:#cc6b4f;font-size:11px;top:9px}
.timeline{position:relative;padding-left:18px}
.tl-item{position:relative;padding:0 0 18px 18px;border-left:2px solid #eee9df}
.tl-item:last-child{border-left-color:transparent;padding-bottom:0}
.tl-dot{position:absolute;left:-7px;top:3px;width:12px;height:12px;border-radius:50%;background:#cc6b4f;border:2px solid #fff;box-shadow:0 0 0 1px #eae7df}
.tl-head{display:flex;gap:10px;align-items:baseline}
.tl-type{font-size:12px;font-weight:600;color:#cc6b4f;background:#fbeee4;padding:1px 8px;border-radius:5px}
.tl-time{font-size:11px;color:#a8a298;font-variant-numeric:tabular-nums}
.tl-summary{font-size:13.5px;margin-top:5px}
.tl-details{font-size:12.5px;color:#6b665e;margin-top:4px;white-space:pre-wrap;word-break:break-word;background:#faf9f5;border-radius:6px;padding:7px 9px}
.tl-actor{font-size:11px;color:#a8a298;margin-top:4px}
.cases .case{border-top:1px solid #f2f0ea;padding:11px 0}
.cases .case:first-child{border-top:none}
.case-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.case-title{font-size:13.5px;font-weight:500}
.case-desc{font-size:12.5px;color:#6b665e;margin-top:4px}
.case-evi{font-size:12px;color:#3f7d4a;margin-top:4px}
.cklist{list-style:none}
.ck{display:flex;align-items:center;gap:9px;padding:7px 0;border-top:1px solid #f2f0ea;font-size:13.5px}
.ck:first-child{border-top:none}
.ck-mark{width:18px;text-align:center;color:#a8a298;font-weight:600}
.ck-done .ck-mark{color:#3f7d4a}
.ck-blocked .ck-mark{color:#bf5536}
.ck-done .ck-title{color:#8a857c}
.ck-title{flex:1}
.ck-notes{font-size:12px;color:#a8a298}
</style></head>
<body><div class="wrap">
<a class="back" href="/board">← 返回任务列表</a>
<div class="head">
  <h1 class="serif">${escHtml(task.title)}</h1>
  <div class="head-meta">
    <span class="badge ${statusTone(task.status)}">${escHtml(statusLabel(task.status))}</span>
    <span class="tag">${escHtml(task.project)}</span>
    <span class="tag">${escHtml(TYPE_LABEL[task.task_type] ?? task.task_type)}</span>
    ${task.priority && task.priority !== 'normal' ? `<span class="tag">${escHtml(task.priority)}</span>` : ''}
  </div>
</div>
${renderProgressBar(task.status)}
${overview}
${timeline}
${criteriaBlock}
${testBlock}
${checklistBlock}
${artifactBlock}
</div></body></html>`;
}

// ---- 路由分发 ----

/**
 * 处理任务账本相关请求。命中返回 true（已写响应），未命中返回 false（交回原 server 逻辑）。
 */
export function handleTaskBoardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const rawUrl = req.url ?? '';
  const u = new URL(rawUrl, 'http://localhost');
  const pathname = u.pathname;

  // 列表页
  if (pathname === '/board') {
    const project = u.searchParams.get('project') || 'all';
    const status = u.searchParams.get('status') || 'all';
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderListPage(project, status));
    } catch (err) {
      logger.error({ err }, '任务账本列表页渲染失败');
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('任务账本读取失败');
    }
    return true;
  }

  // 详情页
  const detailMatch = pathname.match(/^\/board\/task\/([\w-]+)$/);
  if (detailMatch) {
    try {
      const detail = queryTaskDetail(detailMatch[1]);
      if (!detail) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<div style="font-family:sans-serif;text-align:center;padding:60px;color:#8a857c">任务不存在</div>',
        );
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDetailPage(detail));
    } catch (err) {
      logger.error({ err }, '任务账本详情页渲染失败');
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('任务账本读取失败');
    }
    return true;
  }

  // JSON API：列表
  if (pathname === '/api/board/tasks') {
    const project = u.searchParams.get('project') || 'all';
    const status = u.searchParams.get('status') || 'all';
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(queryTasks(project, status)));
    return true;
  }

  // JSON API：详情
  const apiDetail = pathname.match(/^\/api\/board\/tasks\/([\w-]+)$/);
  if (apiDetail) {
    const detail = queryTaskDetail(apiDetail[1]);
    if (!detail) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(detail));
    return true;
  }

  return false;
}
