import { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Cdp } from './cdp'
import { PICK, PICKER_SRC, FREEZE_SRC, measureExpr, SCAN_SRC, highlightExpr } from './inject'
import { isolateExpr, STRIP_STYLE, selectExpr, HIDE_DESC_EXPR, CLEAR_VIS_EXPR, buildTree, writeTree } from './tree'

const TOOLBAR_H = 56
const STRIP_H = 128
const PANEL_W = 272
const MAX_SIDE = 8192

const DIR = path.join(__dirname, '..', '..')
const CAPTURE_DIR = path.join(DIR, 'captures')
const REPORT_DIR = path.join(DIR, 'reports')
const PROJECT_DIR = path.join(DIR, 'projects')

let win: BrowserWindow | null = null
let view: WebContentsView | null = null
let cdp: Cdp | null = null
let frozen = false
let lastPick: any = null
let captureSeq = 0
let project: Project = { version: 1, updatedAt: '', sources: [], assets: [] }

type Recipe = {
  url: string
  selector: string
  viewport: { width: number; height: number }
  dpr: number
  hover: boolean
  clip: { x: number; y: number; width: number; height: number }
  offsetX: number
  offsetY: number
  elementWidth: number
  elementHeight: number
  frozen: boolean
}

type ProjectAsset = {
  id: string
  label: string
  file: string
  sha256: string
  pixel: { width: number; height: number }
  createdAt: string
  recipe: Recipe | null
}

type Project = { version: number; updatedAt: string; sources: string[]; assets: ProjectAsset[] }

type CaptureResult = {
  file: string
  selector: string | null
  label: string
  dpr: number
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  bytes: number
  sha256: string
  ms: number
  frozen: boolean
  /** 元素自身矩形在截图纹理里的偏移（纹理可能为了容纳溢出的徽标/阴影而更大） */
  offsetX: number
  offsetY: number
  elementWidth: number
  elementHeight: number
  hover: boolean
  warnings: string[]
}

function log(...args: unknown[]) {
  console.log('[uimator]', ...args)
}

function send(evt: Record<string, unknown>) {
  win?.webContents.send('evt', evt)
}

function ensureDirs() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true })
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
}

function hardenSession(sess: Electron.Session) {
  sess.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  sess.setPermissionCheckHandler(() => false)
  sess.on('will-download', (e) => e.preventDefault())
}

function createShell() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0a0b0e',
    title: 'UImator — S1 Capture Spike',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.on('resize', layout)
  win.on('closed', () => {
    win = null
    view = null
  })
  win.webContents.on('did-finish-load', () => send({ type: 'shell-ready' }))
}

function createTarget() {
  const captureSession = session.fromPartition('capture')
  hardenSession(captureSession)

  view = new WebContentsView({
    webPreferences: {
      session: captureSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
    },
  })

  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.setBackgroundColor('#ffffff')
  win!.contentView.addChildView(view)

  cdp = new Cdp(view.webContents)
  cdp.attach()
  cdp.onMessage((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const arg = params?.args?.[0]?.value
      if (typeof arg === 'string' && arg.startsWith(PICK)) {
        try {
          lastPick = JSON.parse(arg.slice(PICK.length))
          frozen = frozen
          send({ type: 'picked', pick: lastPick })
          log('picked', lastPick?.tag, lastPick?.selector)
        } catch (err) {
          log('pick parse failed', err)
        }
      }
    }
  })

  cdp.pageEnable().catch((e) => log('pageEnable failed', e))

  view.webContents.on('did-start-loading', () => {
    lastPick = null
    send({ type: 'loading' })
  })
  view.webContents.on('did-finish-load', () => {
    send({ type: 'loaded', url: view!.webContents.getURL() })
  })
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    send({ type: 'load-failed', code, desc, url })
  })

  layout()
}

function layout() {
  if (!win || !view) return
  const [w, h] = win.getContentSize()
  view.setBounds({
    x: PANEL_W,
    y: TOOLBAR_H,
    width: Math.max(320, w - PANEL_W),
    height: Math.max(120, h - TOOLBAR_H - STRIP_H),
  })
}

function fixtureDir() {
  return path.join(DIR, 'fixtures')
}

function fixtureList() {
  const manifestPath = path.join(fixtureDir(), 'index.json')
  if (fs.existsSync(manifestPath)) {
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      /* ignore */
    }
  }
  return fs
    .readdirSync(fixtureDir())
    .filter((f) => f.endsWith('.html'))
    .map((f) => ({ id: f.replace(/\.html$/, ''), file: f, picks: [] }))
}

