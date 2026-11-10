'use strict';

/**
 * store.js —— 本地数据层（零依赖，JSON 落盘）
 *
 * 设计原则：
 * 1. 数据不出本机。除 LLM 请求外，不向任何第三方发送会话内容。
 * 2. 配置、知识库、日志、复核队列分文件存放，便于人工查看与备份。
 * 3. 所有写操作串行化，避免并写损坏。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PDD_CS_DATA_DIR || path.join(__dirname, '..', 'data');

const DEFAULT_CONFIG = {
  port: 8787,
  // suggest = 只给建议，必须人工点发送；auto = 满足条件时自动发送
  mode: 'suggest',
  // 引擎模式：standard = 本地优先（1 点/条）；pro = 事实包+模型优先（本地只留高置信模板）
  engine: 'standard',
  // 自动模式下只对这些意图放行；其余一律走人工
  autoMinConfidence: 0.82,
  // 限流：同一会话两条消息最小间隔 / 全局每分钟上限
  rateLimit: { perConversationMs: 8000, perMinute: 20 },
  // 自动模式生效时段（跨零点请拆成两段配置）
  businessHours: { enabled: false, start: '08:00', end: '23:00' },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: 'deepseek-chat',
    timeoutMs: 25000,
    temperature: 0.3,
  },
  // 生成文本命中这些词一律不发送，转人工
  // 注意：不能简单屏蔽「微信」二字——「微信支付」是正常支付方式。
  // 只拦「引导站外联系」的语境。
  forbiddenOutput: ['加微信', '微信号', '加我微信', '私聊', '加我QQ', '二维码', '手机号', 'http://', 'https://', '赔你', '退你钱', '保证 ', '100%', '绝对'],
  // 服务端模型：本地不确定时才调用，密钥只存在服务端
  backend: {
    url: '',
    token: '',
    deviceId: 'local-dev',
    minConfidence: 0.82,
    timeoutMs: 30000,
  },
  // 运行时能力：默认无人值守；所有承诺都以此为准
  capabilities: {
    humanAvailable: false,
    canQueryOrder: false,
    canQueryLogistics: false,
    canEscalate: false,
    canRefund: false,
  },
  // 语气档位：标准/歉意/热情/专业，商家可逐档关闭
  tone: { enabled: true, disabled: [] },
  // 话术风格：礼貌规则（生成侧约束 + 输出侧改写）
  style: {
    tone: 'formal',
    rewriteWords: [],
    maxExclaim: 1,
  },
  // 预警：商家不在电脑前时，兜底/投诉/点数不足要能推到微信
  alerts: {
    enabled: false,
    channels: [], // { type: 'wecom'|'feishu'|'serverchan'|'webhook', url }
    cooldownMs: 600000,
    rules: { consecutiveFallback: 3, complaint: true, lowPoints: 50 },
  },
  // 称呼：一个店铺一个说法，只在首次回复时带
  salutation: { enabled: true, text: '亲', onlyFirst: true },
  store: { id: 'default', name: '默认店铺' },
};

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'seed'), { recursive: true });
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

const writeQueues = new Map();

function writeJson(file, value) {
  ensureDir();
  const target = path.join(DATA_DIR, file);
  const tmp = target + '.tmp';
  const body = JSON.stringify(value, null, 2);
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(tmp, body, 'utf8', (err) => {
          if (err) return reject(err);
          fs.rename(tmp, target, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  writeQueues.set(file, next.catch(() => {}));
  return next;
}

function appendJsonl(file, value) {
  ensureDir();
  const target = path.join(DATA_DIR, file);
  return new Promise((resolve, reject) => {
    fs.appendFile(target, JSON.stringify(value) + '\n', 'utf8', (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function readJsonl(file, limit = 500) {
  const target = path.join(DATA_DIR, file);
  let raw = '';
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(base && base[k], v);
  }
  return out;
}

function getConfig() {
  const saved = readJson('config.json', {}) || {};
  return deepMerge(DEFAULT_CONFIG, saved);
}

function saveConfig(patch) {
  const merged = deepMerge(getConfig(), patch || {});
  // 端口与数据目录不允许通过接口改写
  merged.port = getConfig().port;
  return writeJson('config.json', merged).then(() => merged);
}

function getKnowledge() {
  const list = readJson('knowledge.json', null);
  if (list) return list;
  // 首次启动：从种子库拷贝
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'seed', 'knowledge.json'), 'utf8'));
    return seed;
  } catch (_) {
    return [];
  }
}

function saveKnowledge(list) {
  return writeJson('knowledge.json', list);
}

function maskPhone(text) {
  return String(text || '').replace(/(\d{3})\d{4}(\d{4})/g, '$1****$2');
}

function addLog(entry) {
  const safe = Object.assign({}, entry);
  if (typeof safe.buyerText === 'string') safe.buyerText = maskPhone(safe.buyerText);
  if (typeof safe.replyText === 'string') safe.replyText = maskPhone(safe.replyText);
  return appendJsonl('logs.jsonl', Object.assign({ ts: new Date().toISOString() }, safe));
}

function getLogs(limit = 200) {
  return readJsonl('logs.jsonl', limit).reverse();
}

function getGaps() {
  return readJson('gaps.json', {}) || {};
}

async function addGap(ask, sample) {
  const g = getGaps();
  const key = ask || 'other';
  const cur = g[key] || { count: 0, samples: [], firstSeen: new Date().toISOString() };
  cur.count += 1;
  cur.lastSeen = new Date().toISOString();
  const text = String(sample || '').slice(0, 50);
  if (text && !cur.samples.includes(text) && cur.samples.length < 5) cur.samples.push(text);
  g[key] = cur;
  await writeJson('gaps.json', g);
  return cur;
}

async function clearGap(ask) {
  const g = getGaps();
  delete g[ask || 'other'];
  await writeJson('gaps.json', g);
  return g;
}

function getReviewQueue() {
  return readJson('review.json', []) || [];
}

async function pushReview(item) {
  const list = getReviewQueue();
  list.unshift(Object.assign({ id: 'rv_' + Date.now().toString(36), ts: new Date().toISOString() }, item));
  await writeJson('review.json', list.slice(0, 200));
  return list[0];
}

async function resolveReview(id, resolution) {
  const list = getReviewQueue();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return null;
  list[idx] = Object.assign({}, list[idx], { resolved: true, resolution: resolution || 'done', resolvedAt: new Date().toISOString() });
  await writeJson('review.json', list);
  return list[idx];
}

module.exports = {
  DATA_DIR,
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  getKnowledge,
  saveKnowledge,
  addLog,
  getLogs,
  getReviewQueue,
  getGaps,
  addGap,
  clearGap,
  pushReview,
  resolveReview,
  maskPhone,
};
