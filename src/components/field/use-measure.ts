import * as React from "react"
import type { Point } from "@/schematic/geometry"
import { pinKey, type PinRef } from "@/schematic/types"
import type { Probe } from "@/sim/loop"

/** The id the probe pair is registered under with the simulation. */
export const PROBE_ID = "probe"
/** Colours of held channels, in the order they are taken; the live probe is always red. */
export const CHANNEL_COLORS = ["#f59e0b", "#0ea5e9", "#8b5cf6", "#10b981", "#ec4899", "#14b8a6", "#f97316", "#84cc16"] as const
/** The live probe plus this many held ones. */
export const MAX_HELD = CHANNEL_COLORS.length

/** One end of the probe: the pin whose net it reads, where its tip sits, and what to call it. */
export type ProbePoint = {
  ref: PinRef
  at: Point
  label: string
  /** Put down on a wire rather than on the pin, so `at` is the click point and stays put. */
  onWire?: boolean
}

export type Tips = { a: ProbePoint | null; b: ProbePoint | null }

/** A probe placement kept on the field after the live probe moved on: an oscilloscope channel. */
export type HeldChannel = { id: string; tips: { a: ProbePoint; b: ProbePoint | null }; color: string }

const NO_PROBES: Probe[] = []
const toProbe = (id: string, tips: { a: ProbePoint; b: ProbePoint | null }): Probe => ({
  id,
  a: pinKey(tips.a.ref.object, tips.a.ref.pin),
  b: tips.b ? pinKey(tips.b.ref.object, tips.b.ref.pin) : null,
})

/**
 * The two-point voltage probe.
 *
 * While `active`, clicking the field puts down the red tip and then the black one; a third
 * click starts a new measurement. With only the red tip down the reading is against ground,
 * which is what a meter with its common lead on the ground rail does.
 */
export function useMeasure() {
  const [active, setActive] = React.useState(false)
  const [tips, setTips] = React.useState<Tips>({ a: null, b: null })
  const [held, setHeld] = React.useState<HeldChannel[]>([])
  const nextId = React.useRef(1)

  /** Keep the live probe where it is as a channel of its own and free the probe for the next point. */
  const hold = React.useCallback(() => {
    // Read the current tips rather than nesting updaters: an updater may run twice.
    const a = tips.a
    if (!a || held.length >= MAX_HELD) return
    const used = new Set(held.map((c) => c.color))
    const color = CHANNEL_COLORS.find((c) => !used.has(c)) ?? CHANNEL_COLORS[0]
    const id = `ch${nextId.current}`
    nextId.current += 1
    setHeld([...held, { id, tips: { a, b: tips.b }, color }])
    setTips({ a: null, b: null })
  }, [tips, held])
  const release = React.useCallback((id: string) => setHeld((list) => list.filter((c) => c.id !== id)), [])
  const releaseAll = React.useCallback(() => setHeld([]), [])

  const pick = React.useCallback((p: ProbePoint) => {
    setTips((cur) => (!cur.a ? { a: p, b: null } : !cur.b ? { a: cur.a, b: p } : { a: p, b: null }))
  }, [])
  const clear = React.useCallback(() => setTips({ a: null, b: null }), [])
  const toggle = React.useCallback(() => setActive((on) => !on), [])
  const stop = React.useCallback(() => setActive(false), [])

  /** Drop a tip whose component is gone, rather than leaving a marker over empty field. */
  const drop = React.useCallback((gone: (ref: PinRef) => boolean) => {
    setTips((cur) => {
      const a = cur.a && gone(cur.a.ref) ? null : cur.a
      const b = cur.b && gone(cur.b.ref) ? null : cur.b
      if (a === cur.a && b === cur.b) return cur
      // Losing the first tip promotes the second: a probe always has its live lead down first.
      return a ? { a, b } : { a: b, b: null }
    })
    // A held channel is a fixed measurement; with either lead gone it is meaningless.
    setHeld((list) => {
      const kept = list.filter((c) => !gone(c.tips.a.ref) && !(c.tips.b && gone(c.tips.b.ref)))
      return kept.length === list.length ? list : kept
    })
  }, [])

  const probes = React.useMemo<Probe[]>(() => {
    const list = held.map((c) => toProbe(c.id, c.tips))
    if (tips.a) list.push(toProbe(PROBE_ID, { a: tips.a, b: tips.b }))
    return list.length ? list : NO_PROBES
  }, [tips, held])

  return { active, toggle, stop, tips, pick, clear, drop, probes, held, hold, release, releaseAll }
}