async function navigate(rawUrl: string) {
  if (!view || !cdp) throw new Error('view not ready')
  let url = rawUrl.trim()
  if (!/^[a-z]+:/i.test(url)) url = 'https://' + url
  if (url.startsWith('file:')) {
    // allow only our own fixtures via file://
    const p = fileURLToPath(url)
    if (!path.resolve(p).startsWith(path.resolve(fixtureDir()))) {
      throw new Error('本地文件只允许 fixtures/ 目录')
    }
  }
  lastPick = null
  frozen = false
  await view.webContents.loadURL(url)
}

async function armPicker() {
  if (!cdp) throw new Error('cdp not ready')
  const ctx = await cdp.createWorld('uimator')
  const r = await cdp.evaluateInWorld(PICKER_SRC, ctx)
  log('picker armed', r)
  return r
}

async function setFreeze(on: boolean, phase = 0.45) {
  if (!cdp) throw new Error('cdp not ready')
  if (on) {
    await cdp.evaluate(FREEZE_SRC)
    const s = await cdp.evaluate(`window.__uimator.freeze(${phase})`)
    frozen = true
    send({ type: 'frozen', on: true, stats: s?.stats })
    return s
  }
  const s = await cdp.evaluate(`window.__uimator ? window.__uimator.unfreeze() : {ok:true, frozen:false}`)
  frozen = false
  send({ type: 'frozen', on: false })
  return s
}

