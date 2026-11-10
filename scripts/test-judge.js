'use strict';

/**
 * test-judge.js —— 质检层单测（不起服务、不调模型、不花钱）
 * 覆盖：引用、数字、单位、承诺、凭证、多意图、缺口。
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const judge = require(path.join(ROOT, 'server', 'judge.js'));

let pass = 0;
let fail = 0;
const fails = [];
function check(id, name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${id}  ${name}`); }
  else { fail++; fails.push(`${id} ${name}`); console.log(`  FAIL  ${id}  ${name} — ${detail || ''}`); }
}

const base = {
  understanding: { ask: 'price', text: '这个多少钱' },
  intent: 'price',
  risks: [],
  knowledge: [{ id: 'kb1', title: '价格' }],
  products: [{ goodsId: '1001', title: '白萝卜种子', price: 9.9 }],
  capabilities: {},
};
const fp = {
  items: [{ id: 'F1', block: 'product', label: '价格', text: '白萝卜种子：9.9 元' }],
  used: ['F1'], invalid: [], asks: ['price'], blocks: ['product'],
};

const ok = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款白萝卜种子是 9.9 元，可以直接拍。' }], facts: fp });
check('J01', '有引用且数字有据 → 放行', ok.action === 'keep', JSON.stringify(ok));

const badCite = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款 9.9 元。' }], facts: { ...fp, invalid: ['F9'] } });
check('J02', '引用不存在 → 兜底', badCite.action === 'fallback' && badCite.issues.includes('引用不存在'), JSON.stringify(badCite));

const badNum = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款白萝卜种子是 8.8 元。' }], facts: fp });
check('J03', '数字无依据 → 兜底', badNum.action === 'fallback' && badNum.issues.includes('数字无依据'), JSON.stringify(badNum));

const multi = {
  ...base,
  understanding: { ask: 'price', text: '多少钱，发什么快递' },
  facts: {
    items: [
      { id: 'F1', block: 'product', label: '价格', text: '白萝卜种子：9.9 元' },
      { id: 'F2', block: 'policy', label: '默认快递', text: '默认发中通。' },
    ],
    used: ['F1'], invalid: [], asks: ['price', 'courier'], blocks: ['product', 'policy'],
  },
};
const partial = judge.review({ ...multi, suggestions: [{ tone: '标准', text: '这款是 9.9 元。' }] });
check('J04', '多意图只答一半 → 兜底', partial.action === 'fallback' && partial.issues.includes('多意图未覆盖'), JSON.stringify(partial));
const full = judge.review({ ...multi, suggestions: [{ tone: '标准', text: '这款是 9.9 元，默认发中通快递。' }] });
check('J05', '多意图逐条覆盖 → 放行', full.action === 'keep', JSON.stringify(full));

const neg = judge.review({ ...base, buyerText: '有质检报告吗', suggestions: [{ tone: '标准', text: '这款暂时没有质检报告，是天然原木。' }], facts: null });
check('J06', '替商家否定资质 → 兜底', neg.action === 'fallback' && neg.issues.includes('替商家否定'), JSON.stringify(neg));
const certOk = judge.review({ ...base, buyerText: '有质检报告吗', suggestions: [{ tone: '标准', text: '亲，检测信息以商品页标注为准哈。' }], facts: null });
check('J07', '正面口径不误杀', certOk.action === 'keep', JSON.stringify(certOk));

const evidenceBad = judge.review({
  ...base, buyerText: '这个木头有没有质检报告',
  understanding: { ask: 'spec', text: '这个木头有没有质检报告' },
  suggestions: [{ tone: '标准', text: '这款是天然花椒木手工打磨的，有色差结疤属正常。' }],
  facts: { items: [{ id: 'M1', block: 'manual', label: '材质', text: '天然花椒木' }], missing: [] },
});
check('J08', '凭证题答材质 → 兜底', evidenceBad.action === 'fallback', JSON.stringify(evidenceBad));

check('J09', '已给天数 → 不缺数值', judge.missingDims('一般3~5天露白', ['days']).length === 0);
check('J10', '只给形容 → 判缺天数', judge.missingDims('温度合适就发芽', ['days']).includes('days'));

const unitBad = judge.review({
  ...base, buyerText: '抽纸多少抽', understanding: { ask: 'spec', text: '抽纸多少抽' },
  suggestions: [{ tone: '标准', text: '这款是520张的大包抽纸哈。' }],
  facts: { items: [{ id: 'F1', block: 'product', label: '商品', text: '加量520张大包抽纸：520张/包' }], missing: [] },
});
check('J11', '问抽答张 → 单位不一致', ['replace', 'fallback'].includes(unitBad.action) && unitBad.issues.includes('单位不一致'), JSON.stringify(unitBad));

const unitOk = judge.review({
  ...base, buyerText: '抽纸多少抽', understanding: { ask: 'spec', text: '抽纸多少抽' },
  suggestions: [{ tone: '标准', text: '520张/包，多少抽以包装标注为准哈。' }],
  facts: { items: [{ id: 'F1', block: 'product', label: '商品', text: '加量520张大包抽纸：520张/包' }], missing: [] },
});
check('J12', '明确说包装标注 → 不误杀', unitOk.action === 'keep', JSON.stringify(unitOk));

const noSuch = judge.review({
  ...base, buyerText: '到底什么时候能到呢',
  suggestions: [{ tone: '标准', text: '亲，您发的这串数字我这边看不到物流详情呢。' }],
  facts: { items: [{ id: 'F1', block: 'order', label: '订单', text: '状态：已发货' }], missing: [] },
});
check('J13', '买家没发过数字 → 无中生有', noSuch.action === 'fallback' && noSuch.issues.includes('无中生有'), JSON.stringify(noSuch));

const numBad = judge.review({
  ...base, buyerText: '这个多少钱',
  suggestions: [{ tone: '标准', text: '亲，2.5 元呢。' }],
  facts: { items: [{ id: 'F1', block: 'product', label: '价格', text: '天然花椒木：1.85 元起' }], missing: [] },
});
check('J14', '事实 1.85 却答 2.5 → 数字无依据', numBad.action === 'fallback' && numBad.issues.includes('数字无依据'), JSON.stringify(numBad));

const noFacts = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款 9.9 元。' }] });
check('J15', '非 Pro 路径不受引用校验影响', noFacts.action === 'keep', JSON.stringify(noFacts));

console.log(`\n质检：${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
