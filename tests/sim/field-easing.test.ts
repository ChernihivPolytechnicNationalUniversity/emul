import { afterEach, describe, expect, it, vi } from "vitest"
import { dotGridStyle } from "@/components/field/dot-grid"
import { easeFactor, progress } from "@/components/field/easing"
import { followTarget, type Viewport } from "@/components/field/use-viewport"
import { WireFlow } from "@/components/field/wire-flow"

const ZOOM_TAU_MS = 70
const FLOW_TAU_MS = 300
const GRID = 20
const HUNG_FRAME_DT_MS = -312
const HUNG_SCALE = -6.97
const FRAME_MS = 16
const STARTED_AT_MS = 1000
const PUSH_EVERY_MS = 50
const PHASE_STEP = 10
const PUSHES = 4
const WIRE_AMPS = 0.01
const FRAME_LIMIT = 200

type FakeStyle = { opacity: string; strokeWidth: string; strokeDashoffset: string }

function fakeFrames() {
  let queued: FrameRequestCallback | null = null
  let ids = 0
  let clock = STARTED_AT_MS
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queued = callback
    return ++ids
  })
  vi.stubGlobal("cancelAnimationFrame", () => {
    queued = null
  })
  return {
    advance(ms: number) {
      clock += ms
    },
    get now() {
      return clock
    },
    get pending() {
      return queued !== null
    },
    run(stampOf: (frame: number) => number) {
      let frames = 0
      while (queued && frames < FRAME_LIMIT) {
        const callback: FrameRequestCallback = queued
        queued = null
        callback(stampOf(frames))
        frames++
      }
      return frames
    },
  }
}