async function capture(opts: {
  selector?: string | null
  dpr?: number
  label?: string
  hover?: boolean
  persist?: boolean
}): Promise<CaptureResult> {
  if (!view || !cdp) throw new Error('view not ready')
  ensureDirs()

  const t0 = Date.now()
  const selector = opts.selector ?? null
  const bounds = view.getBounds()
  const warnings: string[] = []
  let dpr = Math.max(1, Math.min(10, opts.dpr ?? 3))

  // 悬停态必须在冻结之前触发。
  // CSS :hover 由浏览器的真实命中测试驱动，dispatchEvent 是无效的，必须走 CDP Input。
  // 而且要**验证**它真的生效了：命中失败时（元素在折叠线以下、被遮挡、坐标偏移）
  // 静默截一张「非悬停」的图是最坏的失败，所以这里显式检查 el.matches(':hover')。
  let hoverApplied = false

  // 归位鼠标并**确认** :hover 已经解除。
  // 上一次捕获把指针留在卡片上，会让这一次的裁切框跟着 4px 的 hover 位移一起动，
  // 表现为「同一配方两次结果差一张图」——这是最隐蔽的一类不确定性。
  if (selector && !opts.hover) {
    let cleared = false
    for (let i = 0; i < 8 && !cleared; i++) {
      await cdp
        .send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none', pointerType: 'mouse' })
        .catch(() => {})
      await waitFor(90)
      cleared = !(await cdp
        .evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.matches(':hover'); })()`)
        .catch(() => false))
    }
    if (!cleared) warnings.push('hover-stale')
  }

  if (opts.hover && selector) {
    // 先把元素滚进视口：Input 事件用的是视口坐标，元素在折叠线以下就命中不到
    await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    })()`).catch(() => {})
    await waitFor(240)

    const probe = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return !!el && el.matches(':hover');
    })()`

    for (let attempt = 0; attempt < 2 && !hoverApplied; attempt++) {
      const pre: any = await cdp.evaluate(measureExpr(selector))
      if (!pre) break
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(pre.centerX) + attempt,
        y: Math.round(pre.centerY) + attempt,
        button: 'none',
        pointerType: 'mouse',
      })
      await waitFor(320)
      hoverApplied = !!(await cdp.evaluate(probe).catch(() => false))
    }

    if (!hoverApplied) warnings.push('hover-not-applied')
    if (!frozen) await setFreeze(true, 0.45)
  }

  // 截图前必须清掉我们自己的高亮/拾取遮罩，否则它会被合成进素材（并且让哈希漂移）
  await cdp
    .evaluate(`(() => { document.querySelectorAll('[data-uimator]').forEach(n => n.remove()); return true })()`)
    .catch(() => {})

  const setMetrics = (scale: number) =>
    cdp!.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      deviceScaleFactor: scale,
      mobile: false,
    })

  // 关键：先设 DPR，再重新量 rect（设 DPR 会触发重排）
  await setMetrics(dpr)

  let clip: { x: number; y: number; width: number; height: number; scale: number } = {
    x: 0, y: 0, width: bounds.width, height: bounds.height, scale: 1,
  }
  let cssWidth = bounds.width
  let cssHeight = bounds.height
  let offsetX = 0
  let offsetY = 0
  let elementWidth = bounds.width
  let elementHeight = bounds.height

  if (selector) {
    let m: any = await cdp.evaluate(measureExpr(selector))
    if (!m) throw new Error(`元素未找到：${selector}`)

    // 单边超过纹理上限时自动降倍率：宁可少一点分辨率，也不要截出半张空白
    if (Math.max(m.width, m.height) * dpr > MAX_SIDE) {
      dpr = Math.max(1, Math.min(dpr, Math.floor((MAX_SIDE / Math.max(m.width, m.height)) * 10) / 10))
      warnings.push(`dpr-clamped-to-${dpr}`)
      await setMetrics(dpr)
      m = await cdp.evaluate(measureExpr(selector))
      if (!m) throw new Error(`元素未找到：${selector}`)
    }

    // 用「元素 + 溢出后代」的并集，避免裁掉徽标、tooltip、超出边界的阴影
    clip = { x: m.x, y: m.y, width: m.width, height: m.height, scale: 1 }
    cssWidth = m.width
    cssHeight = m.height
    offsetX = Math.round(m.offsetX)
    offsetY = Math.round(m.offsetY)
    elementWidth = Math.round(m.elW)
    elementHeight = Math.round(m.elH)
  }

  const shot: any = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip,
    captureBeyondViewport: true,
    fromSurface: true,
    optimizeForSpeed: false,
  })

  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})

  if (!shot?.data) throw new Error('截图返回空数据')
  const buf = Buffer.from(shot.data, 'base64')

  const slug = (opts.label || selector || 'viewport').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 48)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  const file = path.join(CAPTURE_DIR, `${stamp}-${String(++captureSeq).padStart(2, '0')}-${slug}@${dpr}x.png`)
  fs.writeFileSync(file, buf)

  const result: CaptureResult = {
    file,
    selector,
    label: opts.label || selector || 'viewport',
    dpr,
    cssWidth: Math.round(cssWidth),
    cssHeight: Math.round(cssHeight),
    pixelWidth: Math.round(cssWidth * dpr),
    pixelHeight: Math.round(cssHeight * dpr),
    bytes: buf.byteLength,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    ms: Date.now() - t0,
    frozen,
    offsetX,
    offsetY,
    elementWidth,
    elementHeight,
    hover: hoverApplied,
    warnings,
  }
  send({ type: 'captured', asset: result })
  log('captured', path.basename(file), `${result.pixelWidth}×${result.pixelHeight}`, `${result.ms}ms`, result.sha256)

  if (opts.persist !== false && selector) {
    const url = view.webContents.getURL()
    if (url && !project.sources.includes(url)) project.sources.push(url)
    project.assets.push({
      id: `${result.sha256}-${Date.now().toString(36)}`,
      label: result.label,
      file,
      sha256: result.sha256,
      pixel: { width: result.pixelWidth, height: result.pixelHeight },
      createdAt: new Date().toISOString(),
      recipe: {
        url,
        selector,
        viewport: { width: Math.round(bounds.width), height: Math.round(bounds.height) },
        dpr,
        hover: !!opts.hover,
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
        offsetX,
        offsetY,
        elementWidth,
        elementHeight,
        frozen,
      },
    })
    saveProject()
  }

  return result
}

function saveProject() {
  project.updatedAt = new Date().toISOString()
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, 'last.json'), JSON.stringify(project, null, 2))
}

async function scanPage(): Promise<any> {
  if (!cdp) throw new Error('cdp not ready')
  const ctx = await cdp.createWorld('uimator')
  const res = await cdp.evaluateInWorld(SCAN_SRC, ctx)
  if (!res || !res.candidates) throw new Error('扫描失败')
  send({ type: 'scanned', result: res })
  log('scan', `${res.candidates.length} candidates / ${res.scanned} nodes`)
  return res
}

/* ---------------- 自检 / 批量 ---------------- */

async function waitFor(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function selftest() {
  ensureDirs()
  const fixture = 'dashboard.html'
  const url = pathToFileURL(path.join(fixtureDir(), fixture)).toString()
  log('selftest loading', url)
  await navigate(url)
  await waitFor(900)

  const freezeSummary = await setFreeze(true, 0.5)
  log('freeze', JSON.stringify(freezeSummary))

  const picks = [
    { label: 'chart-card', selector: '#chart-card' },
    { label: 'stat-card', selector: '#stat-card' },
    { label: 'sidebar', selector: '#sidebar' },
  ]

  const results: CaptureResult[] = []
  for (const p of picks) {
    results.push(await capture({ selector: p.selector, dpr: 3, label: p.label }))
  }
  results.push(await capture({ selector: null, dpr: 2, label: 'viewport' }))

  // 确定性：同一元素连截 3 次，比对 sha256
  const hashes: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await capture({ selector: '#chart-card', dpr: 3, label: 'determinism' })
    hashes.push(r.sha256)
  }

  const report = {
    mode: 'selftest',
    at: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    fixture,
    results,
    determinism: { hashes, identical: new Set(hashes).size === 1 },
  }
  fs.writeFileSync(path.join(REPORT_DIR, 'selftest.json'), JSON.stringify(report, null, 2))
  console.log('SELFTEST_JSON ' + JSON.stringify({ determinism: report.determinism, results: results.map((r) => ({ label: r.label, px: [r.pixelWidth, r.pixelHeight], ms: r.ms })) }))

  await waitFor(300)
  app.quit()
}

async function batch(customUrl?: string) {
  ensureDirs()
  const list = fixtureList()
  const report: any = { mode: 'batch', at: new Date().toISOString(), runs: [] }

  for (const fx of list) {
    const url = customUrl || pathToFileURL(path.join(fixtureDir(), fx.file)).toString()
    const run: any = { id: fx.id, url, assets: [], errors: [] }
    try {
      await navigate(url)
      await waitFor(700)
      const fz: any = await setFreeze(true, 0.5)
      run.freeze = fz?.stats ?? null
      log('freeze', fx.id, JSON.stringify(run.freeze))
      const picks = (fx.picks && fx.picks.length ? fx.picks : [{ label: 'root', selector: 'body > *' }]) as Array<{ label: string; selector: string }>
      for (const p of picks.slice(0, 6)) {
        try {
          run.assets.push(await capture({ selector: p.selector, dpr: 3, label: `${fx.id}-${p.label}` }))
        } catch (err: any) {
          run.errors.push({ selector: p.selector, error: String(err?.message || err) })
        }
      }
    } catch (err: any) {
      run.errors.push({ stage: 'load', error: String(err?.message || err) })
    }
    report.runs.push(run)
  }

  const file = path.join(REPORT_DIR, `batch-${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  console.log('BATCH_JSON ' + JSON.stringify({ file, runs: report.runs.map((r: any) => ({ id: r.id, assets: r.assets.length, errors: r.errors.length })) }))
  await waitFor(300)
  app.quit()
}

