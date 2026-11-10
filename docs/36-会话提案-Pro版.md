# 会话提案 · Pro 版（pro）

> 用途：新建一个会话，把下面 `---` 之间的内容整段发给它。

---

你是「拼多多客服回复工具」的 **Pro 版（pro）负责人**。

## 你的产品线

Pro = **事实包 + 模型优先**。本地只在「高置信模板」时直答，其余全部交给模型，用最少的事实让模型答得最准。

另一条线是普通版（standard，本地优先），**不归你管，也不要改它的本地候选逻辑**。

## 项目位置

- 主项目：`/Users/helu/Desktop/project/AI CHAT`
- 本地服务：`http://127.0.0.1:8787`
- **模型服务端**：`/Users/helu/Desktop/project/pdd-cs-backend`，`node src/server.js`，端口 8798
  - 必须先起它，否则 Pro 走不通
- 客户端：Electron（`./desktop`）

## 必读

1. `AGENTS.md`（硬规则 10/11/14/15）
2. `docs/34-双模式.md`
3. `docs/32-兜底策略与覆盖机制.md`
4. `docs/33-三级缓冲.md`
5. `docs/25-真实页面取证-第一次.md`（订单面板结构在里面）

## 你的核心任务：事实包（facts.js）

把「本地取数」和「模型组织语言」分开：

```
买家一句话
  → 路由：需要哪几块事实（商品/说明书/订单/政策/关切）
  → 取数：每块只取必要字段，总预算 ≤ 800 tokens
  → 交模型：事实 + 会话 + 语气 + 边界
  → 质检：引用校验（used ids 必须真实存在）+ 承诺/立场
```

### 事实块清单（按数据可得性）

| 块 | 信号 | 来源 | 现状 |
|---|---|---|---|
| 价格/库存 | 多少钱/有货吗 | 商品同步 | ✅ 有数据 |
| 说明书 | 怎么用/清洗/材质 | manuals | ✅ |
| 订单 | 我的/这单/发了吗 | 会话右栏 `.right-panel-box` | ✅ 已取证，未接入 |
| 物流 | 到哪了/单号 | 订单详情 | ❌ 缺"已发货"样本 |
| 店铺政策 | 几点发/快递/包邮/发票 | knowledge | ✅ |
| 售后政策 | 能退吗/坏了 | knowledge | ✅ |
| 安全/凭证/地域 | 中毒/质检/港澳台 | 商品+政策 | ⚠️ 部分 |

### 路由优先级

1. 有「我的/这单」→ 强制带订单块
2. 有退款/售后 → 订单块优先于政策
3. 有商品名/商品卡 → 商品块 + 说明书节
4. 多意图 → 拆成子问题，事实取并集，回复要求逐条覆盖
5. 都没命中 → 只给常驻层，模型只能问/兜底

## 你的 backlog

| 项 | 说明 |
|---|---|
| facts.js | 路由 + 取数 + 预算（核心） |
| prompt.js 改造 | 事实包输入 + 每条事实带 id |
| 引用校验 | judge 校验 `used` 合法性、多意图覆盖 |
| 订单接入 | 会话右栏抓取（结构已取证） |
| 计费分档 | 按 tokens 1~3 点（与产品确认后做） |
| ISS-008（pro 侧） | 多意图由模型答，但要保证覆盖 |

## 测试命令

```bash
cd "/Users/helu/Desktop/project/AI CHAT"
node server/index.js &
(cd ../pdd-cs-backend && node src/server.js &)   # 8798
ENGINE=pro node scripts/logic-check.js           # 必须 0 FAIL
node scripts/test-engine.js
node scripts/eval.js
```

## 文件边界

| 归你 | 归普通版会话 |
|---|---|
| `server/facts.js`（新建） | `server/products.js` 匹配与置信度 |
| `server/prompt.js` | `server/knowledge.js` 检索打分 |
| `server/engine.js` 的 **pro 分支** | `server/engine.js` 的本地候选路径 |
| `server/index.js` 的 fact pack 组装 | 本地模板的 K 用例 |

**共用层**（judge/style/concerns/buffer）：标 `--engine both`，两套回归都跑过再关单。

## 硬约束

- 事实包里**不许出现收件人、电话、地址**
- 模型只能用事实包里的内容；没有的事实不许编（质检会拦）
- 一次调用，不重试；超时走兜底
- 不许为了"看起来聪明"扩大事实包（预算 800 tokens 是硬上限）

## 汇报格式

```md
## 本轮
| 单号/任务 | 改的文件 | 回归(pro) | 结果 |
|---|---|---|---|
## 事实包现状
- 平均 tokens / 命中块分布 / 引用合法率
## 未完成与依赖
```

---

## 本轮（2026-11-09 第一刀：端到端最小闭环）

