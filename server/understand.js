'use strict';

/**
 * understand.js —— 审题：把买家的话，变成「他在要什么」
 *
 * 之前的问题：链路直接从「句子」跳到「检索」，中间没有一步表示"这句话的要求"。
 * 于是「多钱一袋」因为「袋」命中规格，「收到货坏了」因为「收到/货」命中到货时效。
 *
 * 这一层只做两件事：
 *   1. normalize  口语/错字/省略 → 能力可识别的说法（不是说人话，是统一说法）
 *   2. extract    这句话要的是哪类事实（ask）+ 带了哪些实体（地区/数量）+ 有没有威胁
 *
 * 注意：normalize 改的是「理解用的文本」，不改展示给商家的买家原话。
 */

// ---------------------------------------------------------------- 归一化

// 只收「同一意思的不同说法」，不写行业黑话，也不针对某条知识库。
const NORMALIZE = [
  [/多钱|几块钱|啥价|什么价(?!格)/g, '多少钱'],
  [/咋/g, '怎么'],
  [/啥时候|啥时/g, '什么时候'],
  [/肿么/g, '怎么'],
  [/包不包邮|包邮不|包邮吗/g, '包邮'],
  [/能不能便宜|能便宜点|便宜点|少点|优惠点/g, '便宜'],
  [/能不能发(货)?|能发(货)?不|能发吗|可以发吗/g, '发货吗'],
  [/还没发(货)?|没发货|没发出来/g, '还没发货'],
  [/发不发(货)?/g, '发货吗'],
  [/发了没|发货了吗|发出没|发出去了吗/g, '发货了吗'],
  [/到货了没|到货没|到了吗|到哪了/g, '物流到哪了'],
  [/坏|破|烂|压坏/g, '破损'],
  [/泡种|泡水|浸种/g, '催芽'],
  [/退吗|能退吗|可以退吗|退货吗/g, '退货'],
  [/开票/g, '发票'],
  [/有货没|还有没有|有没有货/g, '有货'],
  [/现在种|能种吗|种得吗|来得及吗/g, '能种吗'],
];

function normalize(text) {
  let s = String(text || '');
  for (const [re, to] of NORMALIZE) s = s.replace(re, to);
  // 礼貌前缀不改变问题：请问/你好/老板/在吗/问一下 去掉后仍是完整问题才算
  const stripped = s.replace(/^(请问|想问一下|问一下|麻烦问下|你好|您好|老板|在吗|亲)[\s，。!！?？~]*/, '');
  if (stripped.trim().length >= 2) s = stripped;
  return s;
}

// ---------------------------------------------------------------- 实体

const PROVINCES = [
  '北京', '天津', '河北', '山西', '内蒙古', '辽宁', '吉林', '黑龙江', '上海', '江苏',
  '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西',
  '海南', '重庆', '四川', '贵州', '云南', '西藏', '陕西', '甘肃', '青海', '宁夏',
  '新疆', '台湾', '香港', '澳门',
];

// 知识库口径里的「偏远地区」，不是地理概念，是运费与时效口径
const REMOTE = ['新疆', '西藏', '内蒙古', '青海', '甘肃', '宁夏', '海南'];

function extractSlots(text) {
  const t = String(text || '');
  const region = PROVINCES.find((p) => t.includes(p)) || null;
  const qtyMatch = t.match(/(\d+|[一二三四五六七八九十两]+)\s*(袋|包|件|盒|罐|斤|公斤|亩|盆)/);
  // 价位段：问「最贵/最高」和问「最便宜/最低」不是同一件事。
  // 只在确实在问价时才取，避免「最高温度」被当成问价。
  const asksPrice = /钱|价|多少钱|价格/.test(t);
  const priceBand = !asksPrice
    ? null
    : /最贵|最高|上限|顶配/.test(t)
      ? 'max'
      : /最便宜|最低|起步/.test(t)
        ? 'min'
        : null;
  return {
    region,
    remote: region ? REMOTE.includes(region) : null,
    qty: qtyMatch ? qtyMatch[1] + qtyMatch[2] : null,
    priceBand,
  };
}

// ---------------------------------------------------------------- 问题类型

