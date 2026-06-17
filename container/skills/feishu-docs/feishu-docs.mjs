#!/usr/bin/env node
/**
 * 飞书文档 CLI 工具 — 容器内使用
 *
 * 通过 IPC 向宿主按需获取飞书 token（自动刷新，不依赖启动时注入）
 *
 * 命令:
 *   feishu-docs read <url_or_id>           读取文档内容（返回 markdown）
 *   feishu-docs create <title> [content]   创建文档（content 可从 stdin 读取）
 *   feishu-docs upload <file_path> [--folder name]  上传文件到用户云盘（可指定目录）
 *   feishu-docs search <query>             搜索文档
 */

import _fs from 'fs';
import _path from 'path';
import _crypto from 'crypto';
import _os from 'os';
import { spawnSync } from 'child_process';

const API_BASE = 'https://open.feishu.cn/open-apis';

const AUTH_EXPIRED_CODES = new Set([99991668, 99991672]);

const KNOWN_FOLDER_TOKENS = {
  nanoclaw: 'VRDBfRD3FlkA90d3or8cnkCHnhd',
};

function runLarkCli(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const result = spawnSync('lark-cli', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LARK_CLI_NO_PROXY: '1',
    },
  });

  if (result.error) {
    console.error(`lark-cli 执行失败: ${result.error.message}`);
    process.exit(1);
  }
  const stdout = (result.stdout || '').trim();
  let parsed = {};
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }
  }

  if (result.status !== 0) {
    if (opts.allowFailure) {
      return {
        ...parsed,
        ok: parsed.ok ?? false,
        status: result.status,
        stderr: result.stderr || '',
      };
    }
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }

  if (!stdout) return {};
  return parsed;
}

function withTempMarkdown(content, fn) {
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'feishu-docs-'));
  const file = _path.join(dir, 'content.md');
  _fs.writeFileSync(file, content || '', 'utf8');
  try {
    return fn(dir, 'content.md');
  } finally {
    try { _fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
  }
}

function withTempFile(filePath, fn) {
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'feishu-docs-'));
  const safeName = _path.basename(filePath);
  const target = _path.join(dir, safeName);
  _fs.copyFileSync(filePath, target);
  try {
    return fn(dir, safeName);
  } finally {
    try { _fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore cleanup */ }
  }
}

function larkDocUrl(doc) {
  return doc?.url || (doc?.document_id ? `https://poizon.feishu.cn/docx/${doc.document_id}` : '');
}

// ---- IPC token 获取 ----

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '';
const CHAT_JID = process.env.NANOCLAW_CHAT_JID || '';
const SENDER_ID = process.env.NANOCLAW_SENDER_ID || '';

let _cachedToken = null;

