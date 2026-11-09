'use strict';

/**
 * fact-registry.js —— 可更新的路由注册表
 *
 * 解决什么：
 *   静态路由表（fact-route.js 里的 ASK_BLOCK）只能覆盖想到的问法。
 *   「发货了吗」在静态表里会被归成 shipping_time，答成「当天发货」，
 *   但买家问的是「我这一单发没发」——需要订单/物流事实。
 *
 * 注册表是一份可增长的数据（data/fact-registry.json）：
 *   短语 → 问法(ask) → 需要哪些块(blocks) → 是否必须有订单数据(needs)
 *
 * 三个来源：
 *   seed    内置（第一批手写）
 *   learned 测试时模型提议、人工采纳
 *   manual  商家/我们自己手动加
 *
 * 注册表只影响「取哪几块事实」，不改回复话术；质检照旧。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = 'fact-registry.json';
const GAPS = 'route-gaps.json';

const SEED = [
  {
    id: 'reg_shipped_or_not',
    match: ['发货了吗', '发货了没', '发出了吗', '发出去了吗', '发了吗', '还没发货', '没发货'],
    ask: 'shipping_status',
    blocks: ['order'],
    needs: ['order'],
    note: '问「我这一单发没发」，必须有订单/物流数据；没有就标缺失，不许拿发货时效糊弄',
    source: 'seed',
  },
  {
    id: 'reg_where_is_it',
    match: ['到哪了', '到哪儿了', '物流到哪', '快递到哪', '走到哪了'],
    ask: 'shipping_status',
    blocks: ['order'],
    needs: ['order'],
    note: '问物流进度，必须有运单信息',
    source: 'seed',
  },
  {
    id: 'reg_invoice',
    match: ['开发票', '能开票', '专票', '普票', '税点'],
    ask: 'invoice',
    blocks: ['policy'],
    needs: [],
    note: '发票口径在店铺政策里',
    source: 'seed',
  },
  {
    id: 'reg_stock',
    match: ['有货吗', '还有吗', '有现货', '库存'],
    ask: 'stock',
    blocks: ['product'],
    needs: ['product'],
    note: '库存必须有商品数据',
    source: 'seed',
  },
  {
    id: 'reg_usage',
    match: ['怎么用', '怎么种', '怎么泡', '要泡水吗', '怎么清洗'],
    ask: 'usage',
    blocks: ['manual'],
    needs: ['manual'],
    note: '用法按商品说明书分节答',
    source: 'seed',
  },
  {
    id: 'reg_courier',
    match: ['什么快递', '哪家快递', '发什么快递', '快递公司'],
    ask: 'courier',
    blocks: ['policy'],
    needs: [],
    note: '承运方属于店铺政策',
    source: 'seed',
  },
];

function filePath(name) {
  return path.join(DATA_DIR, name || FILE);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，。！？!?；;、,.:：~]+/g, '');
}

function load() {
  const data = readJson(filePath(), null);
  if (data && Array.isArray(data.entries)) return data;
  const fresh = { version: 1, entries: SEED.slice() };
  writeJson(filePath(), fresh);
  return fresh;
}

function save(data) {
  writeJson(filePath(), { version: 1, entries: data.entries || [] });
  return (data.entries || []).length;
}

/** 命中最长的短语（越长越具体） */
function match(text) {
  const t = norm(text);
  if (!t) return null;
  let best = null;
  for (const e of load().entries) {
    if (!e || e.enabled === false) continue;
    for (const p of e.match || []) {
      const k = norm(p);
      if (k.length < 2 || !t.includes(k)) continue;
      if (!best || k.length > best.len) best = { entry: e, phrase: p, len: k.length };
    }
  }
  return best ? { entry: best.entry, phrase: best.phrase } : null;
}

function upsert(entry) {
  const data = load();
  const list = data.entries;
  const item = {
    id: entry.id || 'reg_' + Date.now().toString(36),
    match: (entry.match || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
    ask: String(entry.ask || 'other'),
    blocks: (entry.blocks || []).filter(Boolean).slice(0, 4),
    needs: (entry.needs || []).filter(Boolean).slice(0, 4),
    note: String(entry.note || '').slice(0, 120),
    source: entry.source || 'manual',
    enabled: entry.enabled !== false,
    updatedAt: new Date().toISOString(),
  };
  if (!item.match.length) throw new Error('至少要有一个匹配短语');
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) list.unshift(item);
  else list[idx] = { ...list[idx], ...item };
  save(data);
  return item;
}

function disable(id) {
  const data = load();
  const it = data.entries.find((x) => x.id === id);
  if (!it) return false;
  it.enabled = false;
  it.updatedAt = new Date().toISOString();
  save(data);
  return true;
}

// ---------------------------------------------------------------- 缺口记录

function loadGaps() {
  const d = readJson(filePath(GAPS), null);
  return d && Array.isArray(d.items) ? d.items : [];
}

function saveGaps(items) {
  writeJson(filePath(GAPS), { version: 1, items: items.slice(0, 200) });
}

/**
 * 测试里的「路由没覆盖」：同一句只累加次数，不重复堆。
 * 只在 test 会话里记录，避免真实接待时写满盘。
 */
function recordGap({ buyerText, asks, mode, trigger }) {
  const key = norm(buyerText).slice(0, 40);
  if (!key) return null;
  const items = loadGaps();
  const hit = items.find((g) => g.key === key);
  if (hit) {
    hit.count = (hit.count || 1) + 1;
    hit.lastAt = new Date().toISOString();
    hit.mode = mode || hit.mode;
    hit.trigger = trigger || hit.trigger;
  } else {
    items.unshift({
      key,
      buyerText: String(buyerText || '').slice(0, 80),
      asks: (asks || []).slice(0, 4),
      mode: mode || '',
      trigger: trigger || '',
      count: 1,
      status: 'open',
      createdAt: new Date().toISOString(),
    });
  }
  saveGaps(items);
  return key;
}

function dismissGap(key) {
  const items = loadGaps();
  const hit = items.find((g) => g.key === key);
  if (!hit) return false;
  hit.status = 'ignored';
  saveGaps(items);
  return true;
}

module.exports = { load, save, match, upsert, disable, recordGap, loadGaps, dismissGap, norm, SEED };
