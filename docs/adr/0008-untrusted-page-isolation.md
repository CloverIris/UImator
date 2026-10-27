# ADR-0008 不可信页面的隔离与安全边界

- 状态：已接受
- 日期：2026-10-26
- 关联：ADR-0001、ADR-0002

## 背景

UImator 的核心动作是「在用户机器上打开一个任意 URL」。这个页面可能是用户自己的产品，也可能是竞品、钓鱼站、或者专门攻击桌面应用的页面。

同时，我们**必须**能截图、能注入脚本、能模拟输入——这些都是「看起来很像恶意软件」的能力。如果安全边界没设计对，UImator 会变成一个「打开链接就能读你硬盘」的程序。

## 威胁模型

| 威胁 | 例子 | 后果 |
| --- | --- | --- |
| 页面逃逸到 Node | 页面调用 `require('fs')` | 读写用户文件、执行任意命令 |
| 通过 preload 桥接提权 | 我们图省事暴露了 `window.api.capture()` | 页面滥用内部能力 |
| 会话串味 | 捕获视图与编辑器共用 session | 页面能读我们的 cookie / 缓存 |
| 注入泄漏 | 注入的脚本挂在 `window` 上 | 页面可以篡改我们的抓取结果 |
| 资源耗尽 | 页面开 200 个 WebGL 上下文 / 死循环 | 应用卡死、崩溃 |
| 意外上报 | 页面把「自己被截图」的事实发回服务器 | 隐私与合规争议 |
| 供应链 | 远程内容被当作可信 UI 渲染 | XSS 到我们的编辑器 |

## 决策

### 1. 三层进程 + 三套 session

```
capture view  ── partition: "capture"   （每次新工程可为独立 partition）
stage window  ── partition: "stage"     （只跑我们自己的渲染代码）
editor window ── partition: "editor"    （localhost/devserver，禁止加载远程内容）
```

`capture` 必须使用 `session.fromPartition()` 的**非持久化**分区（`persist:` 前缀不加），除非用户显式选择「记住此站点的登录"。保留登录态时单独建一个持久分区，并在 UI 上标出来。

### 2. 捕获视图的 webPreferences（不可协商）

```ts
new WebContentsView({
  webPreferences: {
    session: captureSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    allowRunningInsecureContent: false,
    webSecurity: true,          // 绝不关闭
    backgroundThrottling: false // 仅导出窗口需要
  }
})
```

> 注：`enableRemoteModule` 在 Electron 14 已移除，这里不再列出；若项目锁定的版本更老，需显式设为 `false`。

配套：

- `session.setPermissionRequestHandler(() => false)` —— 摄像头、麦克风、地理位置、通知、剪贴板读取，全部拒绝。
- `contents.setWindowOpenHandler(() => ({ action: 'deny' }))` —— 不允许弹出新窗口（新窗口是逃逸的经典路径）。
- `will-attach-webview` → `preventDefault()`。
- `will-download` → 取消。
- 不做任何响应头改写（不剥离 `X-Frame-Options` / CSP）；**不设** `webSecurity: false`。

### 3. 注入方式

- 用 CDP `Runtime.evaluate` 在**隔离世界（isolated world）**里执行采集脚本，页面 JS 看不见我们的变量，也无法篡改返回值。
- 需要绕过页面 CSP 时用 `Page.setBypassCSP(true)`（仅对当前捕获视图生效）。注意：这也会放开页面自己的内联脚本，但那只影响页面自身的安全，不影响宿主。
- 采集脚本只做「读」：读 DOM、读计算样式、读几何。写操作（隐藏节点、暂停动画）限定在采集窗口，且必须可恢复。

### 4. 跨界只传位图与结构化数据

从捕获进程回传到主进程的，只有三类东西：

1. **截图**（WebP/PNG 字节）。
2. **结构化元数据**（矩形、类名摘要、文本摘要、样式 token）。
3. **错误**。

**禁止**把 DOM 节点、页面提供的字符串当文件名/路径、页面 HTML 直接塞进编辑器渲染。素材在素材箱里是 `<img src="asset://hash">`，绝不 `dangerouslySetInnerHTML`。

### 5. 编辑器窗口的自我约束

- 编辑器只加载 `app://` 或 `file://` 的本地资源，禁止导航到远程 URL（`will-navigate` 拦截）。
- 自己的 UI 也加 CSP（`script-src 'self'`），不给未来的 XSS 留口子。
- 捕获到的文本（如页面标题、按钮文案）进入 UI 前必须转义。

### 6. 资源看门狗

- 捕获视图设内存上限与请求上限，超限直接销毁重建。
- 采集脚本有全局超时（默认 15 s），超时即中止并返回已采集部分。
- 渲染/导出进程崩溃不影响已保存工程（导出走 chunk 落盘，见 ADR-0006）。

## 法律与合规边界（写进产品条款）

- 仅支持**用户主动发起**的单页采集；不做批量、不做定时、不做队列。
- 采集产物仅保存截图，不保存页面源码与用户数据（除截图中不可避免的可见内容）。
- 明确提示：用他人站点素材做宣传需自行获得授权；「竞品解构」不作为官方推荐用法。
- 遵守 `robots.txt` 只在批量场景有意义；单次用户操作等同于正常浏览，但仍需在 UA 与频率上保持克制。

## 后果

**正面**

- 打开任意链接的爆炸半径被限制在「一个沙箱渲染进程能做的事」。
- 安全审查（企业采购、应用商店）时有一份可交付的边界文档。
- 注入与捕获能力不会成为攻击面。

**负面**

- `sandbox: true` 下某些注入能力受限，需要通过 CDP 而非 preload 完成。
- 拒绝所有权限会让部分站点降级（比如需要剪贴板的应用），需要在 UI 上解释原因。
- 每次采集新建 session 会让「记住登录」变成显式选择，牺牲一点便利换隔离。

## 何时重审

- 若需要支持「批量采集自己的多个页面」，必须新增独立的权限模型与速率限制，不能直接放开。
- 若 Electron 的 sandbox 模型发生重大变化，重跑本节清单。
