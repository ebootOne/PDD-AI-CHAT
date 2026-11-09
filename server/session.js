'use strict';

/**
 * session.js —— 会话状态，按店铺分区 + 本地落盘
 *
 * 为什么按店铺：
 *   一个店几百个买家、一个人可能管多个店；全局一个池会串店，也无法按店清理/限额。
 *
 * 存储：
 *   data/sessions/<storeId>.json，每店一个文件；
 *   每店最多 300 场、TTL 24 小时，超了按最后活跃时间淘汰；
 *   写入防抖 2 秒，原子写（tmp → rename）。
 *
 * 隐私：只存本地；订单号在摘要里只留前 4 位。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const DIR = path.join(DATA_DIR, 'sessions');
const TTL = 24 * 60 * 60 * 1000;
const MAX_PER_STORE = 300;

const stores = new Map(); // storeId -> Map(convId -> state)
const timers = new Map();

const ASK_CN = {
  courier: '快递', shipping_time: '发货', arrival_time: '到货',
  invoice: '发票', payment: '支付', return_policy: '退换', after_sale: '售后',
  spec: '规格', stock: '库存', price: '价格', usage: '种植', nego: '议价',
};

function safeId(id) {
  return String(id || 'default').replace(/[^\w.-]/g, '_').slice(0, 60);
}

function fileOf(storeId) {
  return path.join(DIR, safeId(storeId) + '.json');
}

function loadStore(storeId) {
  if (stores.has(storeId)) return stores.get(storeId);
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(storeId), 'utf8'));
    for (const [k, v] of raw || []) map.set(k, v);
  } catch (_) { /* 首次 */ }
  stores.set(storeId, map);
  return map;
}

function saveStore(storeId) {
  if (timers.has(storeId)) clearTimeout(timers.get(storeId));
  timers.set(storeId, setTimeout(() => {
    timers.delete(storeId);
    try {
      fs.mkdirSync(DIR, { recursive: true });
      const map = stores.get(storeId) || new Map();
      const list = [...map.entries()];
      const tmp = fileOf(storeId) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
      fs.renameSync(tmp, fileOf(storeId));
    } catch (_) { /* 落盘失败不影响回答 */ }
  }, 2000));
}

function prune(map) {
  const now = Date.now();
  for (const [id, s] of map) if (now - (s.updatedAt || 0) > TTL) map.delete(id);
  while (map.size > MAX_PER_STORE) {
    let oldest = null;
    for (const [id, s] of map) if (!oldest || (s.updatedAt || 0) < (oldest[1].updatedAt || 0)) oldest = [id, s];
    if (!oldest) break;
    map.delete(oldest[0]);
  }
}

function get(storeId, convId) {
  if (!convId) return null;
  const map = loadStore(storeId);
  const s = map.get(convId);
  if (!s) return null;
  if (Date.now() - (s.updatedAt || 0) > TTL) { map.delete(convId); saveStore(storeId); return null; }
  return s;
}

function update(storeId, convId, patch = {}) {
  if (!convId) return null;
  const map = loadStore(storeId);
  const cur = get(storeId, convId) || { id: convId, topic: '', answered: [], goods: '', turns: 0, history: '', updatedAt: 0 };
  if (patch.topic) cur.topic = patch.topic;
  if (patch.goods) cur.goods = String(patch.goods).slice(0, 40);
  if (patch.reply) {
    const text = String(patch.reply).slice(0, 16);
    if (text && !cur.answered.includes(text)) cur.answered.push(text);
    cur.answered = cur.answered.slice(-4);
  }
  cur.turns += 1;
  cur.updatedAt = Date.now();
  map.set(convId, cur);
  prune(map);
  saveStore(storeId);
  return cur;
}

/** 滚动摘要：超过 12 条窗口后，把更早的部分压成一行（不调模型） */
function compact(storeId, convId, messages, detectAsk) {
  const list = Array.isArray(messages) ? messages : [];
  const older = list.slice(0, Math.max(0, list.length - 12));
  if (!older.length) return;
  const asks = new Set();
  let order = '';
  let risky = false;
  for (const m of older) {
    const text = String(m.text || '');
    if (m.role !== 'buyer') continue;
    const a = typeof detectAsk === 'function' ? detectAsk(text) : 'other';
    if (a && a !== 'other') asks.add(ASK_CN[a] || a);
    const mo = text.match(/\d{10,}/);
    if (mo) order = mo[0];
    if (/投诉|退款|退货|差评/.test(text)) risky = true;
  }
  const parts = [];
  if (asks.size) parts.push('早期问过：' + [...asks].slice(0, 4).join('/'));
  if (order) parts.push('提到订单：' + order.slice(0, 4) + '****');
  if (risky) parts.push('提过售后/投诉');
  const map = loadStore(storeId);
  const cur = get(storeId, convId) || { id: convId, topic: '', answered: [], goods: '', turns: 0, history: '', updatedAt: 0 };
  cur.history = parts.join('；');
  cur.updatedAt = Date.now();
  map.set(convId, cur);
  saveStore(storeId);
}

function summary(storeId, convId) {
  const s = get(storeId, convId);
  if (!s) return '';
  const parts = [];
  if (s.history) parts.push(s.history);
  if (s.topic) parts.push('当前话题：' + s.topic);
  if (s.goods) parts.push('正在聊：' + s.goods);
  if (s.answered.length) parts.push('已经答过：' + s.answered.join('；'));
  return parts.join('；').slice(0, 220);
}

function reset() { stores.clear(); for (const t of timers.values()) clearTimeout(t); timers.clear(); }

module.exports = { get, update, compact, summary, reset, DIR };
