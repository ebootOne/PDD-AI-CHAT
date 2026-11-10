'use strict';

/**
 * judge.js —— 出厂质检：这句话答的是他问的吗？像不像一个会做生意的客服说的？
 *
 * 引擎只负责「生成」，这一层负责「拦」。四道检查，顺序就是优先级：
 *
 *   1. 不打包票：保证/一定/赔您，任何话题都不许出现。
 *   2. 立场：不是售后话题却劝退款；买家在施压却只讲规则。
 *      ——这是最伤商家利益的一类：把能挽回的客户往退款上推。
 *   3. 有依据：知识库/商品都没有的问题，不许模型自由发挥。
 *   4. 对题：买家问的是价格/时效/售后，回复里得真有那个答案。
 *      拦「收到货坏了 → 回答到货时效」这种答非所问。
 *
 * 第五、六条是「没答上」的两种形态：承认查不到（兜底、进复核）、
 * 只承诺去查（可以先发，但不算答案、进复核）。两种都照常计费——回复已经产出了。
 *
 * 这一层只做判定，不写话术；话术在 policy.merchantReply 里，按「问题类型」取。
 */

const { SHOP_ASK } = require('./policy');

const TOPIC_SIGNALS = {
  price: /元|价格|报价|没货|补货|包邮|运费|邮费/,
  nego: /优惠|券|满减|便宜|划算|折扣/,
  shipping_time: /发货|发出|当天|16点|付款后|仓库/,
  arrival_time: /天|到货|时效|物流|快递|派送/,
  shipping_status: /订单号|单号|物流|快递|查/,
  courier: /顺丰|中通|圆通|韵达|邮政|极兔|申通|快递/,
  after_sale: /售后|照片|订单号|登记|专员|补发|退款|破损|不发芽|少发|漏发|错发|包裹/,
  return_policy: /退|换|运费|七天|拆封/,
  invoice: /发票|抬头|税号|专票|普票/,
  payment: /支付|微信|支付宝|花呗|货到付款/,
  spec: /规格|克|袋|粒|亩|盆|张|抽|商品页|厘米|cm|尺寸|直径|毫米|mm|重量|净含量|容量|长[约度]|宽|高/i,
  usage: /种|播|泡|温度|天|土|浇水|肥|阳台|光照|季节/,
  stock: /有货|现货|库存|拍/,
  recommend: /推荐|适合|建议|对比|区别|更好|选哪|哪款/,
  greeting: /在的|您好|你好|问题/,
};

// 必须有知识/商品依据才能答的问题类型（闲聊、越界不在此列）
const FACTUAL = new Set([
  'price', 'shipping_time', 'arrival_time', 'shipping_status', 'after_sale',
  'return_policy', 'invoice', 'payment', 'spec', 'usage', 'stock', 'recommend', 'courier', 'nego',
]);

// 买家自己问售后/退换时，提退款是正常的；其它话题里提，就是把人在往退款上带
const KEEP_TOPICS = new Set(['return_policy', 'after_sale']);

const HEDGE = /核实|确认一下|稍后回复|稍后给您|稍等片刻|帮您问一下/;
// 空话判定：说了半天，但没有一个可核验的信息或动作
const CONCRETE = /订单号|单号|链接|照片|元|天|小时|规格|发票|专员|补发|退款|退货|运费|袋|克|亩|盆/;

function isEmptyHedge(text) {
  return HEDGE.test(text) && !CONCRETE.test(text);
}

function isHonestUnknown(text) {
  return /没有查到|查不到|没有相关|暂时没有.*(资料|信息)|无法确认/.test(text);
}

function saysRefund(text) {
  return /退款|退货|取消订单|申请退|换一家|别家/.test(text);
}

function overPromise(text) {
  return /保证|一定|100%|绝对|肯定能|包退包换|赔您|退您钱/.test(text);
}

function hasEmpathy(text) {
  return /抱歉|不好意思|理解|别急|您的心情/.test(text);
}

function hasAction(text) {
  return /马上|立刻|尽快|催促|催一下|帮您查|登记|安排人|专人/.test(text);
}