/** 通过 IPC 向宿主请求新鲜的飞书 token */
async function requestTokenViaIpc() {
  if (!IPC_DIR) return null;

  const tasksDir = _path.join(IPC_DIR, 'tasks');
  const responsesDir = _path.join(IPC_DIR, 'responses');
  _fs.mkdirSync(tasksDir, { recursive: true });
  _fs.mkdirSync(responsesDir, { recursive: true });

  const requestId = _crypto.randomUUID();
  const payload = {
    type: 'get_feishu_token',
    requestId,
    chatJid: CHAT_JID,
    senderId: SENDER_ID,
    timestamp: new Date().toISOString(),
  };

  // 原子写入请求
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = _path.join(tasksDir, filename);
  const tempPath = `${filepath}.tmp`;
  _fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  _fs.renameSync(tempPath, filepath);

  // 轮询等待响应（最多 15s）
  const responsePath = _path.join(responsesDir, `${requestId}.json`);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (_fs.existsSync(responsePath)) {
      const data = JSON.parse(_fs.readFileSync(responsePath, 'utf-8'));
      try { _fs.unlinkSync(responsePath); } catch { /* 已被清理 */ }
      if (data.error) console.error('IPC token:', data.error);
      return data.token || null;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function getToken() {
  if (_cachedToken) return _cachedToken;

  // 通过 IPC 向宿主请求（宿主自动刷新，永远拿到最新 token）
  const ipcToken = await requestTokenViaIpc();
  if (ipcToken) {
    _cachedToken = ipcToken;
    return ipcToken;
  }

  return null;
}

function authRequiredExit(reason) {
  console.error(`FEISHU_AUTH_REQUIRED: ${reason}`);
  console.error('请使用 send_message 工具发送以下内容请求用户授权：');
  console.error('{"type":"feishu_auth_request"}');
  console.error('发送后告知用户点击授权卡片完成授权。授权完成后可重试操作。');
  process.exit(2);
}

async function api(method, path, body) {
  const token = await getToken();
  if (!token) {
    authRequiredExit('飞书文档工具需要用户授权才能使用');
  }
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const data = await resp.json();
  if (AUTH_EXPIRED_CODES.has(data.code)) {
    // token 过期 — 清缓存重试一次
    _cachedToken = null;
    const freshToken = await getToken();
    if (freshToken && freshToken !== token) {
      const retryOpts = { ...opts, headers: { ...opts.headers, 'Authorization': `Bearer ${freshToken}` } };
      const retryResp = await fetch(url, retryOpts);
      const retryData = await retryResp.json();
      if (!AUTH_EXPIRED_CODES.has(retryData.code)) return retryData;
    }
    authRequiredExit('飞书 token 已过期或权限不足');
  }
  return data;
}

// ---- URL 解析 ----

function parseFeishuUrl(input) {
  // 支持: https://xxx.feishu.cn/docx/TOKEN, /wiki/TOKEN, /file/TOKEN, /sheets/TOKEN 或直接 TOKEN
  const docxMatch = input.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch) return { type: 'docx', token: docxMatch[1] };

  const wikiMatch = input.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) return { type: 'wiki', token: wikiMatch[1] };

  const fileMatch = input.match(/\/file\/([A-Za-z0-9]+)/);
  if (fileMatch) return { type: 'file', token: fileMatch[1] };

  const sheetMatch = input.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheetMatch) return { type: 'sheet', token: sheetMatch[1] };

  // 纯 token（无 URL 前缀）
  if (/^[A-Za-z0-9]{20,}$/.test(input)) return { type: 'docx', token: input };

  return null;
}

// ---- 读取文档 ----

async function readDoc(urlOrId) {
  const result = runLarkCli([
    'docs', '+fetch',
    '--api-version', 'v2',
    '--as', 'user',
    '--doc', urlOrId,
    '--format', 'json',
  ]);
  const doc = result?.data?.document || {};
  console.log(doc.content || JSON.stringify(result, null, 2));
}

function blocksToMarkdown(blocks) {
  const lines = [];
  for (const block of blocks) {
    const type = block.block_type;
    // 1=page, 2=text, 3=heading1, 4=heading2, 5=heading3,
    // 6=heading4, 7=heading5, 8=heading6, 9=heading7, 10=heading8, 11=heading9
    // 12=bullet, 13=ordered, 14=code, 15=quote, 17=todo, 22=divider
    // 23=image, 27=table, 31=callout

    if (type === 1) continue; // page 根节点跳过

    const textContent = extractText(block);

    if (type === 2) { // text
      lines.push(textContent);
    } else if (type >= 3 && type <= 11) { // heading 1-9
      const level = type - 2;
      lines.push(`${'#'.repeat(Math.min(level, 6))} ${textContent}`);
    } else if (type === 12) { // bullet
      lines.push(`- ${textContent}`);
    } else if (type === 13) { // ordered
      lines.push(`1. ${textContent}`);
    } else if (type === 14) { // code
      const lang = block.code?.style?.language || '';
      // 语言映射
      const langMap = { 1: 'plaintext', 2: 'abap', 12: 'c', 14: 'cpp', 15: 'csharp',
        18: 'css', 25: 'go', 28: 'html', 30: 'java', 31: 'javascript',
        40: 'lua', 46: 'objectivec', 49: 'php', 52: 'python', 55: 'ruby',
        56: 'rust', 58: 'shell', 59: 'sql', 60: 'swift', 63: 'typescript',
        71: 'yaml', 72: 'json', 73: 'xml', 80: 'kotlin', 81: 'dart' };
      const langStr = langMap[lang] || '';
      lines.push(`\`\`\`${langStr}\n${textContent}\n\`\`\``);
    } else if (type === 15) { // quote
      lines.push(`> ${textContent}`);
    } else if (type === 17) { // todo
      const done = block.todo?.style?.done ? 'x' : ' ';
      lines.push(`- [${done}] ${textContent}`);
    } else if (type === 22) { // divider
      lines.push('---');
    } else if (type === 23) { // image
      const token = block.image?.token || '';
      lines.push(`[图片: ${token}]`);
    } else if (textContent) {
      lines.push(textContent);
    }
  }
  return lines.join('\n\n');
}