// 顺序即优先级：先判「出了什么事」，再判「问什么信息」。
const ASK_RULES = [
  ['shipping_status', /物流到哪了|物流状态|到哪了|查一下物流/],
  ['courier', /发什么快递|哪家快递|什么快递|默认快递|走什么快递|用什么快递|顺丰|中通|圆通|韵达|申通|极兔|邮政|快递/],
  ['after_sale', /破损|少发|漏发|错发|不发芽|没出芽|没发芽|质量问题|售后|坏了|死苗/],
  ['return_policy', /退货|退款|退换|七天/],
  ['invoice', /发票|开票|税号|专票|普票/],
  ['payment', /货到付款|支付|花呗|支付宝|微信支付/],
  ['arrival_time', /到货|到货时间|多久能到|多久到|几天能到|几天可以到|几天到|什么时候能到|什么时候到|哪天到|几天能收到|几天收到|明天能到|明天到|今天下单.*能到|今天买.*能到|发货后.*天|物流.*天|多长时间.*到|要多久.*到|时效/],
  ['shipping_time', /发货|什么时候发|几天发货|多久发货|发出|快递/],
  ['nego', /便宜|优惠|少点|划算|讲价|券|满减/],
  ['freight', /包邮|运费|邮费|快递费|免运费/],
  ['price', /多少钱|多钱|价格|怎么卖|几块|报价/],
  ['spec', /规格|尺寸|多大(?!的?(?:鸟|鹦鹉|动物|猫|狗|仓鼠|兔))|多长(?!时间)|多高|多宽|多厚|多少克|克数|多少张|几张|多少抽|几抽|多少粒|几盆|多少地|斤|袋|厘米|cm/],
  ['stock', /有货|库存|现货|还有吗|有吗|有没有/],
  ['recommend', /推荐|哪个好|选哪|哪个适合/],
  ['usage', /怎么种|催芽|温度|播种|泡多久|泡[几多少]?天|浸种.*天|适合|阳台|光照|浇水|施肥|能种吗|季节|冬天|发芽|出芽|出苗/],
  ['privacy', /老板.{0,6}(电话|手机|微信|姓名|叫啥|叫什么|是谁|联系方式)|电话|手机号|法人|营业执照|身份证|微信|QQ/],
  ['greeting', /^(在吗|在不在|有人吗|你好|您好|老板|hi|hello)[\s，。！？!?~]*$/],
];

function detectAsk(text) {
  const t = String(text || '');
  for (const [ask, re] of ASK_RULES) if (re.test(t)) return ask;
  return 'other';
}

// 谓词优先：问的是什么动作/对象，而不是句子里出现了什么实体。
const PAY_ENTITY = /支付宝|微信支付|微信|花呗|银行卡|信用卡/;
const STATUS_PRED = /发货了吗|发了吗|发了没|发出没|到哪|物流|签收|派送|快递到/;
const REFUND_PRED = /退款|退货|退钱|退差价|售后/;
const REFUND_TIMING = /到账|几天|多久|多长时间|什么时候/;
const USAGE_OBJ = /发芽|出芽|出苗|催芽|浸种|泡[几多少]?天|怎么种|种植|养护|清洗|保养|怎么用/;
const ARRIVAL_OBJ = /到货|能到|收到|送达|到账|发货后|物流/;
const DURATION = /几天|多久|多长时间|多少天/;
const REGION = /新疆|西藏|内蒙古|青海|宁夏|甘肃|海南|港澳|台湾|海外|偏远|北京|上海|广州|深圳|杭州|成都|重庆|武汉|西安|南京|天津|苏州/;
const CARRIER = /顺丰|中通|圆通|韵达|申通|极兔|邮政|德邦|京东物流/;

function classify(text) {
  const t = String(text || '');
  const payment = (t.match(PAY_ENTITY) || [])[0] || null;
  const region = (t.match(REGION) || [])[0] || null;
  const duration = (t.match(DURATION) || [])[0] || null;
  let ask = 'other';
  let predicate = '';

  if (STATUS_PRED.test(t)) {
    ask = 'shipping_status';
    predicate = '订单状态';
  } else if (REFUND_PRED.test(t)) {
    ask = REFUND_TIMING.test(t) ? 'after_sale' : 'return_policy';
    predicate = REFUND_TIMING.test(t) ? '退款时效' : '退款/售后';
  } else if (USAGE_OBJ.test(t)) {
    ask = 'usage';
    predicate = '用法/生长';
  } else if (DURATION.test(t) && ARRIVAL_OBJ.test(t)) {
    ask = 'arrival_time';
    predicate = '到货时效';
  } else if (CARRIER.test(t)) {
    ask = 'courier';
    predicate = '快递公司';
  } else {
    ask = detectAsk(t);
    predicate = ask === 'other' ? '' : ask;
  }

  return { ask, predicate, entities: { payment, region, duration } };
}

