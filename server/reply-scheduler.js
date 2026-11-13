'use strict';

/**
 * reply-scheduler.js —— 多会话 3 分钟回复调度核心
 *
 * 不直接操作页面；只负责：
 *   - 每个会话独立计时；
 *   - 按最早未回复优先；
 *   - 同一条消息去重；
 *   - 到软 deadline 交安全兜底，硬 deadline 交人工；
 *   - 同一时刻只允许一个发送任务。
 */

const SOFT_MS = 120000;
const HARD_MS = 180000;

function createScheduler(opts = {}) {
  const soft = Number(opts.softMs) || SOFT_MS;
  const hard = Number(opts.hardMs) || HARD_MS;
  const tasks = new Map(); // key -> task
  const done = new Set();
  let sending = false;

  function keyOf(storeId, conversationId, messageId) {
    return [storeId || '', conversationId || '', messageId || ''].join('|');
  }

  function enqueue(input = {}) {
    const key = keyOf(input.storeId, input.conversationId, input.messageId);
    if (done.has(key) || tasks.has(key)) return { ok: false, duplicate: true, key };
    const at = Number(input.at) || Date.now();
    const task = {
      key,
      storeId: input.storeId || '',
      conversationId: input.conversationId || '',
      messageId: input.messageId || '',
      buyerText: input.buyerText || '',
      at,
      softAt: at + soft,
      hardAt: at + hard,
      replied: false,
      state: 'waiting',
    };
    tasks.set(key, task);
    return { ok: true, key, task };
  }

  function markReplied(key) {
    const t = tasks.get(key);
    if (!t) return false;
    t.replied = true;
    t.state = 'replied';
    done.add(key);
    tasks.delete(key);
    return true;
  }

  function markFallback(key) {
    const t = tasks.get(key);
    if (!t) return false;
    t.state = 'fallback';
    t.replied = true;
    done.add(key);
    tasks.delete(key);
    return true;
  }

  function markHuman(key) {
    const t = tasks.get(key);
    if (!t) return false;
    t.state = 'human';
    done.add(key);
    tasks.delete(key);
    return true;
  }

  /** 返回当前应处理的任务：最早未回复优先；到软/硬 deadline 标记。 */
  function tick(now = Date.now()) {
    const list = [...tasks.values()].sort((a, b) => a.at - b.at);
    const out = [];
    for (const t of list) {
      if (now >= t.hardAt) out.push({ type: 'human', task: t });
      else if (now >= t.softAt) out.push({ type: 'fallback', task: t });
      else out.push({ type: 'waiting', task: t });
    }
    return out;
  }

  function next(now = Date.now()) {
    const list = [...tasks.values()]
      .filter((t) => !t.replied)
      .sort((a, b) => a.at - b.at);
    for (const t of list) {
      if (now >= t.hardAt) return { type: 'human', task: t };
      if (now >= t.softAt) return { type: 'fallback', task: t };
    }
    return list[0] ? { type: 'reply', task: list[0] } : null;
  }

  function acquireSend() {
    if (sending) return false;
    sending = true;
    return true;
  }
  function releaseSend() { sending = false; }

  function snapshot() {
    return {
      pending: [...tasks.values()].map((t) => ({ ...t })),
      done: done.size,
      sending,
    };
  }

  return { enqueue, markReplied, markFallback, markHuman, tick, next, acquireSend, releaseSend, snapshot, keyOf };
}

module.exports = { createScheduler, SOFT_MS, HARD_MS };