// 结果承诺：没问售后政策就主动提，等于替商家做主
const OUTCOME = /补发|退款|退货|赔付|赔偿|赔您|退您钱|包退包换|三倍/;
// 内部口径：把“我们不知道”暴露给买家
const ABUSE_RE = /(傻逼|傻b|sb|脑子有病|神经病|智障|弱智|废物|垃圾客服|垃圾店铺|垃圾东西|去死|滚蛋|滚|妈的|操你|草泥马|狗东西|贱人)/i;
const INTERNAL = /(资料|知识库|模型|系统|数据库).{0,10}(没有|暂无|未|里|中)|没有.{0,10}(资料|相关信息)|能参考|只提到|仅供/;

const DIM_SIGNALS = {
  tax_rate: /税率|税点|个点|%|％/,
  days: /\d+\s*天|天左右|当天|次日|\d+~\d+\s*天/,
  usage_duration: /时间|时长|多久|看情况/,
  price: /\d+(\.\d+)?\s*元|没货|补货/,
  weight: /\d+\s*(克|g|粒)/i,
  fee: /\d+\s*元|包邮|运费/,
  qty: /\d+\s*袋|袋/,
};
const DEFER = /商品页|页面标注|包装标注|以实际|订单页|规格页/;

const UNIT_ALT = '元|块|天|小时|分钟|℃|度|克|g|斤|粒|袋|包|张|抽|厘米|cm|毫米|mm|%|％|点';
const NUM_UNIT = new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:[~-]\\s*(\\d+(?:\\.\\d+)?)\\s*)?(' + UNIT_ALT + ')', 'gi');

function escapeRe(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 事实里有没有这个「数值 + 单位」（支持区间写法 3~5天）
function hasNumUnit(factText, value, unit) {
  const v = escapeRe(value);
  const u = escapeRe(unit);
  const re = new RegExp('(?:' + v + '\\s*[~-]\\s*\\d+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?\\s*[~-]\\s*' + v + '|' + v + ')\\s*' + u, 'i');
  return re.test(factText);
}

// 只看数字后面的单位，避免把「抽纸」这种名词当单位
function numericUnits(text) {
  const set = new Set();
  NUM_UNIT.lastIndex = 0;
  let m;
  while ((m = NUM_UNIT.exec(String(text || '')))) set.add(String(m[3]).toLowerCase());
  return set;
}

function unitDeferred(text, wantUnit) {
  const u = escapeRe(wantUnit);
  return new RegExp('(?:多少|具体)?' + u + '数?[^。]{0,16}(?:包装|页面|商品页)[^。]{0,8}(?:标注|为准)').test(String(text || ''));
}

function repairUnitClaims(text, badUnit, wantUnit) {
  const parts = String(text || '').split(/([，。；！？\n])/);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i];
    if (seg && new RegExp('\\d+\\s*' + escapeRe(badUnit)).test(seg)) {
      parts[i] = '具体' + wantUnit + '数以包装或页面标注为准';
      changed = true;
    }
  }
  return changed ? parts.join('') : '';
}

// 问「抽」不能答「张」，问「克」不能答「粒」
function unitMismatch(buyerText, text) {
  const q = String(buyerText || '');
  const ru = numericUnits(text);
  const has = (u) => ru.has(u) || (u === '克' && ru.has('g'));
  const askChou = /(多少|几)\s*抽|抽数/.test(q);
  const askZhang = /(多少|几)\s*张|张数/.test(q);
  if (askChou && has('张') && !ru.has('抽')) return '抽/张';
  if (askZhang && has('抽') && !ru.has('张')) return '张/抽';
  if (/粒/.test(q) && has('克') && !ru.has('粒')) return '粒/克';
  if (/(克|g)/i.test(q) && ru.has('粒') && !has('克')) return '克/粒';
  return '';
}

// 回复里每个带单位的数字，都要在事实里找到；返回没找到的
function ungroundedNumbers(text, factText) {
  const out = [];
  const seen = new Set();
  NUM_UNIT.lastIndex = 0;
  let m;
  while ((m = NUM_UNIT.exec(String(text || '')))) {
    const unit = m[3];
    if (unit === '点') continue; // 时间点允许 16点/下午4点 两种说法
    const vals = [m[1], m[2]].filter(Boolean);
    for (const v of vals) {
      if (!hasNumUnit(factText, v, unit)) {
        const key = v + unit;
        if (!seen.has(key)) { seen.add(key); out.push(key); }
      }
    }
  }
  return out;
}