function extractText(block) {
  // 尝试不同的文本字段位置
  const textBlock = block.text || block.heading || block.heading1 || block.heading2 ||
                    block.heading3 || block.heading4 || block.heading5 || block.heading6 ||
                    block.heading7 || block.heading8 || block.heading9 ||
                    block.code || block.quote || block.bullet || block.ordered ||
                    block.todo || block.callout;
  if (!textBlock?.elements) return '';

  return textBlock.elements.map(el => {
    if (el.text_run) return el.text_run.content || '';
    if (el.inline_code) return `\`${el.inline_code.content || ''}\``;
    if (el.equation) return `$${el.equation.content || ''}$`;
    if (el.mention_doc) return `[文档链接]`;
    if (el.mention_user) return `@用户`;
    return '';
  }).join('');
}

// ---- 创建文档 ----

async function createDoc(title, content) {
  const args = [
    'docs', '+create',
    '--api-version', 'v2',
    '--as', 'user',
    '--title', title,
    '--format', 'json',
  ];

  const result = content
    ? withTempMarkdown(content, (cwd, rel) => runLarkCli([...args, '--content', `@${rel}`], { cwd }))
    : runLarkCli(args);

  const doc = result?.data?.document || {};
  const documentId = doc.document_id || '';

  // lark-cli v2 用 markdown --content 创建时会忽略 --title（文档标题取正文首个 H1，
  // 正文无 H1 时标题就变成 Untitled）。这里显式 PATCH 根 page block 把标题强制写回。
  // 写失败直接报错退出，不静默吞——标题是创建的一部分，设不上就是失败。
  if (documentId && title) {
    const titleResp = await api(
      'PATCH',
      `/docx/v1/documents/${documentId}/blocks/${documentId}?document_revision_id=-1`,
      { update_text_elements: { elements: [{ text_run: { content: title } }] } },
    );
    if (titleResp.code !== 0) {
      console.error('文档已创建但标题写入失败:', titleResp.msg || JSON.stringify(titleResp));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({
    document_id: documentId,
    url: larkDocUrl(doc),
    message: content ? '文档已通过官方 lark-cli 创建并写入内容' : '文档已通过官方 lark-cli 创建（空文档）',
    backend: 'lark-cli',
  }));
}

function markdownToBlocks(md) {
  // 简单的 markdown → 飞书 block 转换
  const lines = md.split('\n');
  const blocks = [];
  let inCodeBlock = false;
  let codeContent = '';
  let codeLang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push({
          block_type: 14, // code
          code: {
            elements: [{ text_run: { content: codeContent.trimEnd() } }],
          },
        });
        codeContent = '';
        inCodeBlock = false;
      } else {
        codeLang = line.slice(3).trim();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += line + '\n';
      continue;
    }

    if (!line.trim()) continue;

    // heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push({
        block_type: 2 + level, // heading1=3, heading2=4, ...
        [`heading${level}`]: {
          elements: [{ text_run: { content: headingMatch[2] } }],
        },
      });
      continue;
    }

    // bullet
    if (line.match(/^[-*]\s+/)) {
      blocks.push({
        block_type: 12,
        bullet: {
          elements: [{ text_run: { content: line.replace(/^[-*]\s+/, '') } }],
        },
      });
      continue;
    }

    // ordered list
    if (line.match(/^\d+\.\s+/)) {
      blocks.push({
        block_type: 13,
        ordered: {
          elements: [{ text_run: { content: line.replace(/^\d+\.\s+/, '') } }],
        },
      });
      continue;
    }

    // quote
    if (line.startsWith('> ')) {
      blocks.push({
        block_type: 15,
        quote: {
          elements: [{ text_run: { content: line.slice(2) } }],
        },
      });
      continue;
    }

    // plain text
    blocks.push({
      block_type: 2,
      text: {
        elements: [{ text_run: { content: line } }],
      },
    });
  }

  return blocks;
}

