'use strict';

/**
 * kb-templates.js —— 常见问题模板库（「入知识库」用）
 *
 * 为什么要有：
 *   发货、快递、运费、发票、退换这些是全行业都会问的，让每个商家从零写一遍不现实；
 *   但答案又是**店铺自己的事实**（发哪家快递、几点截单、补多少运费），不能替商家编。
 *
 * 所以模板只给「问法 + 结构」，关键事实留【】让商家填；
 * 导入后一律 enabled:false（停用），商家核对改写后再启用——不核对就不回答，符合「不编造」。
 */

const CATEGORIES = [
  { id: 'shipping', name: '发货与时效' },
  { id: 'courier', name: '快递' },
  { id: 'freight', name: '运费与包邮' },
  { id: 'payment', name: '支付' },
  { id: 'invoice', name: '发票' },
  { id: 'return', name: '退换货' },
  { id: 'after', name: '售后' },
  { id: 'product', name: '商品咨询' },
  { id: 'misc', name: '其他' },
  { id: 'statement', name: '店铺声明（投诉时用）' },
  { id: 'general', name: '通用常识（非本店数据）' },
];

const T = (id, category, title, question, keywords, answer) => ({
  id,
  category,
  title,
  question,
  keywords,
  answer,
  needsConfirm: true,
});