function missingDims(text, dims) {
  return (dims || []).filter((d) => DIM_SIGNALS[d] && !DIM_SIGNALS[d].test(text));
}

// 替商家否定：没查到的资质/报告/发票，不许说「没有」（AGENTS 第 18 条）
const NEGATIVE_CERT = /(没有|暂无|不提供|无法提供|不能提供).{0,8}(质检|检测|报告|证书|资质|认证|发票)|(质检|检测|报告|证书|资质|认证|发票).{0,8}(没有|暂无|不提供|无法提供|不能提供)/;

// 无人值守时，这些动作我们做不到，说了就是假承诺
const PROMISE = /留言.{0,8}回|看到.{0,10}回|尽快(帮|给|处理)|马上跟进|会跟进|跟进处理|马上处理|尽快处理|安排人|反馈给店里|反馈给店|转给(售后|人工|专员)|稍后有人|专人和您联系|帮您查|查一下|查询一下|核实一下|稍后回复|帮您看下|帮您判断|帮您催|帮您留意|帮您处理|帮您解决|反馈|答复|相关同事|记录一下|帮您算|核实|帮您确认|确认一下再|帮您排查|帮您看看|再回复您|转人工|帮您转|帮您一起|一起排查|确认后.{0,6}回复|马上回复|尽快回复|第一时间回复|回复您|联系您|给您回电|稍后联系/;
// 索取信息 = 制造下一轮；而下一轮我们大概率答不上，且没有看图/查单能力
const SOLICIT = /(发我|发过来|发给|拍给我|拍一下|拍张|拍照|拍下.{0,20}(发|给)|您把.{0,10}发|提供.{0,8}订单号|提供.{0,6}照片|说下|说一下|告诉我|方便的话)/;

// 按句剔除做不到的承诺，保留事实部分；剔完太短就整段换模板
function stripUnsafe(text, ask) {
  const parts = String(text || '').split(/(?<=[。！？!?；;])/).map((x) => x.trim()).filter(Boolean);
  const keep = parts.filter((p) => {
    if (SOLICIT.test(p) || PROMISE.test(p)) return false;
    if (INTERNAL.test(p)) return false;
    if (OUTCOME.test(p) && ask !== 'return_policy') return false;
    return true;
  });
  let cleaned = keep.join('').replace(/[；;、，,\s]+$/, '');
  if (cleaned && !/[。！？!?]$/.test(cleaned)) cleaned += '。';
  return cleaned.length >= 8 ? cleaned : '';
}

// 威胁语境下的回复类型：看他要我们办的是哪件事
function threatKind(ask, text) {
  if (ask === 'shipping_time' || ask === 'arrival_time' || ask === 'shipping_status') return 'shipping_delay';
  if (/发货|快递|物流|到货/.test(text)) return 'shipping_delay';
  if (/售后|坏|破|不发芽|没出芽/.test(text)) return 'after_sale';
  return 'generic';
}

/**
 * @param {{buyerText:string, understanding:object, intent:string, suggestions:Array,
 *          risks:string[], knowledge?:Array, products?:Array}} input
 * @returns {{action:'keep'|'replace'|'hold'|'fallback', issues:string[], reason:string,
 *            replyKind?:string, confidenceCap?:number}}
 */
