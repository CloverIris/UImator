// @ts-nocheck
import * as THREE from 'three'

type N = any

const W = 1280
const H = 720
const DURATION = 3.2

const canvas = document.getElementById('c') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(1)
renderer.setSize(W, H, false)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#06070b')
const camera = new THREE.PerspectiveCamera(32, W / H, 10, 9000)

const stage = new THREE.Group()
scene.add(stage)

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

type Entry = { node: N; mesh: THREE.Mesh; role: string; baseZ: number; bx: number; by: number; order: number; cardOrder: number }
const entries: Entry[] = []
const glyphs: Array<{ mesh: THREE.Mesh; left: number; width: number; order: number }> = []

let rootRect = { x: 0, y: 0, w: 1, h: 1 }

async function init() {
  const data = await (window as any).uimator.getStage()
  const tree = data.tree
  const textures: Record<string, string> = data.textures
  rootRect = tree.root
  const cx = rootRect.w / 2
  const cy = rootRect.h / 2

  const loader = new THREE.TextureLoader()
  const flat: N[] = []
  const walk = (n: N, parentZ: number, cardOrder: number) => {
    const local = n.role === 'card' ? 0 : n.role === 'icon' ? 8 : n.role === 'heading' || n.role === 'text' ? 2 : 0.5
    const z = parentZ + local
    flat.push({ ...n, __z: z, __card: n.role === 'card' ? cardSeq : cardOrder })
    n.children.forEach((c: N) => walk(c, z, n.role === 'card' ? cardSeq : cardOrder))
    if (n.role === 'card') cardSeq++
  }
  tree.nodes.forEach((n: N) => walk(n, 0, -1))

  let cardSeq = 0

  for (const n of flat) {
    if (!n.render || !textures[n.render.file]) continue
    const tex = await loader.loadAsync(textures[n.render.file])
    tex.colorSpace = THREE.SRGBColorSpace
    tex.minFilter = THREE.LinearFilter
    tex.generateMipmaps = false

    const baseZ = n.__z as number
    const geo = new THREE.PlaneGeometry(n.abs.w, n.abs.h)
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 1 })
    const mesh = new THREE.Mesh(geo, mat)
    // abs 是文档坐标：减去树根原点再居中，否则整棵树会被推到画面外
    const bx = n.abs.x - rootRect.x + n.abs.w / 2 - cx
    const by = -(n.abs.y - rootRect.y + n.abs.h / 2 - cy)
    mesh.position.set(bx, by, baseZ)
    mesh.renderOrder = n.depth * 10
    stage.add(mesh)

    const order = n.role === 'card' ? cardSeq - 1 : 0
    const cardOrder = n.__card as number
    entries.push({ node: n, mesh, role: n.role, baseZ, bx, by, order, cardOrder })

    if ((n.role === 'heading' || n.role === 'text') && n.text?.glyphs?.length) {
      mesh.visible = false
      let gi = 0
      for (const g of n.text.glyphs) {
        const gw = Math.max(1, g.w)
        const gh = Math.max(1, g.h)
        const u0 = (rootRect.x + g.x - n.abs.x) / n.abs.w
        const v0 = 1 - (rootRect.y + g.y - n.abs.y + gh) / n.abs.h
        const du = gw / n.abs.w
        const dv = gh / n.abs.h
        const gg = new THREE.PlaneGeometry(gw, gh)
        const uv = gg.attributes.uv as THREE.BufferAttribute
        uv.setXY(0, u0, v0)
        uv.setXY(1, u0 + du, v0)
        uv.setXY(2, u0, v0 + dv)
        uv.setXY(3, u0 + du, v0 + dv)
        const gm = new THREE.Mesh(gg, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }))
        const left = g.x + gw / 2 - cx
        gm.position.set(left, -(g.y + gh / 2 - cy), baseZ + 0.8)
        gm.renderOrder = n.depth * 10 + 1
        gm.scale.x = 0.001
        stage.add(gm)
        glyphs.push({ mesh: gm, left, width: gw, order: gi++ })
      }
    }
  }

  ;(window as any).__stage = { ready: true, duration: DURATION, renderAt }
  renderAt(0)
}

function renderAt(t: number) {
  const p = clamp01(t / DURATION)
  const dolly = ease(clamp01(t / (DURATION * 0.9)))
  camera.position.set(-90 + 180 * dolly, 60 - 60 * dolly, 1850 - 520 * dolly)
  camera.lookAt(0, 0, 0)

  stage.rotation.y = -0.17 + 0.26 * ease(p)
  stage.rotation.x = 0.02 - 0.05 * p
  stage.position.y = -30 + 20 * p

  for (const e of entries) {
    const mat = e.mesh.material as THREE.MeshBasicMaterial
    const lift = e.cardOrder >= 0 ? ease(clamp01((t - 0.15 - e.cardOrder * 0.07) / 0.85)) * 165 : 0
    if (e.role === 'card') {
      const st = ease(clamp01((t - 0.15 - e.order * 0.07) / 0.85))
      e.mesh.position.set(e.bx, e.by, e.baseZ + lift)
      mat.opacity = 0.12 + 0.88 * st
    } else if (e.role === 'icon') {
      const st = ease(clamp01((t - 1.0 - e.order * 0.06) / 0.7))
      e.mesh.position.set(e.bx, e.by + st * 14, e.baseZ + lift)
      mat.opacity = 0.35 + 0.65 * st
    } else {
      const st = ease(clamp01((t - 0.05) / 0.6))
      e.mesh.position.set(e.bx, e.by, e.baseZ + lift)
      mat.opacity = st
    }
  }

  for (const g of glyphs) {
    const st = clamp01((t - 0.55 - g.order * 0.028) / 0.22)
    const s = Math.max(0.001, ease(st))
    g.mesh.scale.x = s
    g.mesh.position.x = g.left - (g.width * (1 - s)) / 2
    ;(g.mesh.material as THREE.MeshBasicMaterial).opacity = st > 0 ? 1 : 0
  }

  renderer.render(scene, camera)
}

init().catch((err) => {
  ;(window as any).__stage = { ready: false, error: String(err) }
  console.error(err)
})