// ---- 下载文件附件 ----

async function downloadFile(fileToken) {
  const token = await getToken();
  if (!token) authRequiredExit('下载文件需要飞书授权');

  // 下载文件内容（优先 /drive/v1/files/ 端点，支持云盘文件）
  let dlResp = await fetch(`${API_BASE}/drive/v1/files/${fileToken}/download`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // fallback: medias 端点（嵌入式媒体）
  if (!dlResp.ok) {
    dlResp = await fetch(`${API_BASE}/drive/v1/medias/${fileToken}/download`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
  }

  if (!dlResp.ok) {
    console.error('下载失败: HTTP', dlResp.status);
    process.exit(1);
  }

  const buffer = Buffer.from(await dlResp.arrayBuffer());
  const contentDisp = dlResp.headers.get('content-disposition') || '';
  const nameMatch = contentDisp.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
  const fileName = nameMatch ? decodeURIComponent(nameMatch[1]) : fileToken;
  const outPath = `/tmp/${fileName}`;
  _fs.writeFileSync(outPath, buffer);
  console.log(`文件已下载到: ${outPath} (${buffer.length} bytes)`);

  // 尝试当文本读取
  if (buffer.length < 500000) {
    try {
      const text = buffer.toString('utf-8');
      if (!text.includes('\0')) {
        console.log('\n--- 文件内容 ---\n');
        console.log(text);
      } else {
        console.log('(二进制文件，无法直接显示内容)');
      }
    } catch { /* 二进制文件 */ }
  }
}

// ---- 上传文件 ----

// ---- 云盘文件夹管理 ----

/** 获取用户云盘根目录下的文件/文件夹列表 */
async function listFolder(folderToken) {
  const token = folderToken || '';
  const resp = await api('GET', `/drive/v1/files?folder_token=${token}&page_size=200`);
  return resp?.data?.files || [];
}

/** 在指定父目录下创建文件夹 */
async function createFolder(name, parentToken) {
  const resp = await api('POST', '/drive/v1/files/create_folder', {
    name,
    folder_token: parentToken || '',
  });
  return resp?.data?.token || null;
}

/** 查找或创建指定名称的文件夹，支持多级路径（如 "nanoclaw/子目录"） */
async function findOrCreateFolder(folderName) {
  const segments = folderName.split('/').filter(Boolean);
  let parentToken = '';

  for (const seg of segments) {
    // 根目录下的已知文件夹直接用固定 token，跳过搜索（避免同名文件夹歧义）
    if (!parentToken && KNOWN_FOLDER_TOKENS[seg]) {
      parentToken = KNOWN_FOLDER_TOKENS[seg];
      continue;
    }

    const files = await listFolder(parentToken);
    const existing = files.find(f => f.name === seg && f.type === 'folder');
    if (existing) {
      parentToken = existing.token;
    } else {
      const newToken = await createFolder(seg, parentToken);
      if (!newToken) {
        console.error('创建文件夹失败:', seg, '(父目录:', parentToken || '根目录', ')');
        return null;
      }
      parentToken = newToken;
    }
  }
  return parentToken;
}

// ---- 构建云盘文件链接 ----

function buildDriveFileUrl(fileToken) {
  // 飞书云盘文件的通用链接格式
  return `https://poizon.feishu.cn/file/${fileToken}`;
}

async function uploadFile(filePath, folderName) {
  if (!_fs.existsSync(filePath)) {
    console.error('文件不存在:', filePath);
    process.exit(1);
  }

  const fileName = _path.basename(filePath);
  const args = [
    'drive', '+upload',
    '--as', 'user',
    '--file', fileName,
    '--name', fileName,
    '--format', 'json',
  ];
  if (folderName) {
    const folderToken = KNOWN_FOLDER_TOKENS[folderName];
    if (!folderToken) {
      console.error(`官方 lark-cli 上传只接受 folder token；当前仅内置映射: ${Object.keys(KNOWN_FOLDER_TOKENS).join(', ')}`);
      process.exit(1);
    }
    args.push('--folder-token', folderToken);
  }

  const result = withTempFile(filePath, (cwd) => runLarkCli(args, { cwd, allowFailure: true }));
  if (result?.ok === false) {
    const msg = `${result?.error?.message || ''}\n${result?.stderr || ''}`;
    if (msg.includes('drive:file:upload') || msg.includes('drive:drive') || msg.includes('drive:file')) {
      await uploadFileLegacy(filePath, folderName, 'lark-cli 缺少 drive 上传权限，已自动 fallback 到 user-token 上传');
      return;
    }
    if (result.raw) process.stderr.write(result.raw);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(JSON.stringify(result, null, 2));
    process.exit(result.status || 1);
  }
  const file = result?.data?.file || result?.data || {};
  const fileToken = file.file_token || file.token || file.fileToken || '';
  const fileUrl = file.url || buildDriveFileUrl(fileToken);
  console.log(JSON.stringify({
    file_token: fileToken,
    file_name: fileName,
    size: _fs.statSync(filePath).size,
    url: fileUrl,
    folder: folderName || '(根目录)',
    message: `文件已通过官方 lark-cli 上传到云盘${folderName ? ' ' + folderName + '/' : ''}`,
    backend: 'lark-cli',
  }));
}

async function uploadFileLegacy(filePath, folderName, fallbackReason = '') {
  const fileName = _path.basename(filePath);
  const fileData = _fs.readFileSync(filePath);
  const fileSize = fileData.length;

  const token = await getToken();
  if (!token) authRequiredExit('上传文件需要飞书授权');

  let parentNode = '';
  if (folderName) {
    parentNode = await findOrCreateFolder(folderName) || '';
  }

  const boundary = '----FormBoundary' + Date.now().toString(36);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nexplorer`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${parentNode}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${fileSize}`);

  const prefixStr = parts.join('\r\n') + '\r\n';
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(prefixStr),
    Buffer.from(fileHeader),
    fileData,
    Buffer.from(suffix),
  ]);

  const resp = await fetch(`${API_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const data = await resp.json();

  if (data.code !== 0) {
    console.error('上传失败:', data.msg || JSON.stringify(data));
    process.exit(1);
  }

  const fileToken = data.data?.file_token;
  const fileUrl = buildDriveFileUrl(fileToken);
  console.log(JSON.stringify({
    file_token: fileToken,
    file_name: fileName,
    size: fileSize,
    url: fileUrl,
    folder: folderName || '(根目录)',
    message: `文件已上传到云盘${folderName ? ' ' + folderName + '/' : ''}`,
    backend: 'legacy-user-token',
    fallback_reason: fallbackReason,
  }));
}

async function uploadDocxImageLegacy(filePath, parentNode) {
  const fileName = _path.basename(filePath);
  const fileData = _fs.readFileSync(filePath);
  const token = await getToken();
  if (!token) authRequiredExit('插入图片需要飞书授权');

  const boundary = '----FormBoundary' + Date.now().toString(36);
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\ndocx_image`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${parentNode}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${fileData.length}`);

  const prefixStr = parts.join('\r\n') + '\r\n';
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(prefixStr),
    Buffer.from(fileHeader),
    fileData,
    Buffer.from(suffix),
  ]);

  const resp = await fetch(`${API_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`上传图片失败: code=${data.code}, msg=${data.msg || JSON.stringify(data)}`);
  }
  return data.data?.file_token || '';
}

