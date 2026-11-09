'use strict';

/**
 * policy.js —— 兜底与安抚话术
 *
 * 关键约束（2026-11-05）：默认「无人值守」。
 * 无人值守时，回复不许出现任何我们做不到的动作：
 *   安排人 / 反馈店里 / 稍后回复 / 帮您查 / 发我订单号或照片。
 *
 * 所以模板分两套：
 *   AUTO     全自动：只陈述、只安抚，承诺面为空
 *   ATTENDED 有人值守：才可以出现「已通知客服跟进」
 */

const AUTO = {
  care: [
    '非常抱歉给您带来困扰。',
    '实在不好意思，给您添麻烦了。',
  ],
  verify: [
    '这个问题我暂时没有准确信息，怕说错了误导您。',
    '这个我这边确实没有准确答案，不敢乱说误导您。',
  ],
  hold: [
    '这个问题我暂时确认不了，先不贸然回答您。',
  ],
  unknown: [
    '这个问题我暂时没有准确的信息，怕说错了误导您。',
    '这个我暂时给不了准确答复，不敢乱说。',
    '这个问题我暂时答不上来，不敢乱说误导您。',
  ],
};

const ATTENDED = {
  verify: ['这个我需要跟店里确认一下，马上回您。', '这个我确认一下，稍等片刻哈。'],
  hold: ['收到，我这边帮您查一下，稍等。', '好的，我帮您看一下，稍等哈。'],
  care: ['非常抱歉，您的问题我记录下来了，马上安排人跟进。', '实在抱歉，我已经把您的情况记下来了，会尽快有人跟进处理。'],
  unknown: ['这个问题我暂时没办法准确回答您，已经反馈给店里，稍后会有人跟进给您答复。', '这个我这边暂时给不了准确答复，已经转给店里，稍后回复您。'],
};

// 兼容旧引用
const LEVELS = ATTENDED;

function humanAvailable(ctx) {
  return Boolean(ctx && ctx.capabilities && ctx.capabilities.humanAvailable);
}

/**
 * 选一句兜底话术
 * @param {{risks?:string[], intent?:string, attempt?:number, noContext?:boolean, capabilities?:object}} ctx
 */
function pickFallback(ctx = {}) {
  const risks = ctx.risks || [];
  const attempt = Math.max(0, Number(ctx.attempt) || 0);
  const isComplaint = risks.includes('投诉威胁') || risks.includes('索赔诉求') || ctx.intent === 'complaint';
  const pool = humanAvailable(ctx) ? ATTENDED : AUTO;

  let level;
  if (isComplaint) level = attempt === 0 ? 'care' : 'unknown';
  else if (ctx.noContext) level = 'unknown';
  else if (attempt === 0) level = 'verify';
  else if (attempt === 1) level = 'hold';
  else level = 'unknown';

  const list = pool[level] || pool.unknown;
  return { level, text: list[attempt % list.length], attempt };
}

/**
 * 商人语气：按「问题类型」给，不按某一句买家原话给。
 * 无人值守版本不索取单号/照片、不承诺查单。
 */
const MERCHANT_AUTO = {
  shipping_delay: '实在不好意思让您久等了，给您添麻烦了，我们会马上跟进的，请放心！',
  shipping_status: '物流进度以订单页显示为准，您可以随时查看。',
  after_sale: '非常抱歉给您带来困扰，如果是质量问题，可以按平台规则申请售后处理。',
  generic: '非常抱歉给您添麻烦了，您的情况我记下了。',
  grow: '只要温度合适都能种，注意保温和光照就行。',
};

const MERCHANT_ATTENDED = {
  shipping_delay: '实在不好意思让您久等了，给您添麻烦了，我们会马上跟进的，请放心！',
  shipping_status: '您把订单号发我，我帮您查一下物流到哪儿了。',
  after_sale: '您先别急，把订单号和照片发我，我这边马上帮您走售后流程。',
  generic: '非常抱歉给您添麻烦了，您的情况我记下了，马上安排人跟进处理。',
  grow: '只要温度合适都能种，注意保温和光照就行。',
};

function merchantReply(kind, ctx = {}) {
  const set = humanAvailable(ctx) ? MERCHANT_ATTENDED : MERCHANT_AUTO;
  return set[kind] || set.generic;
}

// 知识缺口时的「对外口径」：不暴露我们不知道，也不编具体事实
const PUBLIC_FALLBACK = {
  courier: '亲，快递公司以实际发货为准哦，下单后订单里能看到物流信息。',
  shipping_time: '亲，发货时间以订单页显示为准哦。',
  arrival_time: '亲，到货时间以物流信息为准哦。',
  invoice: '亲，发票可以在订单页申请，具体以页面显示为准。',
  payment: '亲，支付方式以下单页显示为准哦。',
  return_policy: '亲，退换规则以平台售后页面显示为准哦。',
  after_sale: '亲，售后可以在订单里申请，具体以平台规则为准。',
  spec: '亲，规格以商品页标注为准哦。',
  stock: '亲，库存以商品页显示为准哦。',
  price: '亲，价格以商品页显示为准哦。',
};

// 这些属于「店铺事实」：库里没有时，对外用口径兜底，对内记缺口
const SHOP_ASK = new Set(['courier', 'shipping_time', 'arrival_time', 'invoice', 'payment', 'return_policy', 'after_sale', 'spec', 'stock', 'price']);

function publicFallback(ask, buyerText) {
  // 关切优先：问"有没有质检报告"不该回"库存以页面为准"
  const byConcern = require('./concerns').fallbackText(buyerText || '');
  if (byConcern) return byConcern;
  return PUBLIC_FALLBACK[ask] || '亲，这个以商品页/订单页显示为准哦。';
}

module.exports = { pickFallback, merchantReply, publicFallback, SHOP_ASK, PUBLIC_FALLBACK, LEVELS, AUTO, ATTENDED, MERCHANT_AUTO, MERCHANT_ATTENDED };
