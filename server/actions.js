'use strict';

/**
 * actions.js —— 退款/邀请下单的“计划层”
 *
 * 只做匹配与确认单，不点击拼多多提交。
 * 原则：能从订单/商品数据拿到的不问；拿不到或不确定的，必须人工确认。
 */

const REFUND_TYPES = {
  refund_only: '仅退款',
  return_refund: '退货退款',
};

function inferReceived(order) {
  const s = String((order && order.status) || '');
  if (/退款成功|已退款|退款关闭/.test(s)) return 'closed';
  if (/未发货|待发货/.test(s)) return false;
  if (/已签收|已收货|交易完成|确认收货/.test(s)) return true;
  if (/已发货|待签收|运输中|派送中/.test(s)) return null; // 物流状态不等于买家实际收到
  return null;
}

function refundPlan(input = {}) {
  const order = input.order || null;
  const status = String((order && order.status) || '');
  const received = input.received === true || input.received === false ? input.received : inferReceived(order);
  const amount = Number(input.amount != null ? input.amount : (order && order.paid) || (order && order.amount) || 0);
  const type = input.type || (received === false ? 'refund_only' : received === true ? 'return_refund' : null);
  const reason = String(input.reason || '').trim();
  const missing = [];
  if (!order || !order.hasOrder) missing.push('order');
  if (received === null) missing.push('received');
  if (!type) missing.push('type');
  if (!reason) missing.push('reason');
  if (!(amount > 0)) missing.push('amount');
  const closed = received === 'closed' || /退款成功/.test(status);
  return {
    kind: 'refund',
    orderNo: (order && order.orderNo) || '',
    status,
    received,
    suggestedType: received === false ? 'refund_only' : received === true ? 'return_refund' : null,
    type,
    typeName: type ? REFUND_TYPES[type] : '',
    amount,
    reason,
    missing,
    closed,
    needsHumanConfirm: true,
    canSubmit: !closed && missing.length === 0 && input.confirm === true,
  };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s，。！？、；：:：/\\\-_()（）【】]/g, '');
}

function matchSku(product, request = {}) {
  const skus = (product && Array.isArray(product.skus) ? product.skus : [])
    .filter((s) => s && s.enabled !== false && s.status !== 'off_shelf');
  if (!skus.length) return { mode: 'no_sku', matches: [], sku: null };
  if (request.skuId) {
    const one = skus.find((s) => String(s.skuId) === String(request.skuId));
    return one ? { mode: 'exact', matches: [one], sku: one } : { mode: 'not_found', matches: [], sku: null };
  }
  const q = norm(request.spec || request.text || '');
  if (!q) return { mode: 'need_spec', matches: skus, sku: null };
  const matches = skus.filter((s) => {
    const hay = norm([s.spec, s.style, s.model, ...(s.aliases || [])].filter(Boolean).join(' '));
    return hay && (hay.includes(q) || q.includes(hay));
  });
  if (matches.length === 1) return { mode: 'exact', matches, sku: matches[0] };
  if (matches.length > 1) return { mode: 'ambiguous', matches, sku: null };
  return { mode: 'not_found', matches: [], sku: null };
}

function invitePlan(input = {}) {
  const product = input.product || null;
  if (!product || !product.goodsId) {
    return { kind: 'invite', mode: 'no_product', product: null, sku: null, options: [], needsHumanConfirm: true, canSend: false };
  }
  const m = matchSku(product, { spec: input.spec, text: input.text, skuId: input.skuId });
  return {
    kind: 'invite',
    mode: m.mode,
    product: { goodsId: product.goodsId, title: product.title || '' },
    sku: m.sku ? { skuId: m.sku.skuId, spec: m.sku.spec || '', price: m.sku.price, stock: m.sku.stock } : null,
    options: m.matches.map((s) => ({ skuId: s.skuId, spec: s.spec || '', price: s.price, stock: s.stock })),
    needsHumanConfirm: true,
    canSend: m.mode === 'exact' && input.confirm === true,
  };
}

module.exports = { refundPlan, invitePlan, matchSku, inferReceived, REFUND_TYPES };