const TEMPLATES = [
  // 发货与时效
  T('tpl-ship-cutoff', 'shipping', '发货截止时间', '几点前付款当天发货？',
    ['几点发货', '什么时候发货', '当天发吗', '今天能发吗', '截单'],
    '当天【填写时间，如 16:00】前付款的订单当天发出，之后的顺延到第二天。'),
  T('tpl-ship-days', 'shipping', '发货时长', '下单后多久发货？',
    ['多久发货', '几天发货', '什么时候发', '24小时发货吗'],
    '付款后【填写时长，如 48 小时】内发出，节假日顺延。'),
  T('tpl-ship-holiday', 'shipping', '节假日发货安排', '节假日发货吗？',
    ['节假日发货吗', '过年发货吗', '假期发货'],
    '【填写节假日安排，如 春节期间 2 月 X 日恢复发货】。'),
  T('tpl-ship-pre', 'shipping', '预售/缺货说明', '预售多久发货？',
    ['预售', '缺货', '什么时候有货', '补货'],
    '【填写预售/补货时间，如 预售 7 天内发出】。'),
  T('tpl-ship-urge', 'shipping', '催发货安抚', '怎么还没发货？',
    ['催发货', '还没发货', '快点发货', '急用'],
    '非常抱歉让您久等了，我这边马上帮您催促仓库，有进展第一时间回复您。'),

  // 快递
  T('tpl-courier-default', 'courier', '默认快递公司', '发什么快递？',
    ['发什么快递', '哪家快递', '默认快递', '用什么快递'],
    '默认发【主快递，可写多个，如 中通/圆通 随机发】；【偏远地区】转【备选快递，如 邮政】。如需指定快递请备注，能否满足以发货为准。'),
  T('tpl-courier-assign', 'courier', '能否指定快递', '可以指定快递吗？',
    ['指定快递', '发顺丰吗', '能发顺丰吗', '换快递'],
    '【填写能否指定，如 可以备注，需补差价 X 元 / 暂不支持指定】。'),
  T('tpl-courier-remote', 'courier', '快递不到/转寄', '我们这快递不到怎么办？',
    ['快递不到', '不派送', '转邮政', '偏远'],
    '【填写处理方式，如 转邮政小包 / 建议下单前咨询】。'),

  // 运费与包邮
  T('tpl-freight-free', 'freight', '包邮范围', '包邮吗？',
    ['包邮吗', '运费多少', '邮费', '免运费'],
    '【填写包邮范围，如 除新疆西藏内蒙古外全国包邮】。'),
  T('tpl-freight-remote', 'freight', '偏远地区补差', '偏远地区补多少运费？',
    ['补运费', '偏远补差', '新疆运费', '内蒙古运费'],
    '【填写偏远地区补差规则，如 下单页显示补差 X 元】。'),
  T('tpl-freight-return', 'freight', '退换货运费', '退货运费谁承担？',
    ['退货运费', '运费谁出', '质量问题运费'],
    '【填写规则，如 质量问题我们承担，个人原因买家承担】。'),

  // 支付
  T('tpl-pay-methods', 'payment', '支付方式', '支持哪些支付方式？',
    ['支付方式', '怎么付款', '微信支付', '支付宝', '花呗'],
    '支持【填写支付方式，如 微信、支付宝、花呗】，【是否支持货到付款】。'),
  T('tpl-pay-cod', 'payment', '货到付款', '支持货到付款吗？',
    ['货到付款', '到付', '可以先收货再付钱吗'],
    '【填写是否支持货到付款】。'),
  T('tpl-pay-installment', 'payment', '分期/花呗', '可以分期吗？',
    ['分期', '花呗', '信用卡'],
    '【填写分期规则】。'),

  // 发票
  T('tpl-invoice-available', 'invoice', '能否开发票', '能开发票吗？',
    ['开发票', '开票', '发票'],
    '可以开【填写票种，如 电子普票】，下单后把抬头和税号发我，【填写开票时长】开出。'),
  T('tpl-invoice-special', 'invoice', '专票资料', '开专票需要什么？',
    ['专票', '增值税专用发票', '一般纳税人'],
    '专票需要提供【填写资料，如 一般纳税人资格证明、开票信息】，走【填写流程】。'),
  T('tpl-invoice-time', 'invoice', '开票时间', '多久能开出来？',
    ['多久开票', '开票时间', '当天开吗'],
    '【填写开票时长，如 当天开出】。'),

  // 退换货
  T('tpl-return-7', 'return', '七天无理由', '支持七天无理由吗？',
    ['七天无理由', '能退吗', '退货'],
    '【填写规则，如 未拆封支持七天无理由，运费按平台规则】。'),
  T('tpl-return-opened', 'return', '拆封能否退', '拆开了还能退吗？',
    ['拆封能退吗', '打开了能退吗', '用过了能退'],
    '【填写规则，如 已拆封播种的，质量问题我们负责；个人原因需承担来回运费】。'),
  T('tpl-return-quality', 'return', '质量问题退换', '质量问题怎么退？',
    ['质量问题', '坏了', '退货退款'],
    '【填写流程，如 拍照发我，核实后补发或退款】。'),
  T('tpl-return-refund-time', 'return', '退款到账时间', '退款多久到账？',
    ['退款多久到', '退款到账', '钱什么时候退'],
    '【填写到账时长，如 平台审核后 1~3 个工作日原路退回】。'),

  // 售后
  T('tpl-after-nosprout', 'after', '不发芽处理', '种下去不发芽怎么办？',
    ['不发芽', '没出芽', '不出苗', '死苗'],
    '先别急，把【填写需要的信息：播种时间、温度、浸种方式、照片】发我，我帮您判断是种子问题还是方法问题。'),
  T('tpl-after-short', 'after', '少发漏发', '少发了一件怎么办？',
    ['少发', '漏发', '少了一件', '数量不对'],
    '【填写处理方式，如 拍照核对后补发/退款】。'),
  T('tpl-after-damage', 'after', '运输破损', '收到货破损了怎么办？',
    ['破损', '压坏', '包装坏了', '漏了'],
    '【填写处理方式，如 拍照发我，核实后补发】。'),
  T('tpl-after-resend', 'after', '补发时效', '补发多久能到？',
    ['补发多久', '重新发', '什么时候补发'],
    '【填写补发时效】。'),

  // 商品咨询
  T('tpl-product-spec', 'product', '规格与用量', '一袋多少克/能种多少？',
    ['多少克', '多少粒', '一袋能种多少', '规格'],
    '规格以【商品页/包装】标注为准，需要按亩用量的话把种植面积发我，我帮您算。'),
  T('tpl-product-germination', 'product', '发芽率', '发芽率多少？',
    ['发芽率', '出芽率', '能发芽吗'],
    '【填写发芽率与检测说明，如 按批次检测，常规品种 85% 以上】。'),
  T('tpl-product-planting', 'product', '种植方法', '怎么种？',
    ['怎么种', '种植方法', '要泡水吗', '催芽'],
    '【填写种植步骤，如 温水浸种 4~6 小时，25℃ 催芽 3~5 天露白后播种】。'),
  T('tpl-product-region', 'product', '适宜地区/季节', '我们这种合适吗？',
    ['适合什么地区', '几月种', '冬天能种吗', '北方能种吗'],
    '【填写适宜地区与播期，如 春播 3~4 月、秋播 8~9 月】。'),

  // 其他
  T('tpl-misc-address', 'misc', '修改地址', '能改地址吗？',
    ['改地址', '地址写错了', '换地址'],
    '【填写规则，如 发货前可以改，发货后需联系快递】。'),
  T('tpl-misc-merge', 'misc', '合并发货', '两单能一起发吗？',
    ['合并发货', '一起发', '两个订单'],
    '【填写规则，如 同地址可以合并，备注订单号】。'),
  // 店铺声明：投诉时唯一允许的事实来源，必须商家确认
  T('tpl-stmt-channel', 'statement', '正规渠道进货', '你们是不是假货？',
    ['正规渠道', '假货', '是不是正品', '渠道'],
    '我们的种子都是从正规渠道进货的。'),
  T('tpl-stmt-report', 'statement', '可提供检测报告', '有检测报告吗？',
    ['检测报告', '质检报告', '检测'],
    '我们的种子按批次检测，可以提供检测报告。'),

  // 通用常识：回答时必须标注“非本店检测”，不能当店铺事实用
  T('tpl-gen-ph', 'general', '土壤酸碱度（通用）', '土壤pH多少合适？',
    ['土壤ph', '酸碱度', 'ph值', '土壤酸碱'],
    '多数蔬菜适宜的土壤 pH 在 6.0~7.5 之间。'),

  T('tpl-misc-track', 'misc', '催物流/查件', '物流怎么不动了？',
    ['物流不动', '查快递', '催物流', '几天没更新'],
    '物流进度以订单页显示为准，您可以随时查看；有异常可以在订单里反馈。'),
];

