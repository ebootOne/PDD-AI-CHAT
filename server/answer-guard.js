'use strict';

/**
 * answer-guard.js —— 最后一道事实兼容守卫。
 * 只拦截“问题类型和回答事实明显不匹配”，不生成业务事实。
 * 触发时给安全反问/状态口径，避免把订单状态当库存答案。
 */

function shortTitle(t) {
  return String(t || '').replace(/^\d{2,4}年/, '').replace(/^加量\d+[张包]/, '').replace(/^大包/, '').split(/精品|正宗|加量|大包|大号|可湿水/)[0].slice(0, 10);
}

function titleHit(title, buyer) {
  const core = shortTitle(title);
  if (!core) return false;
  if (buyer.includes(core)) return true;
  for (let i = 0; i + 2 <= core.length; i++) {
    if (buyer.includes(core.slice(i, i + 2))) return true;
  }
  return false;
}

function orderSummary(orders) {
  return orders.slice(0, 3).map((o) => {
    const name = shortTitle((o.items && o.items[0] && o.items[0].title) || '订单');
    const st = String(o.status || '');
    return name + (st ? '（' + st + '）' : '');
  }).join('、');
}

function guard(input = {}) {
  const ask = String(input.ask || '');
  const buyer = String(input.buyerText || '');
  const text = String(input.text || '');
  const orders = (Array.isArray(input.orders) ? input.orders : []).filter((o) => o && o.hasOrder);
  const facts = input.facts || {};
  const used = Array.isArray(facts.used) ? facts.used : [];
  const explicitOrder = /那单|这单|订单|尾号|我买|这单/.test(buyer);
  const orderAsk = ['shipping_status', 'logistics'].includes(ask)
    || ((ask === 'arrival_time' || ask === 'courier' || /快递/.test(buyer)) && explicitOrder)
    || /那单.*(发货|到哪|物流|退款)|发货了吗|到哪了/.test(buyer);
  const isQuestion = /[？?]/.test(text);

  // 0) 快递/配送能力被绝对否定，没有事实依据 → 页面可选口径
  if (/(顺丰|快递|配送|发货)/.test(buyer) && /发不了|不能发|不支持|不配送|不到|不能到|无法发/.test(text)
      && !/可选/.test(text)) {
    return { text: '快递公司以页面可选为准哦，您下单时能看到可选快递，您下单时选一下地址就能看到可选快递哈。', reason: '无依据否定配送能力' };
  }

  return null;
}

module.exports = { guard };
