'use strict';

/**
 * block-registry.js —— 事实块能力目录
 *
 * 告诉模型：有哪些块、现在能不能给、怎么按 selector 取。
 * 只描述数据源，不描述问法。
 */

function manifest(input = {}) {
  const orders = Array.isArray(input.orders) ? input.orders.filter((o) => o && o.hasOrder) : [];
  const products = Array.isArray(input.products) ? input.products : [];
  const manual = input.manual;
  const kb = Array.isArray(input.kb) ? input.kb : [];
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const blocks = [
    { type: 'order', available: orders.length > 0, count: orders.length, desc: '买家订单状态、商品、包裹、快递/运单；selector.orderId 选单' },
    { type: 'product', available: products.length > 0 || Boolean(input.goods && input.goods.title), count: products.length + (input.goods && input.goods.title ? 1 : 0), desc: '在售商品标题/价格/库存；selector.goodsId 选款' },
    { type: 'manual', available: Boolean(manual && manual.sections && manual.sections.length), sections: manual && manual.sections ? manual.sections.map((s) => s.title) : [], desc: '当前商品说明书；selector.section 选节' },
    { type: 'policy', available: kb.length > 0, topics: kb.map((k) => k.title).slice(0, 20), desc: '店铺政策/知识；selector.topic 选条' },
    { type: 'profile', available: Boolean(input.profile && input.profile.hours && input.profile.hours.start), desc: '客服在线时间' },
    { type: 'conversation', available: messages.length > 0, count: messages.length, desc: '最近会话主题/指代' },
    { type: 'tracking', available: false, desc: '平台实时物流轨迹；未接入，不可请求' },
  ];
  return blocks;
}

function resolve(packet, need) {
  const items = (packet && packet.items) || [];
  const selected = [];
  const errors = [];
  for (const req of (Array.isArray(need) ? need : [])) {
    const block = String((req && req.block) || '');
    const sel = (req && req.selector) || {};
    let hit = [];
    if (block === 'order') {
      hit = items.filter((i) => i.block === 'order' && (!sel.orderId || i.orderNo === sel.orderId || i.id === sel.orderId));
    } else if (block === 'manual') {
      hit = items.filter((i) => i.block === 'manual' && (!sel.section || String(i.label || '').includes(String(sel.section))));
    } else if (block === 'policy') {
      hit = items.filter((i) => i.block === 'policy' && (!sel.topic || String(i.label || '').includes(String(sel.topic))));
    } else if (block === 'product') {
      hit = items.filter((i) => i.block === 'product' && (!sel.goodsId || i.goodsId === sel.goodsId));
    } else if (block === 'profile') {
      hit = items.filter((i) => i.block === 'profile');
    } else if (block === 'conversation') {
      hit = items.filter((i) => i.block === 'conversation');
    } else {
      errors.push('未知事实块：' + block);
      continue;
    }
    if (!hit.length) errors.push('没有可用事实：' + block + (sel.section || sel.topic || sel.orderId || sel.goodsId ? ' / ' + JSON.stringify(sel) : ''));
    selected.push(...hit);
  }
  const seen = new Set();
  return { items: selected.filter((x) => !seen.has(x.id) && seen.add(x.id)), errors };
}

module.exports = { manifest, resolve };
