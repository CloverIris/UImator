# ADR-0006 导出管线：WebCodecs + 固定步长 + 子帧累积

- 状态：待尖峰 S3 验证
- 日期：2026-10-26
- 关联：ADR-0003、ADR-0007、ADR-0009

## 背景

导出是这类工具**最容易死的地方**：预览很流畅，一按导出就发现帧率掉到 2fps、音画不同步、颜色不对、文件打不开、或者渲了两小时崩在第 1700 帧。

目标：30 秒 4K60（1800 帧）在 15 分钟内出片，帧级可重复，可中断续渲。

## 备选方案

### A. 原生 ffmpeg 逐帧管道

- 稳定、通用、编码质量好、mux 无坑。
- 但要把每帧从渲染进程搬运到 ffmpeg（`-f rawvideo` 管道或临时 PNG 序列），I/O 成本高；PNG 序列 1800 帧 ≈ 数十 GB。
- 需要为三端打包静态 ffmpeg（~70 MB/平台），签名与公证变复杂。

### B. `MediaRecorder`

- 最简单，但**实时录制**：导出 30 秒就得实打实跑 30 秒以上，而且丢帧不可控、时间戳来自墙钟、无法超采样、无法保证逐帧确定。
- 结论：只能做"快速预览"，不能做交付级导出。

### C. WebCodecs `VideoEncoder` + muxer（选定）

- 帧是**推**进去的：`new VideoFrame(canvas, {timestamp})` → `encoder.encode(frame)`，不依赖墙钟，天然支持离线逐帧。
- 硬件编码可用（H.264 / HEVC / VP9 / AV1 视平台），4K60 不是瓶颈。
- 音频用 `AudioEncoder`（AAC-LC）编码，`mp4-muxer` 直接封装成 MP4。
- 缺点：编码器能力因平台而异，必须做能力探测与降级；muxer 是第三方库，边界情况要自己兜。

## 决策

**主路径 C，兜底 A。**

1. 启动时探测：`VideoEncoder.isConfigSupported()`，按 `H.264 High → HEVC → VP9 → AV1` 的顺序选，选不到就提示平台不支持并建议 1080p。
2. 音频：Web Audio 解码 → `AudioEncoder`（AAC-LC 192 kbps）→ 与视频同轨封装；`mp4-muxer` 不可用时退回 ffmpeg 二次封装。
3. 导出在**独立隐藏窗口**里跑（`session: stage`，与编辑器隔离），`backgroundThrottling: false`，并禁用 `requestAnimationFrame` 节流。

## 帧循环

```
for (let i = 0; i < totalFrames; i++) {
  const t = i / fps                      // 时间只来自帧号
  const snapshot = evaluate(project, t)  // 纯函数（ADR-0007）
  renderer.render(snapshot)
  accumulateIfNeeded(i, snapshot)
  encoder.encode(new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps) }))
  await backpressure()                   // encoder.encodeQueueSize 超阈值就等
}
await encoder.flush()
```

三条硬规则：

- **不要用 `THREE.Clock`、`performance.now()` 或 `rAF` 的时间戳**决定 `t`。时间只来自帧号，否则导出结果随机器负载变化。
- **背压必须有**。`encodeQueueSize` 无限增长会吃光内存然后崩溃。
- **每帧渲染后必须 `gl.finish()` 或读回一次**，否则 `VideoFrame` 可能捕获到未完成的绘制（不同驱动行为不同，读回最稳）。

## 质量：超采样 + 累积运动模糊

### 超采样（SSAA）

按输出分辨率的 **1.5–2x** 渲染，再缩到目标尺寸编码。这是让 UI 边缘和 MSDF 文字看起来"贵"的最便宜手段。4K 输出 = 8K 渲染，显存与时耗都要算进预算（见 architecture.md §7）。

### 运动模糊（子帧累积）

视频的"电影感"很大程度来自 180° 快门。做法：

```
S = 6                                   // 子帧数
for s in 0..S-1:
  ts = t + (s / S - 0.5) * (0.5 / fps)  // 180° 快门，围绕当前帧
  render(ts) → accum += color
encode(accum / S)
```

代价是 S 倍渲染时间。策略：

- 只在**有相机运动或大幅度位移**的帧开启（静态幕关闭）。
- 编辑器预览不做累积，用一个廉价的屏幕空间方向模糊近似。
- 提供三档：`关闭 / 快速(S=4, 半分辨率累积) / 电影(S=8)`。

**替代方案**：速度缓冲 + 后期方向模糊。渲染成本低得多，但对"分层薄片"和透明边缘会出鬼影。v1 用累积，因为它不会错。

## 断点与并行

因为 `f(project, t)` 是纯函数（ADR-0007），帧与帧之间无状态依赖：

- 按帧分块（如每 120 帧一个 chunk），每块渲染完立即写临时文件并记录哈希。
- 中断后从最后一个完整 chunk 续。
- 崩溃恢复：manifest 里记录已完成 chunk 与参数，重开工程时提示"继续上次导出"。
- 不做多进程并行渲染（GPU 已经被占满，多进程只会互相抢显存），但**编码与渲染可以流水线**：第 n 帧编码时同时渲染第 n+1 帧。

## 音频

- 解码：`AudioContext.decodeAudioData` → 得到 PCM 与精确采样率。
- 编码：`AudioEncoder`，AAC-LC，192 kbps，48 kHz。
- 对齐：音频时间戳按采样点计算（`sampleIndex / sampleRate`），**不要**按帧估算，否则长片会累积漂移。
- 结尾：视频流最后一帧时间戳必须 ≥ 音频总时长，否则部分播放器会截断音轨。

## 后果

**正面**

- 导出时间可预测（`帧数 × 单帧耗时`），可给用户一个有意义的进度与剩余时间。
- 不依赖外部二进制，安装包小，签名简单。
- 逐帧确定，可以做"渲染同一帧两次 → 哈希一致"的回归测试。

**负面**

- 编码器能力碎片化（尤其 Windows 的 HEVC 需要系统扩展），必须有降级链路与清晰的错误文案。
- `mp4-muxer` 这类库的边界情况（大文件、非整除时长、可变帧率）需要自测覆盖。
- 8K 超采样 + 4K 输出对显存要求高，低端机要自动降级到 1.25x。

## 验证方式（尖峰 S3）

- 30 秒 1080p60，20 个图层 + 景深 + 辉光 + 颗粒，导出 ≤ 4 分钟。
- 30 秒 4K60 同场景，2x SSAA、S=4，导出 ≤ 18 分钟，峰值显存 ≤ 4 GB。
- 同一帧渲染两次，像素哈希一致（同一机器、同一驱动）。
- 音画同步：片尾最后一个鼓点与画面切换误差 ≤ 1 帧。
- 导出中途杀进程，重启后能续渲，最终文件与不中断版本逐帧一致。