/**
 * 端到端 UI 自检：走真实的 preload → IPC → 捕获链路，最后给壳层和页面各截一张图。
 * 用来在没有人工点击的情况下验证「界面 + 管道」都是通的。
 */
async function uicheck() {
  ensureDirs()
  await waitFor(900)

  const errors: string[] = []
  win!.webContents.on('console-message', (_e, ...rest: any[]) => {
    const msg = rest.find((x) => typeof x === 'string' && /error|failed|undefined is not/i.test(x))
    if (msg) errors.push(String(msg).slice(0, 200))
  })

  const info = await win!.webContents.executeJavaScript(`(() => ({
    hasApi: typeof window.uimator === 'object',
    status: document.getElementById('status')?.textContent,
    chips: document.querySelectorAll('.chip').length
  }))()`)

  const fixtureUrl = pathToFileURL(path.join(fixtureDir(), 'landing.html')).toString()
  await win!.webContents.executeJavaScript(`window.uimator.navigate(${JSON.stringify(fixtureUrl)})`)
  await waitFor(1200)
  await win!.webContents.executeJavaScript(`window.uimator.freeze(true)`)

  // 走真实渲染进程的扫描按钮逻辑（点按钮，而不是直接调 IPC，这样面板才会真的渲染）
  await win!.webContents.executeJavaScript(`document.getElementById('scan').click()`)
  await waitFor(1600)
  const scan: any = await win!.webContents.executeJavaScript(`(() => {
    const rows = document.querySelectorAll('.cand');
    if (rows[1]) rows[1].click();
    return { scanned: 0, candidates: rows.length, top: document.querySelector('.cand .cls')?.textContent };
  })()`)
  await win!.webContents.executeJavaScript(`window.uimator.capture({ selector: '#hero', dpr: 3, label: 'ui-hero' })`)
  await win!.webContents.executeJavaScript(`window.uimator.capture({ selector: '.feature-card', dpr: 3, label: 'ui-card', hover: true })`)
  await win!.webContents.executeJavaScript(`window.uimator.capture({ selector: '.feature-card', dpr: 6, label: 'ui-6x' })`)
  const plain: any = await win!.webContents.executeJavaScript(`window.uimator.capture({ selector: '.feature-card', dpr: 3, label: 'ui-plain', hover: false })`)
  const hovered: any = await win!.webContents.executeJavaScript(`window.uimator.capture({ selector: '.feature-card', dpr: 3, label: 'ui-hover', hover: true })`)
  await waitFor(600)

  const after = await win!.webContents.executeJavaScript(`(() => ({
    status: document.getElementById('status')?.textContent,
    thumbs: document.querySelectorAll('.thumb').length
  }))()`)

  await cdp?.evaluate(`window.scrollTo({ top: 0, left: 0, behavior: 'instant' })`).catch(() => {})
  await waitFor(350)

  const shellShot = await win!.webContents.capturePage()
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ui-shell.png'), shellShot.toPNG())
  const pageShot = await view!.webContents.capturePage()
  fs.writeFileSync(path.join(CAPTURE_DIR, 'ui-page.png'), pageShot.toPNG())

  console.log('UICHECK_JSON ' + JSON.stringify({
    info,
    after,
    errors,
    scan: { rows: scan?.candidates, top: scan?.top },
    hoverProbe: { plain: plain?.sha256, hovered: hovered?.sha256, differs: plain?.sha256 !== hovered?.sha256, applied: hovered?.hover },
  }))
  await waitFor(300)
  app.quit()
}


