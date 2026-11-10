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
  const productAsk = ['stock', 'product', 'price', 'spec'].includes(ask) || /还有货|有货|库存|其他.*品种|别的大蒜/.test(buyer);
  const explicitOrder = /那单|这单|订单|尾号|我买|这单/.test(buyer);
  const orderAsk = ['shipping_status', 'arrival_time', 'logistics'].includes(ask)
    || ((ask === 'courier' || /快递/.test(buyer)) && explicitOrder)
    || /那单.*(发货|到哪|物流|退款)|发货了吗|到哪了/.test(buyer);
  const isQuestion = /[？?]/.test(text);

  // 0) 快递/配送能力被绝对否定，没有事实依据 → 页面可选口径
  if (/(顺丰|快递|配送|发货)/.test(buyer) && /发不了|不能发|不支持|不配送|不到|不能到/.test(text)
      && !/页面|可选|为准/.test(text)) {
    return { text: '快递公司以页面可选为准哦，您下单时能看到可选快递，您下单时选一下地址就能看到可选快递哈。', reason: '无依据否定配送能力' };
  }

  // 1) 库存/品种题出现订单状态
  if (productAsk && /已发货|未发货|物流|订单页|运单|签收|退款成功/.test(text)) {
    if (/其他.*品种|别的大蒜|还有别的/.test(buyer)) {
      return { text: '您问的是其他品种的大蒜呀？店铺在售品种以页面为准，您搜「大蒜」看看哈。', reason: '库存/品种题用了订单事实' };
    }
    if (ask === 'price' || /多少钱|价格|便宜/.test(buyer)) {
      return { text: '价格以页面显示为准哦，具体规格价格可以在商品页看到。', reason: '价格题用了订单状态' };
    }
    if (ask === 'spec' || /规格|多大|尺寸|多粗/.test(buyer)) {
      return { text: '具体规格以商品页标注为准哦，您可以在页面选到对应尺寸。', reason: '规格题用了订单状态' };
    }
    if (/我买|这个订单|这单/.test(buyer)) {
      return { text: '您问的是您买的这款大蒜还有没有货呀？我帮您确认哈。', reason: '库存题用了订单状态' };
    }
    return { text: '您问的是哪款商品的库存呀？我帮您确认哈。', reason: '库存题用了订单状态' };
  }

  // 2) 多订单 + 只答一单
  if (orderAsk && orders.length > 1 && !isQuestion
      && !/那单|这单|订单号|尾号/.test(buyer)
      && !/两单|都发|全部都|全部|退款/.test(text)
      && !/另外|其他两单/.test(buyer)) {
    const names = orderSummary(orders);
    return { text: '您有多单：' + names + '，您问的是哪一单呀？', reason: '多订单只覆盖一部分' };
  }

  // 3) 尾号重复 + 默认第一单
  const tail = (buyer.match(/\b(\d{4})\b/) || [])[1];
  if (tail && orders.length > 1) {
    const same = orders.filter((o) => String(o.orderNo || '').endsWith(tail));
    if (same.length > 1 && !isQuestion) {
      return { text: '这几单尾号都是' + tail + '，您问的是' + orderSummary(same) + '哪一单呀？', reason: '尾号重复不能默认第一单' };
    }
  }

  // 4) 点名商品对应到已退款单
  if (orderAsk && !/退款/.test(text)) {
    const named = orders.find((o) => (o.items || []).some((it) => titleHit(it.title, buyer)));
    if (named && /退款/.test(String(named.status || ''))) {
      return { text: '这单已经退款成功了，您在订单页能查到退款进度哦。', reason: '点名订单已退款但答页面' };
    }
  }

  // 5) 已退款单答成“看页面”
  if (orderAsk) {
    const usedOrderNos = used.map((id) => {
      const x = (facts.allItems || facts.items || []).find((i) => i.id === id);
      return x && x.orderNo ? String(x.orderNo) : '';
    }).filter(Boolean);
    if (usedOrderNos.length === 1) {
      const o = orders.find((x) => String(x.orderNo || '') === usedOrderNos[0]);
      if (o && /退款/.test(String(o.status || '')) && !/退款/.test(text)) {
        return { text: '这单已经退款成功了，您在订单页能查到退款进度哦。', reason: '已退款单没有说明退款' };
      }
    }
  }

  return null;
}

module.exports = { guard };
