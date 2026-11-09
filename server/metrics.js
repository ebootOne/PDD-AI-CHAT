'use strict';

/**
 * metrics.js —— 运行指标汇总（仅内部）
 *
 * 输入是 data/logs.jsonl 里的 reply 记录，输出按引擎拆开的：
 *   本地命中率 / 模型调用率 / 兜底率 / 平均扣点 / 平均延迟
 *   Pro 事实包：平均 tokens、平均条数、扩召回率、注册表命中率、引用非法数
 *
 * 为什么不放商家端：模型调用率、成本属于内部信息（AGENTS 第 12 条）。
 * 这里只做纯计算，不读文件，便于单测。
 */

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

function emptyBucket() {
  return { replies: 0, local: 0, model: 0, fallback: 0, handoff: 0, points: 0, latencySum: 0 };
}

/**
 * @param {Array} logs reply 日志
 * @param {{since?:number}} opts since 毫秒时间戳
 */
function summarize(logs, opts = {}) {
  const since = Number(opts.since) || 0;
  const list = (logs || []).filter((x) => x && x.type === 'reply'
    && (!since || Date.parse(x.ts || '') >= since));

  const byEngine = {};
  const fact = { packs: 0, normal: 0, wide: 0, empty: 0, tokens: 0, items: 0, registry: 0, invalid: 0, missing: 0, tokenPacks: 0, itemPacks: 0, registryKnown: 0 };
  let total = 0;
  let local = 0;
  let model = 0;
  let fallback = 0;
  let handoff = 0;
  let points = 0;
  let latency = 0;

  for (const x of list) {
    const eng = x.engine || 'unknown';
    const b = byEngine[eng] || (byEngine[eng] = emptyBucket());
    b.replies++;
    total++;

    const isModel = x.source === 'backend';
    const isHandoff = x.decision === 'handoff' || x.source === 'none';
    if (isModel) {
      b.model++;
      model++;
    } else if (isHandoff) {
      b.handoff++;
      handoff++;
    } else {
      b.local++;
      local++;
    }
    if (x.decision === 'fallback') {
      b.fallback++;
      fallback++;
    }

    const p = Number(x.cost) || 0;
    b.points += p;
    points += p;
    const lat = Number(x.totalMs != null ? x.totalMs : x.latencyMs) || 0;
    b.latencySum += lat;
    latency += lat;

    if (x.factMode) {
      fact.packs++;
      if (x.factMode === 'wide') fact.wide++;
      else if (x.factMode === 'empty') fact.empty++;
      else fact.normal++;
      if (x.factTokens != null) {
        fact.tokens += Number(x.factTokens) || 0;
        fact.tokenPacks++;
      }
      if (x.factItems != null) {
        fact.items += Number(x.factItems) || 0;
        fact.itemPacks++;
      }
      if (x.factRegistry !== undefined && x.factRegistry !== null) {
        fact.registryKnown++;
        if (x.factRegistry) fact.registry++;
      }
      fact.invalid += Number(x.factInvalid) || 0;
      if (x.factMissing) fact.missing++;
    }
  }

  for (const b of Object.values(byEngine)) {
    b.localRate = pct(b.local, b.replies);
    b.modelRate = pct(b.model, b.replies);
    b.fallbackRate = pct(b.fallback, b.replies);
    b.avgPoints = b.replies ? Math.round((b.points / b.replies) * 1000) / 1000 : 0;
    b.avgLatency = b.replies ? Math.round(b.latencySum / b.replies) : 0;
    delete b.latencySum;
  }

  return {
    total,
    local,
    model,
    fallback,
    handoff,
    localRate: pct(local, total),
    modelRate: pct(model, total),
    fallbackRate: pct(fallback, total),
    points: Math.round(points * 1000) / 1000,
    avgPoints: total ? Math.round((points / total) * 1000) / 1000 : 0,
    avgLatency: total ? Math.round(latency / total) : 0,
    byEngine,
    fact: {
      ...fact,
      avgTokens: fact.tokenPacks ? Math.round(fact.tokens / fact.tokenPacks) : 0,
      avgItems: fact.itemPacks ? Math.round((fact.items / fact.itemPacks) * 10) / 10 : 0,
      wideRate: pct(fact.wide, fact.packs),
      emptyRate: pct(fact.empty, fact.packs),
      // 旧日志没有该字段，分母只算「有记录」的包，避免把历史包当成未命中
      registryRate: pct(fact.registry, fact.registryKnown),
      missingRate: pct(fact.missing, fact.packs),
    },
  };
}

module.exports = { summarize, pct };
