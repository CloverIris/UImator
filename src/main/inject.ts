/**
 * 注入到页面里的脚本源码。
 *
 * - FREEZE_SRC  跑在 main world（必须的：只有改真实 window 才能真的冻结页面）
 * - PICKER_SRC  跑在 isolated world（页面脚本看不见我们的变量）
 *
 * 两者都通过 CDP 注入，因此不受页面 CSP 限制。
 */

export const PICK = '__UIMATOR_PICK__'

/** 冻结 / 解冻。返回一段表达式，执行后得到 { ok, frozen, stats }。 */
export const FREEZE_SRC = String.raw`
(function () {
  if (window.__uimator) return { ok: true, reused: true };

  var st = {
    frozen: false,
    originals: {},
    rafQueue: [],
    frozenAt: 0,
    frozenPerf: 0,
    stats: {}
  };
  window.__uimator = st;

  st.freeze = function (phase) {
    if (st.frozen) return st.summary();
    var RealDate = window.Date;
    var RealPerf = window.performance.now.bind(window.performance);

    st.originals.Date = RealDate;
    st.originals.raf = window.requestAnimationFrame;
    st.originals.caf = window.cancelAnimationFrame;
    st.originals.setTimeout = window.setTimeout;
    st.originals.setInterval = window.setInterval;
    st.originals.perfNow = RealPerf;
    st.originals.getAnimations = document.getAnimations;

    st.frozenAt = RealDate.now();
    st.frozenPerf = RealPerf();
    var t = st.frozenAt;

    function FakeDate(a, b, c, d, e, f, g) {
      var n = arguments.length;
      if (!(this instanceof FakeDate)) return new RealDate(t).toString();
      if (n === 0) return new RealDate(t);
      if (n === 1) return new RealDate(a);
      return new RealDate(a, b, c === undefined ? 1 : c, d || 0, e || 0, f || 0, g || 0);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return t; };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;

    try {
      Object.defineProperty(window.performance, 'now', {
        configurable: true,
        value: function () { return st.frozenPerf; }
      });
    } catch (err) {}

    window.requestAnimationFrame = function (cb) { st.rafQueue.push(cb); return st.rafQueue.length; };
    window.cancelAnimationFrame = function () {};
    window.setTimeout = function () { return 0; };
    window.setInterval = function () { return 0; };

    var paused = 0, seeked = 0;
    var anims = [];
    try { anims = RealDate === undefined ? [] : st.originals.getAnimations.call(document); } catch (err) {}
    for (var i = 0; i < anims.length; i++) {
      var a = anims[i];
      try {
        a.pause();
        paused++;
        if (typeof phase === 'number' && a.effect && a.effect.getComputedTiming) {
          var ct = a.effect.getComputedTiming();
          if (ct && isFinite(ct.duration) && ct.duration > 0) {
            a.currentTime = ct.duration * phase;
            seeked++;
          }
        }
      } catch (err) {}
    }
    st.animations = anims;

    var style = document.createElement('style');
    style.id = '__uimator_freeze';
    style.textContent =
      '*,*::before,*::after{transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' +
      'html{scroll-behavior:auto!important}';
    document.documentElement.appendChild(style);

    var videos = document.querySelectorAll('video');
    for (var v = 0; v < videos.length; v++) {
      try { videos[v].pause(); } catch (err) {}
    }

    st.frozen = true;
    st.stats = {
      animations: paused,
      seeked: seeked,
      videos: videos.length,
      rafQueued: 0,
      nodes: document.getElementsByTagName('*').length
    };
    return st.summary();
  };

  st.unfreeze = function () {
    if (!st.frozen) return st.summary();
    try {
      window.Date = st.originals.Date;
      window.requestAnimationFrame = st.originals.raf;
      window.cancelAnimationFrame = st.originals.caf;
      window.setTimeout = st.originals.setTimeout;
      window.setInterval = st.originals.setInterval;
      Object.defineProperty(window.performance, 'now', {
        configurable: true,
        value: st.originals.perfNow
      });
    } catch (err) {}
    var style = document.getElementById('__uimator_freeze');
    if (style) style.remove();
    for (var i = 0; i < st.animations.length; i++) {
      try { st.animations[i].play(); } catch (err) {}
    }
    st.animations = [];
    for (var q = 0; q < st.rafQueue.length; q++) {
      try { st.originals.raf(st.rafQueue[q]); } catch (err) {}
    }
    st.rafQueue = [];
    st.frozen = false;
    return st.summary();
  };

  st.summary = function () {
    return {
      ok: true,
      frozen: st.frozen,
      frozenAt: st.frozenAt,
      stats: st.stats
    };
  };

  return st.summary();
})()
`

