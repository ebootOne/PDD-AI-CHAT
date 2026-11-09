'use strict';

/**
 * natural.js —— 把机器格式说成人话
 *
 * 只做“说法”转换，不改事实：
 *   08:00~23:00 → 早上8点到晚上11点
 *   16:00       → 下午4点
 */

function period(h) {
  if (h < 6) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h === 12) return '中午';
  if (h < 18) return '下午';
  if (h < 24) return '晚上';
  return '深夜';
}

function clock(h, m) {
  const hh = Number(h);
  const mm = Number(m);
  const h12 = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
  return period(hh) + h12 + '点' + (mm ? mm + '分' : '');
}

function speakTime(text) {
  let t = String(text || '');
  t = t.replace(/(\d{1,2}):(\d{2})\s*[~～-]\s*(\d{1,2}):(\d{2})/g, (_, a, b, c, d) => `${clock(a, b)}到${clock(c, d)}`);
  t = t.replace(/(\d{1,2}):(\d{2})/g, (_, a, b) => clock(a, b));
  return t;
}

function hoursText(hours) {
  if (!hours || !hours.start || !hours.end) return '';
  return speakTime(hours.start + '~' + hours.end);
}

module.exports = { speakTime, hoursText, clock };
