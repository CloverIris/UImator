import type { UImatorApi } from '../preload/index'

declare global {
  interface Window {
    uimator: UImatorApi
  }
}

export {}
