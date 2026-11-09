'use strict';

/**
 * migrate-knowledge.js —— 把「通用知识」一次性复制成各店铺自己的条目
 *
 * 目的：让知识库彻底按店铺隔离。复制完，通用条目只作为历史/测试数据保留，
 *      不再参与任何店铺的回答（ISS-001）。
 */

const fs = require('fs');
const path = require('path');

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const STORES_FILE = path.join(process.env.HOME, 'Library', 'Application Support', 'pdd-cs-desktop', 'stores.json');

(async () => {
  const storesRaw = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
  const stores = (storesRaw.stores || []).filter((s) => s.id);
  if (!stores.length) {
    console.log('没有店铺，跳过');
    return;
  }

  const all = (await (await fetch(API + '/api/knowledge')).json()).items || [];
  const generic = all.filter((k) => !k.storeId && !k.archived);
  console.log('通用条目：' + generic.length + ' 条，店铺：' + stores.map((s) => s.name).join('、'));
  if (!generic.length) return;

  for (const s of stores) {
    const mine = all.filter((k) => k.storeId === s.id);
    const have = new Set(mine.map((k) => k.title));
    const additions = generic.filter((k) => !have.has(k.title)).map((k) => ({
      ...k,
      id: 'kb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      storeId: s.id,
      updatedAt: new Date().toISOString(),
    }));
    if (!additions.length) {
      console.log(`- ${s.name}：已有 ${mine.length} 条，无需复制`);
      continue;
    }
    const list = all.filter((k) => k.storeId === s.id).concat(additions);
    // 用整表覆盖：只替换本店的条目
    const whole = all.filter((k) => k.storeId !== s.id).concat(list);
    await fetch(API + '/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: whole }),
    });
    console.log(`- ${s.name}：复制 ${additions.length} 条`);
  }

  console.log('完成。通用条目保留但不再参与店铺回答。');
})().catch((e) => {
  console.error('迁移失败：', e.message);
  process.exit(1);
});