function flowingWire() {
  const flow = new WireFlow()
  const style = (): FakeStyle => ({ opacity: "", strokeWidth: "", strokeDashoffset: "" })
  const dash = { style: style(), dataset: { base: "2" } }
  flow.bodyRef("w")({ style: style(), dataset: { base: "2" } } as unknown as SVGPathElement)
  flow.dashRef("w")(dash as unknown as SVGPathElement)
  return { flow, dash, currents: new Map([["w", WIRE_AMPS]]) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the field's frame step survives a frame stamped before the animation started (BUGS.md, wheel zoom)", () => {
  it("eases nothing over a negative, zero or unknown interval", () => {
    for (const dt of [HUNG_FRAME_DT_MS, -1e-9, 0, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(easeFactor(dt, ZOOM_TAU_MS), `zoom, dt ${dt} ms`).toBe(0)
      expect(easeFactor(dt, FLOW_TAU_MS), `wire flow, dt ${dt} ms`).toBe(0)
    }
  })

  it("closes part of the gap over a frame and all of it over a long stall, never more", () => {
    expect(easeFactor(ZOOM_TAU_MS, ZOOM_TAU_MS)).toBeNear(1 - Math.exp(-1), 1e-12)
    expect(easeFactor(16, ZOOM_TAU_MS)).toBeGreaterThan(0)
    expect(easeFactor(Number.POSITIVE_INFINITY, ZOOM_TAU_MS)).toBe(1)
  })

  it("keeps a zoom between where it was and where it is going for any frame interval", () => {
    const from = 0.5
    const to = 2
    for (const dt of [HUNG_FRAME_DT_MS, -16, 0, 1, 16, 70, 1000, 1e9]) {
      const scale = from + (to - from) * easeFactor(dt, ZOOM_TAU_MS)
      expect(scale, `scale after a ${dt} ms frame`).toBeGreaterThanOrEqual(from)
      expect(scale, `scale after a ${dt} ms frame`).toBeLessThanOrEqual(to)
    }
  })

  it("slides the wire flow's phase only forward, and no further than the target", () => {
    expect(progress(-5, 50)).toBe(0)
    expect(progress(25, 50)).toBe(0.5)
    expect(progress(500, 50)).toBe(1)
    expect(progress(10, 0)).toBe(0)
    expect(progress(Number.NaN, 50)).toBe(0)
  })
})

describe("the wire flow slides to every phase the solver sends, whatever the first frame after a push is stamped (review of 37ae994)", () => {
  const offsetsAfterPushes = (firstFrameLagMs: number) => {
    const frames = fakeFrames()
    const { flow, dash, currents } = flowingWire()
    flow.push(currents, new Map([["w", 0]]), true, false)
    frames.run((f) => frames.now + f * FRAME_MS)
    const offsets: string[] = []
    for (let push = 1; push <= PUSHES; push++) {
      frames.advance(PUSH_EVERY_MS)
      flow.push(currents, new Map([["w", push * PHASE_STEP]]), true, false)
      const pushedAt = frames.now
      const ran = frames.run((f) => pushedAt + firstFrameLagMs + f * FRAME_MS)
      frames.advance(ran * FRAME_MS)
      offsets.push(dash.style.strokeDashoffset)
    }
    return { offsets, pending: frames.pending }
  }
  const everyPhase = Array.from({ length: PUSHES }, (_, i) => String(-(i + 1) * PHASE_STEP))

  it("a first frame stamped after the push", () => {
    expect(offsetsAfterPushes(2).offsets).toEqual(everyPhase)
  })

  it("a first frame stamped 2 ms before the push, which used to end the loop with the dash where it was", () => {
    expect(offsetsAfterPushes(-2).offsets).toEqual(everyPhase)
  })

  it("frame stamps running 312 ms behind the clock, as BUGS.md measured on the wheel zoom", () => {
    expect(offsetsAfterPushes(HUNG_FRAME_DT_MS).offsets).toEqual(everyPhase)
  })

  it("the dash moves on the first frame after a push, not once the stamps catch up with the clock", () => {
    const frames = fakeFrames()
    const { flow, dash, currents } = flowingWire()
    flow.push(currents, new Map([["w", 0]]), true, false)
    frames.run((f) => frames.now + f * FRAME_MS)
    frames.advance(PUSH_EVERY_MS)
    flow.push(currents, new Map([["w", PHASE_STEP]]), true, false)
    let first = ""
    const pushedAt = frames.now
    frames.run((f) => {
      if (f === 1) first = dash.style.strokeDashoffset
      return pushedAt + HUNG_FRAME_DT_MS + f * FRAME_MS
    })
    expect(Number(first)).toBeLessThan(0)
    expect(Number(first)).toBeGreaterThan(-PHASE_STEP)
  })

  it("and the loop ends once the dash has arrived and the width has settled", () => {
    const { offsets, pending } = offsetsAfterPushes(-2)
    expect(offsets.at(-1)).toBe(everyPhase.at(-1))
    expect(pending).toBe(false)
  })
})

describe("a wheel zoom moves from its first frame, however far behind the clock the frame stamps run (BUGS.md, 312 ms)", () => {
  const zoom = (lagMs: number) => {
    fakeFrames()
    const view = { current: { x: 0, y: 0, scale: 0.5 } as Viewport }
    const target = { current: { x: -200, y: -100, scale: 2 } as Viewport }
    const scales: number[] = []
    let settledAt = -1
    const step = followTarget(view, target, (shown, settled) => {
      scales.push(shown.scale)
      if (settled && settledAt < 0) settledAt = scales.length
    })
    for (let f = 0; f < FRAME_LIMIT && settledAt < 0; f++) step(STARTED_AT_MS + lagMs + f * FRAME_MS)
    return { scales, settledAt, view }
  }

  it.each([2, -2, HUNG_FRAME_DT_MS])("frames stamped %s ms from the start: every frame zooms further in, and it settles on the target", (lag) => {
    const { scales, settledAt, view } = zoom(lag)
    expect(scales[0], "the first frame").toBeGreaterThan(0.5)
    for (let i = 1; i < scales.length; i++) expect(scales[i], `frame ${i}`).toBeGreaterThan(scales[i - 1])
    expect(settledAt).toBeGreaterThan(0)
    expect(view.current).toEqual({ x: -200, y: -100, scale: 2 })
  })

  it("a lag in the stamps costs no frames: the zoom settles in the same number of frames with or without it", () => {
    expect(zoom(HUNG_FRAME_DT_MS).settledAt).toBe(zoom(2).settledAt)
  })
})

describe("the dot grid gives up on a scale it cannot draw instead of looping for ever", () => {
  it.each([HUNG_SCALE, 0, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("scale %s draws no dots", (scale) => {
    expect(dotGridStyle(GRID, scale).backgroundImage).toBe("none")
  })

  it("draws the usual grid at a real scale", () => {
    const style = dotGridStyle(GRID, 1)
    expect(style.backgroundImage).toContain("radial-gradient")
    expect(style.backgroundSize).toBe("20px 20px")
  })
})
