'use strict';

/**
 * sync-products.js —— 从商家后台「商品列表」页同步商品到本地商品库
 *
 * 只读、可回滚、异常不覆盖：抓不到或条数异常时不动本地数据。
 * 运行：node scripts/sync-products.js
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const PORT = Number(process.env.CDP_PORT || 9335);
const CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html#/';
const GOODS_URL = 'https://mms.pinduoduo.com/goods/goods_list';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && /mms\.pinduoduo\.com/.test(x.url || ''));
  if (!t) throw new Error('没找到拼多多页面');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id);
      pending.delete(m.id);
      q(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result && r.result.value;
  };
  return { ws, send, ev };
}

(async () => {
  const c = await connect();
  console.log('打开商品列表…');
  await c.send('Page.navigate', { url: GOODS_URL });
  await sleep(6000);

  const rows = await c.ev(`(() => {
    const out = [];
    document.querySelectorAll('tr').forEach((tr) => {
      const nameEl = tr.querySelector('span.goods-name');
      if (!nameEl) return;
      const rowText = (tr.innerText || '').replace(/\\s+/g, ' ');
      const idMatch = rowText.match(/ID:\\s*([0-9]+)/);
      let price = '', stock = '';
      tr.querySelectorAll('td').forEach((td) => {
        const t = (td.innerText || '').replace(/\\s+/g, ' ').trim();
        if (!price && /修改价格/.test(t)) price = (t.match(/[0-9]+(?:\\.[0-9]+)?(?:～[0-9]+(?:\\.[0-9]+)?)?/) || [''])[0];
        if (!stock && /修改库存/.test(t)) { const m = t.match(/([0-9]+)/); if (m) stock = m[1]; }
      });
      out.push({ goodsId: idMatch ? idMatch[1] : '', title: nameEl.innerText.trim(), price, stock, status: /已下架/.test(rowText) ? 'off_shelf' : 'on_sale' });
    });
    return out;
  })()`);

  console.log('抓到 ' + rows.length + ' 个商品');
  if (!rows.length) {
    console.log('没有抓到商品，未改动本地数据');
    await c.send('Page.navigate', { url: CHAT_URL });
    process.exit(1);
  }

  const STORE = process.env.STORE_ID || 'real';
  const all = (await (await fetch(API + '/api/products')).json()).items || [];
  const mine = all.filter((p) => p.storeId === STORE);

  // 异常不覆盖：只和「本店上次同步的条数」比，别的店的商品不算
  if (mine.length > 3 && rows.length < mine.length * 0.5) {
    console.log('条数异常（本次 ' + rows.length + '，上次 ' + mine.length + '），拒绝覆盖');
    await c.send('Page.navigate', { url: CHAT_URL });
    process.exit(2);
  }

  const byId = new Map(all.filter((p) => p.storeId !== STORE).map((p) => [String(p.storeId || 'seed') + ':' + String(p.goodsId), p]));
  for (const p of mine) byId.set(String(STORE) + ':' + String(p.goodsId), p);
  for (const r of rows) {
    const key = String(STORE) + ':' + String(r.goodsId);
    const prev = byId.get(key) || {};
    const [min, max] = String(r.price).split('～');
    byId.set(key, {
      storeId: STORE,
      ...prev,
      goodsId: r.goodsId,
      title: r.title,
      price: Number(min) || prev.price || 0,
      priceMax: max ? Number(max) : undefined,
      stock: Number(r.stock) || 0,
      status: r.status,
      enabled: r.status === 'on_sale',
      syncedAt: new Date().toISOString(),
      source: 'mms-sync',
    });
  }

  const merged = [...byId.values()];
  const r = await fetch(API + '/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: merged }),
  });
  const out = await r.json();
  console.log('已写入商品库：' + JSON.stringify(out));

  await c.send('Page.navigate', { url: CHAT_URL });
  console.log('已切回客服页');
  c.ws.close();
})().catch((e) => {
  console.error('同步失败：', e.message);
  process.exit(1);
});
