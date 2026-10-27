# UImator

把运行中的 H5 / Electron 界面拆成 3D 舞台素材，用模板化的镜头、灯光与排版，导出一条产品宣发短片。

> **当前状态：R2 完成 + 结构树打通。** 捕获 → 自动拆解 → 语义树（29 节点，重建误差 0.71/255）→ 配方复现，全链路可跑。3D 舞台与导出尚未开始。
> 架构文档的目的只有一个：把「会返工的三条路线」定死，并给出可验证的失败判据。

## 文档地图

| 文档 | 作用 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统全景、模块边界、三条不变量、性能预算、开放问题 |
| [docs/adr/0001-host-runtime.md](docs/adr/0001-host-runtime.md) | 宿主运行时：为什么必须是 Electron |
| [docs/adr/0002-capture-strategy.md](docs/adr/0002-capture-strategy.md) | 捕获：CDP 位图优先，导出期两遍重截 |
| [docs/adr/0003-stage-renderer.md](docs/adr/0003-stage-renderer.md) | 舞台渲染：全 WebGL，不用 CSS3D |
| [docs/adr/0004-asset-model.md](docs/adr/0004-asset-model.md) | 素材模型：贴图 + 深度语义 + LOD + 文字策略 |
| [docs/adr/0005-scene-timeline.md](docs/adr/0005-scene-timeline.md) | 场景与时间轴：状态节点 + 分段过渡，不用节点图 |
| [docs/adr/0006-export-pipeline.md](docs/adr/0006-export-pipeline.md) | 导出：WebCodecs + 固定步长 + 累积运动模糊 |
| [docs/adr/0007-determinism.md](docs/adr/0007-determinism.md) | 确定性契约：抓取期冻结、导出期纯函数 |
| [docs/adr/0008-untrusted-page-isolation.md](docs/adr/0008-untrusted-page-isolation.md) | 不可信页面的隔离与安全边界 |
| [docs/adr/0009-project-format.md](docs/adr/0009-project-format.md) | 工程文件格式：素材是缓存，配方是真相 |
| [docs/adr/0010-url-mode-boundaries.md](docs/adr/0010-url-mode-boundaries.md) | URL 模式的能力矩阵与降级策略 |
| [docs/adr/0011-beat-sync.md](docs/adr/0011-beat-sync.md) | 节拍对齐：分析、校正、磁吸规则 |
| [docs/adr/0012-layered-assets.md](docs/adr/0012-layered-assets.md) | 分层素材模型：L0→L3，拆开再合回去是无损的 |
| [docs/adr/0013-semantic-tree.md](docs/adr/0013-semantic-tree.md) | 语义树：动画按 role / text 寻址，不按截图坐标 |
| [docs/spikes.md](docs/spikes.md) | 开工前的三个验证尖峰与 go / no-go 判据 |
| [docs/round-01.md](docs/round-01.md) | R1 实录：捕获链路、冻结、确定性 |
| [docs/round-02.md](docs/round-02.md) | R2 实录：自动拆解、6x 重截、悬停态、配方复现 |

## 三条不变量

这三条不是设计目标，是**约束**。任何实现如果违反它们，后期一定返工：

1. **素材是缓存，不是真相。** 工程文件里存的是「怎么重新截到这张图」的配方，而不是那张图本身。
2. **舞台上只有一个 canvas。** 不允许 DOM 文本、DOM 图片直接参与构图，否则后期、遮挡、导出全部失控。
3. **任意一帧 = `f(project, t)` 的纯函数。** 不含墙钟、不含未播种随机、不含渲染中途的异步加载。

## 运行

```bash
npm install
npm start          # 打开应用：加载 → 扫描/拾取 → 截取选中（支持 6x、悬停态）
npm run matrix     # 12 个真实站点：加载 → 冻结 → 扫描 → 截前 4 个候选
npm run recap      # 按配方重新截一遍，比对像素哈希
npm run tree       # 把一块 UI 拆成语义树 + 每节点贴图，写 projects/tree.json
npm run selftest   # 无交互跑一遍捕获链路
npm run batch      # 三个 fixture，14 个素材 + 报告
npm run uicheck    # 端到端验证 preload / IPC / 面板 / 缩略图
```

素材落在 `captures/`，报告落在 `reports/`。

受限环境（CI、容器）里 Chromium 的沙箱起不来，用 `UIMATOR_SANDBOX=0` 切换到无沙箱 + 软渲染；产品默认必须保留沙箱（见 [ADR-0008](docs/adr/0008-untrusted-page-isolation.md)）。

## 下一步

- **R2（已完成）**：真实站点矩阵、高倍率重截、候选自动拆解、配方复现。
- **R3**：3D 舞台与相机 —— 对应 **S2，也是唯一的 go / no-go**。从真实 DOM 拆出来的图层做 3D 爆炸和运镜，如果不好看，这个产品不成立。
- **R4**：导出管线 —— 对应 S3。
