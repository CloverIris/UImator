import { contextBridge, ipcRenderer } from 'electron'

export type CaptureOpts = { selector?: string | null; dpr?: number; label?: string; hover?: boolean }

const api = {
  navigate: (url: string) => ipcRenderer.invoke('nav', url),
  pick: () => ipcRenderer.invoke('pick'),
  scan: () => ipcRenderer.invoke('scan'),
  highlight: (selector: string) => ipcRenderer.invoke('highlight', selector),
  capture: (opts: CaptureOpts) => ipcRenderer.invoke('capture', opts),
  freeze: (on: boolean) => ipcRenderer.invoke('freeze', on),
  fixtures: () => ipcRenderer.invoke('fixtures'),
  state: () => ipcRenderer.invoke('state'),
  getStage: () => ipcRenderer.invoke('stage-data'),
  reveal: (p: string) => ipcRenderer.invoke('reveal', p),
  onEvent: (cb: (evt: any) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: any) => cb(payload)
    ipcRenderer.on('evt', handler)
    return () => ipcRenderer.removeListener('evt', handler)
  },
}

contextBridge.exposeInMainWorld('uimator', api)

export type UImatorApi = typeof api