/** 拾取器：悬停高亮 + 点击回传。返回 'armed'，点击后通过 console 发送 payload。 */
export const PICKER_SRC = String.raw`
(function () {
  if (window.__picker && window.__picker.stop) { window.__picker.stop(); }

  var NS = '__UIMATOR_PICK__';
  var box = document.createElement('div');
  box.setAttribute('data-uimator', 'pick-box');
  box.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'display:none',
    'border:2px solid #38bdf8', 'background:rgba(56,189,248,0.10)',
    'box-shadow:0 0 0 9999px rgba(3,7,18,0.45), 0 0 24px rgba(56,189,248,0.55)',
    'border-radius:4px', 'transition:none'
  ].join(';');

  var label = document.createElement('div');
  label.setAttribute('data-uimator', 'pick-label');
  label.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'pointer-events:none', 'display:none',
    'font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#e6f7ff', 'background:#0284c7', 'padding:2px 6px', 'border-radius:4px',
    'white-space:nowrap', 'max-width:70vw', 'overflow:hidden', 'text-overflow:ellipsis'
  ].join(';');

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function pathOf(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift('#' + node.id);
        break;
      }
      var tag = node.tagName.toLowerCase();
      var idx = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) idx++;
      }
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function depthOf(el) {
    var d = 0;
    while (el && el.parentElement) { d++; el = el.parentElement; }
    return d;
  }

  function look(el) {
    var cs = getComputedStyle(el);
    var createsStacking = false;
    try {
      createsStacking =
        cs.transform !== 'none' || cs.filter !== 'none' ||
        cs.perspective !== 'none' || cs.isolation === 'isolate' ||
        parseFloat(cs.opacity) < 1 || cs.willChange.indexOf('transform') >= 0;
    } catch (e) {}
    return cs, createsStacking;
  }

  var current = null;

  function describe(el) {
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var stacking = false;
    try {
      stacking =
        cs.transform !== 'none' || cs.filter !== 'none' ||
        cs.perspective !== 'none' || cs.isolation === 'isolate' ||
        parseFloat(cs.opacity) < 1;
    } catch (e) {}

    var text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160);

    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : null,
      role: el.getAttribute('role'),
      selector: pathOf(el),
      viewportRect: { x: r.left, y: r.top, width: r.width, height: r.height },
      documentRect: {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height
      },
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      shadow: cs.boxShadow === 'none' ? null : cs.boxShadow.slice(0, 160),
      shadowBlur: (function () {
        var m = /rgba?\([^)]*\)\s+(-?\d+)px\s+(-?\d+)px\s+(\d+)px/.exec(cs.boxShadow);
        return m ? parseFloat(m[3]) : 0;
      })(),
      position: cs.position,
      zIndex: cs.zIndex,
      backdrop: cs.backdropFilter !== 'none' ? cs.backdropFilter : null,
      overflow: cs.overflow,
      stackingContext: stacking,
      domDepth: depthOf(el),
      childCount: el.getElementsByTagName('*').length,
      hasCanvas: !!el.querySelector('canvas'),
      hasImage: !!el.querySelector('img'),
      hasSvg: !!el.querySelector('svg'),
      area: Math.round(r.width * r.height),
      textDigest: hash(text),
      textPreview: text.slice(0, 80),
      pageSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }
    };
  }

  function onMove(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label || el.hasAttribute('data-uimator')) return;
    current = el;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';

    label.style.display = 'block';
    label.textContent =
      el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    var top = r.top - 22;
    label.style.left = Math.max(4, r.left) + 'px';
    label.style.top = (top < 4 ? r.bottom + 4 : top) + 'px';
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = current || e.target;
    if (!el || el.hasAttribute('data-uimator')) return;
    var payload = describe(el);
    console.log(NS + JSON.stringify(payload));
    stop();
  }

  function onKey(e) {
    if (e.key === 'Escape') stop();
  }

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', function (e) { e.stopPropagation(); }, true);
  window.addEventListener('keydown', onKey, true);

  function stop() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    box.remove();
    label.remove();
    window.__picker = null;
  }

  document.documentElement.appendChild(box);
  document.documentElement.appendChild(label);
  window.__picker = { stop: stop };

  return 'armed';
})()
`

