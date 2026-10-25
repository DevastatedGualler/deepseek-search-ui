#!/usr/bin/env node
/**
 * DeepSeek 搜索 - 零依赖本地服务
 *
 * 两个上游接口：
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * 浏览器只与本服务通信，API Key 不会出现在前端代码或请求响应里。
 */
import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENV_FILE = path.join(ROOT, '.env');

await loadDotEnv();

const PORT = Number(process.env.PORT || 5178);
const HOST = process.env.HOST || '127.0.0.1';
const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEMO = process.env.DEMO_MODE === '1' || process.argv.includes('--demo');
const SEARCH_ENDPOINT = '/v1/tools/search';
const FETCH_ENDPOINT = '/v1/tools/fetch';
const MAX_BODY = 64 * 1024;
const MAX_FETCH_CHARS = 120_000;

const envKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
let runtimeKey = '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 配置                                                                 */
/* ------------------------------------------------------------------ */

async function loadDotEnv() {
  let text = '';
  try {
    text = await readFile(ENV_FILE, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const name = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function activeKey() {
  return runtimeKey || envKey;
}

function keySource() {
  if (runtimeKey) return 'runtime';
  if (envKey) return 'env';
  return 'none';
}

function configPayload() {
  const key = activeKey();
  return {
    hasKey: Boolean(key),
    keySource: keySource(),
    keyHint: key ? key.slice(-4) : '',
    demo: DEMO,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 基础设施                                                        */
/* ------------------------------------------------------------------ */

class AppError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.detail = detail;
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: http: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return Promise.reject(new AppError(415, '请求必须使用 application/json。'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new AppError(413, '请求体过大。'));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new AppError(400, '请求体不是合法的 JSON。'));
      }
    });
    req.on('error', () => reject(new AppError(400, '读取请求体失败。')));
  });
}

function isLoopback(req) {
  const address = req.socket.remoteAddress || '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 上游 API                                                             */
/* ------------------------------------------------------------------ */

function friendlyStatus(status, endpoint) {
  const isFetch = endpoint === FETCH_ENDPOINT;
  switch (status) {
    case 400:
      return '请求参数不合法。';
    case 401:
      return 'API Key 无效或已过期，请在「API 设置」中更新。';
    case 402:
      return 'DeepSeek 账户余额不足，请前往开放平台充值后再试。';
    case 403:
      return isFetch ? '目标网页拒绝了抓取请求。' : '该请求被上游服务拒绝。';
    case 404:
      return isFetch
        ? '未能从该网页提取可用正文，可能被站点策略拦截或页面没有可读内容。'
        : '上游接口不存在。';
    case 408:
      return '请求超时，请稍后重试。';
    case 413:
      return '请求体过大。';
    case 429:
      return '请求过于频繁，已触发 QPS 限流，请稍等片刻再试。';
    case 500:
      return 'DeepSeek 服务内部错误，请稍后重试。';
    case 502:
      return '无法连接 DeepSeek 服务，请检查网络后重试。';
    case 504:
      return 'DeepSeek 上游服务响应超时，请稍后重试。';
    default:
      return status >= 500 ? 'DeepSeek 服务暂时不可用，请稍后重试。' : '请求失败。';
  }
}

async function callDeepSeek(endpoint, payload, key) {
  let response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'deepseek-search-ui/1.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new AppError(504, 'DeepSeek 上游服务响应超时，请稍后重试。');
    }
    throw new AppError(502, '无法连接 DeepSeek 服务，请检查网络或代理设置。');
  }

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = cleanText(data?.error?.message || raw, 400);
    throw new AppError(response.status, friendlyStatus(response.status, endpoint), detail);
  }

  if (!data || typeof data !== 'object') {
    throw new AppError(502, 'DeepSeek 返回了无法解析的响应。');
  }

  return data;
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const url = safeHttpUrl(result.url);
  if (!url) return null;
  const score = Number(result.rerank_score);
  const authority = Number(result.authority);
  const timestamp = typeof result.date === 'string' ? Date.parse(result.date) : NaN;

  return {
    rerank_score: Number.isFinite(score) ? Math.max(0, Math.min(3, score)) : 0,
    title: cleanText(result.title, 300) || url,
    url,
    snippet: cleanText(result.snippet, 1200),
    site_name: cleanText(result.site_name, 120) || null,
    site_icon: safeHttpUrl(result.site_icon),
    date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    authority: Number.isInteger(authority) ? Math.max(-1, Math.min(4, authority)) : -1,
  };
}

