import fs from 'node:fs'
import path from 'node:path'

/**
 * UI 结构树（UINode）。
 *
 * 这是 UImator 的真正资产：一棵带语义、几何、样式、文本与可动画属性的树。
 * 位图只是每个节点的「渲染载荷」——它让树可以被 3D 舞台精确重建，
 * 而树本身让动画可以按语义寻址（role / text / path），而不是按截图坐标。
 */

export type Role = 'card' | 'button' | 'heading' | 'text' | 'icon' | 'image' | 'input' | 'chart' | 'group'

export type Box = { x: number; y: number; w: number; h: number }

export type Glyph = { c: string; x: number; y: number; w: number; h: number }

export type UINode = {
  id: string
  role: Role
  tag: string
  /** 相对父节点的框（CSS px） */
  box: Box
  /** 绝对框（文档坐标），用于验证与回贴 */
  abs: Box
  path: string
  depth: number
  text?: { value: string; glyphs: Glyph[] }
  style: {
    radius: number
    background: string
    color: string
    fontSize: string
    fontWeight: string
    border: string
    shadow: string
  }
  animatable: string[]
  render?: { file: string; dpr: number; alphaPct: number }
  children: UINode[]
}

export type FlatNode = Omit<UINode, 'children'> & { parent: number }

const ROLE_ANIMATABLE: Record<Role, string[]> = {
  heading: ['opacity', 'translate', 'scale', 'textReveal', 'maskReveal'],
  text: ['opacity', 'translate', 'textReveal', 'maskReveal'],
  button: ['opacity', 'translate', 'translateZ', 'scale', 'hoverState'],
  card: ['translateZ', 'rotate', 'opacity', 'scale'],
  icon: ['translate', 'rotate', 'scale', 'opacity'],
  image: ['opacity', 'scale', 'maskReveal'],
  input: ['opacity', 'translate', 'textReveal'],
  chart: ['opacity', 'scale', 'maskReveal'],
  group: ['opacity', 'translateZ'],
}

