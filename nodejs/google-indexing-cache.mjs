/**
 * Google Indexing API 增量缓存推送脚本
 *
 * 核心机制：
 * 1. 从生产构建生成的 sitemap.xml 提取 candidate URLs 及其 <lastmod> 时间戳；
 * 2. 通过正则严格剪枝：剔除低权重 /tag/ 标签页、/page/ 列表分页与顶层目录主页，锁定实质内容；
 * 3. 比对本地状态持久化文件 .indexing-cache.json：
 *    - 从未提交的新页面 -> 入队推送
 *    - 当前 lastmod > 缓存记录 lastmod（内容有更新）-> 入队推送
 *    - 缓存无 lastmod 但当前补充了时间戳 -> 入队推送
 *    - 内容无变更 -> 毫秒级直接跳过，零网络开销
 * 4. 严格受控在 Google Indexing API 每日 200 条免费配额内。
 *
 * 依赖凭证：
 * 需在 Google Cloud Console 开启 Web Search Indexing API 并下载 Service Account JSON 密钥，
 * 默认读取 process.env.GOOGLE_CREDENTIALS_PATH 或当前目录 google-credentials.json。
 * 注意：凭证文件切勿提交进公共 Git 仓库！
 *
 * @example
 * // 基本用法
 * node google-indexing-cache.mjs
 *
 * // 强制全量提交（忽略缓存对比）
 * node google-indexing-cache.mjs --all
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

// 路径与配置（支持环境变量覆盖）
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || resolve(process.cwd(), 'google-credentials.json');
const SITEMAP_PATH = process.env.SITEMAP_PATH || resolve(process.cwd(), 'dist/sitemap-0.xml');
const CACHE_PATH = process.env.INDEXING_CACHE_PATH || resolve(process.cwd(), '.indexing-cache.json');
const SITE_DOMAIN = process.env.SITE_DOMAIN || 'https://example.com';

if (!existsSync(CREDENTIALS_PATH)) {
  console.error(`Error: Google Cloud service account JSON not found at ${CREDENTIALS_PATH}`);
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));

function loadCache() {
  if (existsSync(CACHE_PATH)) {
    try {
      return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function base64url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * 通过 RSA-SHA256 签名签发 JWT 并兑换 Google OAuth 2.0 Access Token
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/indexing',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedClaim = base64url(JSON.stringify(claimSet));
  const signInput = `${encodedHeader}.${encodedClaim}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  const signature = base64url(signer.sign(creds.private_key));
  const jwt = `${signInput}.${signature}`;

  const postData = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  return new Promise((resolvePromise, rejectPromise) => {
    const proxyEnv = process.env.https_proxy || process.env.HTTPS_PROXY;
    const reqOptions = {
      host: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const makeRequest = (socket) => {
      if (socket) {
        reqOptions.socket = socket;
        reqOptions.agent = false;
      }
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.access_token) {
              resolvePromise(parsed.access_token);
            } else {
              rejectPromise(new Error(`Failed to get token: ${data}`));
            }
          } catch (e) {
            rejectPromise(e);
          }
        });
      });
      req.on('error', rejectPromise);
      req.write(postData);
      req.end();
    };

    if (proxyEnv) {
      const proxy = new URL(proxyEnv);
      const connectReq = http.request({
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: 'oauth2.googleapis.com:443',
      });
      connectReq.on('connect', (res, socket) => makeRequest(socket));
      connectReq.on('error', rejectPromise);
      connectReq.end();
    } else {
      makeRequest();
    }
  });
}

/**
 * 调用 Google Indexing API 发送 URL_UPDATED 通知
 */
function publishUrl(token, url) {
  const body = JSON.stringify({
    url: url,
    type: 'URL_UPDATED',
  });

  return new Promise((resolvePromise) => {
    const proxyEnv = process.env.https_proxy || process.env.HTTPS_PROXY;
    const reqOptions = {
      host: 'indexing.googleapis.com',
      path: '/v3/urlNotifications:publish',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const makeRequest = (socket) => {
      if (socket) {
        reqOptions.socket = socket;
        reqOptions.agent = false;
      }
      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolvePromise({ success: true, url });
          } else {
            resolvePromise({ success: false, url, status: res.statusCode, error: data });
          }
        });
      });
      req.on('error', (err) => resolvePromise({ success: false, url, error: err.message }));
      req.write(body);
      req.end();
    };

    if (proxyEnv) {
      const proxy = new URL(proxyEnv);
      const connectReq = http.request({
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: 'indexing.googleapis.com:443',
      });
      connectReq.on('connect', (res, socket) => makeRequest(socket));
      connectReq.on('error', (err) => resolvePromise({ success: false, url, error: err.message }));
      connectReq.end();
    } else {
      makeRequest();
    }
  });
}

