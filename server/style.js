'use strict';

/**
 * style.js —— 礼貌改写（不是禁用清单）
 *
 * 用户的判断是对的：
 *   1. 「您」只是礼貌的一个例子，不该写死成硬规则；
 *   2. 靠穷举禁用词永远举不完，而且命中就丢弃 = 白白浪费一条本来能用的回答。
 *
 * 所以这里改成「检测 → 改写 → 事实校验」三步，永不静默丢弃：
 *   ① 内置改写表：覆盖最常见的生硬说法（确定性、0 成本）
 *   ② 模型润色：表里没有的，交给模型改（长尾，需配 Key）
 *   ③ 兜底话术：连模型都没有/改坏了，才退到兜底
 *
 * 无论走哪一步，都必须有一条回复发出去。
 */

const { chat, extractJson } = require('./llm');

// 最常见的生硬说法 → 礼貌说法。只放"改写后语义不变"的，宁可少放。
const TABLE = [
  [/不知道/g, '这个我帮您确认一下'],
  [/没办法/g, '我帮您想想办法'],
  [/你自己看/g, '您可以先看一下'],
  [/随便/g, '都可以'],
  [/爱买不买/g, '您可以再考虑一下'],
  [/不关我事/g, '这个我帮您转给相关同事'],
  [/管不了/g, '这个我帮您转给相关同事'],
  [/喂[，,！!\s]*/g, ''],
];

// ---------------------------------------------------------------- 亲近语感
//
// 目标：把「1.85 元起。」这种播报腔，变成「1.85 元起呢。」。
// 硬约束：**怎么加都不能加错**。所以不是"到处补个词"，而是：
//   ① 先判断这句是不是真的冷（疑问/致歉/指令/已有语气词 → 不算冷）
//   ② 只对"结尾是可加词"的句型加（白名单，宁可不加）
//   ③ 加完做事实校验，数字/否定变了就放弃
// 三步任一不满足就原样返回——不加，永远不会错。

const ASK_PARTICLE = {
  price: '呢',
  stock: '呢',
  spec: '呢',
  shipping_time: '哈',
  arrival_time: '哈',
  shipping_status: '哈',
  courier: '哈',
  payment: '哦',
  return_policy: '哦',
  invoice: '哦',
  freight: '哦',
};

// 结尾要是这些"可以自然收尾"的词，才允许加语气词
const TAIL_OK = /(元起|元|块钱|有货|现货|没货|缺货|发出|发货|到货|送达|签收|支持|不支持|可以|不可以|能用|包邮|不包邮|为准|左右|就行|就成|直接拍|可以拍|中通|圆通|顺丰|韵达|极兔|申通|邮政|付款|第二天|工作日|发货时间|时效)$/;

// 这些句子不加：致歉、指令、敏感信息
const NEVER = /抱歉|对不起|请|麻烦|感谢|谢谢|投诉|退款|赔付|退货|税号|单号|链接|二维码|隐私/;

function warm(text, opts = {}) {
  let t = String(text || '').trim();
  if (!t) return t;
  if (opts.emotion) return t;

  const core = t.replace(/[。！!～~\s]+$/, '');
  if (!core) return t;
  if (core.length < 4 || core.length > 40) return t;      // 太短没内容，太长不加
  if (/[呢哈哦啦呀嘛吧吗啊]$/.test(core)) return t;       // 已经有语气词
  if (/[？?]$/.test(t)) return t;                          // 疑问句
  if (NEVER.test(core)) return t;
  if (!TAIL_OK.test(core)) return t;                       // 句型不在白名单，宁可不加

  const p = ASK_PARTICLE[opts.ask] || (opts.tier === 'warm' ? '呢' : '哈');
  const joined = core + p;

  // 加完做一次事实校验：数字、否定必须完全一致，否则放弃
  if (!sameFacts(core, joined)) return t;

  return joined + (/！$/.test(t) ? '！' : '。');
}

