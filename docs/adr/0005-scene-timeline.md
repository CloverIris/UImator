# ADR-0005 场景与时间轴：状态节点 + 分段过渡，不做节点图

- 状态：已接受
- 日期：2026-10-26
- 关联：ADR-0003、ADR-0007

## 背景

PRD 里写的是「节点式时间线」：在时间轴上摆状态节点，连线，中间由引擎插值。这个方向是对的，但「节点图」三个字很容易被实现成 Blender 着色器图那种自由连线系统——那是一个**图灵完备的编辑器**，工期、交互复杂度、用户学习成本全部失控，而收益接近零。

需要先回答的是：**用户到底在编排什么？**

不是属性，是**状态**。「全景曲面墙」是一个状态，「聚焦第三张卡片并展开」是另一个状态。用户关心的是这两者之间怎么过去，而不是某个图层的 `rotation.y` 在第 37 帧是多少度。

## 备选方案

### A. 传统图层 + 属性关键帧（AE / Theatre.js 模式）

- 表达力最强，但**每个属性都要 K**。用户要调 40 个图层的 z，就得 K 40 条曲线。
- Theatre.js 自带一套序列化与状态模型，会和我们的求值器抢控制权；它的编辑器 UI 也很重，等于把半个 AE 嵌进来。
- 结论：作为**底层能力**保留（单属性覆盖），不作为主交互。

### B. 自由节点图（Blender 式连线段子）

- 节点、端口、类型推导、连线合法性、子图、循环检测……这是一个独立产品的工作量。
- 对目标用户（市场 / 独立开发者）来说，学习成本高于收益。
- 结论：**v1 不做，v3 再议**。

### C. 状态节点 + 分段过渡（选定）

时间轴上是一串**镜头（Cue）**，每个 Cue 绑定一个完整状态；Cue 之间是一段**过渡**，由引擎插值。用户调的是状态和过渡曲线，不是属性曲线。

## 数据模型

```ts
type Project = {
  meta: { name: string; fps: 24 | 30 | 60; resolution: [number, number]; seed: number }
  sources: Source[]          // 抓取源（URL / 本地端口 / 会话）
  assets: Asset[]            // ADR-0004
  scenes: Scene[]            // 可复用的完整状态
  timeline: Track[]          // 分轨，见下
  audio?: { ref: string; bpm: number; beats: number[]; downbeats: number[] }
}

type Scene = {
  camera: { position: vec3; target: vec3; fov: number; dof: { focus: number; aperture: number } }
  stage: { explode: number; curvature: number; spread: number; layout: LayoutId }
  lights: LightRig
  background: BackgroundSpec   // 纯色 / mesh gradient / 色采样环境 / 粒子
  items: ItemState[]           // 每个素材的局部变换、透明度、可见性
  typography: TextBlock[]      // 文案块及其位置
}

type Cue = {
  t: number
  scene: SceneId | Scene
  transitionIn: {
    duration: number
    kind: 'camera' | 'cut' | 'morph' | 'geometric' | 'dissolve'
    easing: Bezier | Spring
    seed: number              // 决定程序化转场的随机形态，可「换一版」
  }
}
```

**分轨而不是单轨**，是这套模型的关键：`camera / stage / typography / audio / fx` 各自独立。这样「换一套运镜」不会打乱文字节奏，「改文案」不会影响镜头。「节点图」做这件事要连一堆线，分轨是天然的。

## 求值

```
f(project, t):
  cue = 最后一个 t' <= t 的 cue
  p = clamp((t - cue.t) / cue.transitionIn.duration, 0, 1)
  e = easing(p)                       // bezier 或 spring，spring 需按 dt 积分而非闭式
  return blend(prevScene, cue.scene, e, cue.transitionIn.kind)
```

`blend` 的规则按类型分：

- **camera**：位置在**球坐标**下插值（距离 / 方位角 / 仰角），而不是笛卡尔直线。直线插值会让镜头"穿过"舞台中心，球坐标插值才是真正的"环绕"。`fov` 与焦点单独插值。
- **morph**：图层位置 / 旋转 / 透明度的加权混合。
- **geometric**：把两个状态的画面当作两个纹理，用程序化图案（Voronoi / 网格洗牌 / 噪声）做遮罩推进；`seed` 决定图案的实例。
- **cut**：硬切。不要小看硬切，专业片子里 30% 的转场是硬切。

`spring` 必须**按固定 dt 预积分成采样表**再查表。闭式弹簧公式在变速和暂停时会不一致，而导出必须与预览逐帧一致（ADR-0007）。

## 相机模型

- 透视相机，`fov` 用 35mm 等效焦距表达（用户更懂「35mm」而不是「53.13°」）。
- 相机状态 = `{position, target, up, fov, focusDistance, aperture}`。
- 提供 6 个**机位预设**（推、拉、摇、移、环绕、俯冲），本质是参数化的相机路径片段，可叠加到任意 Cue 上。
- **不要**暴露原始的欧拉角。用户一旦开始调 pitch/yaw，就会做出穿模的镜头。

## 程序化与种子

所有"随机"效果（几何转场的图案、粒子、背景流动）都由 `seed` 决定，`seed` 挂在 Cue 上而不是全局。

理由：用户对某一个转场不满意时，点「换一版」应该**只**变那一段，其余不动。全局种子做不到这件事。

## 自动初稿（Director）

模板不是"好看的预设"，而是**带叙事结构的函数**：

```
director(assets, brandTokens, music) -> Timeline
  0.0–0.15  钩子：Hero 标题 + 品牌色背景
  0.15–0.45 全景：首屏倾斜入画 + 卡片按 depthClass 爆炸
  0.45–0.75 特写：2–3 个高信息量素材，逐个推近 + 文案入场
  0.75–1.0  收束：曲面墙 + Logo + CTA
```

输入是素材的**视觉信息量排序**（面积 × 颜色熵 × 文本密度 × 是否含图表/图像），输出是 Cue 列表。这一步质量决定"第一次出片能不能看"，比渲染器的上限更影响留存。

自动初稿必须**至少生成 3 个变体**（不同种子 + 不同叙事比例），而不是一个。因为用户判断"好不好"需要比较，而单个结果很容易被误判为"烂"。

## 后果

**正面**

- 用户的心智模型是"这一幕、下一幕"，不是"这个属性在第几帧"。这与宣发片的实际制作方式一致。
- 数据结构简单，序列化、撤销、协作、AI 生成都好做（Cue 列表就是一个 JSON 数组）。
- 分轨让局部替换成为可能（换运镜 / 换文案 / 换音乐）。

**负面**

- 表达力弱于自由关键帧。需要保留"单属性覆盖"作为逃生舱（少量属性直接 K：透明度、可见性、文字位移）。
- 过渡类型是枚举式的，用户不能自定义混合规则；靠"程序化转场 + 种子"覆盖长尾。
- 球坐标插值在多机位快速切换时可能绕远路，需要按最短弧选方向（方位角取 `±2π` 中较短者）。

## 何时重审

- 若 30% 以上的用户在使用后仍然要求"能不能直接 K 这个属性"，说明状态模型不够，需要引入局部关键帧轨道。
- 若"换一版"被高频使用（说明自动初稿质量不足），应优先投模板与素材打分，而不是加编辑器功能。
