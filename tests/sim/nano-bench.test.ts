/**
 * Arduino Nano 3.x on the bench, checked against its schematic (NanoV3.3) and the data sheets
 * of the parts on it: USB 5 V through the polyfuse and the SS1P3L Schottky, VIN through the
 * LM1117-5.0, the FT232RL's TXD/RXD through 1 kΩ to D0/D1, 3V3 from the FT232RL, the L LED on
 * D13, RESET pulled up by 1 kΩ with the button to ground, and Arduino's fuses. The firmware
 * (firmware/avr/examples/blink.c) blinks PB5 (D13) at 1 Hz, prints a tick a second at 9600 baud
 * and echoes what is typed upper-cased.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function bench(opts: { usb?: boolean; vin?: string; terminal?: boolean } = {}) {
  const { doc, place, wire } = builder(GRID)
  const nano = place("arduino-nano", 0, 0, { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
  doc.parts[`${nano.id}:USB`] = { on: opts.usb !== false }
  let term = null
  if (opts.terminal !== false) {
    term = place("serial-terminal", 3, -8, { baud: "9600" })
    wire(nano, "VCP-TX", term, "RX")
    wire(nano, "VCP-RX", term, "TX")
  }
  if (opts.vin) {
    const v = place("supply", -10, 16, { value: "VIN", voltage: opts.vin })
    const g = place("ground", -10, 20)
    wire(v, "V", nano, "J2-1")
    wire(g, "GND", nano, "J2-2")
  }
  return { doc, nano, term, place, wire }
}

function run(loop: SimLoop, state: { clock: number }, seconds: number) {
  const end = state.clock + seconds * 1000
  while (state.clock < end) {
    state.clock = Math.min(end, state.clock + 30)
    loop.advance(state.clock)
  }
}
function start(doc: ReturnType<typeof bench>["doc"]) {
  const loop = new SimLoop()
  const state = { clock: 0 }
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(0)
  return { loop, state }
}

describe("Arduino Nano on USB: blink, serial, LEDs", () => {
  const b = bench()
  const { loop, state } = start(b.doc)
  const v = (pin: string) => loop.snapshot()!.pinVoltage[pinKey(b.nano.id, pin)]

  beforeAll(() => run(loop, state, 2.3))

  it("+5V is the USB's 5 V less the Schottky's drop (D1, SS1P3L), not 5 V", () => {
    expect(v("J2-4")).toBeGreaterThan(4.55)
    expect(v("J2-4")).toBeLessThan(4.85)
  })

  it("3V3 is the FT232RL's 3V3OUT", () => {
    expect(v("J2-14")).toBeCloseTo(3.3, 1)
  })

  it("runs at 16 MHz with the fuses Arduino programs, whatever the image's .fuse section says", () => {
    const st = loop.snapshot()!.mcus[b.nano.id]
    expect(st.running).toBe(true)
    expect(st.sysclk).toBe(16e6)
    expect(st.labels?.fuses).toBe("L:FF H:DA E:FD lock:0F")
  })

  it("the empty boot section (BOOTRST) runs through into the sketch: ticks at 9600 baud through RP1B", () => {
    const t = loop.snapshot()!.terminals[b.term!.id]
    expect(t.text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect(t.framingErrors).toBe(0)
  })

  it("the PC's bytes reach D0 through RP1A and come back upper-cased", () => {
    loop.sendSerial(b.term!.id, "nano")
    run(loop, state, 0.05)
    expect(loop.snapshot()!.terminals[b.term!.id].text.replace(/tick \d+\r\n/g, "")).toBe("NANO")
  })

  it("the L LED on D13 blinks: lit about half the time", () => {
    let lit = 0
    const n = 100
    for (let i = 0; i < n; i++) {
      run(loop, state, 0.01)
      if (v("J2-15") > 2.5) lit++
    }
    expect(lit / n).toBeGreaterThan(0.3)
    expect(lit / n).toBeLessThan(0.7)
  })

  it("PWR is lit from +5V through RP1C; the L LED takes ≈ 2.6 mA from D13 through RP2A while lit", () => {
    const parts = loop.snapshot()!.parts
    expect(parts[`${b.nano.id}:PWR`].level).toBeGreaterThan(0)
    let peak = 0
    for (let i = 0; i < 100; i++) {
      run(loop, state, 0.01)
      peak = Math.max(peak, loop.snapshot()!.parts[`${b.nano.id}:L`].amps ?? 0)
    }
    // (4.7 V − 2.0 V) / 1 kΩ, less the pad's own drop.
    expect(peak).toBeGreaterThan(2.2e-3)
    expect(peak).toBeLessThan(2.9e-3)
  })

  it("TX flickers while the sketch prints, RX stays dark with nothing typed", () => {
    let tx = 0
    let rx = 0
    for (let i = 0; i < 400; i++) {
      run(loop, state, 0.005)
      const p = loop.snapshot()!.parts
      tx = Math.max(tx, p[`${b.nano.id}:TXLED`].level)
      rx = Math.max(rx, p[`${b.nano.id}:RXLED`].level)
    }
    expect(tx).toBeGreaterThan(0.01)
    expect(rx).toBeLessThan(1e-3)
  })

  it("pressing RESET restarts the sketch from tick 0", () => {
    const before = loop.snapshot()!.mcus[b.nano.id].resets
    loop.setParts({ ...b.doc.parts, [`${b.nano.id}:RESET`]: { pressed: true } })
    run(loop, state, 0.05)
    expect(loop.snapshot()!.mcus[b.nano.id].powered).toBe(false)
    loop.setParts({ ...b.doc.parts, [`${b.nano.id}:RESET`]: { pressed: false } })
    run(loop, state, 0.3)
    const st = loop.snapshot()!.mcus[b.nano.id]
    expect(st.resets).toBeGreaterThan(before)
    expect(st.labels?.reset).toBe("RESET pin")
  })
})

describe("Arduino Nano power paths", () => {
  it("on VIN alone (9 V): +5V comes from the LM1117 at 5 V and the sketch runs", () => {
    const b = bench({ usb: false, vin: "9 V" })
    const { loop, state } = start(b.doc)
    run(loop, state, 1.2)
    expect(loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J2-4")]).toBeCloseTo(5, 1)
    expect(loop.snapshot()!.terminals[b.term!.id].text).toMatch(/^tick 0\r\n/)
  })

  it("on VIN at 6 V the LM1117 drops out: +5V sits about 1.2 V under VIN", () => {
    const b = bench({ usb: false, vin: "6 V" })
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    const v5 = loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J2-4")]
    expect(v5).toBeGreaterThan(4.6)
    expect(v5).toBeLessThan(4.95)
  })

  it("USB and 9 V on VIN together: the regulator's 5 V wins and D1 keeps it out of the USB port", () => {
    const b = bench({ vin: "9 V" })
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    expect(loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J2-4")]).toBeCloseTo(5, 1)
  })

  it("no USB and no VIN: nothing runs", () => {
    const b = bench({ usb: false })
    const { loop, state } = start(b.doc)
    run(loop, state, 0.3)
    const st = loop.snapshot()!.mcus[b.nano.id]
    expect(st.powered).toBe(false)
    expect(loop.snapshot()!.terminals[b.term!.id].text).toBe("")
  })
})

describe("Arduino Nano: D0 behind the bridge", () => {
  it("with nothing on the serial pins, D0 is held high by the FT232RL's TXD through 1 kΩ", () => {
    const b = bench({ terminal: false })
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    expect(loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J1-2")]).toBeGreaterThan(4.3)
  })

  it("a 10 kΩ pull-down on D0 cannot pull it low against the bridge: it stays above VIH", () => {
    const b = bench({ terminal: false })
    const r = b.place("resistor", 12, 14, { ref: "R1", value: "10 kΩ", power: "0.25" }, 90)
    const g = b.place("ground", 12, 20)
    b.wire(b.nano, "J1-2", r, "1")
    b.wire(r, "2", g, "GND")
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    // 10 k against 1 k + ≈ 450 Ω from +5V: ≈ 4.1 V on D0.
    const d0 = loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J1-2")]
    expect(d0).toBeGreaterThan(3.8)
    expect(d0).toBeLessThan(4.4)
  })
})

describe("Arduino Nano: AREF (DS40002061B §24.5.2)", () => {
  it("AREF with only C1 on it is no problem: the ADC is off, or on AVCC, which drives AREF itself", () => {
    const b = bench()
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    expect(loop.snapshot()!.mcus[b.nano.id].reference).toBeNull()
  })

  it("3.3 V wired to AREF while the sketch converts against AVCC (REFS = 01): the internal reference is shorted to it", () => {
    const b = bench()
    b.nano.props = { ...b.nano.props, firmware: "avr-adc.elf", firmwareData: exampleBase64("avr-adc.elf") }
    b.wire(b.nano, "J2-14", b.nano, "J2-13")
    const { loop, state } = start(b.doc)
    run(loop, state, 0.3)
    expect(loop.snapshot()!.mcus[b.nano.id].reference).toMatch(/AREF.*REFS = 01.*shorted/)
  })

  it("the same sketch with AREF left alone reports nothing", () => {
    const b = bench()
    b.nano.props = { ...b.nano.props, firmware: "avr-adc.elf", firmwareData: exampleBase64("avr-adc.elf") }
    const { loop, state } = start(b.doc)
    run(loop, state, 0.3)
    expect(loop.snapshot()!.mcus[b.nano.id].reference).toBeNull()
  })
})

describe("Arduino Nano: 3V3 with only a capacitor on it", () => {
  it("holds 3.3 V: a regulator that stops conducting does not leave its output capacitor charged above the set point", () => {
    const b = bench({ terminal: false })
    const c = b.place("capacitor", 12, 5, { ref: "C9", value: "100 nF" })
    const g = b.place("ground", 12, 10)
    b.wire(b.nano, "J2-14", c, "1")
    b.wire(c, "2", g, "GND")
    const { loop, state } = start(b.doc)
    for (let i = 0; i < 20; i++) {
      run(loop, state, 0.005)
      expect(loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J2-14")]).toBeLessThan(3.35)
    }
    expect(loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J2-14")]).toBeCloseTo(3.3, 1)
  })
})

describe("Arduino Nano: the terminal on the USB serial pins is the PC, not a wire (FT232RL drives the lines)", () => {
  it("the PC side idles at the bridge's VCCIO (+5V rail), not at a 3.3 V terminal fighting it", () => {
    const b = bench()
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    const s = loop.snapshot()!
    const v5 = s.pinVoltage[pinKey(b.nano.id, "J2-4")]
    expect(s.pinVoltage[pinKey(b.nano.id, "VCP-RX")]).toBeGreaterThan(v5 - 0.05)
    // D1 idles high at +5V through RP1B into the FT232RL's RXD (a 200 kΩ pull-up): no terminal load on it.
    expect(s.pinVoltage[pinKey(b.nano.id, "VCP-TX")]).toBeGreaterThan(v5 - 0.05)
    expect(s.pinVoltage[pinKey(b.term!.id, "TX")]).toBeGreaterThan(v5 - 0.05)
  })

  it("a byte typed in the terminal reaches D0 at the bridge's 5 V levels: low bits pull D0 under VIL", () => {
    const b = bench()
    const { loop, state } = start(b.doc)
    run(loop, state, 0.1)
    loop.sendSerial(b.term!.id, "\u0000")
    let lowest = 5
    for (let i = 0; i < 40; i++) {
      run(loop, state, 0.00002)
      lowest = Math.min(lowest, loop.snapshot()!.pinVoltage[pinKey(b.nano.id, "J1-2")])
    }
    expect(lowest).toBeLessThan(0.3 * 4.7)
  })
})

describe("Arduino Nano: two of its pins tied together keep it running as it was", () => {
  it("a button from D2 to the board's own 5V (which RP1D ties to RESET) neither restarts the core nor its serial", () => {
    const b = bench()
    const sw = b.place("pushbutton", 16, 4)
    b.wire(b.nano, "J1-5", sw, "2")
    b.wire(b.nano, "J2-4", sw, "1")
    const { loop, state } = start(b.doc)
    run(loop, state, 1.2)
    const before = loop.snapshot()!.mcus[b.nano.id]
    loop.setParts({ ...b.doc.parts, [`${sw.id}:SW`]: { pressed: true } })
    run(loop, state, 2)
    const after = loop.snapshot()!.mcus[b.nano.id]
    // The same core, its time and instruction count carried on: not reloaded with the image's (factory) fuses.
    expect(after.instructions).toBeGreaterThan(before.instructions)
    expect(after.labels?.fuses).toBe("L:FF H:DA E:FD lock:0F")
    // It stays where it ran (in this thread, or its worker, then in step): a move would reload it.
    expect(after.host.split(" ")[0]).toBe(before.host.split(" ")[0])
    const t = loop.snapshot()!.terminals[b.term!.id]
    expect(t.text).toMatch(/^tick 0\r\ntick 1\r\ntick 2\r\n/)
    expect(t.framingErrors).toBe(0)
  })
})

describe("Arduino Nano: the terminal on the USB pins is rated as nothing", () => {
  it("its pins carry no current and no rating: the PC is on the other end of a USB cable", () => {
    const b = bench()
    const { loop, state } = start(b.doc)
    run(loop, state, 0.3)
    const readings = loop.snapshot()!.readings.filter((r) => r.object === b.term!.id)
    expect(readings.length).toBeGreaterThan(0)
    for (const r of readings) {
      expect(r.load).toBeUndefined()
      expect(Math.abs(r.current)).toBeLessThan(1e-9)
    }
  })
})
