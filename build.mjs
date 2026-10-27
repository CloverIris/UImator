import * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'

const out = 'dist'
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"development"' },
}

// main —— CJS，external electron
await esbuild.build({
  ...common,
  entryPoints: { 'main/index': 'src/main/index.ts' },
  outdir: out,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
})

// preload —— CJS
await esbuild.build({
  ...common,
  entryPoints: { 'preload/index': 'src/preload/index.ts' },
  outdir: out,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  outExtension: { '.js': '.cjs' },
})

// renderer —— IIFE
await esbuild.build({
  ...common,
  entryPoints: { 'renderer/main': 'src/renderer/main.ts' },
  outdir: out,
  format: 'iife',
  target: 'chrome120',
})

// stage —— three.js 舞台，IIFE
await esbuild.build({
  ...common,
  entryPoints: { 'stage/stage': 'src/stage/stage.ts' },
  outdir: out,
  format: 'iife',
  target: 'chrome120',
})

fs.copyFileSync('src/renderer/index.html', path.join(out, 'renderer/index.html'))
fs.copyFileSync('src/stage/index.html', path.join(out, 'stage/index.html'))
fs.copyFileSync('src/renderer/style.css', path.join(out, 'renderer/style.css'))
fs.cpSync('fixtures', path.join(out, 'fixtures'), { recursive: true })

console.log('build ok →', out)
