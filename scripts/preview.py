#!/usr/bin/env python3
"""
CPU 预览合成器（不是产品渲染器）。

目的只有一个：在没有 WebGL 的环境里，验证舞台的构图与节奏是否成立。
做法：把每个节点当作一个带贴图的平面，按与 three.js 相同的相机/舞台变换
投影成四边形，再用单应变换把贴图 warp 上去，按深度从远到近叠加。

它没有景深、辉光、运动模糊——那些必须靠真正的 WebGL 管线。
"""
import json
import math
import sys
import numpy as np
from PIL import Image

W, H = 1280, 720
FOV = 32.0
DURATION = 3.2

tree = json.load(open('projects/tree.json'))
root = tree['root']
cx0, cy0 = root['w'] / 2, root['h'] / 2


def ease(t):
    return 2 * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 2 / 2


def clamp01(v):
    return max(0.0, min(1.0, v))


def flatten(n):
    yield n
    for c in n['children']:
        yield from flatten(c)


parents = {}
def walk(n, parent=None):
    parents[id(n)] = parent
    for c in n['children']:
        walk(c, n)
for r in tree['nodes']:
    walk(r)
nodes = [n for n in flatten({'children': tree['nodes'], 'role': 'root', 'render': None}) if n.get('render')]


def make_z(t):
    """层级式 z：子节点永远在父节点前方一点点，并继承父节点的位移。

    用「绝对深度 × 间距」是错的——那会让子节点被推到父层背后，
    卡片浮起来时文字和图标就留在原地被挡住。
    """
    memo = {}

    def z_of(n):
        key = id(n)
        if key in memo:
            return memo[key]
        p = parents.get(key)
        base = z_of(p) if p is not None else 0.0
        role = n['role']
        if role == 'card':
            st = ease(clamp01((t - 0.15 - card_seq.get(key, 0) * 0.07) / 0.85))
            local = st * 165
        elif role == 'icon':
            local = 8.0
        elif role in ('heading', 'text'):
            local = 2.0
        else:
            local = 0.5
        memo[key] = base + local
        return memo[key]

    return z_of

# 角色顺序：卡片按文档顺序编号
card_seq = {}
seq = 0
for n in nodes:
    if n['role'] == 'card':
        card_seq[id(n)] = seq
        seq += 1


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


def rot_x(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c)


def homography(src, dst):
    A, b = [], []
    for (u, v), (x, y) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    h = np.linalg.solve(np.array(A, dtype=float), np.array(b, dtype=float))
    return np.append(h, 1).reshape(3, 3)


def render(t):
    p = clamp01(t / DURATION)
    dolly = ease(clamp01(t / (DURATION * 0.9)))
    cam = np.array([-90 + 180 * dolly, 60 - 60 * dolly, 1850 - 520 * dolly])
    target = np.zeros(3)
    fwd = target - cam
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, np.array([0, 1.0, 0]))
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)

    ry = -0.17 + 0.26 * ease(p)
    rx = 0.02 - 0.05 * p
    sy = -30 + 20 * p

    z_of = make_z(t)
    canvas = Image.new('RGBA', (W, H), (6, 7, 11, 255))
    quads = []

    for n in nodes:
        z = z_of(n)
        # abs 是文档坐标，必须减去树根原点，否则整棵树会飞出画面
        bx = (n['abs']['x'] - root['x']) + n['abs']['w'] / 2 - cx0
        by = -((n['abs']['y'] - root['y']) + n['abs']['h'] / 2 - cy0)
        opacity = 1.0

        if n['role'] == 'card':
            st = ease(clamp01((t - 0.15 - card_seq.get(id(n), 0) * 0.07) / 0.85))
            opacity = 0.12 + 0.88 * st
        elif n['role'] == 'icon':
            st = ease(clamp01((t - 1.0) / 0.7))
            by += st * 14
            opacity = 0.35 + 0.65 * st
        else:
            st = ease(clamp01((t - 0.05) / 0.6))
            opacity = st

        hw, hh = n['abs']['w'] / 2, n['abs']['h'] / 2
        corners = []
        for sx, cy_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            q = (bx + sx * hw, by + cy_ * hh * -1, z)
            q = rot_y(q, ry)
            q = rot_x(q, rx)
            q = (q[0], q[1] + sy, q[2])
            rel = np.array(q) - cam
            zc = float(np.dot(rel, fwd))
            if zc <= 40:
                corners = None
                break
            focal = 1.0 / math.tan(math.radians(FOV) / 2)
            nx = float(np.dot(rel, right)) / zc * focal / (W / H)
            ny = float(np.dot(rel, up)) / zc * focal
            corners.append(((nx * 0.5 + 0.5) * W, (1 - (ny * 0.5 + 0.5)) * H))
        if not corners:
            continue
        quads.append((zc, n, corners, opacity))

    quads.sort(key=lambda q: -q[0])
    for zc, n, corners, opacity in quads:
        try:
            im = Image.open(n['render']['file']).convert('RGBA')
        except Exception:
            continue
        sw, sh = im.size
        src = [(0, 0), (sw, 0), (sw, sh), (0, sh)]
        try:
            # homography(a, b) 解出的是 b → a；PIL 需要「屏幕像素 → 贴图像素」
            hm = homography(src, corners)
        except Exception:
            continue
        hm = hm / hm[2, 2]
        coeffs = (hm[0, 0], hm[0, 1], hm[0, 2], hm[1, 0], hm[1, 1], hm[1, 2], hm[2, 0], hm[2, 1])
        layer = im.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
        if opacity < 0.999:
            a = np.array(layer)
            a[..., 3] = (a[..., 3].astype(np.float32) * opacity).astype(np.uint8)
            layer = Image.fromarray(a)
        canvas.alpha_composite(layer)

    return canvas.convert('RGB')


if __name__ == '__main__':
    times = [float(x) for x in sys.argv[1:]] or [0.6, 1.4, 2.2, 3.0]
    for t in times:
        img = render(t)
        out = f'captures/preview-t{t:.1f}.png'
        img.save(out)
        print(out)
