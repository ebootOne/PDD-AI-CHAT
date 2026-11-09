'use strict';

/**
 * quota.js —— 点数（计费）账本
 *
 * 当前是「本地模拟账本」，接口按未来「服务端账本」的形状设计：
 *   getQuota() / consume() / recharge()
 * 将来把这三个函数换成 HTTP 调用，上层不用改。
 *
 * 为什么点数最后必须在服务端：
 *   客户端扣点 = 客户端说了算，改一行代码就白嫖。商用必须服务端为准。
 *   本地账本只承担两件事：① 试用期模拟；② 离线时的短期额度缓存（联网对账）。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = 'quota.json';
const DEFAULT_BALANCE = 500; // 试用赠送

function filePath() {
  return path.join(DATA_DIR, FILE);
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(filePath(), 'utf8'));
  } catch (_) {
    return { balance: DEFAULT_BALANCE, usedTotal: 0, ledger: [], seenKeys: [] };
  }
}

function write(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(state, null, 2), 'utf8');
}

function getQuota() {
  const s = read();
  return {
    balance: s.balance,
    usedTotal: s.usedTotal || 0,
    recent: (s.ledger || []).slice(-20).reverse(),
  };
}

/**
 * 扣点。带幂等键，防止网络重试重复扣费。
 * @returns {{ok:boolean, balance:number, duplicate?:boolean, error?:string}}
 */
function consume(points, reason, idempotencyKey) {
  const s = read();
  const key = String(idempotencyKey || '');

  if (key && (s.seenKeys || []).includes(key)) {
    return { ok: true, balance: s.balance, duplicate: true };
  }
  if (s.balance < points) {
    return { ok: false, balance: s.balance, error: '点数不足' };
  }

  s.balance -= points;
  s.usedTotal = (s.usedTotal || 0) + points;
  s.ledger = (s.ledger || []).concat({
    ts: new Date().toISOString(),
    delta: -points,
    reason: reason || 'reply',
    balanceAfter: s.balance,
  }).slice(-500);
  if (key) s.seenKeys = (s.seenKeys || []).concat(key).slice(-500);

  write(s);
  return { ok: true, balance: s.balance };
}

function recharge(points, note) {
  const s = read();
  s.balance += points;
  s.ledger = (s.ledger || []).concat({
    ts: new Date().toISOString(),
    delta: points,
    reason: note || 'recharge',
    balanceAfter: s.balance,
  }).slice(-500);
  write(s);
  return { ok: true, balance: s.balance };
}

module.exports = { getQuota, consume, recharge };
