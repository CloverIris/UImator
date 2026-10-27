type PickedElement = {
  selector: string
  tag: string
  viewportRect?: { x: number; y: number; width: number; height: number }
  documentRect?: { x: number; y: number; width: number; height: number }
  radius?: number
  shadow?: string | null
  textPreview?: string
}

type Candidate = {
  i: number
  selector: string
  tag: string
  cls: string
  score: number
  w: number
  h: number
  x: number
  y: number
  text: string
  why: string[]
}

type Asset = {
  file: string
  label: string
  selector: string | null
  dpr: number
  pixelWidth: number
  pixelHeight: number
  bytes: number
  sha256: string
  ms: number
  frozen: boolean
  hover: boolean
  warnings: string[]
}

const CLS_LABEL: Record<string, string> = {
  nav: '导航',
  card: '卡片',
  chart: '图表',
  table: '表格',
  sidebar: '侧栏',
  banner: '横幅',
  modal: '弹窗',
  hero: '首屏',
  footer: '页脚',
  section: '区块',
  icon: '图标',
  block: '区块',
}

const el = {
  url: document.getElementById('url') as HTMLInputElement,
  go: document.getElementById('go') as HTMLButtonElement,
  pick: document.getElementById('pick') as HTMLButtonElement,
  freeze: document.getElementById('freeze') as HTMLButtonElement,
  shot: document.getElementById('shot') as HTMLButtonElement,
  shotAll: document.getElementById('shotAll') as HTMLButtonElement,
  scan: document.getElementById('scan') as HTMLButtonElement,
  hiRes: document.getElementById('hiRes') as HTMLButtonElement,
  hoverMode: document.getElementById('hoverMode') as HTMLInputElement,
  status: document.getElementById('status') as HTMLDivElement,
  thumbs: document.getElementById('thumbs') as HTMLDivElement,
  count: document.getElementById('count') as HTMLSpanElement,
  fixtures: document.getElementById('fixtures') as HTMLDivElement,
  toast: document.getElementById('toast') as HTMLDivElement,
  cands: document.getElementById('cands') as HTMLDivElement,
  candCount: document.getElementById('candCount') as HTMLSpanElement,
}

let lastPick: PickedElement | null = null
let assetCount = 0
let candidates: Candidate[] = []

function setStatus(text: string, kind: 'idle' | 'ok' | 'busy' | 'err' = 'idle') {
  el.status.className = 'status' + (kind === 'idle' ? '' : ' ' + kind)
  el.status.innerHTML = '<span class="pulse"></span>' + escapeHtml(text)
}

function toast(text: string, kind: 'info' | 'err' = 'info') {
  el.toast.textContent = text
  el.toast.className = 'toast show' + (kind === 'err' ? ' err' : '')
  clearTimeout((toast as any)._t)
  ;(toast as any)._t = setTimeout(() => (el.toast.className = 'toast'), 2600)
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function fmtBytes(n: number) {
  return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB'
}

function addAsset(a: Asset) {
  const first = el.thumbs.querySelector('.empty')
  if (first) first.remove()

  assetCount++
  el.count.textContent = String(assetCount)

  const node = document.createElement('div')
  node.className = 'thumb'
  node.title = `${a.file}\n${a.selector ?? 'viewport'}\nsha ${a.sha256}${a.warnings?.length ? '\n⚠ ' + a.warnings.join(', ') : ''}`
  node.innerHTML = `
    <span class="badge">${a.dpr}x</span>
    <img src="${'file://' + a.file}" alt="">
    <div class="meta"><b>${escapeHtml(a.label)}</b> · ${a.pixelWidth}×${a.pixelHeight} · ${fmtBytes(a.bytes)}</div>`
  node.addEventListener('click', () => window.uimator.reveal(a.file))
  el.thumbs.prepend(node)
}

function selectCandidate(c: Candidate) {
  lastPick = {
    selector: c.selector,
    tag: c.tag,
    documentRect: { x: c.x, y: c.y, width: c.w, height: c.h },
  }
  for (const n of Array.from(el.cands.querySelectorAll('.cand'))) {
    n.classList.toggle('on', (n as HTMLElement).dataset.i === String(c.i))
  }
  window.uimator.highlight(c.selector)
  setStatus(`已选中 ${CLS_LABEL[c.cls] ?? c.cls} · ${c.w}×${c.h}`, 'ok')
}

function renderCandidates(list: Candidate[]) {
  candidates = list
  el.candCount.textContent = String(list.length)
  el.cands.innerHTML = ''

  if (!list.length) {
    el.cands.innerHTML = '<div class="p-empty">这个页面没扫出可信的候选。<br />试试「拾取」手工选。</div>'
    return
  }

  for (const c of list) {
    const row = document.createElement('div')
    row.className = 'cand'
    row.dataset.i = String(c.i)
    const tone = c.score >= 70 ? 'hi' : c.score >= 45 ? 'mid' : 'lo'
    row.innerHTML = `
      <div class="cand-top">
        <span class="cls ${c.cls}">${CLS_LABEL[c.cls] ?? c.cls}</span>
        <span class="score ${tone}">${c.score}</span>
        <span class="dim">${c.w}×${c.h}</span>
      </div>
      <div class="cand-txt">${escapeHtml(c.text || '<' + c.tag + '>')}</div>
      <div class="cand-why">${c.why.map((w) => `<i>${escapeHtml(w)}</i>`).join('')}</div>`
    row.addEventListener('click', () => selectCandidate(c))
    el.cands.appendChild(row)
  }

  if (list[0]) selectCandidate(list[0])
}

async function boot() {
  const fixtures = (await window.uimator.fixtures()) as Array<{ id: string; label: string; url: string }>
  for (const f of fixtures) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.textContent = f.label
    b.addEventListener('click', () => {
      el.url.value = f.url
      navigate(f.url)
    })
    el.fixtures.appendChild(b)
  }
}