/**
 * 精准过滤：剔除薄内容目录，只保留具有独立长尾价值的内容详情页
 */
function isEligibleContentPage(url) {
  if (!url) return false;

  // 排除标签聚合页、列表分页
  if (url.includes('/tag/') || url.includes('/page/')) {
    return false;
  }

  // 严格匹配文章详情页与项目页，排除列表主页
  const isArticle =
    /\/(?:[a-z]{2}\/)?blog\/[a-z0-9-]+(?:\/)?$/.test(url) &&
    !url.endsWith('/blog/') &&
    !url.endsWith('/blog');

  const isProject =
    /\/(?:[a-z]{2}\/)?projects\/[a-z0-9-]+(?:\/)?$/.test(url) &&
    !url.endsWith('/projects/') &&
    !url.endsWith('/projects');

  return isArticle || isProject;
}

/**
 * 解析 sitemap.xml 提取目标 URL 及 lastmod
 */
function collectArticles() {
  if (!existsSync(SITEMAP_PATH)) {
    console.error(`Error: Sitemap not found at ${SITEMAP_PATH}. Please build the project first.`);
    process.exit(1);
  }

  const content = readFileSync(SITEMAP_PATH, 'utf8');
  const blocks = [...content.matchAll(/<url>([\s\S]*?)<\/url>/g)];
  const items = [];

  for (const block of blocks) {
    const loc = block[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const lastmod = block[1].match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] || null;

    if (loc && isEligibleContentPage(loc)) {
      items.push({ url: loc, lastmod });
    }
  }

  return items;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const isForceAll = process.argv.includes('--all');
  console.log('--- Google Indexing: Incremental Article Submitter ---');

  const cache = loadCache();
  const allItems = collectArticles();
  console.log(`Discovered ${allItems.length} candidate content pages.`);

  const pending = [];
  let skippedCount = 0;

  for (const item of allItems) {
    const cached = cache[item.url];

    if (isForceAll) {
      pending.push(item);
      continue;
    }

    if (!cached) {
      pending.push({ ...item, reason: 'new/unsubmitted' });
    } else if (item.lastmod && cached.lastmod && new Date(item.lastmod) > new Date(cached.lastmod)) {
      pending.push({ ...item, reason: 'updated' });
    } else if (!cached.lastmod && item.lastmod) {
      pending.push({ ...item, reason: 'lastmod-attached' });
    } else {
      skippedCount++;
    }
  }

  console.log(`- Unchanged & Skipped: ${skippedCount}`);
  console.log(`- Pending Submission: ${pending.length}`);

  if (pending.length === 0) {
    console.log('\n✓ All content pages are up-to-date in cache. No submissions needed!');
    return;
  }

  console.log('\nAuthenticating with Google Cloud...');
  const token = await getAccessToken();
  console.log('✓ Authentication successful!\n');

  // Google 官方单个项目每日限额 200 次
  const maxQuota = 200;
  const targetBatch = pending.slice(0, maxQuota);
  console.log(`Submitting ${targetBatch.length} pages to Google Indexing API...\n`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < targetBatch.length; i++) {
    const item = targetBatch[i];
    const res = await publishUrl(token, item.url);

    if (res.success) {
      succeeded++;
      cache[item.url] = {
        lastmod: item.lastmod,
        submittedAt: new Date().toISOString(),
      };
      console.log(`[${i + 1}/${targetBatch.length}] [200 OK] (${item.reason || 'ready'}) ${item.url}`);
    } else {
      failed++;
      console.error(`[${i + 1}/${targetBatch.length}] [FAILED] ${item.url} -> ${res.status || ''} ${res.error || ''}`);
      if (res.status === 429) {
        console.warn('\nDaily quota limit reached (429 Too Many Requests). Stopping.');
        break;
      }
    }

    await sleep(80);
  }

  saveCache(cache);

  console.log('\n--- Submission Summary ---');
  console.log(`✓ Successfully submitted: ${succeeded}`);
  if (failed > 0) console.log(`✗ Failed: ${failed}`);
  console.log('Cache updated in .indexing-cache.json');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