// ---------------------------------------------------------------- 数值限定词
// 「专票税率多少」和「能开专票吗」是两件事：前者要一个数，后者要流程。
// 回复里没有同维度答案，就是答非所问——这一条对「多少天/多少克/多少钱」同样成立。
const DIMENSIONS = [
  ['tax_rate', /税率|税点|几个点|百分之几/],
  ['days', /多少天|几天|多久|多长时间/],
  ['price', /多少钱|多钱|几块|价格是多少/],
  ['weight', /多少克|几克|多少粒|几粒|多重/],
  ['fee', /多少运费|运费多少|邮费多少|补多少/],
  ['qty', /几袋|多少袋|几包|能种几/],
];

function detectDims(text) {
  const t = String(text || '');
  return DIMENSIONS.filter(([, re]) => re.test(t)).map(([k]) => k);
}

// 威胁 ≠ 投诉：买家还没投诉，是在用「退款/差评/找平台」施压。
// 这类消息的正确答案是「道歉 + 具体动作」，不是「告诉他能退款」。
const THREAT_COND = /再不|再拖|再这样|还不|一直不|不给|还没有/;
const THREAT_TARGET = /退款|退货|退了|退掉|不要了|投诉|差评|举报|曝光|找平台|12315|退钱/;
const EMOTION = /急|催|等了三|等了几天|还没|到底|怎么回事|失望|无语|气/;

// 「能不能发到某地」问的是配送范围，不是发货时间；问「几天到」才是时效。
const DELIVERY_VERB = /发|寄|送|到|邮|运|收/;
const DELIVERY_TIMING = /几天|多久|什么时候|何时|多少天/;

function extract(raw) {
  const text = normalize(raw);
  const slots = extractSlots(text);
  const threat = THREAT_COND.test(text) && THREAT_TARGET.test(text);
  const intent = classify(text);
  let ask = intent.ask;
  // 地区槽位先说话：句子里点了偏远地区、又在问"能不能发"，该回答配送范围/运费。
  // 否则「新疆发货吗」会被「发货」带到发货时间上。
  if (slots.remote && DELIVERY_VERB.test(text) && !DELIVERY_TIMING.test(text)) ask = 'freight';
  // 价位段同理：「最便宜多少钱」里的「便宜」是价格，不是议价。
  if (slots.priceBand && ask !== 'price') ask = 'price';
  // 「再不发货我就退款」：要回答的是发货，不是退款规则。威胁时以他要我们做的事为准。
  if (threat && /发货|快递|物流|到货/.test(text)) ask = 'shipping_time';
  return {
    text,
    ask,
    predicate: intent.predicate,
    entities: intent.entities,
    dims: detectDims(text),
    slots,
    threat,
    emotion: EMOTION.test(text),
  };
}

// ---------------------------------------------------------------- 检索扩写

// 同义词只解决「说法」，扩写解决「同一件事的不同问法」：
// 「发到黑龙江得几天」里没有「时效」二字，但问的就是到货时效。
const ASK_EXPANSION = {
  arrival_time: '到货 时效 几天',
  shipping_time: '发货 时间',
  shipping_status: '物流 单号',
  courier: '快递 承运',
  freight: '包邮 免运费 配送费 运费 邮费',
  after_sale: '售后 退货 质量问题',
  return_policy: '退货 退换 运费',
  invoice: '发票 开票',
  payment: '支付 货到付款',
  price: '价格 报价 多少钱',
  nego: '优惠 券 满减 便宜',
  spec: '规格 克数',
  stock: '有货 现货',
  usage: '种植 催芽 温度',
  recommend: '推荐 适合 品种',
};

module.exports = { normalize, extract, detectAsk, extractSlots, detectDims, ASK_EXPANSION, PROVINCES, REMOTE };