/* ------------------------------------------------------------------ */
/* API 路由                                                             */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, configPayload());
    return;
  }

  if (pathname === '/api/key') {
    if (!isLoopback(req)) {
      throw new AppError(403, '只允许在本机配置 API Key。');
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = String(body.key || '').trim();
      if (key.length < 16 || key.length > 200 || /\s/.test(key)) {
        throw new AppError(400, 'API Key 格式看起来不正确，请检查后重试。');
      }
      runtimeKey = key;
      sendJson(res, 200, configPayload());
      return;
    }
    if (req.method === 'DELETE') {
      if (keySource() === 'env') {
        throw new AppError(409, '当前 Key 来自环境变量，请修改 .env 或系统环境变量。');
      }
      runtimeKey = '';
      sendJson(res, 200, configPayload());
      return;
    }
    throw new AppError(405, '不支持的请求方法。');
  }

  if (pathname === '/api/search') {
    if (req.method !== 'POST') throw new AppError(405, '不支持的请求方法。');
    await handleSearch(req, res);
    return;
  }

  if (pathname === '/api/fetch') {
    if (req.method !== 'POST') throw new AppError(405, '不支持的请求方法。');
    await handleFetch(req, res);
    return;
  }

  throw new AppError(404, '接口不存在。');
}

async function handleSearch(req, res) {
  const body = await readJsonBody(req);
  const query = cleanText(body.query, 200);
  const chars = [...query].length;

  if (!query) throw new AppError(400, '请输入搜索关键词。');
  if (chars > 128) throw new AppError(400, '搜索关键词不能超过 128 个字符。');

  let count = Number(body.count);
  if (!Number.isFinite(count)) count = 10;
  count = Math.max(1, Math.min(50, Math.trunc(count)));

  const oriQuestion = cleanText(body.ori_question, 200);
  const payload = { query, count };
  if (oriQuestion && [...oriQuestion].length <= 128) {
    payload.ori_question = oriQuestion;
  }

  const started = performance.now();
  if (DEMO) {
    await sleep(380);
    sendJson(res, 200, {
      results: demoResults(),
      tookMs: Math.round(performance.now() - started),
      demo: true,
    });
    return;
  }

  const key = activeKey();
  if (!key) {
    throw new AppError(401, '尚未配置 DeepSeek API Key，请点击右上角「API 设置」进行配置。');
  }

  const data = await callDeepSeek(SEARCH_ENDPOINT, payload, key);
  const results = Array.isArray(data.results)
    ? data.results.slice(0, count).map(sanitizeResult).filter(Boolean)
    : [];

  const tookMs = Math.round(performance.now() - started);
  console.log(`[search] -> ${results.length} 条 / ${tookMs}ms`);
  sendJson(res, 200, { results, tookMs, demo: false });
}

