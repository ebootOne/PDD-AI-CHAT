'use strict';

/**
 * router.js —— 问题分流：这句话该由谁回答
 *
 * 之前是"命中关键词就去说明书"，这是个平铺规则，用户问的可能是别的事。
 * 现在改成按「谁拥有这个问题的正确答案」来分流：
 *
 *   风险    投诉/索赔/举报          → 先安抚 + 告警（谁都不该自动答）
 *   商品    有没有/哪款/多少钱       → 商品目录（真实库存和价格）
 *   说明书  怎么用/怎么种/要泡水吗    → 这个商品的说明书
 *   政策    发货/快递/退换/发票       → 店铺知识库（全店一套）
 *   模型    其余                     → 交给模型（有资料才答）
 *
 * 一句话：不是"句子里有没有某个词"，而是"这件事的事实归谁管"。
 */

const RULES = [
  {
    route: 'risk',
    weight: 10,
    test: /投诉|差评|举报|12315|平台介入|起诉|骗人|骗子|假货|退一赔/,
    reason: '风险诉求',
  },
  {
    route: 'product',
    weight: 6,
    test: /有没有|有卖|有货|还有吗|哪款|多少钱|什么价|价格|库存|能拍吗|现货/,
    reason: '问商品本身',
  },
  {
    // 「有白萝卜吗」这种弱信号：权重低，遇到"发票/退换"等强政策词会被压过去
    route: 'product',
    weight: 3,
    test: /有[^\s，。？！?]{1,8}吗/,
    reason: '问有没有某商品',
  },
  {
    route: 'manual',
    weight: 5,
    test: /怎么用|用法|怎么种|怎么栽|播种|泡水|浸种|泡多久|催芽|育苗|施肥|浇水|覆土|深度|间距|株距|温度|多少度|多久发芽|好养|能种活|注意事项|适合.*(种|养)/,
    reason: '问这个商品怎么用',
  },
  {
    route: 'policy',
    weight: 5,
    test: /发货|快递|物流|到货|几天到|包邮|运费|退换|退货|退款|发票|开票|改地址|售后|支付|付款|货到付款|花呗/,
    reason: '问店铺政策',
  },
];

// 已知会误判的说法：出现这些就不按"说明书"走
const MANUAL_GUARDS = [/怎么种出来|你们怎么种|从哪进的货|进货渠道|批发/];

/**
 * @returns {{route:string, confidence:number, reasons:string[], scores:object}}
 */
function classify(text, ctx = {}) {
  const t = String(text || '');
  const scores = { risk: 0, product: 0, manual: 0, policy: 0, model: 0 };
  const reasons = [];

  for (const r of RULES) {
    if (r.test.test(t)) {
      scores[r.route] += r.weight;
      reasons.push(r.route + '：' + r.reason);
    }
  }

  // 说明书只在"本身像用法问题"且"商品已知"时才加权；
  // 不加权到凭空冒出一个 manual 路由（否则"货到付款吗"也会被当成说明书）。
  if (scores.manual > 0) {
    if (ctx.productKnown) {
      scores.manual += 1;
    } else {
      scores.manual -= 2;
      reasons.push('manual：但商品未知，降权');
    }
  }

  // 明确的误判说法：从说明书路由里剔除，交给模型
  if (MANUAL_GUARDS.some((re) => re.test(t))) {
    scores.manual = 0;
    scores.model += 3;
    reasons.push('命中误判保护，改走模型');
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topRoute, topScore] = ranked[0];
  const secondScore = ranked[1] ? ranked[1][1] : 0;

  if (topScore === 0) {
    return { route: 'model', confidence: 0.5, reasons: ['没有明显信号，交给模型'], scores };
  }

  // 两个路由打平 = 说不清，交给模型（模型能看到上下文，比硬选一个稳）
  if (topScore === secondScore && topScore > 0) {
    return { route: 'model', confidence: 0.4, reasons: reasons.concat(['两条路由打平，交给模型']), scores };
  }

  const margin = (topScore - secondScore) / topScore;
  return {
    route: topRoute,
    confidence: Number((0.6 + 0.35 * Math.min(1, margin)).toFixed(2)),
    reasons,
    scores,
  };
}

module.exports = { classify };