// ---- 搜索文档 ----

async function searchDocs(query) {
  const result = runLarkCli([
    'drive', '+search',
    '--as', 'user',
    '--query', query,
    '--doc-types', 'docx,wiki,file',
    '--page-size', '10',
    '--format', 'json',
  ], { allowFailure: true });
  if (result?.ok === false) {
    const msg = `${result?.error?.message || ''}\n${result?.stderr || ''}`;
    if (msg.includes('need_user_authorization') || msg.includes('search:docs:read')) {
      await searchDocsLegacy(query, 'lark-cli 缺少 user 搜索授权，已自动 fallback 到 user-token 搜索');
      return;
    }
    if (result.raw) process.stderr.write(result.raw);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(JSON.stringify(result, null, 2));
    process.exit(result.status || 1);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function searchDocsLegacy(query, fallbackReason = '') {
  const resp = await api('POST', '/suite/docs-api/search/object', {
    search_key: query,
    count: 10,
    offset: 0,
    owner_ids: [],
    docs_types: [2, 3, 8, 15, 16],
  });

  if (resp.code !== 0) {
    console.error('搜索失败:', resp.msg || JSON.stringify(resp));
    process.exit(1);
  }

  const items = resp.data?.docs_entities || [];
  if (items.length === 0) {
    console.log(JSON.stringify({ results: [], backend: 'legacy-user-token', fallback_reason: fallbackReason }, null, 2));
    return;
  }

  const results = items.map(item => ({
    title: item.title || '(无标题)',
    type: item.docs_type,
    url: item.url || '',
    owner: item.owner_id || '',
    updated: item.update_time || '',
  }));

  console.log(JSON.stringify({ results, backend: 'legacy-user-token', fallback_reason: fallbackReason }, null, 2));
}

async function appendDoc(urlOrId, content) {
  if (!content) {
    console.error('追加内容不能为空');
    process.exit(1);
  }
  const result = withTempMarkdown(content, (cwd, rel) => runLarkCli([
    'docs', '+update',
    '--api-version', 'v2',
    '--as', 'user',
    '--doc', urlOrId,
    '--command', 'append',
    '--content', `@${rel}`,
    '--format', 'json',
  ], { cwd }));
  const doc = result?.data?.document || {};
  console.log(JSON.stringify({
    document_id: doc.document_id || parseFeishuUrl(urlOrId)?.token || '',
    url: larkDocUrl(doc) || urlOrId,
    message: '文档已通过官方 lark-cli 追加内容',
    backend: 'lark-cli',
  }));
}

async function insertImage(urlOrId, filePath, args = []) {
  if (!_fs.existsSync(filePath)) {
    console.error('图片文件不存在:', filePath);
    process.exit(1);
  }
  const widthIdx = args.indexOf('--width');
  const captionIdx = args.indexOf('--caption');
  const cliArgs = [
    'docs', '+media-insert',
    '--as', 'user',
    '--doc', urlOrId,
    '--file', _path.basename(filePath),
    '--type', 'image',
    '--format', 'json',
  ];
  if (widthIdx >= 0 && args[widthIdx + 1]) cliArgs.push('--width', args[widthIdx + 1]);
  if (captionIdx >= 0 && args[captionIdx + 1]) cliArgs.push('--caption', args[captionIdx + 1]);
  const result = withTempFile(filePath, (cwd) => runLarkCli(cliArgs, { cwd, allowFailure: true }));
  if (result?.ok !== false) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const msg = `${result?.error?.message || ''}\n${result?.stderr || ''}\n${result?.raw || ''}`;
  if (!msg.includes('docs:document.media:upload')) {
    if (result.raw) process.stderr.write(result.raw);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(JSON.stringify(result, null, 2));
    process.exit(result.status || 1);
  }

  await insertImageLegacy(urlOrId, filePath, 'lark-cli 缺少 docs:document.media:upload 权限，已自动 fallback 到老三阶段 docx_image 插图链路');
}

async function insertImageLegacy(urlOrId, filePath, fallbackReason = '') {
  const parsed = parseFeishuUrl(urlOrId);
  const documentId = parsed?.token || urlOrId;
  if (!documentId) {
    console.error('无法解析文档 ID:', urlOrId);
    process.exit(1);
  }

  const createResp = await api('POST', `/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
    children: [{ block_type: 27, image: {} }],
  });
  if (createResp.code !== 0) {
    console.error('创建图片 Block 失败:', createResp.msg || JSON.stringify(createResp));
    process.exit(1);
  }

  const imageBlock = createResp.data?.children?.[0] || {};
  const blockId = imageBlock.block_id || '';
  if (!blockId) {
    console.error('创建图片 Block 后未返回 block_id:', JSON.stringify(createResp));
    process.exit(1);
  }

  let fileToken = '';
  try {
    fileToken = await uploadDocxImageLegacy(filePath, blockId);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
  if (!fileToken) {
    console.error('上传图片后未返回 file_token');
    process.exit(1);
  }

  const patchResp = await api('PATCH', `/docx/v1/documents/${documentId}/blocks/${blockId}?document_revision_id=-1`, {
    replace_image: { token: fileToken },
  });
  if (patchResp.code !== 0) {
    console.error('绑定图片 token 失败:', patchResp.msg || JSON.stringify(patchResp));
    process.exit(1);
  }

  console.log(JSON.stringify({
    document_id: documentId,
    block_id: blockId,
    file_token: fileToken,
    url: `https://poizon.feishu.cn/docx/${documentId}`,
    message: '图片已插入飞书文档',
    backend: 'legacy-user-token-docx-image',
    fallback_reason: fallbackReason,
  }, null, 2));
}

