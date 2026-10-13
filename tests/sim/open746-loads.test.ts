import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type Element, type PartState } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"
import { buffer, example } from "../lib/firmware"

const board = getDef("open746i-c")!
const elf = example("open746-loads.elf")
const BENCH = parseElf(buffer(elf)).symbols.find((s) => s.name === "bench")!.value
const LEVELS = BENCH + 16
const PORTS = 9
const Command = { outputLow: 1, outputHigh: 2, floating: 3, pulledUp: 4, pulledDown: 5 } as const
const VDD = 3.3
const PAD_PULL_OHMS = 40e3
const OTG_ID_PULL_OHMS = 10e3
const NRST_FARADS = 2 * 10e-9
const CP2102_OUTPUT_HIGH_OHMS = 0.7 / 3e-3
const CP2102_INPUT_PULL_UP_OHMS = 3.3 / 25e-6
const CP2102_VDD = 3.3
const FLASH = { BOOT: { on: false } }
const VBUS_FITTED = { OTG_VBUS: { on: true } }
const BOARD_ON_THE_USART1_USB = { MUSB: { on: false }, SW1: { on: false }, S2: { on: false }, USB: { on: true } }

const padOf = (name: string) => (name.charCodeAt(1) - 65) * 16 + Number(name.slice(2))
const stripPin = (mcu: string) => {
  const found = board.pins.filter((p) => /^P(18|19|20|21)-/.test(p.id) && p.mcu === mcu)
  expect(found, `${mcu} is on exactly one strip pin`).toHaveLength(1)
  return found[0]!.id
}
const divider = (top: number, bottom: number) => (VDD * bottom) / (top + bottom)

