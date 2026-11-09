'use strict';

/**
 * explain.js —— 把「一句话 → 一条回复」的全过程摊开
 *
 * 用途：回答"这句回复到底是怎么来的"，排查"为什么答非所问/为什么不回答"。
 * 运行：node scripts/explain.js "这个种子发芽率多少"
 */

const engine = require('../server/engine');
const { retrieve } = require('../server/knowledge');
const store = require('../server/store');

const text = process.argv[2] || '这个种子发芽率多少？';
const cfg = Object.assign(store.getConfig(), { mode: 'auto' });
const KB = store.getKnowledge();

(async () => {
  console.log('\n买家：' + text + '\n');

  const intent = engine.classifyIntent(text);
  const risks = engine.detectRisk(text);
  console.log('① 意图识别：' + intent);
  console.log('② 风险识别：' + (risks.length ? risks.join('、') : '无'));

  const hits = retrieve(text, KB, {});
  console.log('\n③ 知识检索（四项独立累加，不是「全部命中」）：');
  if (!hits.length) {
    console.log('   没有命中任何知识');
  }
  for (const h of hits) {
    const d = h.detail || {};
    console.log(`   ${h.entry.title} → ${h.score.toFixed(2)} 分`);
    for (const k of d.kwHits || []) console.log(`     · 关键词「${k.kw}」 +${k.score}`);
    if (d.titleScore) console.log(`     · 标题整词命中 +${d.titleScore}`);
    if (d.bodyScore) console.log(`     · 二元组重合 ${d.body} → +${d.bodyScore}`);
    if (d.bonus) console.log(`     · 商品专属 +${d.bonus}`);
    console.log(`     = ${d.total} 分`);
  }

  const r = await engine.generate(
    { storeId: 'demo', storeName: '演示店', messages: [{ role: 'buyer', text }], mode: 'auto' },
    cfg,
    KB,
    { rateOk: true }
  );

  console.log(
    '\n④ 生成方式：' +
      ({ llm: '模型（LLM）', rule: '本地知识库（不调模型）', product: '商品目录匹配（不调模型）' }[r.source] || '无')
  );
  if (r.products && r.products.length) {
    console.log('   匹配商品：' + r.products.map((x) => `${x.title}（¥${x.price}，库存${x.stock}）`).join('；'));
  }
  if (r.llmError) console.log('   模型调用失败，已回退：' + r.llmError);

  console.log('\n⑤ 候选回复：');
  if (!r.suggestions.length) console.log('   （无候选，转人工）');
  r.suggestions.forEach((s, i) => {
    console.log(`   [${i + 1}] ${s.tone}：${s.text}`);
  });

  console.log('\n⑥ 决策：' + r.decision + ' — ' + r.reason);
  console.log('   置信度 ' + r.confidence + ' · 计费 ' + r.cost + ' 点 · 内部成本 ¥' + (r.marginCost || 0));
  console.log('');
})();
