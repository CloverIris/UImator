# ADR-0009 工程文件格式：素材是缓存，配方是真相

- 状态：已接受
- 日期：2026-10-26
- 关联：ADR-0002、ADR-0004、ADR-0007

## 背景

一个 30 秒工程可能有 100 个素材、每张 2–8 MB，加上 4K 重截后可能到几 GB。如果工程文件就是「图片的集合」，会立刻遇到四个问题：

1. 文件巨大，无法分享、无法云同步。
2. 页面改版后，素材还是旧的，用户不知道。
3. 导出 4K 需要更高倍率，但文件里只有 3x。
4. 换一台机器打开，字体、路径、会话全丢。

## 决策

`.uimator` = 一个 zip 包，**真相是「怎么重新截到这张图」的配方 + 场景 + 时间轴**，纹理只是缓存。

```
project.uimator (zip)
├── manifest.json          # schemaVersion, app/chrome 版本, 创建时间, 校验
├── project.json           # sources / assets(recipe) / scenes / timeline / audio / render
├── assets/
│   ├── <contentHash>.webp      # 1x 预览（必有）
│   ├── <contentHash>@2x.webp   # 可选
│   └── <contentHash>@6x.webp   # 可选（重截产物）
├── audio/<hash>.<ext>
├── fonts/                 # 仅存「字体引用」，不打包商业字体文件
└── thumbs/cover.png
```

### 两类哈希

| 哈希 | 计算方式 | 用途 |
| --- | --- | --- |
| `recipeHash` | `sha256(规范化后的配方 JSON)` | 判断「还是不是同一个素材」、缓存键 |
| `pixelHash` | `sha256(解码后的像素)` | 判断「画面有没有变」、失效检测、回归测试 |

配方 → `recipeHash` → 纹理文件。同一个配方在不同倍率下产出不同 `pixelHash`，所以倍率是配方的一部分。

### 配方的字段（关键子集）

```jsonc
{
  "sourceId": "src_01",
  "route": "https://app.example.com/dashboard?tab=overview",
  "viewport": { "width": 1440, "height": 900 },
  "deviceScaleFactor": 3,
  "media": { "colorScheme": "dark", "reducedMotion": "no-preference" },
  "locale": "zh-CN",
  "timezone": "Asia/Shanghai",
  "clock": { "frozenAt": 1735689600000, "animationPhase": 0.35 },
  "randomSeed": 42,
  "scroll": { "x": 0, "y": 0 },
  "hover": null,
  "clip": { "x": 312, "y": 96, "width": 420, "height": 280 },
  "matcher": { "cssPath": "...", "role": "card", "textDigest": "9f2c", "aspect": 1.5 }
}
```

`matcher` 是重截时的「找回」依据。CSS 路径会随重构失效，所以再加两个兜底：`textDigest`（子树文本的指纹）与 `aspect`（宽高比）。三者命中任意两个即认为找到了；只命中一个则标记「低置信度」，重截后必须人工确认。

### 失效检测

重截后对比 `pixelHash` 与旧值：

- 完全相同 → 无变化。
- 感知哈希距离 < 阈值 → 视为「轻微变化」（字体微调、抗锯齿差异），静默更新。
- 超过阈值 → 标记「素材已过期」，在时间轴上高亮该素材，导出前弹窗让用户选择「用旧图 / 重截 / 跳过」。

## 三种分享形态

| 形态 | 内容 | 大小 | 场景 |
| --- | --- | --- | --- |
| `full` | 配方 + 全部纹理 + 音频 | 数百 MB | 交付、归档 |
| `light` | 配方 + 1x 预览 + 音频 | 数 MB | 团队评审、云同步 |
| `video` | 仅 mp4 | — | 对外发布 |

`light` 形态打开时会提示「高倍率纹理需重新采集」，这对「评审」场景完全够用——评审看的是节奏与构图，不是锐度。

## 版本与迁移

- `manifest.schemaVersion` 用整数递增；读取器必须能读 `N` 与 `N-1`。
- `manifest.environment` 记录 `electronVersion`、`chromeVersion`、`gpuRenderer`、`os`。跨版本打开时，若渲染结果可能不同，提示「需重新预览确认」。
- 迁移是**纯函数**：`migrate(project, from, to) -> project`，每一步独立可测。
- 不允许破坏性迁移。旧版本打开新文件时应给出明确错误，而不是部分解析。

## 为什么值得为这个单独写一份 ADR

因为它是**所有其他决策的收敛点**：

- ADR-0002 的两遍重截，依赖配方完整。
- ADR-0004 的 LOD，依赖「按需再生纹理」。
- ADR-0007 的确定性，依赖 `clock` / `randomSeed` / `media` 被记录。
- 云同步、团队协作、模板市场，全部建立在「工程文件很小」这个前提上。

如果工程文件是「一堆图」，上述能力一个都做不了，而且没有回头路。

## 后果

**正面**

- 工程文件小、可 diff（`project.json` 是可读 JSON）、可版本管理。
- 源页面变化可检测，不会静默输出旧素材。
- 4K 导出按需升倍率，不需要一开始就存巨图。

**负面**

- 打开工程依赖源页面可访问；离线或源站下线时，只能出「预览级」视频。
- 配方里有 URL，可能包含内部域名/参数，分享前需要脱敏（提供「移除源地址」选项）。
- 重截是异步且可能失败，打开旧工程的体验会比「纯本地素材」复杂。

## 何时重审

- 若用户普遍只需要「导入一次、永久离线」，应增加「冻结模式」：把高倍率纹理全部烘进包内，配方转为只读。这是对 `full` 的补充，不是替代。
- 若配方命中率低于 70%，说明 matcher 策略不足，需要引入视觉定位（模板匹配 / 特征点）作为第三兜底。
