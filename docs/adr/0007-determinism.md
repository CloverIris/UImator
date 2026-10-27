# ADR-0007 确定性契约

- 状态：已接受
- 日期：2026-10-26
- 关联：ADR-0002、ADR-0005、ADR-0006、ADR-0009

## 背景

「导出两次结果不一样」是这类工具最致命的体验问题：用户调好了片子，换个时间导出，镜头快了半帧、粒子位置全变、卡片抖动了一下——信任瞬间归零。

确定性有两个独立的层面，必须分开治理：

- **捕获期**：同一个页面、同一次会话，两次截图必须一模一样。
- **导出期**：同一个工程、同一个 `t`，两次渲染必须一模一样。

## 1. 捕获期的冻结清单

页面是活的：有定时器、有随机、有动画、有网络。抓取前必须把它变成一个**静止的标本**。

| 目标 | 手段 | 备注 |
| --- | --- | --- |
| 时间 | 覆写 `Date.now`、`Date` 构造、`performance.now` 为可控单调时钟 | 用 `addInitScript` 在页面脚本之前注入 |
| 动画帧 | 接管 `requestAnimationFrame`，改为由我们手动 `tick(t)` 驱动 | 否则动画相位不可控 |
| CSS 动画 | `document.getAnimations()` 全部 `pause()`，再设 `currentTime = phase` | 需要指定「停在哪一帧」 |
| CSS 过渡 | 全局注入 `transition: none !important`（采集瞬时态时） | 采集 hover 态时相反，要等过渡结束 |
| 定时器 | 接管 `setTimeout/setInterval`，只允许在我们的 tick 中触发 | 防止「抓取过程中弹出 toast」 |
| 随机 | 用 `mulberry32(seed)` 覆写 `Math.random`、`crypto.getRandomValues` | seed 存进配方 |
| 网络 | 页面加载完成后 `Network.emulateNetworkConditions` 设为 offline | 防止延迟请求改变布局 |
| 实时连接 | 关闭 WebSocket / EventSource / SSE | 否则数据会变 |
| 视频 | 所有 `<video>` `pause()` 并设 `currentTime` | 记录时间点，重截时复现 |
| 光标 | `caret-color: transparent`，隐藏输入焦点 | 截图里不应有闪烁光标 |
| 滚动 | `scroll-behavior: auto`，直接设 `scrollTop` | 平滑滚动会让位置不确定 |
| 字体 | 等 `document.fonts.ready` + 显式触发所有 `@font-face` 使用 | 否则截图时回退字体 |
| 懒加载 | 先滚动到底触发 `IntersectionObserver`，再滚回目标位置 | 需要给图片解码留时间 |
| 媒体偏好 | 固定 `prefers-color-scheme` / `prefers-reduced-motion` / `forced-colors` | 通过 `Emulation.setEmulatedMedia` |
| 时区 / 语言 | 固定 `timezoneId` 与 `locale` | 日期与数字格式会进截图 |
| 设备像素比 | 固定 `deviceScaleFactor` | 影响 `srcset` 选图 |

**验收方式**：同一页面连续捕获 50 次，任意两次的素材像素哈希必须相同。这是 CI 里的常驻测试。

### 一个容易被忽略的点

冻结之后，页面可能停在「加载中」的骨架上。所以冻结的时机是「**网络静默 + 字体就绪 + 首屏动画播完 + 布局连续 3 帧无变化**」，而不是 `load` 事件。等待策略本身要可配置（有的站点需要等一个特定的选择器出现）。

## 2. 导出期的纯函数约束

```
frame(t) = render(evaluate(project, t))
```

禁止清单：

- 禁止读 `Date.now()` / `performance.now()` / `THREE.Clock`（时间只来自帧号）。
- 禁止未播种的随机。所有随机 = `mulberry32(hash(project.seed, cue.seed, frameIndex))`。
- 禁止帧内异步加载。所有纹理、字体、音频必须在开始渲染前全部就绪，缺一个就报错而不是等。
- 禁止依赖上一帧的状态（粒子不应「累积」；需要拖尾就用解析式或固定窗口重算）。
- 禁止 spring 用「按真实 dt 积分」。必须预积分成固定采样表（ADR-0005）。

### R2 实测补充：两条容易漏掉的规则

1. **截图前必须清掉自己注入的 DOM。** 拾取高亮、候选聚光灯这类遮罩是半透明的，肉眼几乎看不出，但会被合成进素材，并让同一配方两次结果不同。截图前统一 `querySelectorAll('[data-uimator]').forEach(n => n.remove())`。
2. **每次捕获前重置指针并校验 `:hover`。** 上一次的鼠标停位会让这一次的目标元素处于 hover 态（或让裁切框跟着 hover 位移走）。做法：非悬停捕获前把指针挪到 (1,1)，轮询确认目标元素 `matches(':hover') === false`；悬停捕获后确认 `=== true`，否则记 `hover-not-applied` / `hover-stale`。

这两条都属于「状态残留」而不是渲染错误，只有「同一流程跑第二遍」才会暴露——这正是需要 `recap` 这种回归机制的原因。

## 3. GPU 不是逐位确定的

同一台机器、同一驱动，通常可以做到逐位一致；跨 GPU（ANGLE/Metal vs D3D vs SwiftShader）不可能。

因此把确定性分成两级：

| 级别 | 要求 | 用途 |
| --- | --- | --- |
| L1 逐位一致 | 同机同驱动，两次导出像素哈希相同 | 用户可见的承诺、断点续渲 |
| L2 感知一致 | 跨驱动，感知哈希距离 ≤ 阈值 | CI 回归、版本升级验收 |

CI 里固定用 SwiftShader（软件渲染）跑 L2，避免 CI 机器换 GPU 就红一片。

## 4. 浮点顺序问题

CPU 侧的求值必须**顺序确定**：不要用 `Object.keys()` 的隐式顺序、不要用 `Promise.all` 的结果顺序、不要用 `Set` 迭代来决定图层顺序。图层顺序必须显式存储（`items: ItemState[]` 的数组下标就是顺序）。

## 后果

**正面**

- 用户信任：同一工程永远出同一条片。
- 工程能力：断点续渲、并行分块、回归测试、A/B 模板对比全部成立。
- 调试能力：任何一帧都可以凭 `t` 精确复现，便于定位渲染 bug。

**负面**

- 捕获期注入的补丁会与某些站点的框架冲突（尤其自己劫持了 `rAF` 的动画库）。需要「补丁白名单 / 黑名单」机制，冲突时降级为「不冻结，只截当前帧」并标注。
- 部分站点的动画无法冻结（canvas 内部自绘、WebGL），只能采样当前一帧。素材会因此失去动态能力。
- 纯函数约束会限制一些效果（比如基于上一帧的反馈式粒子），需要在效果设计阶段就规避。

## 何时重审

- 若「冻结」导致超过 30% 的站点布局异常，说明注入过重，应改为「按需冻结」（只冻结与选中素材相关的子树）。
- 若 L1 在真实用户机器上频繁失败，说明有未识别的墙钟依赖，需要加「帧级随机源审计」。
