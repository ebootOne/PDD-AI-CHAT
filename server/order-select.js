'use strict';

/**
 * order-select.js —— 从买家这句话里筛订单候选（只做候选，不做最终决定）
 *
 * - 命中订单号/尾号 → 对应订单
 * - 命中商品名 → 含该商品的订单（可能多单，仍交给模型取舍）
 * - 没有任何命中 → 全部订单（怕漏就给全量，由模型判断/反问）
 */

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s+/g, '')
    .replace(/^\d{2,4}年/, '')
    .replace(/^加量\d+[张包]/, '')
    .replace(/^大包/, '')
    .split(/精品|正宗|加量|大包|大号|可湿水|透气|母婴|家用|商用/)[0];
}

function queryCore(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/那单|这单|那个|这个|哪单|哪款|呢|呀|吗|哈|的/g, '');
}

function orderMatchesText(order, q) {
  if (!q) return false;
  const no = String(order.orderNo || '').replace(/\D/g, '');
  if (no && q.replace(/\D/g, '').length >= 4) {
    const digits = q.replace(/\D/g, '');
    if (no.endsWith(digits.slice(-4)) || no.includes(digits)) return true;
  }
  return (order.items || []).some((it) => {
    const t = cleanTitle(it.title);
    if (!t) return false;
    if (q.includes(t) || t.includes(q)) return true;
    // “大蒜那单”这类：取商品名前后片段做包含
    return q.includes(t.slice(0, 4)) || q.includes(t.slice(-3)) || q.includes(t.slice(-2));
  });
}

function pickOrders(buyerText, orders, fallback) {
  const list = Array.isArray(orders) ? orders.filter((o) => o && o.hasOrder) : [];
  if (!list.length) return { orders: fallback ? [fallback] : [], matched: false, ambiguous: false };
  const q = queryCore(buyerText);
  const hit = list.filter((o) => orderMatchesText(o, q));
  if (!hit.length) return { orders: list, matched: false, ambiguous: list.length > 1 };
  return { orders: hit, matched: true, ambiguous: hit.length > 1 };
}

module.exports = { pickOrders, orderMatchesText, cleanTitle };
