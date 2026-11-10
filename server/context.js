'use strict';

/**
 * context.js —— 候选事实池（上下文选择架构第一步）
 *
 * 只负责“有什么事实可用”，不判断“这句话需要哪些事实”。
 * 相关性、取舍、是否反问，由模型基于这些带 ID 的候选决定。
 */

function clean(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/(?<![\d-])1[3-9]\d{9}(?![\d-])/g, '')
    .trim();
}

function shortTitle(title, max = 18) {
  const s = String(title || '').replace(/\s+/g, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function orderText(o) {
  const bits = [];
  if (o.orderNo) bits.push('订单号：' + o.orderNo);
  if (o.status) bits.push('状态：' + o.status);
  if (Array.isArray(o.items) && o.items.length) bits.push('商品：' + o.items.map((x) => clean(x.title)).filter(Boolean).join('、'));
  if (Array.isArray(o.packages) && o.packages.length) {
    bits.push('包裹：' + o.packages.map((p) => (p.courier || '快递') + (p.trackingNo ? '尾号' + String(p.trackingNo).slice(-4) : '')).join('；'));
  }
  return bits.join('；');
}

function build(input = {}) {
  const storeId = input.storeId || '';
  const items = [];
  const stats = { orders: 0, products: 0, policies: 0, conversation: 0 };
  const inStore = (x) => !storeId || !x.storeId || x.storeId === storeId;

  // 1) 当前商品
  const goods = input.goods || {};
  if (goods.title) {
    items.push({
      id: 'P0', block: 'product', label: '当前商品',
      text: clean(goods.title) + (goods.spec ? '；规格：' + clean(goods.spec) : ''),
      source: 'goods',
    });
    stats.products++;
  }

  // 2) 当前买家订单（全部，不按问题筛）
  const orders = (Array.isArray(input.orders) ? input.orders : (input.order ? [input.order] : []))
    .filter((o) => o && o.hasOrder && inStore(o)).slice(0, 5);
  orders.forEach((o, i) => {
    items.push({ id: 'O' + (i + 1), block: 'order', label: '订单' + (i + 1), text: clean(orderText(o)), source: 'order' });
  });
  stats.orders = orders.length;

  // 3) 商品目录候选（不按问题筛）
  const products = (Array.isArray(input.products) ? input.products : []).filter(inStore).slice(0, 8);
  products.forEach((p, i) => {
    items.push({
      id: 'G' + (i + 1), block: 'product', label: '商品' + (i + 1),
      text: shortTitle(p.title) + (p.price != null ? '；价格 ' + p.price + ' 元' : '') + (Number.isFinite(Number(p.stock)) ? '；库存 ' + p.stock : ''),
      source: 'catalog', updatedAt: p.syncedAt || null,
    });
  });
  stats.products += products.length;

  // 4) 店铺知识/政策
  const kb = (Array.isArray(input.kb) ? input.kb : []).filter(inStore).slice(0, 20);
  kb.forEach((k, i) => {
    items.push({ id: 'K' + (i + 1), block: 'policy', label: clean(k.title), text: clean(k.answer), source: 'knowledge', updatedAt: k.updatedAt || null });
  });
  stats.policies = kb.length;

  // 5) 最近会话（主题/指代）
  const msgs = (Array.isArray(input.messages) ? input.messages : []).slice(-8);
  msgs.forEach((m, i) => {
    if (!m || !m.text) return;
    items.push({ id: 'C' + (i + 1), block: 'conversation', label: m.role === 'buyer' ? '买家' : '客服', text: clean(m.text), source: 'conversation' });
  });
  stats.conversation = msgs.length;

  // 6) 店铺档案
  if (input.profile && input.profile.hours && input.profile.hours.start) {
    items.push({ id: 'S1', block: 'profile', label: '客服在线', text: input.profile.hours.start + '到' + input.profile.hours.end, source: 'profile' });
  }

  return {
    items,
    stats,
    route: { asks: [], mode: 'candidate-pool', blocks: [...new Set(items.map((x) => x.block))] },
    budget: { tokens: 0 },
    missing: [],
  };
}

module.exports = { build };
