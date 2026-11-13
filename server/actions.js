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

function receivedFromText(text) {
  const t = String(text || '');
  if (/没收到|未收到|还没到|没到货|拒收|退回/.test(t)) return false;
  if (/已经到|已到|收到货|收到了|已经收到|签收|取了|拿到了/.test(t)) return true;
  return null;
}

function reasonFromText(text) {
  const t = String(text || '');
  if (/空包/.test(t)) return '空包裹';
  if (/少发|漏发|少件|少配件/.test(t)) return '收到商品少件（含少配件）';
  if (/破损|污渍|坏了|裂/.test(t)) return '商品破损或污渍';
  if (/错发|发错|拍错|买错/.test(t)) return '卖家发错货';
  if (/质量/.test(t)) return '质量问题';
  if (/不喜欢|效果不好|不满意/.test(t)) return '不喜欢、效果不好';
  if (/不想要|不需要|多买/.test(t)) return '不想要了';
  if (/缺货|没货/.test(t)) return '缺货';
  if (/发货慢|太慢/.test(t)) return '发货慢';
  return '';
}

function refundPlan(input = {}) {
  const buyerReceived = input.buyerReceived != null ? input.buyerReceived : receivedFromText(input.buyerText);
  const buyerReason = input.reason || reasonFromText(input.buyerText);
  const order = input.order || null;
  const status = String((order && order.status) || '');
  const received = input.received === true || input.received === false ? input.received : (buyerReceived != null ? buyerReceived : inferReceived(order));
  const amount = Number(input.amount != null ? input.amount : (order && order.paid) || (order && order.amount) || 0);
  const type = input.type || (received === false ? 'refund_only' : received === true ? 'return_refund' : null);
  const reason = String(buyerReason || '').trim();
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

module.exports = { refundPlan, invitePlan, matchSku, inferReceived, receivedFromText, reasonFromText, REFUND_TYPES };
