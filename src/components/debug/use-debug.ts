import * as React from "react"
import type { BoardView, DebugController } from "@/debug/session"

/** A board's debugger view, re-rendering on every change the controller announces. */
export function useDebugView(debug: DebugController | null, id: string | null): BoardView {
  const subscribe = React.useCallback((fn: () => void) => debug?.subscribe(fn) ?? (() => {}), [debug])
  const get = React.useCallback(() => debug!.view(id), [debug, id])
  const view = React.useSyncExternalStore(subscribe, debug ? get : emptyView, debug ? get : emptyView)
  // Whatever the views read and the snapshot did not have is fetched once they have rendered.
  React.useEffect(() => {
    debug?.requestMissing(id)
  })
  return view
}

const EMPTY_VIEW = { status: "no-image", stop: null, regs: null, prevRegs: null, prevMem: null, frames: [], frame: 0, mem: null, time: 0, error: null, version: 0 } as BoardView
const emptyView = () => EMPTY_VIEW

/** The bench's Run/Pause as the debugger has it. */
export function useBenchRunning(debug: DebugController | null): boolean {
  const subscribe = React.useCallback((fn: () => void) => debug?.subscribe(fn) ?? (() => {}), [debug])
  return React.useSyncExternalStore(subscribe, () => debug?.benchRunning ?? false)
}
