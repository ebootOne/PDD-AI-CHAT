'use strict';
const API = process.env.API_URL || 'http://127.0.0.1:8787';
async function reply(title, text, engine = 'standard') {
  const r = await fetch(API + '/api/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storeId: 'real', engine, mode: 'suggest', test: true, storeName: 'domain', conversationId: 'dom-' + Date.now() + Math.random(), messages: [{ role: 'buyer', text }], goods: { title } }),
  });
  return r.json();
}
(async () => {
  const stand = await reply('天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚', '怎么催芽');
  const t1 = (stand.suggestions || [])[0] && stand.suggestions[0].text || '';
  if (/浸种|露白|播种|土壤|育苗/.test(t1)) throw new Error('用品仍用种子口径：' + t1);

  const seed = await reply('番茄种子 大果 沙瓤 四季播', '怎么催芽');
  const t2 = (seed.suggestions || [])[0] && seed.suggestions[0].text || '';
  if (!/浸种|催芽|露白|播种|泡/.test(t2)) throw new Error('种子商品没有种植口径：' + t2);
  console.log('domain：用品不串种子 / 种子保留种植 PASS');
})();
