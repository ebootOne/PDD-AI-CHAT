'use strict';

/**
 * backend.js —— 客户端调用服务端模型的通道
 *
 * 分工：
 *   本地：知识库 / 商品 / 规则（0 成本，先跑）
 *   服务端：只在本地不确定时调用，模型密钥在服务端，客户端拿不到
 */

const { maskPhone } = require('./store');

function maskPayload(payload) {
  return {
    ...payload,
    // 只传必要字段，手机号打码，单条截断
    session: String(payload.session || '').slice(0, 200),
    messages: (payload.messages || []).slice(-12).map((m) => ({
      role: m.role,
      text: maskPhone(String(m.text || '').slice(0, 300)),
    })),
    knowledge: (payload.knowledge || []).slice(0, 4).map((k) => ({
      title: String(k.title || '').slice(0, 40),
      answer: String(k.answer || '').slice(0, 500),
    })),
    // Pro 事实包：本地已经脱敏过一遍，这里再按「条数/长度/手机号」兜一次，
    // 不让客户端某处漏洗就把隐私送到模型（docs/36 硬约束）
    facts: maskFacts(payload.facts),
  };
}

function maskFacts(facts) {
  if (!facts || !Array.isArray(facts.items)) return undefined;
  return {
    version: 1,
    // normal=正常路由；wide=扩召回（事实可能不贴题）；empty=没事实
    mode: facts.mode === 'wide' ? 'wide' : facts.mode === 'empty' ? 'empty' : 'normal',
    route: {
      blocks: (facts.route && facts.route.blocks || []).slice(0, 6).map((x) => String(x).slice(0, 12)),
      asks: (facts.route && facts.route.asks || []).slice(0, 4).map((x) => String(x).slice(0, 16)),
    },
    items: facts.items.slice(0, 8).map((f) => ({
      id: String(f.id || '').slice(0, 6),
      block: String(f.block || '').slice(0, 12),
      label: String(f.label || '').slice(0, 24),
      text: maskPhone(String(f.text || '').slice(0, 260)),
    })).filter((f) => f.id && f.text),
    missing: (facts.missing || []).slice(0, 6).map((m) => ({
      block: String((m && m.block) || '').slice(0, 12),
      reason: String((m && m.reason) || '').slice(0, 24),
    })),
  };
}

/**
 * @returns {Promise<{ok:boolean, candidates?:Array, confidence?:number, error?:string}>}
 */
async function call(cfg, pathname, payload) {
  const b = (cfg && cfg.backend) || {};
  if (!b.url) return { ok: false, error: '未配置服务端' };

  const url = String(b.url).replace(/\/+$/, '') + pathname;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), b.timeoutMs || 30000);
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(b.token ? { Authorization: 'Bearer ' + b.token } : {}),
      },
      body: JSON.stringify({ deviceId: b.deviceId || 'local-dev', ...payload }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { ok: false, error: text.slice(0, 200) };
    }
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || 'HTTP ' + res.status, ms: Date.now() - t0 };
    }
    return { ...data, ms: Date.now() - t0 };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '服务端请求超时' : String((e && e.message) || e);
    return { ok: false, error: msg, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function reply(cfg, payload) {
  return call(cfg, '/v1/reply', maskPayload(payload));
}

/** 路由注册表分析：拿一句买家话，让服务端判断需要哪些事实块（不生成回复） */
async function registryAnalyze(cfg, utterance) {
  return call(cfg, '/v1/registry', { utterance: String(utterance || '').slice(0, 200) });
}

module.exports = { reply, call, registryAnalyze, maskPayload };
