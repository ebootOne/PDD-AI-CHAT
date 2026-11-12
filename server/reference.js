'use strict';

/**
 * reference.js —— 先解析买家在说哪个商品/订单，再决定答还是问。
 * 目录检索不到 ≠ 买家没说清；能确定主题但没数据，应给该主题的页面口径。
 */

const productIndex = require('./product-index');

function core(t) {
  return String(t || '').replace(/^\d{2,4}年/, '').replace(/^加量\d+[张包]/, '').replace(/^大包/, '')
    .split(/精品|正宗|加量|大包|大号|可湿水|透气|母婴|家用|商用/)[0];
}

function short(t) {
  const c = core(t).replace(/[\s\d]/g, '');
  return c.length > 10 ? c.slice(0, 10) : c;
}

function hit(text, title) {
  const c = core(title);
  if (!c) return false;
  const s = String(text || '');
  if (s.includes(c)) return true;
  for (let i = 0; i + 2 <= c.length; i++) if (s.includes(c.slice(i, i + 2))) return true;
  return false;
}

function resolve(input = {}) {
  const buyer = String(input.buyerText || '');
  const msgs = Array.isArray(input.messages) ? input.messages : [];
  const recent = msgs.slice(-6).map((m) => m.text || '').join(' ');
  const goods = input.goods || {};
  const orders = Array.isArray(input.orders) ? input.orders.filter((o) => o && o.hasOrder) : [];
  const products = Array.isArray(input.products) ? input.products : [];
  const orderItems = orders.flatMap((o) => (o.items || []).map((it) => ({ ...it, orderNo: o.orderNo, status: o.status })));

  const explicitOrder = orderItems.find((it) => hit(buyer, it.title));
  const topicTitles = [...orderItems.map((x) => x.title), goods.title, ...products.map((p) => p.title)].filter(Boolean);
  const mentioned = topicTitles.filter((t) => hit(buyer, t) || hit(recent, t));
  const candidates = productIndex.search(products, buyer + ' ' + recent, 5);
  const orderCandidates = orderItems.filter((it) => hit(buyer, it.title) || hit(recent, it.title));

  let ref = null;
  let source = '';
  if (explicitOrder) {
    ref = { kind: 'order_item', title: short(explicitOrder.title), orderNo: explicitOrder.orderNo, status: explicitOrder.status };
    source = 'explicit_order';
  } else if (goods.title && hit(buyer, goods.title) === false && /这个|这款|它/.test(buyer)) {
    ref = { kind: 'current', title: short(goods.title) };
    source = 'current_goods';
  } else if (mentioned.length === 1) {
    ref = { kind: 'topic', title: short(mentioned[0]) };
    source = 'history_topic';
  } else if (mentioned.length > 1) {
    ref = { kind: 'family', title: short(mentioned[0]) };
    source = 'multi_topic';
  } else if (candidates.length === 1) {
    ref = { kind: 'catalog', title: short(candidates[0].title), product: candidates[0] };
    source = 'catalog_single';
  }

  // 历史/当前句有明确品类，但目录没有该商品：是数据缺失，不是买家没说
  if (!ref) {
    const family = /大蒜|蒜头|蒜/.test(buyer + recent) ? '大蒜' : '';
    if (family) { ref = { kind: 'family', title: family, dataGap: true }; source = 'family_topic'; }
    else if (goods.title) { ref = { kind: 'current', title: short(goods.title) }; source = 'current_goods'; }
  }

  return {
    ref,
    source,
    candidates: candidates.map((p) => ({ title: p.title, goodsId: p.goodsId || '', price: p.price, stock: p.stock })),
    orderCandidates: orderCandidates.map((x) => ({ title: x.title, orderNo: x.orderNo, status: x.status })),
    ambiguity: !ref && candidates.length !== 1,
  };
}

module.exports = { resolve, core, hit };
