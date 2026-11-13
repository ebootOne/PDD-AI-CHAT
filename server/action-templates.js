'use strict';

/**
 * action-templates.js —— 动作模板注册表
 *
 * 模型选择模板并填槽；本地只校验模板字段、平台枚举、订单状态和重复。
 * 退款/邀请不再靠本地关键词猜测。
 */

const { refundPlan, reasonFromText, inferReceived } = require('./actions');

const REFUND_REASONS = [
  '不喜欢、效果不好', '不想要了', '缺货', '发货慢', '质量问题', '卖家发错货',
  '空包裹', '其他原因', '收到商品少件（含少配件）', '商品破损或污渍',
];
const REFUND_TYPES = { refund_only: '退款', return_refund: '退货退款', resend: '补寄' };

const refund = {
  id: 'refund',
  title: '帮消费者申请售后',
  description: '买家明确要求退款/退货退款/补寄时使用；信息不足先追问。',
  required: ['orderNo', 'refundType', 'received', 'reason', 'amount'],
  enums: { refundType: Object.keys(REFUND_TYPES), reason: REFUND_REASONS },
  fromModel(action = {}, context = {}) {
    const orders = Array.isArray(context.orders) ? context.orders.filter((o) => o && o.hasOrder) : [];
    const order = action.orderNo
      ? (orders.find((o) => String(o.orderNo) === String(action.orderNo)) || context.order || null)
      : (orders.length === 1 ? orders[0] : (orders.length === 0 ? context.order : null));
    const received = action.received === true || action.received === false ? action.received
      : (context.buyerReceived != null ? context.buyerReceived : inferReceived(order));
    const reason = REFUND_REASONS.includes(String(action.reason || ''))
      ? String(action.reason)
      : (reasonFromText(context.buyerText) || '');
    const plan = refundPlan({
      order,
      boughtText: context.buyerText,
      buyerText: context.buyerText,
      received,
      type: action.refundType,
      reason,
      amount: Number(action.amount) || (order && order.paid) || (order && order.amount)
        || Number(String((order && order.items && order.items[0] && order.items[0].price) || '').replace(/[^\d.]/g, '')) || 0,
    });
    if (!plan.reason || !REFUND_REASONS.includes(plan.reason)) plan.missing = [...new Set([...(plan.missing || []), 'reason'])];
    if (plan.type && !REFUND_TYPES[plan.type]) plan.missing = [...new Set([...(plan.missing || []), 'type'])];
    return {
      template: 'refund',
      ...plan,
      needs: plan.missing,
      canAuto: !plan.closed && plan.missing.length === 0,
    };
  },
};

const invite = {
  id: 'invite',
  title: '邀请下单',
  description: '买家明确要某商品/规格时使用；商品与 SKU 必须唯一匹配。',
  required: ['product', 'spec'],
  fromModel(action = {}, context = {}) {
    const product = action.product || context.product || (context.products && context.products[0]) || null;
    const spec = String(action.spec || context.spec || '').trim();
    const needs = [...(product ? [] : ['product']), ...(spec ? [] : ['spec'])];
    return { template: 'invite', product, spec, needs, canAuto: !!(product && spec) };
  },
};

const registry = { refund, invite };

function get(id) { return registry[String(id || '')] || null; }

function matchLocal(text) {
  const t = String(text || '').replace(/[\s，。！？!?、；;：:]/g, '');
  if (/^(我要|我想|帮我|给我|麻烦|申请|办理|直接)*(退款|退货退款|退钱|退下款|退个款)$/.test(t)) {
    return { template: 'refund', slots: {} };
  }
  if (/^邀请下单$/.test(t)) return { template: 'invite', slots: {} };
  return null;
}

function manifest() {
  return Object.values(registry).map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    required: t.required || [],
    enums: t.enums || {},
  }));
}

module.exports = { registry, get, matchLocal, manifest, refund, invite, REFUND_REASONS, REFUND_TYPES };