function loadsBench(initial: Record<string, PartState> = {}, groundedThrough?: { pin: string; ohms: string }) {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-loads.elf", firmwareData: elf.toString("base64") }
  if (groundedThrough) {
    const b = builder(GRID)
    const load = b.place("resistor", 90, 4, { value: groundedThrough.ohms })
    b.wire(u, groundedThrough.pin, load, "1")
    b.wire(load, "2", u, "CN2-6")
    doc.objects.push(...b.doc.objects)
    doc.wires.push(...b.doc.wires)
  }
  const loop = new SimLoop()
  const failures: string[] = []
  loop.onFailure = (f) => failures.push(`${f.ref} element ${f.damage.element}: ${f.damage.reason}`)
  let clock = 0
  let parts: Record<string, PartState> = { ...FLASH, ...initial }
  const set = (changes: Record<string, PartState>) => {
    parts = { ...parts, ...changes }
    loop.setParts(Object.fromEntries(Object.entries(parts).map(([part, state]) => [partKey(u.id, part), state])))
  }
  loop.setDoc(doc)
  set({})
  loop.setRunning(true)
  loop.advance(clock)
  const run = (seconds: number): Snapshot => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
    const snap = loop.snapshot()
    expect(snap, "the circuit produces a snapshot").not.toBeNull()
    return snap!
  }
  let sequence = 0
  const order = async (command: number, pad: string) => {
    sequence++
    const word = (value: number) => new Uint8Array(new Uint32Array([value]).buffer)
    await loop.inspect(u.id, {
      write: [
        { kind: "memory", addr: BENCH + 8, bytes: word(command) },
        { kind: "memory", addr: BENCH + 12, bytes: word(padOf(pad)) },
        { kind: "memory", addr: BENCH, bytes: word(sequence) },
      ],
    })
    for (let tries = 0; tries < 20; tries++) {
      run(0.001)
      const reply = await loop.inspect(u.id, { ranges: [{ addr: BENCH + 4, size: 4 }] })
      const applied = new DataView(reply!.memory[0].bytes.buffer, reply!.memory[0].bytes.byteOffset).getUint32(0, true)
      if (applied === sequence) return loop.snapshot()!
    }
    throw new Error(`the firmware never applied command ${command} to ${pad}`)
  }
  const level = async (pad: string) => {
    const reply = await loop.inspect(u.id, { ranges: [{ addr: LEVELS, size: PORTS * 2 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return (view.getUint16(Math.floor(padOf(pad) / 16) * 2, true) >> padOf(pad) % 16) & 1
  }
  const volts = (snap: Snapshot, pin: string) => {
    const v = snap.pinVoltage[pinKey(u.id, pin)]
    expect(Number.isFinite(v), `${pin} has a solved voltage`).toBe(true)
    return v
  }
  const lit = (snap: Snapshot, part: string) => snap.parts[partKey(u.id, part)]?.on ?? false
  run(0.02)
  return { u, loop, run, set, order, level, volts, lit, failures }
}

describe("OTG JMP VBUS (USB.P3): PA9 on the module USB's 5 V, empty as the lab's boards ship", () => {
  const PA9 = stripPin("PA9")

  it("ships empty: with the module's USB plugged in, USART1 TX idles high on PA9 and nothing burns", async () => {
    expect(board.parts.find((p) => p.id === "OTG_VBUS"), "no cap on VBUS (two benches, 2026-10-13)").toMatchObject({ type: "switch", initial: undefined })
    const bench = loadsBench()
    await bench.order(Command.outputHigh, "PA9")
    const snap = bench.run(EYE_SETTLED)
    expect(bench.volts(snap, PA9), "PA9 high at the pad's own VDD").toBeNear(VDD, 0.05)
    expect(bench.lit(snap, "MVBUS"), "the module's VBUS LED, on that USB's 5 V either way").toBe(true)
    expect(bench.failures).toEqual([])
  })

  it("fitted, with the module's USB plugged in, holds PA9 at 5 V and reads 1 there", async () => {
    const bench = loadsBench(VBUS_FITTED)
    await bench.order(Command.floating, "PA9")
    const snap = bench.run(0.005)
    expect(bench.volts(snap, PA9), "PA9 on the strip").toBeNear(5, 0.05)
    expect(await bench.level("PA9"), "PA9 input").toBe(1)
    expect(bench.failures, "an input takes 5 V: PA9 is five-volt tolerant").toEqual([])
  })

  it("fitted, keeps the CP2102's own 3.3 V where its regulator puts it: its 20 mA swamps what 5 V on RXD pushes back through the pull-up", async () => {
    const bench = loadsBench(VBUS_FITTED)
    await bench.order(Command.floating, "PA9")
    await bench.order(Command.floating, "PA10")
    await bench.order(Command.floating, "PA12")
    const snap = bench.run(0.005)
    expect(bench.volts(snap, "VCP-TX"), "the bridge's RXD on the module USB's 5 V").toBeNear(5, 0.05)
    expect(bench.volts(snap, "VCP-RX"), "its TXD, high at its own VDD").toBeNear(CP2102_VDD, 0.02)
    expect(bench.volts(snap, "VCP-RTS"), "its RTS, high at its own VDD").toBeNear(CP2102_VDD, 0.02)
  })

  it("fitted, burns the MCU when a firmware drives PA9 low against it", async () => {
    const bench = loadsBench(VBUS_FITTED)
    await bench.order(Command.outputLow, "PA9")
    const snap = bench.run(0.005)
    expect(bench.failures.join("\n"), "the pad's 25 mA is exceeded").toMatch(/U\d+ element/)
    expect(snap.damage[bench.u.id], "the board's MCU is damaged").toBeDefined()
  })

  it("fitted with the module's USB in, burns a PA9 driven high, as USART1 TX idles: 5 V back into a 3.3 V driver", async () => {
    const bench = loadsBench(VBUS_FITTED)
    await bench.order(Command.outputHigh, "PA9")
    bench.run(0.005)
    expect(bench.failures.length, "the pad's 25 mA is exceeded").toBeGreaterThan(0)
  })

  it("frees PA9 with JMP2 open: the pad's own pull decides", async () => {
    const bench = loadsBench({ JMP2_1: { on: false } })
    await bench.order(Command.pulledDown, "PA9")
    expect(bench.volts(bench.run(0.005), PA9), "pulled down").toBeNear(0, 0.05)
    expect(await bench.level("PA9")).toBe(0)
    await bench.order(Command.pulledUp, "PA9")
    expect(bench.volts(bench.run(0.005), PA9), "pulled up").toBeNear(VDD, 0.05)
    expect(await bench.level("PA9")).toBe(1)
    expect(bench.failures).toEqual([])
  })

  it("fitted, lights the module's VBUS LED from PA9 through the cap when the module's USB is out", async () => {
    const bench = loadsBench({ ...BOARD_ON_THE_USART1_USB, ...VBUS_FITTED })
    await bench.order(Command.outputLow, "PA9")
    expect(bench.lit(bench.run(EYE_SETTLED), "MVBUS"), "PA9 low").toBe(false)
    await bench.order(Command.outputHigh, "PA9")
    const snap = bench.run(EYE_SETTLED)
    expect(bench.lit(snap, "MVBUS"), "PA9 high feeds the LED through 1 kΩ").toBe(true)
    expect(bench.volts(snap, PA9), "PA9 high").toBeGreaterThan(3.1)
    expect(bench.failures).toEqual([])
  })
})

describe("OTG JMP PWR OUT (USB.P1) and FLG (USB.P2): 10 kΩ pull-ups on PE2 and PE3", () => {
  it.each(["PE2", "PE3"])("reads %s as 1 against the pad's own pull-down, through the strip pin", async (pad) => {
    const bench = loadsBench()
    await bench.order(Command.pulledDown, pad)
    const snap = bench.run(0.01)
    expect(bench.volts(snap, stripPin(pad)), `${pad}: 10 kΩ up against 40 kΩ down`).toBeNear(divider(10e3, PAD_PULL_OHMS), 0.05)
    expect(await bench.level(pad)).toBe(1)
  })

  it("lets PE3 climb back through its 100 nF with τ = 1 ms once the pad lets go", async () => {
    const bench = loadsBench()
    await bench.order(Command.outputLow, "PE3")
    expect(bench.volts(bench.run(0.005), stripPin("PE3")), "driven low").toBeNear(0, 0.02)
    const released = await bench.order(Command.floating, "PE3")
    expect(bench.volts(released, stripPin("PE3")), "within a millisecond of the release").toBeLessThan(VDD * (1 - Math.exp(-1)) + 0.1)
    expect(bench.volts(bench.run(0.01), stripPin("PE3")), "10 time constants on").toBeNear(VDD, 0.02)
  })

  it.each([
    ["PE2", "OTG_PWR"],
    ["PE3", "OTG_FLG"],
  ])("frees %s with its cap (%s) off", async (pad, cap) => {
    const bench = loadsBench({ [cap]: { on: false } })
    await bench.order(Command.pulledDown, pad)
    expect(bench.volts(bench.run(0.01), stripPin(pad))).toBeNear(0, 0.05)
    expect(await bench.level(pad)).toBe(0)
  })
})

describe("USART1 JMP (JMP2): the CP2102's side of PA9–PA12", () => {
  it("lights the TX LED while PA9 is low, through JMP2; open, the LED stays dark", async () => {
    const bench = loadsBench()
    await bench.order(Command.outputLow, "PA9")
    expect(bench.lit(bench.run(EYE_SETTLED), "TXLED"), "cap on").toBe(true)
    bench.set({ JMP2_1: { on: false } })
    const snap = bench.run(EYE_SETTLED)
    expect(bench.lit(snap, "TXLED"), "cap off").toBe(false)
    expect(bench.volts(snap, "VCP-TX"), "the bridge's RXD, cut off from PA9, rises on its own pull-up").toBeGreaterThan(1)
  })

  it("holds PA10 high against its pull-down: the CP2102's TXD idles high", async () => {
    const bench = loadsBench()
    await bench.order(Command.pulledDown, "PA10")
    expect(bench.volts(bench.run(0.005), stripPin("PA10")), "PA10 is an OTG ID pad: its pull is 7–14 kΩ (DS10916 Table 57), not 40 kΩ").toBeNear(divider(CP2102_OUTPUT_HIGH_OHMS, OTG_ID_PULL_OHMS), 0.05)
    expect(await bench.level("PA10")).toBe(1)
  })

  it("lights the RX LED while the MCU pulls PA10 low against the bridge, 13 mA, inside the pad's rating", async () => {
    const bench = loadsBench()
    await bench.order(Command.outputLow, "PA10")
    const snap = bench.run(EYE_SETTLED)
    expect(bench.lit(snap, "RXLED")).toBe(true)
    expect(bench.volts(snap, stripPin("PA10")), "25 Ω low against 233 Ω high").toBeNear(divider(CP2102_OUTPUT_HIGH_OHMS, 25), 0.05)
    expect(bench.failures).toEqual([])
  })

  it("frees PA10 from the CP2102 with JMP2 open: pulled down, it reads 0 V", async () => {
    const bench = loadsBench({ JMP2_2: { on: false } })
    await bench.order(Command.pulledDown, "PA10")
    expect(bench.volts(bench.run(0.005), stripPin("PA10"))).toBeNear(0, 0.05)
    expect(await bench.level("PA10")).toBe(0)
  })

  it("pulls PA11 up with the CP2102's 25 µA CTS input, too weak to beat the pad's pull-down", async () => {
    const bench = loadsBench()
    await bench.order(Command.pulledDown, "PA11")
    expect(bench.volts(bench.run(0.005), stripPin("PA11")), "pulled down").toBeNear(divider(CP2102_INPUT_PULL_UP_OHMS, PAD_PULL_OHMS), 0.05)
    expect(await bench.level("PA11")).toBe(0)
    await bench.order(Command.outputLow, "PA11")
    await bench.order(Command.floating, "PA11")
    expect(bench.volts(bench.run(0.001), stripPin("PA11")), "let go, it rises").toBeGreaterThan(3)
  })

  it("holds PA12 high against its pull-down: the CP2102's RTS output, as the bench found it", async () => {
    const bench = loadsBench()
    await bench.order(Command.pulledDown, "PA12")
    expect(bench.volts(bench.run(0.005), stripPin("PA12"))).toBeNear(divider(CP2102_OUTPUT_HIGH_OHMS, PAD_PULL_OHMS), 0.05)
    expect(await bench.level("PA12")).toBe(1)
  })

  it("puts the bridge's CTS on a header pin of its own: fitted, it meets PA11; off, it keeps the bridge's pull-up while PA11 follows its pad", async () => {
    const bench = loadsBench()
    await bench.order(Command.outputLow, "PA11")
    expect(bench.volts(bench.run(0.005), "VCP-CTS"), "cap on: the bridge's CTS sees PA11 low").toBeNear(0, 0.05)
    bench.set({ JMP2_3: { on: false } })
    const snap = bench.run(0.005)
    expect(bench.volts(snap, "VCP-CTS"), "cap off: the bridge's own 25 µA pull-up").toBeNear(CP2102_VDD, 0.05)
    expect(bench.volts(snap, stripPin("PA11")), "PA11 still driven low").toBeNear(0, 0.05)
  })

  it("keeps the bridge's RTS high on its own pin with the cap off, while PA12 pulled down reads 0", async () => {
    const bench = loadsBench({ JMP2_4: { on: false } })
    await bench.order(Command.pulledDown, "PA12")
    const snap = bench.run(0.005)
    expect(bench.volts(snap, "VCP-RTS")).toBeNear(CP2102_VDD, 0.05)
    expect(bench.volts(snap, stripPin("PA12"))).toBeNear(0, 0.05)
    expect(await bench.level("PA12")).toBe(0)
  })

  it("lights the TX and RX LEDs with the USART1 USB out: the unpowered bridge's protection sinks them into its dead supply, PA9 and PA10 under 1 V", async () => {
    const bench = loadsBench({ USB: { on: false } })
    for (const pad of ["PA9", "PA10"]) await bench.order(Command.floating, pad)
    const snap = bench.run(EYE_SETTLED)
    expect(bench.lit(snap, "TXLED"), "TX LED").toBe(true)
    expect(bench.lit(snap, "RXLED"), "RX LED").toBe(true)
    for (const pad of ["PA9", "PA10"]) {
      const v = bench.volts(snap, stripPin(pad))
      expect(v, `${pad}: a junction above the dead rail`).toBeGreaterThan(0.3)
      expect(v, `${pad}: a junction above the dead rail`).toBeLessThan(1)
      expect(await bench.level(pad), pad).toBe(0)
    }
    expect(bench.failures).toEqual([])
  })

  it("lets go of PA11 and PA12 with the USART1 USB out: nothing pulls them up, their protection only clamps them from above", async () => {
    const bench = loadsBench({ USB: { on: false } })
    for (const pad of ["PA11", "PA12"]) {
      await bench.order(Command.pulledDown, pad)
      expect(bench.volts(bench.run(0.005), stripPin(pad)), `${pad} pulled down`).toBeLessThan(0.3)
      expect(await bench.level(pad), pad).toBe(0)
    }
  })

  it("keeps both LEDs dark with the bridge powered and the pads let go: its TXD and RXD idle high", async () => {
    const bench = loadsBench()
    for (const pad of ["PA9", "PA10"]) await bench.order(Command.floating, pad)
    const snap = bench.run(EYE_SETTLED)
    expect(bench.lit(snap, "TXLED"), "TX LED").toBe(false)
    expect(bench.lit(snap, "RXLED"), "RX LED").toBe(false)
  })
})

describe("the MIC2025's fault flag on PE3, as the pin lab found it (2026-10-12)", () => {
  const PIN_LAB = { undisturbedV: 0.8035, padHighV: 3.288 }
  const FLAG_SINK_A = (3.29 - PIN_LAB.undisturbedV) / 10e3

  it("sits at 0.80 V against its 10 kΩ with the board on the USART1 USB and the module's USB out: the flag's NMOS half on", async () => {
    const bench = loadsBench(BOARD_ON_THE_USART1_USB)
    await bench.order(Command.floating, "PE3")
    expect(bench.volts(bench.run(0.01), stripPin("PE3"))).toBeNear(PIN_LAB.undisturbedV, 0.005)
    expect(await bench.level("PE3")).toBe(0)
  })

  it("sinks a saturated 249 µA, so the pad's pull-up only lifts PE3 to 1.30 V, under VIH: it still reads 0", async () => {
    const bench = loadsBench(BOARD_ON_THE_USART1_USB)
    await bench.order(Command.pulledUp, "PE3")
    const v = bench.volts(bench.run(0.01), stripPin("PE3"))
    expect(v).toBeNear(3.29 - FLAG_SINK_A / (1 / 10e3 + 1 / PAD_PULL_OHMS), 0.01)
    expect(await bench.level("PE3")).toBe(0)
  })

  it("costs the pad driving PE3 high only the sink current through its driver, as the bench saw it (VDD − 2 mV)", async () => {
    const bench = loadsBench(BOARD_ON_THE_USART1_USB)
    await bench.order(Command.outputHigh, "PE3")
    expect(bench.volts(bench.run(0.01), stripPin("PE3"))).toBeNear(PIN_LAB.padHighV, 0.005)
  })
})

describe("JMP1: SDMMC's card detect on PC13 through a 0 Ω resistor soldered on the board, not a jumper", () => {
  it("carries PC13 to SDMMC's CD both ways, and there is no cap to take off", async () => {
    const bench = loadsBench({}, { pin: "P6-9", ohms: "10 kΩ" })
    await bench.order(Command.outputHigh, "PC13")
    expect(bench.volts(bench.run(0.005), "P6-9"), "PC13 high").toBeNear(VDD, 0.05)
    await bench.order(Command.outputLow, "PC13")
    expect(bench.volts(bench.run(0.005), "P6-9"), "PC13 low").toBeNear(0, 0.05)
    expect(board.parts.find((p) => p.id === "JMP1")?.type).toBe("link")
    expect((board.model as Element[]).some((e) => e.kind === "SW" && e.part === "JMP1")).toBe(false)
  })
})

describe("JMP5: Arduino A4 and A5", () => {
  it.each([
    ["CN3-5", "JMP5_A4", "PF7", "JMP5_A4_PB9", "PB9"],
    ["CN3-6", "JMP5_A5", "PF6", "JMP5_A5_PB8", "PB8"],
  ])("puts %s on the fitted cap's %s side (%s) and, with the cap moved, on %s (%s)", async (pin, shippedCap, shipped, movedCap, moved) => {
    const bench = loadsBench()
    await bench.order(Command.outputHigh, shipped)
    expect(bench.volts(bench.run(0.005), pin), `${shipped} high`).toBeNear(VDD, 0.05)
    await bench.order(Command.outputHigh, moved)
    await bench.order(Command.outputLow, shipped)
    expect(bench.volts(bench.run(0.005), pin), `${shipped} low, ${moved} high, its position empty`).toBeNear(0, 0.05)
    bench.set({ [shippedCap]: { on: false }, [movedCap]: { on: true } })
    expect(bench.volts(bench.run(0.005), pin), `cap moved: ${moved} high`).toBeNear(VDD, 0.05)
    expect(bench.failures).toEqual([])
  })
})

describe("VIN JMP: the empty footprint of R9, not a jumper", () => {
  it("leaves Arduino VIN unconnected, with nothing on the board to close", () => {
    const bench = loadsBench()
    const snap = bench.run(0.01)
    expect.soft(bench.volts(snap, "CN2-5"), "the 5 V beside it is up").toBeNear(5, 0.05)
    expect.soft(Number.isFinite(snap.pinVoltage[pinKey(bench.u.id, "CN2-8")]), "VIN is on no net").toBe(false)
    expect.soft(board.parts.some((p) => p.id.startsWith("VIN")), "no VIN jumper part").toBe(false)
  })
})

describe("WAKEUP (JMP6): K1 → R5 → C3 at the jumper, R6 on K1's side", () => {
  const PA0 = stripPin("PA0")

  it("lifts a floating PA0 to the full 3.3 V while K1 is held, and back to 0 V released", async () => {
    const bench = loadsBench()
    await bench.order(Command.floating, "PA0")
    bench.set({ WAKEUP: { pressed: true } })
    expect(bench.volts(bench.run(0.06), PA0), "pressed").toBeNear(VDD, 0.02)
    expect(await bench.level("PA0")).toBe(1)
    bench.set({ WAKEUP: { pressed: false } })
    expect(bench.volts(bench.run(0.03), PA0), "released").toBeNear(0, 0.02)
    expect(await bench.level("PA0")).toBe(0)
  })

  it("shows R5 in series against the pad's own pull-down", async () => {
    const bench = loadsBench()
    await bench.order(Command.pulledDown, "PA0")
    bench.set({ WAKEUP: { pressed: true } })
    expect(bench.volts(bench.run(0.03), PA0)).toBeNear(divider(10e3, PAD_PULL_OHMS), 0.05)
  })

  it("rises with R5·C3 = 1 ms and falls with (R5 + R6)·C3 = 2 ms", async () => {
    const bench = loadsBench()
    await bench.order(Command.floating, "PA0")
    const pressedAt = bench.run(0.001).time
    bench.set({ WAKEUP: { pressed: true } })
    const rising = bench.run(0.001)
    expect(bench.volts(rising, PA0), "a millisecond or so after the press").toBeNear(VDD * (1 - Math.exp(-(rising.time - pressedAt) / 1e-3)), 0.1)
    const releasedAt = bench.run(0.05).time
    bench.set({ WAKEUP: { pressed: false } })
    const falling = bench.run(0.002)
    expect(bench.volts(falling, PA0), "two milliseconds or so after the release").toBeNear(VDD * Math.exp(-(falling.time - releasedAt) / 2e-3), 0.1)
  })
})

describe("RESET and BOOT on the module", () => {
  it("lets NRST rise on the MCU's pull-up through 10 nF on each side, τ = Rpu·20 nF", () => {
    const bench = loadsBench()
    bench.set({ RESET: { pressed: true } })
    expect(bench.volts(bench.run(0.05), "CN2-3"), "held").toBeNear(0, 0.01)
    const releasedAt = bench.run(0.001).time
    bench.set({ RESET: { pressed: false } })
    const rising = bench.run(0.001)
    const tau = STM32F746IG.electrical.nrstPullUp * NRST_FARADS
    expect(bench.volts(rising, "CN2-3")).toBeNear(VDD * (1 - Math.exp(-(rising.time - releasedAt) / tau)), 0.15)
  })

  it("brings BOOT0 through MCU.R1's 10 kΩ in both positions", () => {
    const bench = loadsBench({ BOOT: { on: true } })
    const pullDown = STM32F746IG.electrical.boot0PullDown
    const system = pullDown ? divider(10e3, pullDown) : VDD
    expect(bench.volts(bench.run(0.01), "BOOT0"), "SYSTEM").toBeNear(system, 0.05)
    bench.set({ BOOT: { on: false } })
    expect(bench.volts(bench.run(0.01), "BOOT0"), "FLASH").toBeNear(0, 0.01)
  })
})
