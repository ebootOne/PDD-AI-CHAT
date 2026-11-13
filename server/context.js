'use strict';

/**
 * context.js —— 候选事实池（上下文选择架构第一步）
 *
 * 只负责“有什么事实可用”，不判断“这句话需要哪些事实”。
 * 相关性、取舍、是否反问，由模型基于这些带 ID 的候选决定。
 */

const registry = require('./block-registry');
const productIndex = require('./product-index');
const referenceResolver = require('./reference');

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
  if (Array.isArray(o.items) && o.items.length) {
    bits.push('商品：' + o.items.map((x) => [clean(x.title), x.spec ? '规格' + clean(x.spec) : '', x.qty ? '数量' + clean(x.qty) : ''].filter(Boolean).join(' ')).filter(Boolean).join('、'));
  }
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
  const goodsTitle = String((input.goods && input.goods.title) || '');
  const isSeedGoods = /种子|籽|种苗|育苗|菜种|花种|萝卜|番茄|生菜|辣椒|黄瓜|南瓜|玉米/.test(goodsTitle);
  const seedWord = /种子|播种|浸种|催芽|发芽|出芽|出苗|种植|土壤|浇水|施肥|苗期|泡种|露白/;
  const domainOk = (text) => isSeedGoods || !seedWord.test(String(text || ''));

  // 1) 当前商品
  const goods = input.goods || {};
  if (goods.title) {
    items.push({
      id: 'P0', block: 'product', label: '当前商品',
      text: clean(goods.title) + (goods.spec ? '；规格：' + clean(goods.spec) : ''),
      source: 'goods', goodsId: goods.goodsId || '', entity: 'product:current', attrs: ['product_title', ...(goods.spec ? ['product_spec'] : [])],
    });
    stats.products++;
  }

  // 商品域：非种子商品，不允许用种子/种植口径回答
  const seedGoods = /种子|籽|种苗|育苗|菜种|花种|萝卜|番茄|生菜|辣椒|黄瓜|南瓜|玉米/.test(goodsTitle);
  if (goodsTitle && !seedGoods) {
    items.push({ id: 'D1', block: 'profile', label: '商品域', text: '当前商品是用品，不是种子；不要使用浸种、催芽、播种、土壤、育苗等种子种植口径。', source: 'domain', entity: 'domain:goods', attrs: ['domain'] });
  }

  // 2) 当前买家订单（全部，不按问题筛）
  const orders = (Array.isArray(input.orders) ? input.orders : (input.order ? [input.order] : []))
    .filter((o) => o && o.hasOrder && inStore(o)).slice(0, 5);
  orders.forEach((o, i) => {
    items.push({
      id: 'O' + (i + 1), block: 'order', label: '订单' + (i + 1), text: clean(orderText(o)), source: 'order', orderNo: o.orderNo || '',
      entity: 'order:' + (o.orderNo || i + 1),
      attrs: ['order_status', ...((o.packages || []).length ? ['order_courier', 'order_tracking'] : []), ...((o.items || []).some((x) => x.spec) ? ['order_spec'] : []), ...((o.items || []).length ? ['order_items'] : [])],
    });
  });
  stats.orders = orders.length;

  // 3) 商品检索候选：只给当前商品/订单/会话/问题相关 top-K，不传全店
  const allProducts = (Array.isArray(input.products) ? input.products : []).filter(inStore)
    .filter((p) => p.enabled !== false && p.status !== 'off_shelf');
  const queryText = [
    input.buyerText || '',
    goods.title || '',
    ...orders.flatMap((o) => (o.items || []).map((x) => x.title || '')),
    ...(Array.isArray(input.messages) ? input.messages.slice(-4).map((m) => m.text || '') : []),
  ].join(' ');
  const pickedProducts = productIndex.search(allProducts, queryText, 5);
  const products = pickedProducts;
  products.forEach((p, i) => {
    items.push({
      id: 'G' + (i + 1), block: 'product', label: '商品' + (i + 1),
      text: shortTitle(p.title) + (p.price != null ? '；价格 ' + p.price + (Number(p.priceMax) > Number(p.price) ? '~' + p.priceMax : '') + ' 元' : '') + (Number.isFinite(Number(p.stock)) ? '；库存 ' + p.stock : ''),
      source: 'catalog', updatedAt: p.syncedAt || null, goodsId: p.goodsId || '',
      entity: 'product:' + (p.goodsId || p.title || i + 1),
      attrs: ['product_title', ...(p.price != null ? ['product_price'] : []), ...(Number.isFinite(Number(p.stock)) ? ['product_stock'] : []), ...(p.spec ? ['product_spec'] : [])],
    });
  });
  stats.products += products.length;

  // 4) 说明书（当前商品全部节，不按问题筛）
  const manual = input.manual;
  if (manual && Array.isArray(manual.sections)) {
    manual.sections.filter((s) => domainOk((s.title || '') + (s.content || ''))).forEach((s, i) => {
      items.push({ id: 'M' + (i + 1), block: 'manual', label: clean(s.title), text: clean(s.content), source: 'manual', section: s.title, entity: 'manual:current', attrs: ['manual_section'] });
    });
  }

  // 5) 店铺知识/政策
  const kb = (Array.isArray(input.kb) ? input.kb : []).filter(inStore).filter((k) => domainOk((k.title || '') + (k.answer || ''))).slice(0, 20);
  kb.forEach((k, i) => {
    items.push({ id: 'K' + (i + 1), block: 'policy', label: clean(k.title), text: clean(k.answer), source: 'knowledge', updatedAt: k.updatedAt || null, topic: k.title, entity: 'policy', attrs: ['policy'] });
  });
  stats.policies = kb.length;

  // 5) 最近会话（主题/指代）
  const sessionGapMinutes = Number(input.sessionGapMinutes) || 0;
  const rawMsgs = Array.isArray(input.messages) ? input.messages : [];
  // 超过 30 分钟视为新会话段：不继承上一段话题，只保留当前消息
  const scopedMsgs = sessionGapMinutes > 30 ? rawMsgs.slice(-1) : rawMsgs;
  const msgs = scopedMsgs.slice(-8);
  if (sessionGapMinutes > 30) {
    items.push({ id: 'S1', block: 'conversation', label: '会话段', text: '距上次买家消息 ' + sessionGapMinutes + ' 分钟，按新会话处理，不继承上一段话题', source: 'session', entity: 'session', attrs: ['session'] });
  }
  msgs.forEach((m, i) => {
    if (!m || !m.text) return;
    items.push({ id: 'C' + (i + 1), block: 'conversation', label: m.role === 'buyer' ? '买家' : '客服', text: clean(m.text), source: 'conversation', entity: 'conversation', attrs: ['conversation'] });
  });
  stats.conversation = msgs.length;

  // 6) 店铺档案
  if (input.profile && input.profile.hours && input.profile.hours.start) {
    items.push({ id: 'S1', block: 'profile', label: '客服在线', text: input.profile.hours.start + '到' + input.profile.hours.end, source: 'profile', entity: 'profile', attrs: ['profile'] });
  }

  const reference = referenceResolver.resolve({ buyerText: input.buyerText || '', messages: scopedMsgs, goods, orders, products: allProducts });
  if (reference.ref) {
    items.push({ id: 'T1', block: 'topic', label: '当前话题', text: '买家在问：' + reference.ref.title + '（' + reference.source + '）', source: 'reference', entity: reference.ref.kind + ':' + reference.ref.title, attrs: ['topic'] });
  }
  const hasStockFact = items.some((x) => x.block === 'product' && (x.attrs || []).includes('product_stock'));
  const productAsk = /有货|库存|规格|价格|便宜|多少钱|品种|哪款|这款|商品|蒜/.test(input.buyerText || '');
  const emptyStore = allProducts.length === 0;
  const orderAsk = /那单|这单|发货|到哪|到货|签收|收到|物流|退款|订单|买的/.test(input.buyerText || '');
  if ((reference.ref || emptyStore) && !hasStockFact && productAsk && !(orderAsk && !/有货|库存|规格|价格|便宜|多少钱|品种|哪款/.test(input.buyerText || ''))) {
    items.push({
      id: 'N1', block: 'product', label: '商品状态',
      text: (reference.ref ? reference.ref.title + '目前不在本店在售商品里；' : '') + '本店当前没有在售商品，暂无库存数据。',
      source: 'reference', entity: 'product:unavailable', attrs: ['product_availability'],
    });
  }
  const blocks = registry.manifest({ orders, products: allProducts, manual, kb, messages: msgs, profile: input.profile, goods });
  // 初始只给核心事实：当前商品、订单、最近会话、商品目录、档案。
  // 说明书/政策细节不进初始包，模型按 blocks 目录用 need 要。
  const core = [];
  const seen = new Set();
  const add = (x) => { if (x && !seen.has(x.id) && core.length < 8) { seen.add(x.id); core.push(x); } };
  items.filter((x) => x.block === 'product' && x.id === 'P0').forEach(add);
  items.filter((x) => x.block === 'order').forEach(add);
  items.filter((x) => x.block === 'conversation').slice(-2).forEach(add);
  items.filter((x) => x.block === 'product' && x.id !== 'P0').forEach(add);
  items.filter((x) => x.block === 'profile').forEach(add);
  items.filter((x) => x.id === 'D1').forEach(add);
  items.filter((x) => x.block === 'topic').forEach(add);
  items.filter((x) => x.block === 'product' && x.id === 'N1').forEach(add);
  return {
    items: core,
    allItems: items,
    catalog: allProducts,
    reference,
    blocks,
    stats,
    route: { asks: [], mode: 'candidate-pool', blocks: [...new Set(items.map((x) => x.block))] },
    budget: { tokens: 0 },
    missing: [],
  };
}

function validateUsed(pack, used) {
  const ids = new Set(((pack && pack.items) || []).map((x) => x.id));
  const list = Array.isArray(used) ? used.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean) : [];
  const valid = [];
  const invalid = [];
  for (const u of list) (ids.has(u) ? valid : invalid).push(u);
  return { valid: [...new Set(valid)], invalid: [...new Set(invalid)] };
}

module.exports = { build, validateUsed };
