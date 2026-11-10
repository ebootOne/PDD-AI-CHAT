'use strict';

/**
 * fact-route.js —— 本地路由：买家一句话 → 要哪几块事实
 *
 * 为什么单独一层：
 *   facts.js 负责「怎么取、取多少」，这一层只负责「取哪几块、谁优先、缺了怎么说」。
 *   路由表化之后，加一块（订单/规格/物流）是加一行规则，而不是在 build 里塞 if。
 *
 * 输入：买家这句话 + 是否已识别商品（+ 引擎的 understanding，做兜底）
 * 输出：asks（一句话里有几件事）、wanted（要取的块，按优先级）、concern（关切）
 *
 * 这是「本地」判断：不调模型、不读网络，纯规则。
 */

const understand = require('./understand');
const concerns = require('./concerns');
const registry = require('./fact-registry');

// 订单块的关键信号：出现这些，说明买家在问「我这一单」，没有订单数据就不能编
// 只认「这一单」的信号：光有「查一下/催一下」不算，避免「查一下能不能便宜」被当成订单
const ORDER_SIGNAL = /我的(订单|快递|包裹)|这单|订单|单号|物流|快递|哪家|承运|到哪(了|儿)?|发了没|发货了吗|发出没|什么时候到|催(一下)?(发货|发|快递|物流)|收到(了)?吗?|签收|到了(吗|没)|改地址|收货地址|订单地址|改电话/;

// 问法 → 事实块（第一版映射；一块可以被多种问法命中）
const ASK_BLOCK = {
  price: 'product',
  stock: 'product',
  product: 'product',
  nego: 'product',
  spec: 'product',
  usage: 'manual',
  recommend: 'manual',
  shipping_time: 'policy',
  arrival_time: 'policy',
  shipping_status: 'order',
  courier: 'policy',
  freight: 'policy',
  invoice: 'policy',
  payment: 'policy',
  return_policy: 'policy',
  after_sale: 'policy',
  privacy: 'policy',
};

const PRIORITY = { order: 0, product: 1, policy: 2, manual: 3, context: 9 };

const LABEL = {
  order: '这一单',
  product: '商品',
  policy: '店铺政策',
  manual: '说明书',
  context: '常驻层',
};

// 拆句：标点、换行、空格都算。「四个诉求连写」也要能拆开（ISS-008）
const FILLER = /^(嗯+|哦+|噢+|好+|行+|可以|在吗|在么|在不在|你好|您好|谢谢|好的|ok|哈+|啊+|呀+)$/i;

/** 把买家一句话拆成子问题，用来识别多意图（「多少钱，发什么快递」） */
function splitAsks(text) {
  const raw = String(text || '');
  const parts = raw.split(/[。！？!?；;，,\s]+/).map((x) => x.trim()).filter(Boolean);
  const asks = [];
  const unknownParts = [];
  for (const p of parts) {
    const a = understand.detectAsk(p);
    if (a && a !== 'other' && a !== 'greeting') {
      if (!asks.includes(a)) asks.push(a);
    } else if (p.length >= 2 && !FILLER.test(p)) {
      // 分类失败不等于「没问东西」：保留为未覆盖子问题，别整句丢掉（ISS-020）
      unknownParts.push(p);
    }
  }
  if (!asks.length && !unknownParts.length) {
    const a = understand.detectAsk(raw);
    if (a && a !== 'other' && a !== 'greeting') asks.push(a);
  }
  return { asks: asks.slice(0, 4), unknownParts: unknownParts.slice(0, 3), parts };
}

/**
 * @param {{buyerText:string, hasGoods:boolean, understanding?:object}} input
 * @returns {{asks:string[], parts:string[], productAsks:string[], orderAsked:boolean,
 *            concern:object|null, wanted:Array<{key:string,priority:number,reason:string}>}}
 */
function route(input = {}) {
  const text = String(input.buyerText || '');
  const { asks: staticAsks, unknownParts, parts } = splitAsks(text);
  const understanding = input.understanding || null;

  // 注册表优先：它记录的是「静态表没想到、但真实用户会这么问」的说法
  const reg = registry.match(text);
  const asks = reg && reg.entry.ask && reg.entry.ask !== 'other'
    ? [reg.entry.ask, ...staticAsks.filter((a) => a !== reg.entry.ask)].slice(0, 3)
    : staticAsks;

  // 商品字段用：asks 为空时回落到引擎的理解，避免「懂了但路由没拿到」
  const productAsks = asks.length
    ? asks
    : (understanding && understanding.ask ? [understanding.ask] : []);

  const orderAsked = ORDER_SIGNAL.test(text);
  const concern = concerns.detect(text);
  const wanted = [];

  if (orderAsked) {
    wanted.push({ key: 'order', priority: PRIORITY.order, reason: '问到「我的/这单」，要订单事实' });
  }

  const needProduct = productAsks.some((a) => ASK_BLOCK[a] === 'product');
  if (needProduct && input.hasGoods) {
    wanted.push({ key: 'product', priority: PRIORITY.product, reason: '问到价格/库存/规格/这款' });
  }

  // 政策/知识：任何一句话都可能命中（命中多少由检索决定），优先级在商品之后
  wanted.push({ key: 'policy', priority: PRIORITY.policy, reason: '查店铺政策与通用说明' });

  // 说明书：只要商品识别出来就查，问法可能绕（「土要多深」不含"怎么种"）
  if (input.hasGoods) {
    wanted.push({ key: 'manual', priority: PRIORITY.manual, reason: '商品已识别，查说明书分节' });
  }

  // 注册表要求的块：按块优先级插入（同一块只留一次）
  if (reg) {
    for (const b of reg.entry.blocks || []) {
      wanted.push({ key: b, priority: PRIORITY[b] != null ? PRIORITY[b] : 5, reason: '注册表命中：' + reg.phrase });
    }
    const seen = new Map();
    for (const w of wanted) {
      if (!seen.has(w.key) || seen.get(w.key).priority > w.priority) seen.set(w.key, w);
    }
    wanted.length = 0;
    for (const w of [...seen.values()].sort((a, b) => a.priority - b.priority)) wanted.push(w);
  }

  wanted.sort((a, b) => a.priority - b.priority);

  // 多意图：拆出的子句 >=2，且至少两个子句带内容（认识的 ask 或未覆盖子句）
  const multi = parts.length >= 2 && (asks.length + unknownParts.length) >= 2;

  return {
    asks,
    parts,
    unknownParts,
    productAsks,
    orderAsked,
    concern,
    wanted,
    multi,
    registry: reg ? { id: reg.entry.id, phrase: reg.phrase, needs: reg.entry.needs || [] } : null,
  };
}

module.exports = { route, splitAsks, ORDER_SIGNAL, ASK_BLOCK, PRIORITY, LABEL };
