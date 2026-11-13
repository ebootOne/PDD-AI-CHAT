'use strict';

/**
 * action-router.js —— 从买家话里识别“明确动作请求”，生成计划；不执行页面操作。
 */

const { refundPlan } = require('./actions');

const REFUND_ACTION = /(我要|我想|帮我|给我|直接|申请|走)\s*(退款|退货退款|退钱|售后)|申请售后|退货退款/;
const REFUND_INFO = /怎么退|如何退|能退吗|可以退吗|退款多久|退款流程|退货规则|多久到账/;
const INVITE_ACTION = /邀请下单|发我.*(商品|链接|卡片)|我要买|拍这个|下单这个|发个商品/;
const INVITE_INFO = /怎么下单|如何下单|怎么买/;

function plan(input = {}) {
  const text = String(input.buyerText || '');
  if (!text) return null;

  if (!REFUND_INFO.test(text) && REFUND_ACTION.test(text)) {
    const order = input.order || (Array.isArray(input.orders) ? input.orders[0] : null);
    const p = refundPlan({ order, buyerText: text, received: input.received });
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
    const spec = String(input.spec || '').trim();
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

module.exports = { plan, REFUND_ACTION, INVITE_ACTION };
