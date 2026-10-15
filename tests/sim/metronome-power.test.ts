import { describe, expect, it } from "vitest"
import { partKey } from "@/schematic/types"
import type { BuzzerSnapshot } from "@/sim/buzzer"
import { SimLoop } from "@/sim/loop"
import { metronome } from "../lib/metronome-bench"

describe("Metronome V1 rev.B: three NE555s, a 74HC595 and the glue around them", () => {
  it("SW1 off stops everything once C_BULK has run down; on again, the power-on clear restarts the ring from LED1", () => {
    const bench = metronome()
    const loop = new SimLoop()
    loop.setDoc(bench.doc)
    loop.setParts(bench.doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    const flashes: { led: number; time: number }[] = []
    const quiet: { lit: boolean; sounding: boolean; time: number }[] = []
    let lit = -1
    const runTo = (ms: number) => {
      while (clock < ms) {
        clock += 2
        loop.advance(clock)
        const snap = loop.snapshot()!
        const on = bench.leds.findIndex((led) => snap.parts[partKey(led.id, "LED")]?.on)
        if (on >= 0 && on !== lit) flashes.push({ led: on, time: snap.time })
        lit = on
        quiet.push({ lit: on >= 0, sounding: (snap.digital[bench.buzzer.id] as BuzzerSnapshot).sounding, time: snap.time })
      }
    }
    const power = (on: boolean) => loop.setParts({ ...bench.doc.parts, [partKey(bench.sw.id, "SW")]: { on } })
    runTo(3000)
    expect.soft(flashes.length, "beating before it is switched off").toBeGreaterThan(2)
    power(false)
    const offAt = loop.snapshot()!.time
    quiet.length = 0
    runTo(5000)
    const afterHoldUp = quiet.filter((x) => x.time > offAt + 0.2)
    expect.soft(afterHoldUp.length, "time watched while off").toBeGreaterThan(500)
    expect.soft(afterHoldUp.some((x) => x.lit), "no LED lit 0.2 s after switching off").toBe(false)
    expect.soft(afterHoldUp.some((x) => x.sounding), "BZ1 silent 0.2 s after switching off").toBe(false)
    power(true)
    const onFrom = flashes.length
    runTo(8000)
    const again = flashes.slice(onFrom).map((f) => f.led)
    expect.soft(again.length, "beating again").toBeGreaterThan(2)
    expect.soft(again.slice(0, 3), "from LED1, in order").toEqual([0, 1, 2])
  })
})