// 需要模型润色的信号（不能靠词表覆盖的）
function analyze(text, cfg = {}) {
  const t = String(text || '');
  const issues = [];

  // 称呼：只有「正式档」才把单数「你」当问题
  if ((cfg.tone || 'formal') === 'formal' && /你(?!们)/.test(t)) {
    issues.push({ type: 'pronoun', severity: 'low', detail: '用了「你」而不是「您」' });
  }

  // 生硬否定开头
  if (/^(不行|不能|没办法|不知道|不支持)/.test(t)) {
    issues.push({ type: 'harsh', severity: 'high', detail: '开头是生硬否定' });
  }

  // 命令句
  if (/(你必须|赶紧|马上给我|自己搞)/.test(t)) {
    issues.push({ type: 'command', severity: 'high', detail: '命令口吻' });
  }

  // 语气过重
  const ex = (t.match(/！/g) || []).length;
  if (ex > (cfg.maxExclaim || 1)) {
    issues.push({ type: 'exclaim', severity: 'low', detail: ex + ' 个感叹号' });
  }

  // 商家自己加的词（这些无法自动给出改写，只能交给模型或兜底）
  const custom = (cfg.rewriteWords || []).filter((w) => w && t.includes(w));
  if (custom.length) issues.push({ type: 'custom', severity: 'high', detail: '含需改写的词：' + custom.join('、') });

  const score = issues.reduce((n, i) => n + (i.severity === 'high' ? 50 : 15), 0);
  return { score: Math.min(100, score), issues };
}

/** 内置表改写（确定性，不出本机） */
function rewriteByTable(text, cfg = {}) {
  let out = String(text || '');
  const fixed = [];

  // 先跑词表（「你自己看」这类要整词匹配），再统一把「你」换成「您」
  for (const [re, to] of TABLE) {
    re.lastIndex = 0;
    if (re.test(out)) {
      out = out.replace(re, to);
      fixed.push(re.source + '→' + to);
    }
  }

  if ((cfg.tone || 'formal') === 'formal') {
    const before = out;
    out = out.replace(/你(?!们)/g, '您');
    if (out !== before) fixed.push('你→您');
  }

  return { text: out, fixed };
}

// ---------- 事实校验：改写不能把意思改反 ----------

function factsOf(text) {
  const nums = (String(text).match(/\d+(?:\.\d+)?/g) || []).sort();
  const negations = (String(text).match(/不能|不可以|不支持|不退|不包|没有/g) || []).length;
  return { nums, negations };
}

function sameFacts(a, b) {
  const fa = factsOf(a);
  const fb = factsOf(b);
  if (fa.nums.join(',') !== fb.nums.join(',')) return false;
  if (fa.negations !== fb.negations) return false;
  return true;
}

/** 模型润色：只改语气，不改事实 */
async function polishByModel(text, issues, cfg) {
  if (!cfg.llm || !cfg.llm.baseUrl) return null;

  const res = await chat(cfg.llm, [
    {
      role: 'system',
      content:
        '你是客服话术润色器。把用户给你的句子改写得更礼貌、更柔和，但绝对不能改变事实：' +
        '数字、金额、能否、时间、条件必须原样保留。只输出 JSON：{"text":"改写后的句子"}',
    },
    {
      role: 'user',
      content: `原句：${text}\n问题：${issues.map((i) => i.detail).join('；')}`,
    },
  ]);
  if (!res.ok) return null;
  const parsed = extractJson(res.text);
  if (!parsed || !parsed.text) return null;
  if (!sameFacts(text, parsed.text)) return null; // 改坏了就丢掉
  return String(parsed.text).trim();
}

/**
 * 主入口：先改写，改不好再说。
 * @returns {{text:string, fixed:string[], polished:boolean, remaining:Array, score:number}}
 */
async function rewrite(text, cfg = {}) {
  const before = analyze(text, cfg);
  let out = rewriteByTable(text, cfg);
  let polished = false;

  let after = analyze(out.text, cfg);
  const needModel = after.issues.some((i) => i.severity === 'high');

  if (needModel) {
    const better = await polishByModel(out.text, after.issues, cfg);
    if (better) {
      out = { text: better, fixed: out.fixed.concat(['模型润色']) };
      polished = true;
      after = analyze(out.text, cfg);
    }
  }

  return {
    text: out.text,
    fixed: out.fixed,
    polished,
    remaining: after.issues,
    score: before.score,
  };
}

/** 给提示词用的约束 */
function promptRule(style = {}) {
  const rules = [];
  if ((style.tone || 'formal') === 'formal') rules.push('称呼买家尽量用「您」');
  rules.push('不用「不知道」「没办法」「随便」这类敷衍说法');
  rules.push('不用命令句，不用感叹号堆情绪');
  rules.push('先给结论，再给一句理由，不超过三行');
  return rules.join('；') + '。';
}

module.exports = { analyze, rewrite, rewriteByTable, polishByModel, promptRule, sameFacts, warm };
