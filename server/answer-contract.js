'use strict';

/**
 * answer-contract.js —— 实体/属性/答案一致性校验。
 * 事实带 attrs；模型声明 target.attribute；本地只校验属性是否匹配，不决定业务答案。
 */

const ASK_ATTRS = {
  stock: ['product_stock'],
  price: ['product_price'],
  nego: ['product_price'],
  spec: ['product_spec', 'order_spec'],
  courier: ['order_courier', 'policy'],
  shipping_status: ['order_status', 'order_tracking', 'order_courier'],
  logistics: ['order_status', 'order_tracking', 'order_courier'],
  arrival_time: ['order_status', 'order_tracking'],
  invoice: ['policy'],
  freight: ['policy'],
  usage: ['manual_section', 'policy'],
  after_sale: ['policy', 'manual_section', 'order_status'],
  return_policy: ['policy', 'order_status'],
  product: ['product_title', 'product_stock', 'product_price', 'product_spec'],
};

function attrsOf(pack, used) {
  const items = (pack && (pack.allItems || pack.items)) || [];
  const ids = new Set((used || []).map(String));
  const set = new Set();
  for (const x of items) if (ids.has(String(x.id))) (x.attrs || []).forEach((a) => set.add(a));
  return set;
}

function check(input = {}) {
  const ask = String(input.ask || '');
  const expected = ASK_ATTRS[ask] || [];
  const used = Array.isArray(input.used) ? input.used : [];
  const target = input.target && typeof input.target === 'object' ? input.target : null;
  const attrs = attrsOf(input.facts, used);
  const allItems = (input.facts && (input.facts.allItems || input.facts.items)) || [];
  const hasExpectedFacts = expected.length && allItems.some((x) => (x.attrs || []).some((a) => expected.includes(a)));
  const targetAttr = target && target.attribute ? String(target.attribute) : '';
  const text = String(input.text || '');
  const orders = Array.isArray(input.orders) ? input.orders.filter((o) => o && o.hasOrder) : [];
  const buyerText = String(input.buyerText || '');
  const titleHit = (title) => {
    const core = String(title || '').replace(/^\d{2,4}年/, '').replace(/^加量\d+[张包]/, '').replace(/^大包/, '').split(/精品|正宗|加量|大包|大号|可湿水/)[0];
    if (!core) return false;
    if (buyerText.includes(core)) return true;
    for (let i = 0; i + 2 <= core.length; i++) if (buyerText.includes(core.slice(i, i + 2))) return true;
    return false;
  };
  const specific = /那单|这单|订单号|尾号/.test(buyerText) || orders.some((o) => (o.items || []).some((it) => titleHit(it.title)));
  const usedOrderNos = (input.used || []).map((id) => {
    const x = ((input.facts && (input.facts.allItems || input.facts.items)) || []).find((i) => i.id === id);
    return x && x.orderNo ? String(x.orderNo) : '';
  }).filter(Boolean);
  const issues = [];
  const stockTalk = /(有货|无货|缺货|库存充足|现货|能拍|拍下)/.test(text);
  const orderTalk = /(已发货|未发货|物流|订单页|运单|签收|退款成功)/.test(text);
  if (expected.includes('product_stock') && orderTalk && !stockTalk) {
    issues.push('回答文本是订单状态，不是库存');
  }
  if (expected.includes('order_status') && /(元|价格|库存|有货)/.test(text) && !orderTalk) {
    issues.push('回答文本是商品属性，不是订单状态');
  }
  if (!specific && orders.length > 1 && ['shipping_status', 'logistics', 'arrival_time'].includes(ask)
      && usedOrderNos.length < orders.length && !/[？?]/.test(text) && !/两单|都发|全部/.test(text)) {
    issues.push('多订单没有覆盖全部订单');
  }
  if (orders.length > 1) {
    const tail = (String(input.buyerText || '').match(/\b(\d{4})\b/) || [])[1];
    if (tail) {
      const same = orders.filter((o) => String(o.orderNo || '').endsWith(tail));
      if (same.length > 1 && usedOrderNos.length === 1 && !/[？?]/.test(text)) issues.push('尾号重复默认第一单');
    }
  }
  const one = usedOrderNos.length === 1 && orders.find((o) => String(o.orderNo || '') === usedOrderNos[0]);
  if (one && /退款/.test(String(one.status || '')) && !/退款/.test(text)) {
    issues.push('已退款单没有说明退款');
  }
  const namedRefund = orders.find((o) => /退款/.test(String(o.status || '')) && (o.items || []).some((it) => titleHit(it.title)));
  if (namedRefund && !/退款/.test(text)) issues.push('已退款单没有说明退款');
  if (expected.includes('product_price') && orderTalk && !/(元|价格|标价|优惠|活动)/.test(text)) {
    issues.push('回答文本是订单状态，不是价格');
  }
  if ((expected.includes('product_spec') || expected.includes('order_spec'))
      && orderTalk && !/(mm|毫米|厘米|规格|尺寸|大小|多大|单果)/.test(text)) {
    issues.push('回答文本是订单状态，不是规格');
  }

  if (targetAttr && expected.length && !expected.includes(targetAttr)) {
    issues.push('target属性与当前问题不一致');
  }
  if (targetAttr && !attrs.has(targetAttr)) {
    issues.push('target属性没有对应事实');
  }
  if (hasExpectedFacts && used.length && !expected.some((a) => attrs.has(a))) {
    issues.push('used事实没有覆盖当前问题属性');
  }

  return {
    ok: issues.length === 0,
    ask,
    expected,
    target: targetAttr,
    usedAttrs: [...attrs],
    issues: [...new Set(issues)],
  };
}

function safeText(contract) {
  const e = (contract && contract.expected) || [];
  const issues = (contract && contract.issues) || [];
  if (issues.some((x) => /已退款/.test(x))) return '这单已经退款成功了，您在订单页能查到退款进度哦。';
  if (e.includes('product_stock')) return '您问的是哪款商品的库存呀？我帮您确认哈。';
  if (e.includes('product_price')) return '价格以页面显示为准哦，具体规格价格可以在商品页看到。';
  if (e.includes('product_spec') || e.includes('order_spec')) return '具体规格以商品页标注为准哦。';
  if (e.includes('order_status') || e.includes('order_courier') || e.includes('order_tracking')) return '您问的是哪一单呀？';
  return '这个信息以页面显示为准哈。';
}

module.exports = { check, ASK_ATTRS, attrsOf, safeText };
