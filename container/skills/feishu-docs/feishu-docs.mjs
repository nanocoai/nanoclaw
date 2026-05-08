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

const API_BASE = 'https://open.feishu.cn/open-apis';

const AUTH_EXPIRED_CODES = new Set([99991668, 99991672]);

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
  const parsed = parseFeishuUrl(urlOrId);
  if (!parsed) {
    console.error('错误: 无法解析飞书文档 URL 或 ID:', urlOrId);
    process.exit(1);
  }

  // 文件附件 — 下载到本地后输出路径
  if (parsed.type === 'file') {
    await downloadFile(parsed.token);
    return;
  }

  // 电子表格 — 暂不支持完整解析，输出提示
  if (parsed.type === 'sheet') {
    console.error('电子表格（sheets）暂不支持直接读取。请导出为 CSV 或复制内容后发送。');
    process.exit(1);
  }

  let documentId = parsed.token;

  // wiki 类型需要先获取实际的 document_id
  if (parsed.type === 'wiki') {
    const wikiResp = await api('GET', `/wiki/v2/spaces/get_node?token=${parsed.token}`);
    if (wikiResp.code !== 0) {
      console.error('获取 wiki 节点失败:', wikiResp.msg || JSON.stringify(wikiResp));
      process.exit(1);
    }
    documentId = wikiResp.data?.node?.obj_token || parsed.token;
  }

  // 获取所有 blocks
  let allBlocks = [];
  let pageToken = '';
  while (true) {
    const url = `/docx/v1/documents/${documentId}/blocks?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const resp = await api('GET', url);
    if (resp.code !== 0) {
      console.error('读取文档失败:', resp.msg || JSON.stringify(resp));
      process.exit(1);
    }
    const items = resp.data?.items || [];
    allBlocks.push(...items);
    if (!resp.data?.has_more) break;
    pageToken = resp.data.page_token || '';
  }

  // 转换为 markdown
  const md = blocksToMarkdown(allBlocks);
  console.log(md);
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
  const textBlock = block.text || block.heading || block.code || block.quote ||
                    block.bullet || block.ordered || block.todo || block.callout;
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
  // 创建空文档
  const createResp = await api('POST', '/docx/v1/documents', { title });
  if (createResp.code !== 0) {
    console.error('创建文档失败:', createResp.msg || JSON.stringify(createResp));
    process.exit(1);
  }

  const docId = createResp.data?.document?.document_id;
  const docUrl = `https://feishu.cn/docx/${docId}`;

  if (!content) {
    console.log(JSON.stringify({ document_id: docId, url: docUrl, message: '文档已创建（空文档）' }));
    return;
  }

  // 写入内容 — 将 markdown 转为飞书 blocks
  const blocks = markdownToBlocks(content);
  if (blocks.length > 0) {
    const writeResp = await api('POST', `/docx/v1/documents/${docId}/blocks/${docId}/children`, {
      children: blocks,
    });
    if (writeResp.code !== 0) {
      console.log(JSON.stringify({
        document_id: docId,
        url: docUrl,
        message: `文档已创建，但写入内容失败: ${writeResp.msg}`,
      }));
      return;
    }
  }

  console.log(JSON.stringify({ document_id: docId, url: docUrl, message: '文档已创建并写入内容' }));
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
        heading: {
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

// 已知的 nanoclaw 云盘文件夹 token（根目录有多个同名文件夹，用固定 token 消歧）
const KNOWN_FOLDER_TOKENS = {
  'nanoclaw': 'VRDBfRD3FlkA90d3or8cnkCHnhd',
};

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
  const fileData = _fs.readFileSync(filePath);
  const fileSize = fileData.length;

  const token = await getToken();
  if (!token) authRequiredExit('上传文件需要飞书授权');

  // 如果指定了文件夹，先找到或创建它
  let parentNode = '';
  if (folderName) {
    parentNode = await findOrCreateFolder(folderName) || '';
  }

  const boundary = '----FormBoundary' + Date.now().toString(36);

  // 构建 multipart/form-data
  const parts = [];

  // file_name
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`);
  // parent_type (explorer = 云盘)
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nexplorer`);
  // parent_node (文件夹 token，空 = 根目录)
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\n${parentNode}`);
  // size
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
  }));
}

// ---- 搜索文档 ----

async function searchDocs(query) {
  const resp = await api('POST', '/suite/docs-api/search/object', {
    search_key: query,
    count: 10,
    offset: 0,
    owner_ids: [],
    docs_types: [2, 3, 8, 15, 16], // docx, sheet, bitable, wiki, slide
  });

  if (resp.code !== 0) {
    console.error('搜索失败:', resp.msg || JSON.stringify(resp));
    process.exit(1);
  }

  const items = resp.data?.docs_entities || [];
  if (items.length === 0) {
    console.log('未找到匹配的文档');
    return;
  }

  const results = items.map(item => ({
    title: item.title || '(无标题)',
    type: item.docs_type,
    url: item.url || '',
    owner: item.owner_id || '',
    updated: item.update_time || '',
  }));

  console.log(JSON.stringify(results, null, 2));
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
  feishu-docs read <url_or_id>         读取文档内容（输出 markdown）
  feishu-docs create <title> [content] 创建文档（content 可从 stdin 管道输入）
  feishu-docs upload <file_path> [--folder name]  上传文件到用户云盘
  feishu-docs search <query>           搜索文档

示例:
  feishu-docs read https://xxx.feishu.cn/docx/ABC123
  feishu-docs create "会议纪要" "# 今日议题\\n- 项目进度"
  cat report.md | feishu-docs create "项目报告"
  feishu-docs upload ./output.csv --folder nanoclaw
  feishu-docs search "项目规划"`);
}
