'use strict';

/**
 * registry.js —— 事实路由注册表的维护工具（内部用，商家界面不显示）
 *
 * 用法：
 *   node scripts/registry.js list            看已注册条目
 *   node scripts/registry.js gaps            看未命中缺口（按次数排序）
 *   node scripts/registry.js ignore <key>    忽略一个缺口
 *   node scripts/registry.js ignore-all     忽略全部缺口（清空）
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const cmd = process.argv[2] || 'list';

(async () => {
  const data = await (await fetch(API + '/api/facts/registry')).json();
  const entries = data.entries || [];
  const gaps = (data.gaps || []).slice().sort((a, b) => (b.count || 1) - (a.count || 1));

  if (cmd === 'list') {
    console.log('注册条目 ' + entries.length + ' 条：');
    for (const e of entries) {
      console.log('  ' + (e.match || []).slice(0, 3).join('、') + ' → ' + e.ask + ' | 块: ' + (e.blocks || []).join('+') + ' | ' + e.source);
    }
    return;
  }

  if (cmd === 'gaps') {
    console.log('缺口 ' + gaps.length + ' 条（按次数排序）：');
    for (const g of gaps) console.log('  ×' + (g.count || 1) + '  ' + g.buyerText + '   ask=' + (g.asks || []).join(','));
    return;
  }

  if (cmd === 'ignore') {
    const key = process.argv[3];
    if (!key) return console.log('用法: node scripts/registry.js ignore <key>');
    const r = await fetch(API + '/api/facts/registry/gaps/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    console.log(r.ok ? '已忽略 ' + key : '忽略失败');
    return;
  }

  if (cmd === 'ignore-all') {
    let n = 0;
    for (const g of gaps) {
      const r = await fetch(API + '/api/facts/registry/gaps/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: g.key }),
      });
      if (r.ok) n++;
    }
    console.log('已忽略 ' + n + ' 条缺口');
    return;
  }

  console.log('用法: node scripts/registry.js [list|gaps|ignore <key>|ignore-all]');
})();
