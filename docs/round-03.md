# Round 03 —— 树进舞台（部分完成）

- 日期：2026-10-26
- 状态：**代码完成，渲染受阻于运行环境**

## 已完成

1. `src/stage/stage.ts`：three.js 舞台，直接吃 `projects/tree.json`
   - 每个 `render` 节点 = 一个平面，位置取 `abs`，z 取 `depth × 34 + role 偏移`
   - `group` 节点不绘制，只做深度骨架（与 ADR-0013 一致）
   - 文本节点拆成**逐字平面**：用 `text.glyphs` 的矩形反算 UV 子区域，`textReveal` 用 `scale.x` 从 0 到 1 实现
   - 角色绑定：`card` 错峰 +165z、`icon` 独立 +120z 上浮、其余 +20z
   - 相机：3.2 秒 dolly + 轻微 orbit，`renderAt(t)` 纯函数
2. `--stage` 模式：逐帧调用 `renderAt(t)` → `capturePage` → `captures/stage/f###.png`
3. 构建与 IPC 打通：`stage-data` 把树和贴图（data URL）送进渲染进程

## 受阻

本机沙箱里 Chromium 的 GPU 进程无法创建 WebGL 上下文：

```
Could not create a WebGL context ... GL_VENDOR = Disabled / BindToCurrentSequence failed
```

试过 `--no-sandbox`、`--use-angle=swiftshader`、`--disable-gpu + --enable-unsafe-swiftshader`，均失败。
这是**运行环境限制**，不是代码问题——在普通桌面环境执行 `npm run stage` 应当可以出帧。

## 下一步

1. 在正常环境跑 `npm run stage`，先看第一帧的构图（相机距离、卡片间距、文字位置）。
2. 按 S2 判据做盲测：「像不像花钱做的」「是浮着还是贴着」。
3. 若构图成立，再接后期（辉光 / 景深 / 颗粒）与第二套相机模板。

## 补充（同日）

- 预览器补上了**接触阴影 + 渐变背景 + 暗角**。没有阴影的位移看起来只是「错位」，有了阴影才读成「浮起」。
- 修了一个排序 bug：按单个角点深度排序会让大平面盖住小平面（卡片盖住标题）。改成按四边形中心深度排序。
- 修了角色误判：38×38 的图标方块被判定成卡片，导致它被当成「嵌套卡片」二次爆炸、飞出卡片。现在 `≤72px 且无长文本` 判为 icon；同时只有**顶层卡片**才做爆炸位移。
- 产出 3.2 秒、38 帧的 GIF（`docs/assets/stage.gif`），已放进 README。
