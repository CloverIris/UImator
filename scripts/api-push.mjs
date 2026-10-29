#!/usr/bin/env node
/**
 * 当 github.com:443 不可达、但 api.github.com 可用时的推送兜底。
 * 用 REST API 重建提交树并快进 ref，不依赖 git 的 smart HTTP 协议。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const OWNER = 'CloverIris'
const REPO = 'UImator'
const BRANCH = 'main'

const token =
  process.env.GH_TOKEN ||
  execFileSync('bash', ['-lc', 'printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill | sed -n "s/^password=//p"'])
    .toString()
    .trim()

async function api(method, p, body) {
  const res = await fetch(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'uimator',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
const parentSha = ref.object.sha
const parent = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`)
console.log('remote head', parentSha.slice(0, 7), (parent.message || '').split('\n')[0])

const files = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)
console.log('files to upload', files.length)

const uploaded = []
for (const f of files) {
  const content = fs.readFileSync(f).toString('base64')
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content, encoding: 'base64' })
  uploaded.push({ path: f, sha: blob.sha })
}

function buildTree(entries) {
  const files = entries.filter((e) => !e.path.includes('/'))
  const dirs = new Map()
  for (const e of entries) {
    const i = e.path.indexOf('/')
    if (i < 0) continue
    const dir = e.path.slice(0, i)
    if (!dirs.has(dir)) dirs.set(dir, [])
    dirs.get(dir).push({ path: e.path.slice(i + 1), sha: e.sha })
  }
  return { files, dirs }
}

async function makeTree(entries) {
  const { files, dirs } = buildTree(entries)
  const tree = files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha }))
  for (const [dir, sub] of dirs) {
    const subTree = await makeTree(sub)
    tree.push({ path: dir, mode: '040000', type: 'tree', sha: subTree.sha })
  }
  const res = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree })
  return res
}

const tree = await makeTree(uploaded)
const message = execFileSync('git', ['log', '-1', '--pretty=%B']).toString().trim()
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message,
  tree: tree.sha,
  parents: [parentSha],
})
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })
console.log('pushed', commit.sha.slice(0, 7), 'tree', tree.sha.slice(0, 7))
