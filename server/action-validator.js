'use strict';

/**
 * action-validator.js —— 动作证据与澄清门
 *
 * 模型决定“想做什么”；这里只判断：
 *   1. 引用的订单/商品是否真的存在；
 *   2. 是否被当前消息或上下文明确指向；
 *   3. 必填槽位是否完整；
 *   4. 状态是否允许执行。
 * 证据不足 → 统一澄清，不默认、不猜。
 */

const templates = require('./action-templates');
const { receivedFromText, reasonFromText } = require('./actions');

function recentText(context = {}) {
  return (context.messages || []).slice(-8).map((m) => String((m && m.text) || '')).join(' ');
}

function titleHit(text, title) {
  const c = String(title || '').replace(/^\d{2,4}年/, '').replace(/\s+/g, '');
  if (!c) return false;
  if (String(text || '').includes(c.slice(0, 4))) return true;
  for (let i = 0; i + 2 <= c.length; i++) if (String(text || '').includes(c.slice(i, i + 2))) return true;
  return false;
}

function resolveOrder(action, context) {
  const orders = (context.orders || []).filter((o) => o && o.hasOrder);
  if (action.orderNo) {
    const one = orders.find((o) => String(o.orderNo) === String(action.orderNo));
    return one ? { order: one } : { error: 'order_not_found', orders };
  }
  if (orders.length === 1) return { order: orders[0] };
  if (!orders.length) return { error: 'no_order', orders };

  // 没有 orderNo：只有买家明确点中唯一商品时才允许
  const text = String(context.buyerText || '');
  const hits = orders.filter((o) => (o.items || []).some((it) => titleHit(text, it.title)));
  if (hits.length === 1) return { order: hits[0], inferredFrom: 'product' };
  return { error: 'order_ambiguous', orders };
}

function orderListText(orders) {
  return (orders || []).slice(0, 5).map((o) => {
    const it = (o.items && o.items[0]) || {};
    return (it.title || '商品').slice(0, 10) + '（' + (o.status || '状态未知') + '）';
  }).join('、');
}

function validateRefund(action, context) {
  const r = resolveOrder(action, context);
  if (!r.order) {
    if (r.error === 'no_order') {
      return { kind: 'clarify', needs: ['reason'], ask: '您是遇到什么问题了吗？我帮您申请退款。', evidenceError: 'no_order' };
    }
    return {
      kind: 'clarify',
      needs: ['order'],
      ask: r.orders && r.orders.length > 1
        ? '您有' + r.orders.length + '笔订单：' + orderListText(r.orders) + '。您要退哪一单呀？'
        : '您要退哪一单呀？我核对订单后帮您申请。',
      evidenceError: r.error,
    };
  }
  const order = r.order;
  if (/待支付/.test(String(order.status || ''))) {
    return { kind: 'clarify', needs: ['order'], ask: '这单还未支付，不需要退款，您可以直接取消订单。', evidenceError: 'unpaid' };
  }
  if (/退款成功|已退款/.test(String(order.status || ''))) {
    return { kind: 'clarify', needs: [], ask: '这单已经退款成功了，您在订单页能查到退款进度。', evidenceError: 'closed' };
  }

  const buyerText = String(context.buyerText || '');
  const received = action.received === true || action.received === false ? action.received
    : (receivedFromText(buyerText) != null ? receivedFromText(buyerText) : null);
  const reason = templates.REFUND_REASONS.includes(String(action.reason || ''))
    ? String(action.reason) : (reasonFromText(buyerText) || action.reason || '');
  const type = action.refundType || (received === false ? 'refund_only' : received === true ? 'return_refund' : '');
  const plan = templates.refund.fromModel({ ...action, orderNo: order.orderNo, received, reason, refundType: type }, {
    orders: [order], order, buyerText,
  });

  if (!plan.reason) return { kind: 'clarify', needs: ['reason'], ask: '您是遇到什么问题了吗？我帮您申请退款。', order, plan };
  if (!plan.type) return { kind: 'clarify', needs: ['received'], ask: '您收到货了吗？确认后我帮您申请退款。', order, plan };
  if (!plan.amount) return { kind: 'clarify', needs: ['amount'], ask: '这单的退款金额需要确认一下，您要退多少钱？', order, plan };
  if (!plan.canAuto) return { kind: 'clarify', needs: plan.needs || [], ask: '还差一点信息，我帮您确认后再申请退款。', order, plan };

  return { kind: 'refund', plan, order, canAuto: true };
}

function validateInvite(action, context) {
  const product = action.product || context.product || null;
  const spec = String(action.spec || context.spec || '').trim();
  const p = templates.invite.fromModel({ ...action, product, spec }, { product, spec });
  const needs = p.needs || [];
  if (needs.includes('product')) return { kind: 'clarify', needs, ask: '您要哪款商品呢？我帮您加到邀请清单。' };
  if (needs.includes('spec')) return { kind: 'clarify', needs, ask: '您要什么规格/款式呢？我帮您匹配。' };
  return { kind: 'invite', plan: p, product, spec, canAuto: true };
}

function validate(action, context = {}) {
  if (!action || action.kind === 'none') return { kind: 'none' };
  if (action.kind === 'ask') {
    return { kind: 'clarify', needs: action.needs || [], ask: action.ask || '麻烦您补充一下信息。' };
  }
  if (action.kind === 'refund') return validateRefund(action, context);
  if (action.kind === 'invite') return validateInvite(action, context);
  return { kind: 'none' };
}

module.exports = { validate, resolveOrder, orderListText, titleHit, recentText };
