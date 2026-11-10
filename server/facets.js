'use strict';

/**
 * facets.js —— 切面识别与说明书检索词
 *
 * 同一句话可能问多个切面；说明书检索不能只看“有没有关键词”，
 * 要看买家问的是规格、耐久、行为还是普通用法。
 */

const DURABILITY = /能用多久|耐用|耐啃|用多久|会不会断/;
const BEHAVIOR = /不爱啃|不啃|不玩|不愿.{0,4}(啃|磨)/;
const SPEC = /多长|多大(?!的?(?:鸟|鹦鹉|动物|猫|狗|仓鼠|兔))|多高|多粗|尺寸|规格|直径|长度/;
const SUIT = /适合|能用吗|多大的鸟|哪种鸟|什么鸟/;
const USAGE = /怎么用|怎么装|安装|固定|清洗|清洁|消毒|晒太阳|暴晒|掉色|味道|适合|能用吗/;
const CLEAN = /清洗|清洁|消毒|发霉|保养/;
const SUN = /晒太阳|暴晒|阳光|光照|阳台/;
const LOOK = /掉色|色差|结疤|味道|气味|木味/;

function facetOf(text) {
  const s = String(text || '');
  if (DURABILITY.test(s)) return 'durability';
  if (BEHAVIOR.test(s)) return 'behavior';
  if (SPEC.test(s)) return 'spec';
  if (USAGE.test(s)) return 'usage';
  return 'other';
}

/** 给说明书检索的 query：保留原句，按切面补该节的词 */
function manualQueryFor(text) {
  const s = String(text || '');
  const facet = facetOf(s);
  if (facet === 'durability') return s + ' 注意事项 开裂 更换 啃咬';
  if (facet === 'behavior') {
    // 行为问题问“怎么办”，先把物种词从焦点里拿掉，避免命中“适用对象”
    const focus = s.replace(/鹦鹉|鸟宝|鸟儿|鸟/g, '');
    return focus + ' 怎么用 注意事项 啃咬';
  }
  if (facet === 'spec') return s + ' 规格 尺寸';
  if (SUIT.test(s)) return s + ' 适用对象 适合 能用吗';
  // 清洗/暴晒/外观有各自的节，原句已经能命中，不要补“安装”把焦点带偏
  if (CLEAN.test(s) || SUN.test(s) || LOOK.test(s)) return s;
  if (facet === 'usage') return s + ' 怎么用 安装 固定';
  return s;
}

module.exports = { facetOf, manualQueryFor, DURABILITY, BEHAVIOR };
