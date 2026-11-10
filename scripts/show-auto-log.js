'use strict';

/** 查看自动回复链路日志：trigger → result → gate → send_ok/fail */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'data', 'logs.jsonl');
const limit = Number(process.argv[2]) || 40;

let lines = [];
try {
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
} catch (e) {
  console.error('没有日志文件：' + file);
  process.exit(1);
}

const auto = lines.filter((x) => String(x.type || '').startsWith('auto_')).slice(-limit);
if (!auto.length) {
  console.log('没有自动链路日志');
  process.exit(0);
}
for (const x of auto) {
  const bits = [x.ts, x.type, x.runId || '-'];
  if (x.decision) bits.push('decision=' + x.decision);
  if (x.reason) bits.push('reason=' + String(x.reason).slice(0, 60));
  if (x.source) bits.push('source=' + x.source);
  if (x.error) bits.push('error=' + x.error);
  if (x.elapsedMs != null) bits.push('ms=' + x.elapsedMs);
  if (x.text) bits.push('text=' + String(x.text).slice(0, 50));
  console.log(bits.join(' | '));
}
