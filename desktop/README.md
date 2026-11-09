# 桌面客户端（Electron）

拼多多客服工作台的本体。左店铺栏 + 内嵌店铺页面 + 右侧 AI 助手，**不是网页**。

![界面](../docs/screenshots/desktop-app.png)

---

## 启动

```bash
cd desktop
pnpm install          # 首次，会下载 Electron
pnpm start
```

> Electron 的 `--version` 与启动必须在 **没有 `ELECTRON_RUN_AS_NODE` 环境变量**的终端里执行，
> `pnpm start` 脚本已经用 `env -u` 处理了。

---

## 结构

```
desktop/
├── main.js            主进程：窗口、店铺会话分区、WebContentsView、IPC
├── preload-app.js     渲染进程桥（只暴露明确能力）
├── preload-cs.js      注入店铺页面：读会话 / 填输入框 / 点发送
└── renderer/
    ├── index.html     三段式布局：店铺栏 / 舞台 / AI 助手
    ├── styles.css     设计系统（深色外壳 + 浅色工作区）
    └── app.js         交互逻辑
```

### 多店铺怎么做的

每个店铺一个 **独立持久分区** + 一个**常驻 WebContentsView**：

```js
session.fromPartition(`persist:shop-${id}`)   // 登录态互不干扰，重启还在
new WebContentsView({ webPreferences: { session } })
view.setVisible(false) / true                 // 切换只改可见性，不重载
```

10 个店常驻约 3–4 GB 内存，建议 16 GB 机器；超过 12 店要做轮值（见 `docs/05`）。

### 数据从哪来

页面里 `preload-cs.js` 每 2 秒轮询一次：找输入框 → 向上找聊天列 → 按「类名签名重复 + 垂直堆叠」分组出气泡 → 左右位置判买卖双方。
结果通过 IPC 送到渲染进程；渲染进程再请求本地服务 `http://127.0.0.1:8787` 拿回复。

**页面改版只需要改 `preload-cs.js` 一个文件。**

---

## 界面设计说明（产品经理）

| 决策 | 理由 |
|---|---|
| 深色外壳 + 浅色工作区 | 写单时长时间盯屏，深色边框降低干扰，工作区保持白底不刺眼 |
| 三段式固定布局 | 店铺 / 页面 / 助手，位置永远不变，形成肌肉记忆 |
| 右侧助手宽 368px | 一屏放得下 3 条候选，不用滚动就能做决定 |
| 主按钮只有一个（生成回复） | 其余动作都在候选卡片上，靠近结果 |
| 每条候选两个按钮：填入 / 填入并发送 | 「发送」永远在第二位，默认动作是安全的 |
| 状态栏常驻点数与待复核 | 计费与积压永远可见，不用点进去查 |
| 深色店铺栏 | 多店切换是高频动作，暗色让当前店铺的高亮更明显 |

---

## 打包（下一步）

```bash
pnpm add -D electron-builder
npx electron-builder --mac --win
```

需要准备：
- Windows：代码签名证书（否则 SmartScreen 拦截）
- macOS：Apple Developer 账号 + 公证（否则 Gatekeeper 拦截）

---

## 当前限制

- 真实拼多多页面的 DOM 尚未验证，`preload-cs.js` 的选择器可能要按实际结构调整；
- 巡场（自动发现所有未读会话）还没做，目前是「当前会话 + 新消息自动回复」；
- 一键评论模块未做。
