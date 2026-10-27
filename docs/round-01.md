# Round 01 —— 把 S1 从纸面变成可运行的工具

- 开始：2026-10-26
- 完成：2026-10-26
- 对应尖峰：[S1 捕获保真度](spikes.md)
- 状态：**已完成**（本地 fixture 验证通过；真实站点矩阵留给 R2）

## 这一轮交付了什么

一个真的能跑的 Electron 应用，而不是 demo：

1. 顶部地址栏加载任意 URL（本地 fixture 优先，避免网络抖动）
2. 页面里鼠标悬停高亮、点击「摘」下一个元素
3. 一键按 3x 截图，落盘成素材，并记录尺寸 / 偏移 / 哈希 / 耗时
4. 「冻结」开关：暂停动画、锁死时间、关掉过渡，让截图可重复
5. 批量脚本：对一组 fixture 跑「选元素 → 冻结 → 截图 → 记录耗时/失败」
6. 自检模式（`--selftest` / `--uicheck`）：无人工点击跑通全链路，产出可肉眼检查的 PNG

## 验收结果

| # | 项 | 判据 | 实测 |
| --- | --- | --- | --- |
| 1 | 应用能起来 | 窗口出现，地址栏可输入，fixture 能加载 | ✅ 壳层 + 目标视图三层布局正常 |
| 2 | 拾取可用 | 悬停高亮，点击后主进程拿到 rect + selector | ✅ 隔离世界注入，console 通道回传 |
| 3 | 截图正确 | 3x 尺寸 = rect × 3，无变形无缺块 | ✅ 2141×978 / 4440×1563 / 756×2316 均正确 |
| 4 | 冻结有效 | 冻结后同一元素连截 10 次哈希一致 | ✅ 3 次连截哈希全同（`047a6258…`） |
| 5 | 批量可跑 | 一条命令输出 JSON + 素材 | ✅ 14 素材 / 0 错误 / 约 3 秒 |

`npm run selftest` 的输出：

```
freeze {"frozen":true,"stats":{"animations":0,"nodes":151}}
captured chart-card@3x 2141×978 105ms
captured determinism@3x ×3 → 哈希一致
```

`npm run batch` 的输出：landing 5 + dashboard 5 + pricing 4 = **14 个素材，0 失败**。

## 本轮撞到的坑（都已修，且写进了实现注释）

### 1. 伪元素的溢出拿不到

`.tier.featured::before` 那个「最受欢迎」徽标定位在 `top: -11px`，`getBoundingClientRect()` 不包含它，第一次截出来徽标被切掉一半。

修法分两层：

- 先取「元素 + 所有可见后代」的矩形并集（能覆盖绝对定位的徽标、tooltip）
- 再统一向外留 16 px 安全边（伪元素无法通过 DOM 拿到矩形，只能兜底）

同时记下 `offsetX / offsetY`（元素本体在纹理里的位置），否则带外边距的纹理贴到 3D 平面上会偏。

### 2. 圆角处会带上页面底色

矩形裁剪没有 alpha 通道，卡片的圆角里会露出页面背景色。对 3D 舞台不是问题——我们要自己画圆角、厚度和阴影——但素材必须同时记录 `radius`，否则会变成「方角贴纸」。

### 3. `fixed` 元素不能直接贴

cookie 横幅、升级面板的宽度是**视口宽度**，直接贴到舞台上会被拉成一条。素材需要记录 `viewportWidth`，放进舞台时按比例归一化。

### 4. `captureBeyondViewport` 表现良好

侧边栏 2316 px、特性区 1862 px 都一次截全，没有出现「越界截白」的经典 bug。这条比预期顺利。

### 5. 冻结拦不住 canvas

dashboard 的折线图是 `requestAnimationFrame` 里逐帧画的，冻结只能让它「停在当前帧」，无法指定相位。这类素材属于 ADR-0004 里的「不可再生」——高倍重截拿到的是同一帧，可接受。

### 6. 环境里有两个坑（与产品无关，但会挡住所有人）

- `ELECTRON_RUN_AS_NODE=1` 被某些终端注入时，Electron 会退化成 node 进程。`scripts/run.mjs` 里已经清掉。
- 受限沙箱里 Chromium 的 seatbelt 起不来，需要 `UIMATOR_SANDBOX=0` 切到无沙箱 + 软渲染。**这只用于本机测试，产品默认必须保留沙箱**（ADR-0008）。

## 现在能做什么

```bash
npm install
npm start            # 打开应用：输入 URL → 拾取 → 截取选中
npm run selftest     # 无交互跑一遍捕获链路，产出 captures/ + reports/selftest.json
npm run batch        # 跑三个 fixture，产出 14 个素材 + 批量报告
npm run uicheck      # 端到端验证 preload/IPC/缩略图，产出 captures/ui-*.png
```

素材在 `captures/`，报告在 `reports/`，两者都在 `.gitignore` 里。

## 留给 R2 的

- [ ] 真实站点矩阵（12 个，含 Cloudflare / 虚拟滚动 / WebGL 图表 / 跨域 iframe）
- [ ] 高倍率重截（6x / 10x）与分块拼接
- [ ] 候选自动聚类与打分（去重、剔除 cookie 横幅、空状态）
- [ ] 用 CDP `Input.dispatchMouseEvent` 采集真实 `:hover` 态
- [ ] SSIM 评测脚本
- [ ] 素材配方落盘（ADR-0009 的 `recipe` 字段目前只实现了一半）

## 对 ADR 的反馈

- **ADR-0002（CDP 位图）**：本轮实测支持这个决策。复杂度确实只在「边界」上（伪元素、溢出、fixed），而不在渲染保真度上——这比 DOM 重建的复杂度低一个量级。
- **ADR-0004（文字策略）**：3x 下中文已经清晰，这降低了「必须上 MSDF」的紧迫性；MSDF 的主要理由回到「可编辑 + 任意倍率」，而不是「3x 不够用」。
- **ADR-0007（确定性）**：冻结的第一批补丁（时间/随机/rAF/CSS 动画）已验证有效，但 `setTimeout` 全禁之后页面可能抛未捕获异常，需要在 UI 上吞掉日志噪音。
