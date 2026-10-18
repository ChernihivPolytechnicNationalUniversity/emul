/**
 * The supply current an AVR or PIC core puts on the circuit: the loop takes it as a resistor of
 * VDD(nominal) / idd between the part's supply pins. Its current at the rail's voltage V is the
 * datasheet's figure at V (ATmega328P Table 29-8 scaled with VCC; PIC16F628A D012A by VDD), and
 * it does not move with a step's ripple on the rail: a resistor that changes every step makes the
 * circuit be solved again every step.
 */
import { describe, expect, it } from "vitest"
import { ATMEGA328P } from "@/mcu/avr/chip"
import { PIC16F628A } from "@/mcu/pic/chip"
import type { ClockSource } from "@/mcu/periph/rcc"
import { AvrCore } from "@/sim/avr-core"
import { PicCore } from "@/sim/pic-core"
import { DT } from "@/sim/speeds"
import { buffer, example } from "../lib/firmware"

type Core = AvrCore | PicCore

/** `steps` steps at `volts(step)`, the loop's way: supply, run, read the load. */
function run(core: Core, steps: number, volts: (step: number) => number) {
  const loads: number[] = []
  for (let k = 0; k < steps; k++) {
    core.setSupply(volts(k))
    core.runUntil(core.time + DT)
    loads.push(core.supplyCurrent())
  }
  return loads
}

const changes = (xs: number[]) => xs.reduce((n, x, i) => n + (i > 0 && x !== xs[i - 1] ? 1 : 0), 0)

function avr() {
  const core = new AvrCore(ATMEGA328P)
  core.setClockSources({ hz: 16e6, kind: "crystal" } as ClockSource)
  core.load(buffer(example("avr-blink.elf")), "avr-blink.elf")
  return core
}

function pic() {
  const core = new PicCore(PIC16F628A)
  core.load(buffer(example("pic-blink.hex")), "pic-blink.hex")
  return core
}

describe("the supply current a core puts on the circuit", () => {
  for (const [name, make] of [
    ["ATmega328P", avr],
    ["PIC16F628A", pic],
  ] as const) {
    it(`${name}: 50 mV of ripple every other step does not move the resistor`, () => {
      const core = make()
      // 200 ms: past the start-up delay and the sleep share's 10 ms average.
      run(core, 10000, () => 5)
      const loads = run(core, 2500, (k) => (k % 2 ? 4.95 : 5))
      expect(changes(loads), "changes of the load over 50 ms of ripple").toBeLessThanOrEqual(2)
      expect(loads.at(-1)! > 0).toBe(true)
    })
  }

  it("ATmega328P at 4.0 V: the resistor draws Table 29-8's current at 4.0 V (scaled with VCC once, not twice)", () => {
    const core = avr()
    const loads = run(core, 10000, () => 4)
    const drawn = (4 * loads.at(-1)!) / ATMEGA328P.electrical.vdd
    // What the inspector shows: the datasheet's figure at the part's VCC for its sleep share.
    const shown = core.status().power!.current
    expect(drawn / shown).toBeCloseTo(1, 1)
  })

  it("PIC16F628A at 3.0 V on INTOSC, never asleep: the resistor draws D012A's 565 µA", () => {
    const core = pic()
    const loads = run(core, 10000, () => 3)
    const drawn = (3 * loads.at(-1)!) / PIC16F628A.electrical.vdd
    expect(drawn).toBeCloseTo(565e-6, 6)
  })
})
