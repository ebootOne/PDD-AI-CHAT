'use strict';

/**
 * metrics.js —— 运行指标（内部工具）
 *
 * 用法：
 *   node scripts/metrics.js            # 近 1 天，排除测试会话
 *   node scripts/metrics.js 7          # 近 7 天
 *   node scripts/metrics.js 7 --test   # 包含测试会话
 *
 * 这些数字只给我们自己看：模型调用率、成本不外露（AGENTS 第 12 条）。
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';

(async () => {
  const args = process.argv.slice(2);
  const days = Number(args.find((a) => /^\d+$/.test(a)) || 1);
  const includeTest = args.includes('--test');
  const url = `${API}/api/metrics?days=${days}&includeTest=${includeTest ? 1 : 0}`;
  let m;
  try {
    m = await (await fetch(url)).json();
  } catch (e) {
    console.error('取不到指标：本地服务没起？', e.message);
    process.exit(1);
  }
  if (!m || !m.ok) {
    console.error('指标接口报错：', (m && m.error) || 'unknown');
    process.exit(1);
  }

  console.log(`\n近 ${m.days} 天${m.includeTest ? '（含测试会话）' : '（不含测试会话）'} · 回复 ${m.total} 条\n`);
  console.log('引擎      回复   本地率   模型率   兜底率   平均点   均延迟');
  for (const [eng, b] of Object.entries(m.byEngine || {})) {
    console.log(
      `${eng.padEnd(8)} ${String(b.replies).padStart(5)} ${String(b.localRate + '%').padStart(7)} ${String(b.modelRate + '%').padStart(7)} ${String(b.fallbackRate + '%').padStart(7)} ${String(b.avgPoints).padStart(7)} ${String(b.avgLatency + 'ms').padStart(8)}`
    );
  }

  if (m.fact && m.fact.packs) {
    const f = m.fact;
    console.log(`\n事实包：${f.packs} 个 · 平均 ${f.avgTokens} tokens / ${f.avgItems} 条`);
    console.log(`  正常 ${f.normal} · 扩召回 ${f.wide}（${f.wideRate}%）· 空包 ${f.empty}（${f.emptyRate}%）`);
    console.log(`  注册表命中 ${f.registry}（${f.registryRate}%）· 带缺失 ${f.missing}（${f.missingRate}%）· 引用非法 ${f.invalid}`);
  } else {
    console.log('\n事实包：窗口内没有 Pro 调用');
  }

  console.log(`\n注册表未处理缺口：${m.gaps} 条\n`);
})();