/* ---------------- 配方复现 / 站点矩阵 ---------------- */

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ])
}

/**
 * 按工程里保存的「重截配方」重新抓一遍，比对像素哈希。
 * 这是 ADR-0009 的核心承诺：素材是缓存，配方是真相。
 */
async function recap() {
  ensureDirs()
  const file = path.join(PROJECT_DIR, 'last.json')
  if (!fs.existsSync(file)) throw new Error('没有工程文件，先跑一次捕获')
  const saved: Project = JSON.parse(fs.readFileSync(file, 'utf8'))
  const withRecipe = saved.assets.filter((a) => a.recipe)

  const byUrl = new Map<string, ProjectAsset[]>()
  for (const a of withRecipe) {
    const k = a.recipe!.url
    if (!byUrl.has(k)) byUrl.set(k, [])
    byUrl.get(k)!.push(a)
  }

  const report: any = { mode: 'recap', at: new Date().toISOString(), runs: [] }
  for (const [url, assets] of byUrl) {
    const run: any = { url, identical: 0, drifted: [], failed: [], ms: 0 }
    const t0 = Date.now()
    try {
      await withTimeout(navigate(url), 25000, 'navigate')
      await waitFor(900)
      await setFreeze(true, 0.45)
    } catch (err: any) {
      run.failed.push({ stage: 'load', error: String(err?.message ?? err) })
      report.runs.push(run)
      continue
    }
    for (const a of assets) {
      try {
        const r = await capture({
          selector: a.recipe!.selector,
          dpr: a.recipe!.dpr,
          hover: a.recipe!.hover,
          label: `recap-${a.label}`,
          persist: false,
        })
        if (r.sha256 === a.sha256) run.identical++
        else run.drifted.push({ label: a.label, before: a.sha256, after: r.sha256 })
      } catch (err: any) {
        run.failed.push({ label: a.label, error: String(err?.message ?? err) })
      }
    }
    run.ms = Date.now() - t0
    report.runs.push(run)
    console.log(`[recap] ${url} identical=${run.identical} drifted=${run.drifted.length} failed=${run.failed.length}`)
  }

  const out = path.join(REPORT_DIR, `recap-${Date.now()}.json`)
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  const total = report.runs.reduce((n: number, r: any) => n + r.identical + r.drifted.length + r.failed.length, 0)
  const ok = report.runs.reduce((n: number, r: any) => n + r.identical, 0)
  console.log('RECAP_JSON ' + JSON.stringify({ out, total, identical: ok, runs: report.runs.map((r: any) => ({ url: r.url, identical: r.identical, drifted: r.drifted.length, failed: r.failed.length })) }))
  await waitFor(200)
  app.quit()
}

/** 对一组真实站点跑「加载 → 冻结 → 自动拆解 → 截前 N 个候选」。 */
async function matrix() {
  ensureDirs()
  const sitesFile = path.join(fixtureDir(), 'sites.json')
  if (!fs.existsSync(sitesFile)) throw new Error('缺少 fixtures/sites.json')
  const sites = JSON.parse(fs.readFileSync(sitesFile, 'utf8')) as Array<{ id: string; name: string; url: string; note?: string }>

  const report: any = { mode: 'matrix', at: new Date().toISOString(), runs: [] }
  for (const site of sites) {
    const run: any = { id: site.id, name: site.name, url: site.url, ok: false, ms: 0, candidates: 0, assets: [], errors: [] }
    const t0 = Date.now()
    try {
      await withTimeout(navigate(site.url), 30000, 'navigate')
      await waitFor(1500)
      await setFreeze(true, 0.45)
      const scan = await scanPage()
      run.candidates = scan.candidates.length
      for (const c of scan.candidates.slice(0, 4)) {
        try {
          const r = await capture({ selector: c.selector, dpr: 3, label: `${site.id}-${c.cls}`, persist: false })
          run.assets.push({ label: r.label, px: [r.pixelWidth, r.pixelHeight], ms: r.ms, cls: c.cls, score: c.score })
        } catch (err: any) {
          run.errors.push({ selector: c.selector, error: String(err?.message ?? err) })
        }
      }
      run.ok = run.assets.length > 0
    } catch (err: any) {
      run.errors.push({ stage: 'load', error: String(err?.message ?? err) })
    }
    run.ms = Date.now() - t0
    report.runs.push(run)
    console.log(`[matrix] ${site.id} candidates=${run.candidates} assets=${run.assets.length} errors=${run.errors.length} ${run.ms}ms`)
  }

  const out = path.join(REPORT_DIR, `matrix-${Date.now()}.json`)
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('MATRIX_JSON ' + JSON.stringify({ out, ok: report.runs.filter((r: any) => r.ok).length, total: report.runs.length }))
  await waitFor(200)
  app.quit()
}