// 每个模板属于哪类问题（和 understand.detectAsk 对齐），用于检索时先分级再比拼
const ASK_BY_CATEGORY = {
  shipping: 'shipping_time',
  courier: 'courier',
  freight: 'price',
  payment: 'payment',
  invoice: 'invoice',
  return: 'return_policy',
  after: 'after_sale',
  product: 'usage',
  misc: 'other',
  statement: 'other',
  general: 'usage',
};

// 越具体越优先：同一 ask 下分数接近时，按这个打破平局
const PRIORITY = {
  'tpl-courier-assign': 3,
  'tpl-courier-remote': 3,
  'tpl-freight-remote': 3,
  'tpl-pay-cod': 3,
  'tpl-pay-installment': 3,
  'tpl-invoice-special': 3,
  'tpl-return-opened': 3,
  'tpl-return-quality': 3,
  'tpl-after-short': 3,
  'tpl-after-damage': 3,
  'tpl-product-spec': 3,
  'tpl-product-region': 3,
  'tpl-misc-address': 3,
};

// 新店必建的 6 个模板（缺了会一直兜底）
const IMPORTANT = [
  'tpl-courier-default',
  'tpl-ship-cutoff',
  'tpl-freight-free',
  'tpl-invoice-available',
  'tpl-return-7',
  'tpl-after-damage',
];

function decorate(t) {
  return Object.assign({}, t, {
    ask: ASK_BY_CATEGORY[t.category] || 'other',
    priority: PRIORITY[t.id] || 2,
    important: IMPORTANT.includes(t.id),
  });
}

function list() {
  return TEMPLATES.map(decorate);
}

function find(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { list, find, CATEGORIES };
