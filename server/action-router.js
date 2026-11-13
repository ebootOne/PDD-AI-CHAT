'use strict';

/**
 * action-router.js —— 从买家话里识别“明确动作请求”，生成计划；不执行页面操作。
 */

const { refundPlan } = require('./actions');

const REFUND_ACTION = /退款|退货退款|退钱|申请售后|帮我退|我想退|我要退|给我退|退下款|退个款/;
const REFUND_INFO = /怎么退|如何退|能退吗|可以退吗|退款多久|退款流程|退货规则|多久到账/;
const INVITE_ACTION = /邀请下单|发我.*(商品|链接|卡片)|我要买|拍这个|下单这个|发个商品/;
const INVITE_INFO = /怎么下单|如何下单|怎么买/;

function specFromText(text) {
  return (String(text || '').match(/\d+mm(?:左右)?|\d+条装[^，,。\s]*|\d+头[^，,。\s]*/g) || []).join(' ').trim();
}

function plan(input = {}) {
  const text = String(input.buyerText || '');
  if (!text) return null;
  const recent = (Array.isArray(input.messages) ? input.messages : [])
    .filter((m) => m && m.role === 'buyer')
    .slice(-4).map((m) => String(m.text || '')).join(' ');
  const confirmReceived = /收到了|已经收到|已收到|到了|没收到|未收到|还没到|拒收/.test(text);
  const previousRefund = REFUND_ACTION.test(recent) && !REFUND_INFO.test(text);

  if (!REFUND_INFO.test(text) && (REFUND_ACTION.test(text) || (previousRefund && confirmReceived))) {
    const order = input.order || (Array.isArray(input.orders) ? input.orders[0] : null);
    const p = refundPlan({ order, buyerText: text + ' ' + recent, received: input.received });
    return {
      kind: 'refund',
      plan: p,
      needs: p.missing,
      canAuto: !p.closed && p.missing.length === 0,
      reason: '买家明确要求退款/售后',
    };
  }

  if (!INVITE_INFO.test(text) && INVITE_ACTION.test(text)) {
    const product = input.product || null;
    const spec = String(input.spec || '').trim() || specFromText(text);
    return {
      kind: 'invite',
      product: product ? { goodsId: product.goodsId, title: product.title } : null,
      spec,
      needs: [...(product ? [] : ['product']), ...(spec ? [] : ['spec'])],
      canAuto: false,
      reason: '需要商品/SKU 精确匹配后再发送',
    };
  }

  return null;
}

module.exports = { plan, specFromText, REFUND_ACTION, INVITE_ACTION };