/**
 * 分层素材验证（对应 ADR-0012）：
 *  1. 用「隐藏子节点 + 透明背景」把一张卡片拆成两层：底板层、内容层
 *  2. 用 Range 逐字符取矩形，验证「不重建 DOM 也能做逐字动画」
 *  3. 统计 alpha 覆盖，确认圆角/阴影真的被保留成透明
 */
async function layerTest() {
  ensureDirs()
  const url = pathToFileURL(path.join(fixtureDir(), 'landing.html')).toString()
  await navigate(url)
  await waitFor(900)
  await setFreeze(true, 0.45)

  const sel = process.env.UIMATOR_LAYER_SEL || '.feature-card'
  const bounds = view!.getBounds()
  const dpr = 3

  await cdp!.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(bounds.width), height: Math.round(bounds.height),
    deviceScaleFactor: dpr, mobile: false,
  })
  await cdp!.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  })

  const shoot = async (name: string, clip: any) => {
    const shot: any = await cdp!.send('Page.captureScreenshot', {
      format: 'png', clip, captureBeyondViewport: true, fromSurface: true,
    })
    const file = path.join(CAPTURE_DIR, `layer-${name}@${dpr}x.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  // 0) 隔离：把祖先链的背景改成透明、兄弟节点隐藏。
  //    只设 setDefaultBackgroundColorOverride 是不够的——页面自己的 body/背景色仍然会画上去。
  const isolation = await cdp!.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    let node = el, hidden = 0, cleared = 0;
    while (node && node !== document.documentElement) {
      const parent = node.parentElement;
      if (parent) {
        for (const sib of parent.children) {
          if (sib !== node && getComputedStyle(sib).visibility !== 'hidden') { sib.style.visibility = 'hidden'; hidden++; }
        }
      }
      if (node !== el) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { node.style.backgroundColor = 'transparent'; cleared++; }
      }
      node = parent;
    }
    document.documentElement.style.backgroundColor = 'transparent';
    document.body.style.backgroundColor = 'transparent';
    return { hidden, cleared };
  })()`)

  // 1) 完整卡片
  const m0: any = await cdp!.evaluate(measureExpr(sel))
  const fullClip = { x: m0.x, y: m0.y, width: m0.width, height: m0.height, scale: 1 }
  const full = await shoot('full', fullClip)

  // 2) 底板层：隐藏所有后代
  const hidden = await cdp!.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    let n = 0;
    el.querySelectorAll('*').forEach((c) => {
      if (getComputedStyle(c).visibility !== 'hidden') { c.style.visibility = 'hidden'; n++; }
    });
    return n;
  })()`)
  const m1: any = await cdp!.evaluate(measureExpr(sel))
  const base = await shoot('base', { x: m1.x, y: m1.y, width: m1.width, height: m1.height, scale: 1 })

  // 3) 内容层：底板透明、子节点可见（base + content ≈ full）
  await cdp!.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    el.querySelectorAll('*').forEach((c) => { c.style.visibility = ''; });
    el.dataset.__bg = el.style.backgroundColor;
    el.style.backgroundColor = 'transparent';
    el.style.boxShadow = 'none';
    return true;
  })()`)
  const m2: any = await cdp!.evaluate(measureExpr(sel))
  const content = await shoot('content', { x: m2.x, y: m2.y, width: m2.width, height: m2.height, scale: 1 })

  // 4) 逐字符矩形（打字机效果的原语，不需要重排）
  const glyphs = await cdp!.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)} + ' h3') || document.querySelector(${JSON.stringify(sel)});
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return null;
    const out = [];
    for (let i = 0; i < Math.min(node.length, 30); i++) {
      const r = document.createRange();
      r.setStart(node, i); r.setEnd(node, i + 1);
      const b = r.getBoundingClientRect();
      out.push({ c: node.data[i], x: Math.round(b.x), y: Math.round(b.y), w: +b.width.toFixed(1), h: +b.height.toFixed(1) });
    }
    return { text: node.data.slice(0, 30), chars: node.length, rects: out };
  })()`)

  // 4) 恢复
  await cdp!.evaluate(`(() => {
    document.querySelectorAll('[style*="visibility: hidden"]').forEach((c) => { c.style.visibility = ''; });
    return true;
  })()`)
  await cdp!.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {})

  const report = { sel, dpr, isolation, hiddenChildren: hidden, files: { full, base, content }, glyphs }
  fs.writeFileSync(path.join(REPORT_DIR, 'layer-test.json'), JSON.stringify(report, null, 2))
  console.log('LAYER_JSON ' + JSON.stringify({
    sel, hiddenChildren: hidden, isolation,
    glyphs: glyphs ? { text: glyphs.text, chars: glyphs.chars, sample: glyphs.rects.slice(0, 4) } : null,
  }))
  await waitFor(200)
  app.quit()
}


/**
 * 结构树捕获：把一块 UI 拆成「节点 + 每节点的位图载荷」，并写出一棵可寻址的树。
 * 与 capture() 的区别：产物是树，不是图。
 */
async function treeCapture() {
  ensureDirs()
  const url = process.env.UIMATOR_URL || pathToFileURL(path.join(fixtureDir(), 'landing.html')).toString()
  const sel = process.env.UIMATOR_TREE_SEL || '#features'
  const dpr = 3
  const dir = path.join(CAPTURE_DIR, 'tree')
  fs.mkdirSync(dir, { recursive: true })

  await navigate(url)
  await waitFor(1000)
  await setFreeze(true, 0.45)

  const bounds = view!.getBounds()
  await cdp!.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(bounds.width), height: Math.round(bounds.height), deviceScaleFactor: dpr, mobile: false,
  })
  await cdp!.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })

  await cdp!.evaluate(isolateExpr(sel))
  await cdp!.evaluate(STRIP_STYLE)

  const shot = async (clip: any, name: string) => {
    const res: any = await cdp!.send('Page.captureScreenshot', {
      format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true, fromSurface: true,
    })
    const file = path.join(dir, name + '.png')
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
    return file
  }

  const meta: any = await cdp!.evaluate(selectExpr(sel))
  if (!meta) throw new Error('没选中根节点：' + sel)

  // 先截整块，作为复现校验的基准
  const rootClip = { x: meta.root.x, y: meta.root.y, width: meta.root.w, height: meta.root.h }
  const fullFile = await shot(rootClip, 'full')

  // 逐节点：隐藏后代 → 量框 → 截 → 恢复
  for (let i = 0; i < meta.nodes.length; i++) {
    const rect = await cdp!.evaluate(HIDE_DESC_EXPR(i))
    if (!rect || rect.w < 2 || rect.h < 2) continue
    // 改完 visibility 必须等一帧再截，否则 captureScreenshot 可能拿到上一次合成的画面
    await waitFor(90)
    meta.nodes[i].render = {
      file: await shot({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }, `n${String(i).padStart(2, '0')}-${meta.nodes[i].role}`),
      dpr,
    }
  }
  await cdp!.evaluate(CLEAR_VIS_EXPR)

  const tree = buildTree(meta.nodes, meta.root)
  writeTree(path.join(PROJECT_DIR, 'tree.json'), {
    source: url, selector: sel, dpr, root: meta.root, full: fullFile, nodes: tree,
  })

  const byRole: Record<string, number> = {}
  for (const n of meta.nodes) byRole[n.role] = (byRole[n.role] ?? 0) + 1
  console.log('TREE_JSON ' + JSON.stringify({ selector: sel, nodes: meta.nodes.length, byRole, root: meta.root }))
  await cdp!.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {})
  await waitFor(200)
  app.quit()
}


/** 舞台预览：把 tree.json 渲染成一段帧序列，用于 S2 的观感判断。 */
async function stageDemo() {
  ensureDirs()
  const outDir = path.join(CAPTURE_DIR, 'stage')
  fs.mkdirSync(outDir, { recursive: true })
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(outDir, f))

  const stageWin = new BrowserWindow({
    width: 1280, height: 720, show: true, backgroundColor: '#06070b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  })
  stageWin.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('STAGE_LOAD_FAIL', code, desc, url))
  stageWin.webContents.on('console-message', (_e, ...rest: any[]) => {
    const msg = rest.map((x) => (typeof x === 'string' ? x : x?.message)).filter(Boolean).join(' ')
    if (msg) console.log('STAGE_CONSOLE', String(msg).slice(0, 300))
  })
  const stageUrl = pathToFileURL(path.join(__dirname, '../stage/index.html')).toString()
  console.log('STAGE_URL', stageUrl)
  await stageWin.loadURL(stageUrl)
  await waitFor(2200)

  const ready = await stageWin.webContents.executeJavaScript('!!(window.__stage && window.__stage.ready)')
  if (!ready) {
    const detail = await stageWin.webContents.executeJavaScript('JSON.stringify(window.__stage || null)').catch(() => 'null')
    const html = await stageWin.webContents.executeJavaScript('location.href + " ready=" + document.readyState + " body=" + document.body.innerHTML.slice(0,120)').catch(() => '')
    throw new Error('stage 未就绪: ' + detail + ' body=' + html)
  }

  const fps = 12
  const duration = 3.2
  const frames = Math.round(fps * duration)
  for (let i = 0; i < frames; i++) {
    await stageWin.webContents.executeJavaScript(`window.__stage.renderAt(${(i / fps).toFixed(3)})`)
    await waitFor(24)
    const img = await stageWin.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `f${String(i).padStart(3, '0')}.png`), img.toPNG())
  }

  console.log('STAGE_JSON ' + JSON.stringify({ frames, fps, outDir }))
  await waitFor(200)
  app.quit()
}

/* ---------------- IPC ---------------- */

function wireIpc() {
  ipcMain.handle('nav', async (_e, url: string) => navigate(url))
  ipcMain.handle('pick', async () => armPicker())
  ipcMain.handle('scan', async () => scanPage())
  ipcMain.handle('highlight', async (_e, selector: string) => {
    if (!cdp) return false
    return cdp.evaluate(highlightExpr(selector))
  })
  ipcMain.handle('capture', async (_e, opts: { selector?: string | null; dpr?: number; label?: string }) => capture(opts ?? {}))
  ipcMain.handle('freeze', async (_e, on: boolean) => setFreeze(on))
  ipcMain.handle('fixtures', async () => {
    const dir = fixtureDir()
    return fixtureList().map((f: any) => ({
      id: f.id,
      label: f.label || f.id,
      url: pathToFileURL(path.join(dir, f.file)).toString(),
      picks: f.picks || [],
    }))
  })
  ipcMain.handle('stage-data', async () => {
    const tree = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'tree.json'), 'utf8'))
    const textures: Record<string, string> = {}
    const walk = (n: any) => {
      if (n.render?.file && fs.existsSync(n.render.file)) {
        textures[n.render.file] = 'data:image/png;base64,' + fs.readFileSync(n.render.file).toString('base64')
      }
      n.children?.forEach(walk)
    }
    tree.nodes.forEach(walk)
    return { tree, textures }
  })
  ipcMain.handle('state', async () => ({
    url: view?.webContents.getURL() ?? '',
    frozen,
    lastPick,
  }))
  ipcMain.handle('reveal', async (_e, p: string) => {
    if (fs.existsSync(p)) shell.showItemInFolder(p)
  })
}

/* ---------------- 启动 ---------------- */

const argv = process.argv.slice(1)
const isSelftest = argv.includes('--selftest')
const isBatch = argv.includes('--batch')
const isUiCheck = argv.includes('--uicheck')
const isRecap = argv.includes('--recap')
const isMatrix = argv.includes('--matrix')
const isLayerTest = argv.includes('--layertest')
const isTree = argv.includes('--tree')
const isStage = argv.includes('--stage')

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  if (!isSelftest && !isBatch && !isUiCheck && !isRecap && !isMatrix && !isLayerTest && !isTree && !isStage) {
    createShell()
    wireIpc()
    win!.webContents.once('did-finish-load', () => {
      createTarget()
      layout()
    })
    return
  }

  // 自检/批量：仍然要一个窗口（隐藏窗口不产生合成帧，CDP 截图会是空白）
  createShell()
  wireIpc()
  await new Promise<void>((resolve) => win!.webContents.once('did-finish-load', () => resolve()))
  createTarget()
  layout()
  await new Promise((r) => setTimeout(r, 400))

  try {
    if (isSelftest) await selftest()
    else if (isUiCheck) await uicheck()
    else if (isRecap) await recap()
    else if (isMatrix) await matrix()
    else if (isLayerTest) await layerTest()
    else if (isTree) await treeCapture()
    else if (isStage) await stageDemo()
    else await batch(process.env.UIMATOR_URL)
  } catch (err) {
    console.error('FATAL', err)
    app.exit(1)
  }
})

app.on('window-all-closed', () => app.quit())