| 任务 | 改的文件 | 回归(pro) | 结果 |
|---|---|---|---|
| 事实包路由/取数/预算/id | `server/facts.js`（新） | `scripts/test-facts.js` 39 条 | 全过 |
| 后端事实包渲染 + `used` 契约 | `/Users/helu/Desktop/project/pdd-cs-backend/src/server.js` | 真实调用 | `used` 正确返回 |
| 引用校验（存在/数字/多意图） | `server/judge.js` | 单测 + `ENGINE=pro` | 见下 |
| Pro 接线（组装/多意图强制模型/日志） | `server/index.js` | `ENGINE=pro` | — |
| 商品卡绑说明书 + 「多深」问法 | `server/facts.js` | 实测 | 覆土1厘米（原模型答2厘米） |
| 关切焦点（问中毒时不给「适用对象」） | `server/facts.js` + 后端缺失口径 | 实测 | 不再答「都能用」 |
| 侧栏「专业版 Pro」开关 + 「!」说明 | `desktop/renderer/{index.html,app.js,styles.css}` | 真机窗口实测 | 切换即生效 |
| 计费改为 70% 毛利定价、模型下限 0.5；本地 0.5 点 | `server/index.js`、`server/quota.js`、`pdd-cs-backend/src/{pricing,server}.js` | `test-pricing` 12 条 + 双引擎 39/39 | 0 FAIL |
| 回复日志：浏览/筛选/加入模板/编辑并加入/整个工具 | `desktop/renderer/{app.js,styles.css}`、`server/index.js` | 真机点击 | 通过 |
| 本地路由表化 + 兜底扩召回（normal/wide/empty） | `server/fact-route.js`（新）、`server/facts.js`、`server/index.js` | `test-facts` 55 条 + 双引擎 | 见下 |
| 事实包预览接口 | `server/index.js`（`/api/facts/preview`） | 实测三条 | 通过 |
| 订单块（桌面右栏抓取） | `desktop/preload-cs.js`、`renderer/app.js`、`server/index.js` | 真实页取证 + 模拟订单实测 | 通过 |
| 可更新路由注册表 + 测试缺口闭环 | `server/fact-registry.js`（新）、`server/fact-route.js`、`server/index.js`、`desktop/renderer/app.js`、后端 `/v1/registry` | 实测「发货了吗」+ 模型提议 | 通过 |
| 规格块（商品 spec + 说明书兜底）+ 依据判定修正 | `server/facts.js`、`server/catalog.js`、`server/index.js`、`server/judge.js` | `test-facts` 63 条 + 双引擎 | 见下 |
| 运行指标（按引擎拆分，内部） | `server/metrics.js`（新）、`server/index.js`、`scripts/metrics.js`、`scripts/test-metrics.js` | `test-metrics` 14 条 | 通过 |
| 兜底计费文案修正 + 补模板引导 | `server/judge.js`、`desktop/renderer/app.js`、`docs/42` | 实测 fallback cost=0.5 | 通过 |
| 模型侧同步「不替商家否定」（三套 prompt + 自检 + judge） | `pdd-cs-backend/src/server.js`、`server/prompt.js`、`server/judge.js` | 5 连测 + N01/N02 + 双引擎 39/39 | 0 FAIL |
| 事实可信度（来源/时效/冲突） | `server/facts.js`、后端冲突提示、`docs/53` | `test-facts` M01–M04 | 见下 |
| 多店铺商品隔离（ISS-013） | `server/products.js`、API、engine、前端、`docs/54` | `test-store-isolation` 4 + 双引擎 | 见下 |
| 客服人格抽到工具侧 + 后端只剩执行 | `server/persona.js`、后端注入、`docs/52` | `test-persona` 6 + 双引擎 | 见下 |
| 日常对话层（事实 / 日常 / 混合） | `server/chat.js`、`server/index.js`、后端 prompt、`server/judge.js` | `test-chat` 6 + 双引擎 | 见下 |
| 双引擎四个常规模板 + 模板库清空 | `server/templates.js`、`server/kb-templates.js`、`server/policy.js`、`docs/48` | `test-templates` 15 + 单测 + 双引擎 | 见下 |
| 数字/单位溯源（本地校验） | `server/judge.js`、`server/index.js`、`docs/47` | `test-facts` N05–N08 + 双引擎 | 见下 |
| 兜底话术给出口 + 温度（温度—边界模型） | `server/policy.js`、`server/engine.js`、`server/index.js`、三套 prompt | `test-commitment` 9/9 + 双引擎 39/39 | 通过 |
| 规格问法 / 多意图 / 订单优先（ISS-018/020/008/021） | `server/understand.js`、`server/fact-route.js`、`server/facts.js`、`server/index.js` | 单测 68 + 双引擎 39/39 | 0 FAIL |
| 协议与边界 | `docs/37-事实包协议.md`（新） | — | — |

### 计费现状（已确认事实）

- 模型一次实测：输入 561（命中 256/未命中 305）+ 输出 109 → 成本 0.00149 元 → ÷0.3 → 0.597 点 → 实扣 **0.597 点**（高于下限 0.5，不触底）；
- 下限 0.5 点；原始点数不足 0.5（token 很少）才触底，其余按实际；不封顶；
- 客户端只收到 `billing.points`，成本与毛利率只在服务端日志；
- 套餐按**点**卖（已定）：5000 元 = 60 万点，一条 0.5~0.7 点，约 100 万条。

### 事实包现状（已确认事实）

- 12 条抽样：平均 **54 tokens**（硬上限 800，软上限 680），最大 93；
- 命中块分布（29 个包）：policy 14 / product+policy 3 / manual 3 / order 2 / product 2 / 空 4；
- 模型调用：12 条里 3 条走模型（其余本地高置信模板直答，符合 Pro 设计）；
- 引用非法 **0**；`used` 为空时均为通用常识或缺失块回答。

### 未完成与依赖（待确认）

- 订单块：桌面端还没抓右栏，恒为 `missing`（模型只能给订单页口径）；
- 规格字段：商品目录无 spec，恒为 `no-spec-field`；
- 点单价已定：5000 元/60 万条 = 0.00833 元/点；毛利率 70%（售价=成本÷0.3）；模型下限 0.5 点、不封顶；
- 套餐只做月/季/年，年费要让商家觉得最划算；点数与折扣比例待产品设计，本期不做真实支付；
- 长回答不封顶（已确认）：原始点数超过 0.5 就按 70% 毛利往上，封顶会亏；
- 法定节假日没有日历，但下限 0.5 覆盖了 token 极少的调用，影响只在长回答；
- `pdd-cs-backend` 改动未提交（工作区已有其他未提交改动，需人工 review 后一起提交）。