function review(input) {
  const { understanding, suggestions } = input;
  const un = understanding || {};
  const ask = un.ask || 'other';
  const list = Array.isArray(suggestions) ? suggestions : [];
  const text = list.map((s) => s.text || '').join('\n');
  const caps = input.capabilities || {};
  const attended = Boolean(caps.humanAvailable);
  const hits = Array.isArray(input.knowledge) ? input.knowledge : [];
  const prods = Array.isArray(input.products) ? input.products : [];

  const issues = [];
  if (!text) return { action: 'keep', issues, reason: '' };

  // 1. 越界承诺：任何话题都不许打包票
  if (overPromise(text)) {
    issues.push('越界承诺');
    return { action: 'fallback', issues, reason: '候选里出现保证/赔付口吻，已丢弃，改为兜底' };
  }

  // 1.15 范围纪律：只问地区/运费，不追加发货时效
  const asks = Array.isArray(un.asks) ? un.asks : [ask];
  if (asks.includes('freight') && !asks.includes('shipping_time') && !asks.includes('arrival_time')) {
    let changed = false;
    const cleanedList = list.map((s) => {
      const parts = String(s.text || '').split(/([，。；！？\n])/);
      for (let i = 0; i < parts.length; i += 2) {
        const seg = parts[i] || '';
        if (/16点|顺延|当天.{0,4}(发|发出)/.test(seg) && !/运费|包邮|补差|新疆|西藏|内蒙古/.test(seg)) {
          parts[i] = '';
          changed = true;
        }
      }
      return parts.join('');
    }).filter((s) => s && s.trim());
    if (changed) {
      issues.push('答非所问');
      return { action: 'replace', issues, reason: '只问地区/运费，已去掉多余的发货时效', cleanedList };
    }
  }

  // 1.18 不许说买家没发过的内容（“您发的这串数字”）
  if (!input.buffer && /(?:您|你)(?:发|给)的?(?:这|那)?(?:串)?(?:数字|号码|单号)/.test(text)
      && !/\d{3,}/.test(String(input.buyerText || ''))) {
    issues.push('无中生有');
    return { action: 'fallback', issues, reason: '候选说买家发了数字/单号，但买家没发，改为兜底' };
  }

  // 1.2 事实题不能拿反问当回答
  if (!input.buffer && !input.clarify && !input.multiEntity && typeof ask !== 'undefined' && SHOP_ASK.has(ask) && /[？?]\s*$/.test(text)) {
    issues.push('答非所问');
    return { action: 'fallback', issues, reason: '买家问事实，候选却反问，改为页面口径' };
  }

  // 1.4 安全类不许绝对化：放心使用/绝对安全不是我们能保证的
  const safety = require('./concerns').detect(input.buyerText || '');
  if (!input.buffer && safety && safety.key === 'safety' && /放心使用|绝对安全|保证安全|完全无害/.test(text)) {
    issues.push('安全绝对化');
    return { action: 'fallback', issues, reason: '安全类不做绝对保证，改为边界口径' };
  }

  // 1.45 售后类必须给订单页售后入口，不能只共情
  const firstText = (list[0] && list[0].text) || '';
  if (!input.buffer && (ask === 'after_sale' || ask === 'return_policy') && !/售后|订单页|申请|退换/.test(firstText)) {
    issues.push('售后没出口');
    return { action: 'fallback', issues, reason: '售后问题只共情没给入口，改为订单页售后口径' };
  }

  // 1.5 资质/报告/发票：不许替商家否定（没有查到 ≠ 商家没有）
  if (!input.buffer && NEGATIVE_CERT.test(text)) {
    issues.push('替商家否定');
    return {
      action: 'fallback',
      issues,
      reason: '候选替商家否定了资质/报告/发票，改成正面口径并转复核',
    };
  }

  // 2. 威胁语境：必须先接情绪 + 给具体动作，不能讲规则、不能提退款
  if (un.threat) {
    if (!hasEmpathy(text) || !hasAction(text) || saysRefund(text)) {
      issues.push('威胁未安抚');
      return {
        action: 'replace',
        issues,
        reason: '买家在施压，候选只讲规则/在提退款，已换成先道歉再办事',
        replyKind: threatKind(ask, un.text || input.buyerText || ''),
      };
    }
  }

  // 2.5 可执行性：无人值守时，不许承诺做不到的动作、不许索取信息
  //     但三级缓冲里的"问一句"是产品要求的，不算制造下一轮
  if (!attended && !input.buffer) {
    const cleanedList = list.map((x) => stripUnsafe(x.text, ask));
    if (!input.multiEntity && ask !== 'invoice' && SOLICIT.test(text)) {
      issues.push('引导下一步');
      return {
        action: 'replace',
        issues,
        reason: '回复在索取订单号/照片，等于制造下一轮；已剔除该句',
        replyKind: ask === 'shipping_status' ? 'shipping_status' : ask === 'after_sale' ? 'after_sale' : ask === 'other' ? 'offtopic' : 'generic',
        cleanedList,
      };
    }
    if (PROMISE.test(text)) {
      issues.push('承诺不可执行');
      return {
        action: 'replace',
        issues,
        reason: '回复承诺了查单/跟进/反馈等人力动作，但当前是无人值守；已剔除该句',
        replyKind: ask === 'shipping_time' || ask === 'arrival_time' ? 'shipping_delay' : ask === 'after_sale' ? 'after_sale' : ask === 'other' ? 'offtopic' : 'generic',
        cleanedList,
      };
    }
  }

  // 3. 立场：不是售后/退换话题，却主动把人往退款上带
  //    三级缓冲（买家已在谈退款）里引导售后是产品要求，不算劝退
  if (!KEEP_TOPICS.has(ask) && saysRefund(text) && !input.buffer) {
    issues.push('劝退');
    return {
      action: 'replace',
      issues,
      reason: '买家问的是' + ask + '，候选却在引导退款/退货——违背商家利益，已换成安抚+具体动作',
      replyKind: threatKind(ask, un.text || input.buyerText || ''),
    };
  }

  // 3.5 情绪催办：可以答规则，但必须先接情绪 + 给动作
  if ((ask === 'shipping_time' || ask === 'arrival_time') && un.emotion && !hasAction(text)) {
    issues.push('催办未安抚');
    return { action: 'replace', issues, reason: '买家在催，候选只讲规则没给动作，已换成先安抚再催办', replyKind: 'shipping_delay' };
  }

  // 4. 物流状态：没有订单号就答不了「到哪了」
  const hasOrderFact = Boolean(input.facts && Array.isArray(input.facts.items)
    && input.facts.items.some((i) => i.block === 'order'));
  if (ask === 'shipping_status' && !hasOrderFact && !/订单号|单号|订单页|物流进度/.test(text)) {
    issues.push('答不了物流状态');
    return { action: 'replace', issues, reason: '问物流进度但没有订单号，先要单号再查', replyKind: 'shipping_status' };
  }

  // 4.5 快递公司：说不清是哪家，就别拿发货时间糊弄
  if (ask === 'courier' && !/顺丰|中通|圆通|韵达|邮政|极兔|申通|默认.*快递|快递公司/.test(text)) {
    issues.push('答不了快递公司');
    return { action: 'fallback', issues, reason: '问的是哪家快递，候选没给出承运方，改为兜底' };
  }

  // 4.5 结果承诺 / 内部口径：能留事实就留，留不下就换正面模板
  const outcome = OUTCOME.test(text) && ask !== 'return_policy';
  const internal = INTERNAL.test(text);
  if (outcome || internal) {
    if (outcome) issues.push('结果承诺');
    if (internal) issues.push('暴露内部');
    // 种植类问题自曝“资料里没有”时，直接给正面模板，别留半截温度参数
    if (internal && ask === 'usage') {
      return { action: 'replace', issues, reason: '不暴露内部口径，改为正面表述', replyKind: 'grow' };
    }
    const cleanedList = list.map((x) => stripUnsafe(x.text, ask));
    if (cleanedList.some(Boolean)) {
      return { action: 'replace', issues, reason: '剔除了结果承诺/内部口径，保留事实部分', cleanedList };
    }
    return {
      action: 'replace',
      issues,
      reason: outcome ? '只剩结果承诺，已换成正面的安抚表述' : '回复在暴露内部口径，已换成正面表述',
      replyKind: ask === 'usage' ? 'grow' : ask === 'other' ? 'offtopic' : 'generic',
    };
  }

  // 2.6 辱骂复述：任何会话都不许把脏话带出去
  if (!input.buffer && ABUSE_RE.test(text)) {
    issues.push('复述辱骂');
    return { action: 'fallback', issues, reason: '候选复述了辱骂词，改为情绪安抚', replyKind: 'offtopic' };
  }

  // 5. 依据：知识库、商品、Pro 事实包都没有，模型不该凭空给事实性答案
  const factGround = Boolean(input.facts && Array.isArray(input.facts.items)
    && input.facts.items.some((f) => ['order', 'product', 'manual', 'policy', 'general'].includes(f.block)));
  if (SHOP_ASK.has(ask) && !hits.length && !prods.length && !factGround && !input.buffer) {
    issues.push('无依据');
    return { action: 'fallback', issues, reason: '知识库和商品都没有这款的依据，改为兜底并转复核' };
  }

  // 5.2 Pro 事实包：模型可以组织语言，但不能引用不存在的事实、不能报没来源的数字
  if (input.facts) {
    const fp = input.facts;
    const items = Array.isArray(fp.items) ? fp.items : [];
    const ids = new Set(items.map((x) => x.id));
    const invalid = Array.isArray(fp.invalid) && fp.invalid.length
      ? fp.invalid
      : (Array.isArray(fp.used) ? fp.used : []).filter((u) => !ids.has(u));
    if (invalid.length) {
      issues.push('引用不存在');
      return { action: 'fallback', issues, reason: '模型引用了不存在的事实编号（' + invalid.slice(0, 3).join('、') + '），按无依据处理' };
    }

    // 数字必须来自事实原文（docs/32 不变量 4）：价格/时效/规格这类报错一位数就是事故
    if (SHOP_ASK.has(ask)) {
      const nums = text.match(/\d+(?:\.\d+)?/g) || [];
      const hay = items.map((x) => String(x.text || '')).join(' ');
      const bad = [...new Set(nums.filter((n) => !hay.includes(n)))];
      if (bad.length) {
        issues.push('数字无依据');
        return { action: 'fallback', issues, reason: '回复里的数字（' + bad.slice(0, 3).join('、') + '）在事实里找不到，按编造处理' };
      }
    }

    // 多意图覆盖：事实取的是并集，回复也得逐条覆盖（ISS-008）
    const blocks = new Set(fp.blocks || []);
    const expect = (fp.asks || []).filter((a) => {
      if (a === 'price' || a === 'stock' || a === 'product' || a === 'spec') return blocks.has('product') || blocks.has('manual');
      if (a === 'usage' || a === 'recommend') return blocks.has('manual') || blocks.has('policy');
      if (a === 'shipping_status') return blocks.has('order');
      return blocks.has('policy') || blocks.has('order');
    });
    if (expect.length > 1) {
      const uncovered = expect.filter((a) => TOPIC_SIGNALS[a] && !TOPIC_SIGNALS[a].test(text));
      // 规格允许「以商品页标注为准」这种口径，不算没答
      const real = uncovered.filter((a) => !(a === 'spec' && /商品页|规格/.test(text)));
      if (real.length) {
        issues.push('多意图未覆盖');
        return { action: 'fallback', issues, reason: '买家同时问了' + real.join('、') + '，回复只答了其中一部分，改为兜底' };
      }
    }
  }

  // 5.5 时间/地域判断：没有当地气候数据，不许替买家下「现在能种」的结论
  const rawText = (un.text || '') + ' ' + (input.buyerText || '');
  const timeSensitive = /现在|今天|这几天|这两天|今年|最近|入冬|过冬/.test(rawText);
  if (timeSensitive && (ask === 'usage' || ask === 'recommend') && /现在.{0,6}(可以|能|合适|没问题)|(可以|能|合适|没问题).{0,6}现在/.test(text)) {
    issues.push('时间判断无依据');
    return { action: 'fallback', issues, reason: '回复替买家断言「现在能种」，但我们没有当地气候数据，改为兜底' };
  }

  // 6.6 数字/单位溯源：带单位的数字必须来自事实；问抽不能答张
  const factText = input.facts && Array.isArray(input.facts.items)
    ? input.facts.items.map((i) => String(i.text || '')).join(' \n ')
    : '';
  if (factText) {
    const um = unitMismatch(input.buyerText, text);
    if (um) {
      const [wantUnit, badUnit] = um.split('/');
      if (unitDeferred(text, wantUnit)) {
        // 已经明确把该单位推到包装/页面，不算答错
      } else {
      const cleanedList = list.map((s) => repairUnitClaims(s.text, badUnit, wantUnit)).filter((s) => s);
      if (cleanedList.length) {
        issues.push('单位不一致');
        return { action: 'replace', issues, reason: '只替换数量单位那一句，保留价格/其他事实', cleanedList };
      }
      issues.push('单位不一致');
      return { action: 'fallback', issues, reason: '买家问的单位是「' + wantUnit + '」，候选答成了「' + badUnit + '」，改为页面口径' };
      }
    }
    const bad = ungroundedNumbers(text, factText);
    if (bad.length) {
      issues.push('数字无依据');
      return { action: 'fallback', issues, reason: '候选里的数字「' + bad.slice(0, 4).join('、') + '」在事实里找不到，改为兜底' };
    }
  }

  // 6.4 多包裹：必须逐个报到，不能只报一个
  if (!input.buffer && input.facts && Array.isArray(input.facts.items)) {
    const order = input.facts.items.find((i) => i.block === 'order');
    const pm = order && /包裹：([^；]+(?:；[^；]+)*?)(?:；商品：|$)/.exec(order.text || '');
    if (pm && (ask === 'courier' || /快递|哪家|包裹/.test(input.buyerText || ''))) {
      const parts = pm[1].split('；').map((x) => x.trim()).filter((x) => /(顺丰|中通|圆通|韵达|申通|极兔|邮政|EMS|京东快递|德邦)/.test(x));
      const couriers = parts.map((x) => (x.match(/(顺丰|中通|圆通|韵达|申通|极兔|邮政|EMS|京东快递|德邦)/) || [])[1]).filter(Boolean);
      if (parts.length > 1 && !couriers.every((c) => text.includes(c))) {
        issues.push('包裹不全');
        return {
          action: 'replace', issues,
          reason: '这单有多个包裹，候选没有逐个报全',
          cleanedList: ['亲，这单分了' + parts.length + '个包裹：' + parts.join('；') + '，具体看订单页物流哈。'],
        };
      }
    }
  }

  // 6.5 订单实际快递优先于默认政策：不能拿“默认中通”答已发申通的单
  if (!input.buffer && input.facts && Array.isArray(input.facts.items)) {
    const order = input.facts.items.find((i) => i.block === 'order');
    const m = order && /快递[：:]\s*(顺丰|中通|圆通|韵达|申通|极兔|邮政|EMS|京东快递|德邦)/.exec(order.text || '');
    if (m && (ask === 'courier' || /发.{0,4}(哪家|什么).{0,2}快递|哪家快递|什么快递/.test(input.buyerText || ''))) {
      const actual = m[1];
      if (!text.includes(actual)) {
        issues.push('快递不符');
        return {
          action: 'replace',
          issues,
          reason: '本单实际快递是' + actual + '，按订单事实纠正',
          cleanedList: ['亲，您这单发的是' + actual + '哈，物流信息在订单页可以看到。'],
        };
      }
    }
  }

  // 6. 对题：问的东西，回复里有没有对应的答案信号
  //    但买家关切（安全/凭证/地域）被正面回应了，就不按 ask 再卡一次
  const concern = require('./concerns').detect((input.buyerText || '') + ' ' + (un.text || ''));
  const concernAddressed = concern && concern.a.test(text);
  const buffered = Boolean(input.buffer); // 三级缓冲：这一句本来就是在问/在安抚
  const signal = TOPIC_SIGNALS[ask];
  if (signal && !signal.test(text) && !concernAddressed && !buffered && !input.clarify && !input.multiEntity) {
    issues.push('答非所问');
    return { action: 'fallback', issues, reason: '候选没有回答「' + ask + '」，已丢弃，改为兜底' };
  }

  // 6.5 限定词：问「多少」就得给出那个数，或者明确让去看权威页面
  const dims = un.dims || [];
  const missing = missingDims(text, dims);
  if (!input.clarify && !input.multiEntity && missing.length && !DEFER.test(text)) {
    issues.push('没答到数值');
    return { action: 'fallback', issues, reason: '买家问的是具体数值（' + missing.join('、') + '），候选没有给出，改为兜底' };
  }

  // 7. 诚实说不知道：不算答上，进复核；但回复已产出，照常计费
  // 只有事实题才要求“答上来”；日常对话说“查不到”是正常回应
  if (isHonestUnknown(text) && (SHOP_ASK.has(ask) || ask === 'usage')) {
    issues.push('未答上');
    return { action: 'fallback', issues, reason: '回复承认查不到资料，按「没答上」处理并进复核；兜底话术照常计费' };
  }

  // 8. 只有承诺没有结论：可以发，但不算答案
  if (isEmptyHedge(text)) {
    issues.push('空话');
    return { action: 'hold', issues, reason: '只承诺去核实，没有结论——进复核；回复照常计费', confidenceCap: 0.45 };
  }

  return { action: 'keep', issues, reason: '' };
}

module.exports = { review, stripUnsafe, TOPIC_SIGNALS, FACTUAL, isEmptyHedge, isHonestUnknown, overPromise, saysRefund, NEGATIVE_CERT, missingDims, DIM_SIGNALS, unitMismatch, ungroundedNumbers };
