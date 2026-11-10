'use strict';

/**
 * order-parse.js —— 订单面板文本解析（纯函数，可单测）
 *
 * 输入：右侧 .right-panel-container 的 innerText
 * 输出：{ hasOrder, status, courier, trackingNo, source }
 *
 * 只取白名单：状态 / 快递 / 运单号；收件人、电话、地址一律不取。
 */

function parseOrderPanel(text, statusHint) {
  const txt = String(text || '');
  const status = String(statusHint || '').trim()
    || (txt.match(/(已发货，待签收|待付款|待发货|已发货|待收货|已签收|交易成功|已取消|退款中|售后中)/) || [])[1]
    || '';
  const courier = (txt.match(/(顺丰|中通|圆通|韵达|申通|极兔|邮政|EMS|京东快递|德邦)/) || [])[1] || '';
  // 必须带「运单/快递单号」标签才认，避免把订单号当运单号
  const tn = txt.match(/(?:运单号|快递单号|物流单号)[:：\s]*([A-Za-z0-9]{8,})/);
  const trackingNo = tn ? tn[1] : '';
  if (!status && !courier && !trackingNo) return { hasOrder: false };
  return { hasOrder: true, status, courier, trackingNo, source: 'right-panel' };
}

module.exports = { parseOrderPanel };
