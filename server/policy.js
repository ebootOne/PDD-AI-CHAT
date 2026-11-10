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

// 无人值守：不承诺动作、不替商家下判决；缺信息时给「出口」（页面/下一步），不给「结论」
const AUTO = {
  care: [
    '非常抱歉给您带来困扰。',
    '实在不好意思，给您添麻烦了。',
  ],
  verify: [
    '您先看下商品页的说明哈，那里写得更全。',
    '商品页把说明和规格都写全了，您对照着看更方便。',
  ],
  hold: [
    '具体以商品页或订单页标注为准哈，您对照着看更快。',
  ],
  unknown: [
    '商品和订单的信息以页面标注为准哈，您对照着看就行。',
    '具体以页面标注为准哦，您点开就能看到。',
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
  const ask = ctx.ask || '';
  const attempt = Math.max(0, Number(ctx.attempt) || 0);
  const isComplaint = risks.includes('投诉威胁') || risks.includes('索赔诉求') || ctx.intent === 'complaint';
  const pool = humanAvailable(ctx) ? ATTENDED : AUTO;

  let level;
  if (isComplaint) level = attempt === 0 ? 'care' : 'unknown';
  else if (ctx.noContext) level = 'unknown';
  else if (attempt === 0) level = 'verify';
  else if (attempt === 1) level = 'hold';
  else level = 'unknown';

  // 完全无关的问题：别硬套商品页；热情地把话题接回商品和订单
  if (level !== 'care' && ctx.offtopic) {
    return { level, text: '这个信息以页面显示为准哈，商品和订单的问题您随时问我。', attempt };
  }
  // 投诉先共情，不塞页面口径；其他情况有 ask 就给出口，没有才用通用句
  if (level !== 'care' && ask && ask !== 'other') {
    // 同一会话多次兜底要换说法，但出口不变
    const lead = attempt % 3 === 1 ? '再说一下哈，' : attempt % 3 === 2 ? '这边再跟您说一下哈，' : '';
    return { level, text: lead + exitText(ask), attempt };
  }
  const list = pool[level] || pool.unknown;
  return { level, text: list[attempt % list.length], attempt };
}

/**
 * 商人语气：按「问题类型」给，不按某一句买家原话给。
 * 无人值守版本不索取单号/照片、不承诺查单。
 */
const MERCHANT_AUTO = {
  shipping_delay: '理解您着急，实在不好意思让您久等了。这一单的进度以订单页为准，发货时间以页面显示为准哈。',
  shipping_status: '物流进度以订单页显示为准，您可以随时查看。',
  after_sale: '非常抱歉给您带来困扰，如果是质量问题，可以按平台规则申请售后处理。',
  generic: '非常抱歉给您添麻烦了，您的情况我记下了。',
  offtopic: '这个信息以页面显示为准哈，商品和订单的问题您随时问我。',
  grow: '具体用法以商品页说明为准哈。',
};

const MERCHANT_ATTENDED = {
  shipping_delay: '实在不好意思让您久等了，给您添麻烦了，我们会马上跟进的，请放心！',
  shipping_status: '您把订单号发我，我帮您查一下物流到哪儿了。',
  after_sale: '您先别急，把订单号和照片发我，我这边马上帮您走售后流程。',
  generic: '非常抱歉给您添麻烦了，您的情况我记下了，马上安排人跟进处理。',
  offtopic: '这个信息以页面显示为准哈，商品和订单的问题您随时问我。',
  grow: '具体用法您看下商品页说明，有不清楚的随时问我。',
};

function merchantReply(kind, ctx = {}) {
  const set = humanAvailable(ctx) ? MERCHANT_ATTENDED : MERCHANT_AUTO;
  return set[kind] || set.generic;
}

// 出口话术：不知道答案时，告诉买家下一步去哪看，而不是说「我没有信息」
const EXIT = {
  price: '价格以商品页标注为准哈，您点开就能看到。',
  stock: '库存以商品页显示为准哈，能拍下就说明有货。',
  spec: '规格在商品页标得很清楚哈，您点开规格就能看到。',
  usage: '具体用法可以看商品页的说明哈，写得很清楚。',
  recommend: '适合的款式可以看商品页的规格说明哈。',
  courier: '快递公司以实际发货为准哈，下单后订单里能看到物流信息。',
  shipping_time: '发货时间以订单页显示为准哈。',
  arrival_time: '到货时间以物流信息为准哈。',
  shipping_status: '这一单的进度以订单页显示为准哈。',
  invoice: '发票这边可以开哈，您在订单页填好抬头税号，具体以页面显示为准。',
  payment: '支付方式以下单页显示为准哈。',
  return_policy: '退换规则以平台售后页面显示为准哈。',
  after_sale: '售后在订单里就能申请哈，具体以平台规则为准。',
  nego: '优惠以下单页显示为准哈，能用的券会自动抵扣。',
  freight: '运费以下单页显示为准哈。',
  privacy: '这类信息不方便提供哈，店铺和商品信息以平台页面为准。',
};

function exitText(ask) {
  return EXIT[ask] || '具体信息以商品页或订单页显示为准哈，您对照着看就行。';
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
  nego: '亲，优惠以下单页显示为准，能用的券会自动抵扣。',
  freight: '亲，运费以下单页显示为准哦。',
  usage: '亲，具体用法可以看商品页的说明。',
};

// 这些属于「店铺事实」：库里没有时，对外用口径兜底，对内记缺口
const SHOP_ASK = new Set(['courier', 'shipping_time', 'arrival_time', 'invoice', 'payment', 'return_policy', 'after_sale', 'spec', 'stock', 'price']);

function publicFallback(ask, buyerText) {
  // 关切优先：问"有没有质检报告"不该回"库存以页面为准"
  const byConcern = require('./concerns').fallbackText(buyerText || '');
  if (byConcern) return byConcern;
  return PUBLIC_FALLBACK[ask] || '亲，这个以商品页/订单页显示为准哦。';
}

module.exports = { pickFallback, merchantReply, publicFallback, exitText, SHOP_ASK, PUBLIC_FALLBACK, EXIT, LEVELS, AUTO, ATTENDED, MERCHANT_AUTO, MERCHANT_ATTENDED };