// ---- 主入口 ----

const [,, command, ...args] = process.argv;

switch (command) {
  case 'read':
    if (!args[0]) { console.error('用法: feishu-docs read <url_or_id>'); process.exit(1); }
    await readDoc(args[0]);
    break;

  case 'create': {
    if (!args[0]) { console.error('用法: feishu-docs create <title> [content]'); process.exit(1); }
    let content = args.slice(1).join(' ');
    // 如果没有内联 content，从 stdin 读取
    if (!content && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      content = Buffer.concat(chunks).toString('utf-8');
    }
    await createDoc(args[0], content);
    break;
  }

  case 'append': {
    if (!args[0]) { console.error('用法: feishu-docs append <url_or_id> [content]'); process.exit(1); }
    let content = args.slice(1).join(' ');
    if (!content && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      content = Buffer.concat(chunks).toString('utf-8');
    }
    await appendDoc(args[0], content);
    break;
  }

  case 'insert-image': {
    if (!args[0] || !args[1]) { console.error('用法: feishu-docs insert-image <url_or_id> <image_path> [--width 900] [--caption 文案]'); process.exit(1); }
    await insertImage(args[0], args[1], args.slice(2));
    break;
  }

  case 'upload': {
    if (!args[0]) { console.error('用法: feishu-docs upload <file_path> [--folder name]'); process.exit(1); }
    const folderIdx = args.indexOf('--folder');
    const folder = folderIdx >= 0 ? args[folderIdx + 1] : undefined;
    const uploadPath = folderIdx >= 0 && args[0] === '--folder' ? args[2] : args[0];
    await uploadFile(uploadPath, folder);
    break;
  }

  case 'search':
    if (!args[0]) { console.error('用法: feishu-docs search <query>'); process.exit(1); }
    await searchDocs(args.join(' '));
    break;

  default:
    console.log(`飞书文档工具

命令:
  feishu-docs read <url_or_id>         读取文档内容（官方 lark-cli docs +fetch）
  feishu-docs create <title> [content] 创建文档（content 可从 stdin 管道输入）
  feishu-docs append <url_or_id> [content] 追加内容（content 可从 stdin 管道输入）
  feishu-docs insert-image <url_or_id> <image_path> [--width 900] [--caption 文案]  插入图片
  feishu-docs upload <file_path> [--folder name]  上传文件到用户云盘
  feishu-docs search <query>           搜索文档

示例:
  feishu-docs read https://xxx.feishu.cn/docx/ABC123
  feishu-docs create "会议纪要" "# 今日议题\\n- 项目进度"
  cat report.md | feishu-docs create "项目报告"
  cat append.md | feishu-docs append https://xxx.feishu.cn/docx/ABC123
  feishu-docs insert-image https://xxx.feishu.cn/docx/ABC123 ./diagram.png --width 900 --caption "流程图"
  feishu-docs upload ./output.csv --folder nanoclaw
  feishu-docs search "项目规划"`);
}
