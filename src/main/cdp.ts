import type { WebContents, Debugger } from 'electron'

export type ConsolePayload = unknown

/**
 * CDP 的最小封装。
 *
 * 之所以不用 Electron 的 console-message / capturePage：
 *  - console-message 的参数签名在 37 前后变过
 *  - capturePage 是窗口级的，拿不到「按文档坐标裁剪 + 指定 DPR」的能力
 */
export class Cdp {
  private attached = false
  private listeners: Array<(method: string, params: any) => void> = []

  constructor(private wc: WebContents) {}

  attach(): void {
    if (this.attached) return
    const dbg = this.wc.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    this.attached = true
    dbg.on('message', (_event: Electron.Event, method: string, params: any, _sessionId: string) => {
      for (const fn of this.listeners) fn(method, params)
    })
    dbg.on('detach', () => { this.attached = false })
  }

  get debugger(): Debugger {
    return this.wc.debugger
  }

  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  onMessage(fn: (method: string, params: any) => void): void {
    this.listeners.push(fn)
  }

  /** 在 main world 求值，返回 JS 值 */
  async evaluate<T = any>(expression: string, opts: { byValue?: boolean; awaitPromise?: boolean } = {}): Promise<T> {
    const res: any = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: opts.byValue !== false,
      awaitPromise: opts.awaitPromise !== false,
      userGesture: true,
    })
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(`evaluate failed: ${d.text ?? ''} ${d.exception?.description ?? ''}`.trim())
    }
    return res?.result?.value as T
  }

  /** 创建一个隔离世界，返回 executionContextId */
  async createWorld(worldName = 'uimator'): Promise<number> {
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const { executionContextId } = await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName,
      grantUniveralAccess: false,
    } as any)
    return executionContextId
  }

  async evaluateInWorld(expression: string, contextId: number): Promise<any> {
    const res: any = await this.send('Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.text ?? 'evaluateInWorld failed')
    }
    return res?.result?.value
  }

  async pageEnable(): Promise<void> {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
  }

  detach(): void {
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      /* ignore */
    }
    this.attached = false
  }
}
