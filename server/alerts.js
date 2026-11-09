'use strict';

/**
 * alerts.js —— 预警推送
 *
 * 为什么必须有：兜底话术只能保住"有回应"，保不住"有人管"。
 * 商家不在电脑前时，面板上的红点等于没有。预警必须推到他的微信上。
 *
 * 通道做成可插拔：企业微信机器人 / 飞书机器人 / Server酱 / 任意 Webhook（OpenClaw 之类的网关走这个）。
 */

const store = require('./store');

const lastSent = new Map(); // key -> ts，用来做冷却

function fmt(event) {
  const lines = [
    '【客服预警】' + (event.level === 'high' ? '🔴 高' : '🟡 中'),
    '店铺：' + (event.storeName || event.storeId || '-'),
    '会话：' + (event.conversationId || '-'),
    '原因：' + (event.title || event.rule || '-'),
  ];
  if (event.buyerText) lines.push('买家：' + String(event.buyerText).slice(0, 60));
  if (event.detail) lines.push('详情：' + String(event.detail).slice(0, 120));
  lines.push('时间：' + new Date().toLocaleString('zh-CN', { hour12: false }));
  return lines.join('\n');
}

async function postJson(url, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendToChannel(ch, text, event) {
  if (!ch || !ch.url) return { ok: false, error: '缺少 url' };
  if (ch.type === 'wecom') {
    return postJson(ch.url, { msgtype: 'text', text: { content: text } });
  }
  if (ch.type === 'feishu') {
    return postJson(ch.url, { msg_type: 'text', content: { text } });
  }
  if (ch.type === 'serverchan') {
    // Server酱：url 形如 https://sctapi.ftqq.com/<KEY>.send
    return postJson(ch.url, { title: '客服预警', desp: text });
  }
  // 默认：通用 webhook（OpenClaw / 自建网关都走这里）
  return postJson(ch.url, { event, text }, ch.headers || {});
}

/**
 * 发一条预警。带冷却，避免同一个会话刷屏。
 * @param {object} event { rule, level, storeId, storeName, conversationId, buyerText, title, detail }
 */
async function notify(event) {
  const cfg = store.getConfig();
  const a = cfg.alerts || {};
  if (!a.enabled) return { ok: false, skipped: 'disabled' };

  const channels = (a.channels || []).filter((c) => c && c.url);
  if (!channels.length) return { ok: false, skipped: 'no-channel' };

  const key = (event.rule || 'event') + ':' + (event.conversationId || event.storeId || '');
  const now = Date.now();
  const last = lastSent.get(key) || 0;
  if (now - last < (a.cooldownMs || 600000)) return { ok: false, skipped: 'cooldown' };
  lastSent.set(key, now);

  const text = fmt(event);
  const results = [];
  for (const ch of channels) {
    const r = await sendToChannel(ch, text, event);
    results.push({ type: ch.type, ...r });
  }

  await store.addLog({ type: 'alert', rule: event.rule, level: event.level, conversationId: event.conversationId, title: event.title, results });
  return { ok: results.some((r) => r.ok), results };
}

/** 测试通道 */
async function test(channels) {
  const results = [];
  for (const ch of channels || []) {
    const r = await sendToChannel(
      ch,
      '【客服预警】这是一条测试消息，收到说明通道配置正确。\n时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
      { rule: 'test', level: 'normal', title: '通道测试' }
    );
    results.push({ type: ch.type, ...r });
  }
  return results;
}

module.exports = { notify, test, fmt };