async function navigate(url: string) {
  if (!url.trim()) return
  setStatus('加载中…', 'busy')
  try {
    await window.uimator.navigate(url)
  } catch (err: any) {
    setStatus('加载失败', 'err')
    toast(String(err?.message ?? err), 'err')
  }
}

window.uimator.onEvent((evt: any) => {
  switch (evt.type) {
    case 'loading':
      setStatus('加载中…', 'busy')
      break
    case 'loaded':
      el.url.value = evt.url
      setStatus('已加载 · 可扫描或拾取', 'ok')
      break
    case 'load-failed':
      setStatus(`加载失败 ${evt.code}`, 'err')
      toast(`${evt.desc} (${evt.code})`, 'err')
      break
    case 'picked':
      lastPick = evt.pick
      el.pick.classList.remove('on')
      setStatus(`已选中 ${evt.pick.tag}`, 'ok')
      toast(`选中 ${evt.pick.selector}`)
      break
    case 'frozen':
      el.freeze.classList.toggle('on', !!evt.on)
      el.freeze.textContent = evt.on ? '已冻结' : '冻结'
      if (evt.on && evt.stats) setStatus(`已冻结 · ${evt.stats.animations} 个动画`, 'ok')
      break
    case 'captured':
      addAsset(evt.asset)
      setStatus(`已截取 ${evt.asset.pixelWidth}×${evt.asset.pixelHeight}`, 'ok')
      break
  }
})

el.go.addEventListener('click', () => navigate(el.url.value))
el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(el.url.value)
})

el.pick.addEventListener('click', async () => {
  el.pick.classList.add('on')
  setStatus('点选页面中的元素（Esc 取消）', 'busy')
  await window.uimator.pick()
})

el.freeze.addEventListener('click', async () => {
  const on = !el.freeze.classList.contains('on')
  await window.uimator.freeze(on)
})

el.scan.addEventListener('click', async () => {
  el.scan.disabled = true
  setStatus('扫描中…', 'busy')
  try {
    const res: any = await window.uimator.scan()
    renderCandidates(res.candidates ?? [])
    setStatus(`扫描 ${res.scanned} 个节点 → ${res.candidates.length} 个候选`, 'ok')
  } catch (err: any) {
    setStatus('扫描失败', 'err')
    toast(String(err?.message ?? err), 'err')
  } finally {
    el.scan.disabled = false
  }
})

async function doCapture(opts: { dpr: number; label?: string }) {
  if (!lastPick) {
    toast('先「拾取」或点一个候选', 'err')
    return
  }
  setStatus(`截取中 ${opts.dpr}x…`, 'busy')
  try {
    await window.uimator.capture({
      selector: lastPick.selector,
      dpr: opts.dpr,
      label: opts.label ?? lastPick.selector.replace(/[^\w-]+/g, '_').slice(0, 32),
      hover: el.hoverMode.checked,
    })
  } catch (err: any) {
    setStatus('截取失败', 'err')
    toast(String(err?.message ?? err), 'err')
  }
}

el.shot.addEventListener('click', () => doCapture({ dpr: 3 }))
el.hiRes.addEventListener('click', () => doCapture({ dpr: 6, label: 'hires' }))

el.shotAll.addEventListener('click', async () => {
  setStatus('截取整屏…', 'busy')
  try {
    await window.uimator.capture({ dpr: 2, label: 'viewport' })
  } catch (err: any) {
    setStatus('截取失败', 'err')
    toast(String(err?.message ?? err), 'err')
  }
})

boot().catch((e) => toast(String(e?.message ?? e), 'err'))