/**
 * 在页面里重新测量一个选择器的位置（设完 DPR 之后必须重测）。
 *
 * 注意：只用 getBoundingClientRect 会**裁掉溢出子元素**（比如定位在卡片外的徽标）
 * 和超出边界的阴影。所以这里取「元素 + 可见后代」的并集，并记录元素在纹理里的偏移。
 */
export function measureExpr(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs0 = getComputedStyle(el);

    let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;

    for (const d of el.querySelectorAll('*')) {
      if (d.hasAttribute('data-uimator')) continue;
      const cs = getComputedStyle(d);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
      const q = d.getBoundingClientRect();
      if (q.width === 0 && q.height === 0) continue;
      // 过滤掉失控的子元素（巨大的绝对定位层、全屏遮罩）
      if (q.width * q.height > 8 * Math.max(1, r.width * r.height)) continue;
      x1 = Math.min(x1, q.left); y1 = Math.min(y1, q.top);
      x2 = Math.max(x2, q.right); y2 = Math.max(y2, q.bottom);
    }

    // 伪元素（::before/::after）的视觉溢出无法通过 DOM 矩形拿到，
    // 所以统一向外留一圈安全边，同时容纳 box-shadow。
    const PAD = 16;
    const sx = window.scrollX, sy = window.scrollY;
    const left = Math.max(0, x1 + sx - PAD);
    const top = Math.max(0, y1 + sy - PAD);
    const right = Math.min(document.documentElement.scrollWidth, x2 + sx + PAD);
    const bottom = Math.min(document.documentElement.scrollHeight, y2 + sy + PAD);

    return {
      x: left, y: top, width: right - left, height: bottom - top,
      elX: r.left + sx, elY: r.top + sy, elW: r.width, elH: r.height,
      offsetX: (r.left + sx) - left, offsetY: (r.top + sy) - top,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      opacity: cs0.opacity,
      visibility: cs0.visibility,
      scrollX: sx, scrollY: sy,
      // 视口坐标（CDP 的 Input 事件用的是视口坐标系）
      centerX: r.left + r.width / 2,
      centerY: r.top + r.height / 2
    };
  })()`
}

/**
 * 自动拆解：遍历 DOM，按「像不像一个独立 UI 单元」打分，去重、分类，返回候选。
 *
 * 注意这是**候选生成**，不是理解。目标是给用户一个可筛选的池子，
 * 而不是替用户决定。所以每一项都带 reasons，让人能判断它为什么被选中。
 */
export const SCAN_SRC = String.raw`
(function () {
  const vw = window.innerWidth, vh = window.innerHeight;
  const vArea = Math.max(1, vw * vh);
  const SKIP = new Set(['script','style','link','meta','noscript','br','hr','template','path','g','defs','use','circle','rect','line','text','tspan','img','svg','source']);
  const SKIP_TEXT = /(cookie|consent|gdpr|newsletter|subscribe|advert|sponsor|promotion)/i;
  const EMPTY_TEXT = /(暂无|没有数据|暂无数据|no data|nothing here|empty state)/i;

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  function pathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift('#' + node.id); break; }
      const tag = node.tagName.toLowerCase();
      let idx = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) idx++;
      parts.unshift(tag + ':nth-of-type(' + idx + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  const candidates = [];
  let scanned = 0;

  for (const el of document.querySelectorAll('body *')) {
    if (++scanned > 5000) break;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    if (el.hasAttribute('data-uimator')) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 26) continue;
    if (r.bottom < -80 || r.top > vh + 4000) continue;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;

    const areaRatio = (r.width * r.height) / vArea;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const hasMedia = !!el.querySelector('img,canvas,video,picture') || tag === 'img';
    const hasSvg = !!el.querySelector('svg');
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    const shadow = cs.boxShadow !== 'none';
    const bg = cs.backgroundColor;
    const hasBg = !!bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const glass = !!cs.backdropFilter && cs.backdropFilter !== 'none';
    const hasBorder = cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px';
    const floating = cs.position === 'fixed' || cs.position === 'sticky';

    let score = 0;
    const why = [];
    if (radius > 2) { score += 8; why.push('圆角'); }
    if (shadow) { score += 10; why.push('阴影'); }
    if (glass) { score += 8; why.push('毛玻璃'); }
    if (hasBorder) { score += 4; why.push('边框'); }
    if (hasBg) { score += 10; why.push('背景'); }
    if (text.length > 4) { score += 6; why.push('文本'); }
    if (hasMedia) { score += 10; why.push('媒体'); }
    if (hasSvg) { score += 5; }
    if (['header','nav','aside','main','section','article','table','dialog','figure','footer'].includes(tag)) { score += 14; why.push('语义'); }
    if (el.getAttribute('role')) { score += 6; }
    if (floating) { score += 8; why.push('悬浮'); }
    if (areaRatio > 0.02 && areaRatio < 0.6) score += 6;
    const ar = r.width / r.height;
    if (ar > 0.3 && ar < 3.6) score += 4;
    if (text.length > 60) score += 4;

    const blob = (text.slice(0, 120) + ' ' + String(el.className || '') + ' ' + (el.id || ''));
    if (SKIP_TEXT.test(blob) && areaRatio < 0.5) { score -= 60; why.push('可疑横幅'); }
    if (EMPTY_TEXT.test(text) && !hasMedia) { score -= 25; why.push('空状态'); }
    if (areaRatio > 0.9) { score -= 15; why.push('全屏'); }
    if (!text && !hasMedia && el.children.length === 0) score -= 20;

    let cls = 'block';
    if (tag === 'nav' || tag === 'header') cls = 'nav';
    else if (tag === 'footer') cls = 'footer';
    else if (tag === 'aside' || (floating && r.width < 340 && r.height > vh * 0.55)) cls = 'sidebar';
    else if (tag === 'dialog' || el.getAttribute('role') === 'dialog') cls = 'modal';
    else if (el.querySelector('canvas')) cls = 'chart';
    else if (tag === 'table' || el.querySelector('table')) cls = 'table';
    else if (floating && r.height < 150 && r.width > vw * 0.5) cls = 'banner';
    else if (radius > 6 && (shadow || hasBg)) cls = 'card';
    else if (areaRatio > 0.3) cls = 'section';

    candidates.push({
      tag, cls, score, why: why.slice(0, 4),
      x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
      w: Math.round(r.width), h: Math.round(r.height),
      text: text.slice(0, 90),
      key: tag + '|' + Math.round(r.width / 12) + '|' + Math.round(r.height / 12) + '|' +
           Array.from(el.children).slice(0, 4).map(c => c.tagName).join(','),
      hasMedia, selector: pathOf(el)
    });
  }

  // 同构去重：保留分高者
  const byKey = new Map();
  for (const c of candidates) {
    const cur = byKey.get(c.key);
    if (!cur || c.score > cur.score) byKey.set(c.key, c);
  }
  let list = Array.from(byKey.values()).sort((a, b) => b.score - a.score);

  // 包含抑制：被更高分候选包住且差距明显的，丢掉
  const kept = [];
  for (const c of list) {
    let suppressed = false;
    for (const k of kept) {
      const ix = Math.max(0, Math.min(c.x + c.w, k.x + k.w) - Math.max(c.x, k.x));
      const iy = Math.max(0, Math.min(c.y + c.h, k.y + k.h) - Math.max(c.y, k.y));
      const inter = ix * iy;
      const minArea = Math.min(c.w * c.h, k.w * k.h);
      if (minArea > 0 && inter / minArea > 0.92 && k.score - c.score > 10) { suppressed = true; break; }
    }
    if (!suppressed) kept.push(c);
    if (kept.length >= 36) break;
  }

  list = kept;
  list.forEach((c, i) => { c.i = i; });

  return {
    viewport: { w: vw, h: vh, scrollX, scrollY },
    scanned,
    total: candidates.length,
    candidates: list
  };
})()
`

/** 在页面里闪一下某个元素，用于面板点选后的视觉确认。 */
export function highlightExpr(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const d = document.createElement('div');
    d.setAttribute('data-uimator', 'highlight');
    d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:' + r.left +
      'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height +
      'px;border:2px solid #38bdf8;border-radius:4px;box-shadow:0 0 0 9999px rgba(3,7,18,.45)' +
      ';animation:__uimator_fade 1.1s ease-out forwards';
    if (!document.getElementById('__uimator_hl_style')) {
      const st = document.createElement('style');
      st.id = '__uimator_hl_style';
      st.textContent = '@keyframes __uimator_fade{0%{opacity:1}75%{opacity:1}100%{opacity:0}}';
      document.documentElement.appendChild(st);
    }
    document.documentElement.appendChild(d);
    d.addEventListener('animationend', () => d.remove());
    return true;
  })()`
}