async function handleFetch(req, res) {
  const body = await readJsonBody(req);
  const url = safeHttpUrl(body.url);
  if (!url) throw new AppError(400, '请输入合法的 HTTP 或 HTTPS 网页地址。');

  const started = performance.now();
  if (DEMO) {
    await sleep(460);
    const match = DEMO_RESULTS.find((item) => item.url === url);
    sendJson(res, 200, {
      title: match?.title || '演示网页',
      content: demoArticle(match?.title),
      tookMs: Math.round(performance.now() - started),
      demo: true,
      truncated: false,
    });
    return;
  }

  const key = activeKey();
  if (!key) {
    throw new AppError(401, '尚未配置 DeepSeek API Key，请点击右上角「API 设置」进行配置。');
  }

  const data = await callDeepSeek(FETCH_ENDPOINT, { url }, key);
  let content = typeof data.content === 'string' ? data.content : '';
  const truncated = content.length > MAX_FETCH_CHARS;
  if (truncated) content = content.slice(0, MAX_FETCH_CHARS);

  const tookMs = Math.round(performance.now() - started);
  console.log(`[fetch] -> ${content.length} chars / ${tookMs}ms`);
  sendJson(res, 200, {
    title: cleanText(data.title, 300),
    content,
    tookMs,
    demo: false,
    truncated,
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                             */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new AppError(400, '无效的请求路径。');
  }

  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new AppError(403, '禁止访问该路径。');
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new AppError(404, '页面不存在。');
  }
  if (!info.isFile()) throw new AppError(404, '页面不存在。');

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': isHtml ? 'no-store' : 'public, max-age=0, must-revalidate',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ */
/* 服务器                                                               */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    if (parsed.pathname.startsWith('/api/')) {
      await handleApi(req, res, parsed.pathname);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new AppError(405, '不支持的请求方法。');
    }
    await serveStatic(req, res, parsed.pathname);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = error instanceof AppError ? error.status : 500;
    const message = error instanceof AppError ? error.message : '服务器内部错误。';
    const detail = error instanceof AppError ? error.detail : '';
    if (status >= 500) console.error(error);
    sendJson(res, status, { error: { message, detail, status } });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。请设置 PORT=其他端口 后重试。\n`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  console.log('\n  DeepSeek 搜索');
  console.log(`  → http://${shownHost}:${PORT}`);
  if (DEMO) {
    console.log('  演示模式：不会调用真实 API，结果仅用于预览界面。\n');
  } else if (!activeKey()) {
    console.log('  未检测到 DEEPSEEK_API_KEY，可在页面右上角「API 设置」中配置。');
    console.log('  也可以复制 .env.example 为 .env 并填入 Key。\n');
  } else {
    console.log(`  API Key 来源：${keySource() === 'env' ? '环境变量' : '本地运行配置'}\n`);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ------------------------------------------------------------------ */
/* 演示数据                                                             */
/* ------------------------------------------------------------------ */

const DEMO_RESULTS = [
  {
    rerank_score: 2.92,
    title: 'Search & Fetch - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/guides/search',
    snippet:
      'Search API 使用 DeepSeek 自研搜索引擎，按查询返回结构化的网页结果；Fetch API 则抓取单个网页并转换为 Markdown。两者均使用 Bearer 认证，按成功请求计费。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.81,
    title: 'Search API 参考 - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/api/search',
    snippet:
      'POST /v1/tools/search。请求字段包括 query、count、ori_question、localization 与 need_content；结果包含 rerank_score、title、url、snippet、summary、content、site_name、date 和 authority。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.67,
    title: 'Fetch API 参考 - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/api/fetch',
    snippet:
      'POST /v1/tools/fetch 用于抓取网页正文，返回页面标题和 Markdown 内容。URL 必须是 HTTP 或 HTTPS 地址，最大长度 8192 个字符。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.58,
    title: 'Search & Fetch APIs are now open to everyone',
    url: 'https://api-docs.deepseek.com/news/news261017',
    snippet:
      'DeepSeek 宣布 Search 与 Fetch API 面向所有开发者开放，由自研搜索引擎驱动。每个接口每 1,000 次成功调用收费 0.75 美元，Search 的 QPS 限制为 100。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.36,
    title: 'Models & Pricing - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    snippet:
      '查看 DeepSeek 模型与搜索工具的计费方式。Search 和 Fetch 按成功请求数计费，count 只控制返回结果数量，不影响单次请求价格。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.21,
    title: 'Rate Limits - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/quick_start/rate_limit',
    snippet:
      'Search 与 Fetch 的 QPS 限制相互独立，并按账户统一计算。Search 为 100 QPS，Fetch 为 25 QPS，且 Fetch 还受单域名 QPS 限制。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 2.08,
    title: 'Tool Calls - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/guides/tool_calls',
    snippet:
      '学习如何在 Chat Completions 中定义并调用工具。Search 与 Fetch 也可以作为服务端工具接入 Agent 工作流，让模型按需检索实时网页。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-10T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.96,
    title: 'Responses API - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/guides/responses_api',
    snippet:
      'Responses API 提供面向 Agent 的接口形态，支持内置工具、流式事件和多轮状态管理。结合 Search API 可以构建带实时资料的应用。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-10T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.82,
    title: 'Error Codes - DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/quick_start/error_codes',
    snippet:
      'Search 与 Fetch 的错误遵循 OpenAI 兼容格式。401 表示 Key 无效，402 表示余额不足，429 表示触发 QPS 限制，5xx 建议等待后重试。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.74,
    title: 'DeepSeek API Docs',
    url: 'https://api-docs.deepseek.com/',
    snippet:
      'DeepSeek API 使用与 OpenAI / Anthropic 兼容的格式，支持 deepseek-flash 与 deepseek-v4-pro 等模型。文档涵盖快速开始、工具调用、搜索与抓取。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-25T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.61,
    title: 'DeepSeek 开放平台',
    url: 'https://platform.deepseek.com/',
    snippet:
      '登录 DeepSeek 开放平台创建 API Key、查看余额与用量。Search 与 Fetch 调用会计入账户用量，可在控制台查看明细。',
    site_name: 'DeepSeek Platform',
    site_icon: 'https://platform.deepseek.com/favicon.ico',
    date: null,
    authority: 3,
  },
  {
    rerank_score: 1.48,
    title: 'DeepSeek API 更新日志',
    url: 'https://api-docs.deepseek.com/updates',
    snippet:
      '跟踪 DeepSeek API 的功能与模型更新，包括 V4.1-Flash-1017、Search / Fetch API 开放以及 Agent 集成变化。',
    site_name: 'DeepSeek API Docs',
    site_icon: 'https://api-docs.deepseek.com/img/favicon.ico',
    date: '2026-10-17T00:00:00+00:00',
    authority: 4,
  },
  {
    rerank_score: 1.32,
    title: 'anweat/dsh-web-search-pro - GitHub',
    url: 'https://github.com/anweat/dsh-web-search-pro',
    snippet:
      '一个面向 DeepSeek Harness 的增强型持久化网页搜索插件，支持多引擎、SQLite + LRU 缓存、平台后端和 Playwright 渲染，采用 MIT 许可证。',
    site_name: 'GitHub',
    site_icon: 'https://github.com/favicon.ico',
    date: '2026-10-07T00:00:00+00:00',
    authority: 2,
  },
  {
    rerank_score: 1.19,
    title: 'liustack/modsearch - GitHub',
    url: 'https://github.com/liustack/modsearch',
    snippet:
      '为 DeepSeek Harness 及没有原生联网能力的模型提供免费网页搜索桥接，无需注册或 API Key，可作为搜索工具插件使用。',
    site_name: 'GitHub',
    site_icon: 'https://github.com/favicon.ico',
    date: '2026-10-24T00:00:00+00:00',
    authority: 2,
  },
];

function demoResults() {
  return DEMO_RESULTS.map((item) => ({ ...item }));
}

function demoArticle(title) {
  return `# ${title || 'Search & Fetch'}

> 这是一段演示正文。配置 DeepSeek API Key 后，点击「正文预览」会通过 **Fetch API** 抓取真实网页并转换为 Markdown。

## 为什么需要搜索接口

传统搜索框只负责把网页链接列出来；大模型需要的是可以被阅读、引用和进一步处理的内容。DeepSeek 把这两件事拆成了两个接口：

- **Search**：输入查询，返回排序后的结构化结果。
- **Fetch**：输入 URL，返回网页标题和 Markdown 正文。

## 一次最小调用

\`\`\`bash
curl https://api.deepseek.com/v1/tools/search \\
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"DeepSeek V4 release","count":5}'
\`\`\`

响应中的每一条结果都包含：

1. \`rerank_score\`：0–3 的相关性分数；
2. \`title\` / \`url\` / \`snippet\`：适合展示在结果页；
3. \`site_name\` / \`site_icon\` / \`date\`：站点与时间信息；
4. \`authority\`：0–4 的权威度分层。

## 在界面里如何呈现

这个页面把 Search API 当作传统搜索引擎的结果源：

| 字段 | 界面位置 |
| --- | --- |
| title | 结果标题 |
| url | 标题链接与面包屑 |
| snippet | 结果摘要 |
| date | 发布时间 |
| authority | 「权威来源」标记 |

> 提示：搜索语法会原样传给 DeepSeek，例如 \`site:github.com\`、\`"exact phrase"\`、\`after:2026\`。

## 错误处理

遇到 **401** 时检查 Key，**402** 时检查余额，**429** 时降低请求频率。5xx 错误可以稍后重试，其他 4xx 错误应先修正请求。
`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
