#!/usr/bin/env node
/**
 * 启动器。
 *
 * 做两件事，都是为了「同一套命令在不同机器上行为一致」：
 *  1. 清掉 ELECTRON_RUN_AS_NODE（有些终端/IDE 会带上，导致 Electron 变成 node 进程）
 *  2. 沙箱环境（CI、受限容器）里 Chromium 的 seatbelt 起不来，用 UIMATOR_SANDBOX=0 切到无沙箱 + 软渲染
 */
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const modeArgs = process.argv.slice(2)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const sandboxed = process.env.UIMATOR_SANDBOX !== '0'
const flags = sandboxed
  ? []
  : [
      '--no-sandbox',
      // 软件 WebGL：沙箱环境里 GPU 进程起不来，SwiftShader 是唯一能跑 three.js 的路
      // 受限环境里 GPU 进程起不来；WebGL 舞台在这种环境下无法渲染，
      // 正常情况下（用户自己的机器）不需要这些 flag
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${process.cwd()}/.userdata`,
    ]

const child = spawn(electronPath, ['.', ...modeArgs, ...flags], {
  stdio: 'inherit',
  env,
})

child.on('close', (code) => process.exit(code ?? 0))