/** 隔离目标子树：祖先背景透明、兄弟节点隐藏。这样截图才会带真正的 alpha。 */
export function isolateExpr(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    let node = el, hidden = 0, cleared = 0;
    while (node && node !== document.documentElement) {
      const parent = node.parentElement;
      if (parent) {
        for (const sib of parent.children) {
          if (sib !== node && getComputedStyle(sib).visibility !== 'hidden') {
            sib.style.visibility = 'hidden'; hidden++;
          }
        }
      }
      if (node !== el) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          node.style.backgroundColor = 'transparent'; cleared++;
        }
      }
      node = parent;
    }
    document.documentElement.style.backgroundColor = 'transparent';
    if (document.body) document.body.style.backgroundColor = 'transparent';
    return { hidden, cleared };
  })()`
}

/** 剥离阴影与过渡：阴影要由 3D 重新打光，否则「贴纸感」无法消除。 */
export const STRIP_STYLE = `(() => {
  if (document.getElementById('__uimator_tree_style')) return true;
  const st = document.createElement('style');
  st.id = '__uimator_tree_style';
  st.textContent = '*,*::before,*::after{box-shadow:none!important;transition:none!important;animation-play-state:paused!important;caret-color:transparent!important;scroll-behavior:auto!important}';
  document.documentElement.appendChild(st);
  return true;
})()`

/** 选出「有独立绘制内容」的节点，并计算语义角色、文本、样式、字形矩形。 */
export function selectExpr(selector: string, maxNodes = 40, maxDepth = 4): string {
  return `(() => {
    const ROOT = document.querySelector(${JSON.stringify(selector)});
    if (!ROOT) return null;
    const MAX = ${maxNodes}, MAXDEPTH = ${maxDepth};
    const rootRect = ROOT.getBoundingClientRect();

    function roleOf(el) {
      const tag = el.tagName.toLowerCase();
      const cs = getComputedStyle(el);
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
      if (['input','textarea','select'].includes(tag)) return 'input';
      if (['img','picture','video'].includes(tag)) return 'image';
      if (tag === 'svg') return 'icon';
      if (tag === 'canvas') return 'chart';
      if (['p','li','span','strong','em','label','a'].includes(tag)) return 'text';
      const r = parseFloat(cs.borderTopLeftRadius) || 0;
      if (r > 4 && (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none')) return 'card';
      return 'group';
    }

    function ownPaint(el, cs) {
      return cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        || cs.backgroundImage !== 'none'
        || cs.borderTopWidth !== '0px'
        || parseFloat(cs.borderTopLeftRadius) > 2;
    }

    function glyphsOf(el) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      if (!node || !node.data.trim()) return null;
      const out = [];
      const limit = Math.min(node.length, 80);
      for (let i = 0; i < limit; i++) {
        if (!node.data[i].trim()) continue;
        const r = document.createRange();
        r.setStart(node, i); r.setEnd(node, i + 1);
        const b = r.getBoundingClientRect();
        if (!b.width) continue;
        out.push({ c: node.data[i], x: Math.round(b.x - rootRect.x), y: Math.round(b.y - rootRect.y), w: +b.width.toFixed(1), h: +b.height.toFixed(1) });
      }
      return out.length ? out : null;
    }

    const picked = [];
    const all = [ROOT, ...ROOT.querySelectorAll('*')];
    for (const el of all) {
      if (picked.length >= MAX) break;
      if (el.hasAttribute('data-uimator')) continue;
      const tag = el.tagName.toLowerCase();
      if (['script','style','link','meta','noscript','br','path','g','defs','use','circle','rect','line','tspan'].includes(tag)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.width * r.height < 200) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;

      const role = roleOf(el);
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      const isTextLeaf = role === 'text' || role === 'heading';
      const paint = ownPaint(el, cs);

      if (!paint && !isTextLeaf && role === 'group') {
        // 无绘制的纯容器：只在它含有多个子块时才保留（作为分组）
        if (el.children.length < 2) continue;
      }

      let depth = 0, n = el;
      while (n && n !== ROOT) { depth++; n = n.parentElement; }
      if (depth > MAXDEPTH) continue;

      picked.push({
        el, role, tag, depth,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        text: isTextLeaf && text ? { value: text.slice(0, 160), glyphs: glyphsOf(el) || [] } : undefined,
        style: {
          radius: parseFloat(cs.borderTopLeftRadius) || 0,
          background: cs.backgroundColor,
          color: cs.color,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          border: cs.borderTopWidth !== '0px' ? cs.borderTopWidth + ' ' + cs.borderTopColor : '',
          shadow: 'stripped'
        }
      });
    }

    // 建立父子关系：父节点 = 最近的一个已选中祖先
    const depthKey = picked.map((p) => p.depth);
    const flattened = [];
    picked.forEach((p, i) => {
      let parent = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (picked[j].el.contains(p.el) && picked[j].el !== p.el) { parent = j; break; }
      }
      flattened.push({
        parent,
        role: p.role,
        tag: p.tag,
        depth: p.depth,
        text: p.text,
        style: p.style,
        abs: { x: Math.round(p.rect.x), y: Math.round(p.rect.y), w: Math.round(p.rect.w), h: Math.round(p.rect.h) },
        path: p.el.tagName.toLowerCase() + (p.el.className && typeof p.el.className === 'string' ? '.' + p.el.className.trim().split(/\\s+/)[0] : ''),
        _el: i
      });
    });

    // 只保留元素引用与索引，几何在截图时重新测量（避免 stale）
    window.__uimatorTreeEls = picked.map((p) => p.el);
    window.__uimatorTreeRoot = ROOT;
    return { count: flattened.length, root: { x: Math.round(rootRect.x), y: Math.round(rootRect.y), w: Math.round(rootRect.width), h: Math.round(rootRect.height) }, nodes: flattened.map(({ _el, ...rest }) => rest) };
  })()`
}

export const HIDE_DESC_EXPR = (index: number): string => `(() => {
  const els = window.__uimatorTreeEls || [];
  const root = window.__uimatorTreeRoot;
  // 复位必须覆盖整棵子树：被隐藏的可能是「没被选中」的包裹层，
  // 只复位选中节点会让它们的后代因为 visibility 继承而一直不可见。
  if (root) root.querySelectorAll('*').forEach((c) => { c.style.visibility = ''; });
  const el = els[${index}];
  if (!el) return null;
  el.querySelectorAll('*').forEach((c) => { c.style.visibility = 'hidden'; });
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
})()`

export const MEASURE_NODE_EXPR = (index: number): string => `(() => {
  const el = (window.__uimatorTreeEls || [])[${index}];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
})()`

export const CLEAR_VIS_EXPR = `(() => {
  const root = window.__uimatorTreeRoot;
  if (root) root.querySelectorAll('*').forEach((c) => { c.style.visibility = ''; });
  return true;
})()`

/** 把扁平结果装配成树，并把绝对框换算成相对父节点的框。 */
export function buildTree(flat: any[], rootAbs: Box): UINode[] {
  const nodes: UINode[] = flat.map((n, i) => ({
    id: `n${i}-${n.role}`,
    role: n.role,
    tag: n.tag,
    box: { x: 0, y: 0, w: 0, h: 0 },
    abs: n.abs,
    path: n.path,
    depth: n.depth,
    text: n.text,
    style: n.style,
    animatable: ROLE_ANIMATABLE[n.role as Role] ?? [],
    render: n.render,
    children: [],
  }))

  const roots: UINode[] = []
  flat.forEach((n, i) => {
    const parentAbs = n.parent >= 0 ? flat[n.parent].abs : rootAbs
    nodes[i].box = {
      x: n.abs.x - parentAbs.x,
      y: n.abs.y - parentAbs.y,
      w: n.abs.w,
      h: n.abs.h,
    }
    if (n.parent >= 0) nodes[n.parent].children.push(nodes[i])
    else roots.push(nodes[i])
  })
  return roots
}

export function writeTree(outFile: string, data: unknown) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2))
}
