import { beforeAll, describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { decodeI2c, decodeSpi, decodeUart } from "@/sim/protocols"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { buffer, example } from "../lib/firmware"

const UARTS = [
  ["USART1", "PB6"],
  ["USART2", "PD5"],
  ["USART3", "PD8"],
  ["UART4", "PC10"],
  ["UART5", "PC12"],
  ["USART6", "PC6"],
  ["UART7", "PE8"],
  ["UART8", "PE1"],
] as const
const SPIS = [
  ["SPI1", "PA5", "PA7", 0x11, "AF5"],
  ["SPI2", "PB13", "PB15", 0x22, "AF5"],
  ["SPI3", "PB3", "PB2", 0x33, "AF6, MOSI on AF7"],
  ["SPI4", "PE12", "PE14", 0x44, "AF5"],
  ["SPI5", "PH6", "PF11", 0x55, "AF5"],
  ["SPI6", "PG13", "PG14", 0x66, "AF5"],
] as const
const PADS_WITHOUT_SPI1 = ["PD7", "PG11"] as const
const I2CS = [
  ["I2C1", "PB8", "PB9", 0x51],
  ["I2C2", "PH4", "PH5", 0x52],
  ["I2C3", "PH7", "PH8", 0x53],
  ["I2C4", "PF14", "PF15", 0x54],
] as const
const TIMS = [
  ["TIM1", "PE9", 50, "AF1"],
  ["TIM2", "PA15", 100, "AF1"],
  ["TIM3", "PB4", 150, "AF2"],
  ["TIM4", "PD12", 200, "AF2"],
  ["TIM5", "PH10", 250, "AF2"],
  ["TIM8", "PI5", 400, "AF3"],
  ["TIM9", "PE5", 450, "AF3"],
  ["TIM10", "PF6", 500, "AF3"],
  ["TIM11", "PF7", 550, "AF3"],
  ["TIM12", "PB14", 600, "AF9"],
  ["TIM13", "PF8", 650, "AF9"],
  ["TIM14", "PF9", 700, "AF9"],
] as const

const HSI_HZ = 16e6
const UART_BAUD = 115200
const TIMER_TICK = 16 / HSI_HZ
const PWM_PERIOD = 1000 * TIMER_TICK
const INTERVAL_TOLERANCE = 2 * TIMER_TICK
const PWM_PERIODS_CHECKED = 8
const PADS_CONFIGURED_BY = 0.002
const STRIPS = /^P(18|19|20|21)-\d+$/
const STRIP_3V3 = "P20-35"
const STRIP_GND = "P18-35"
const I2C_PULL_UP = "4.7 kΩ"
const FREED_FROM_THE_BOARD = ["JMP2_1", "JMP2_2", "JMP2_3", "JMP2_4", "JMP3_1", "JMP3_2", "JMP3_3", "JMP3_4", "JMP4_1", "JMP4_2", "JMP4_3", "JMP4_4", "JMP4_5", "JMP5_A4", "JMP5_A5", "JMP6", "OTG_VBUS", "OTG_PWR", "OTG_FLG"]
const Command = { send: 1 } as const
const elf = example("open746-peripherals.elf")
const BENCH = parseElf(buffer(elf)).symbols.find((s) => s.name === "bench")!.value
const BENCH_SIZE = 24
const ALL_I2C_NACKED = (1 << I2CS.length) - 1
const I2C1_ANSWERED = ALL_I2C_NACKED & ~1
const EEPROM_STRAPPED_TO_0X51 = { A0: STRIP_3V3, A1: STRIP_GND, A2: STRIP_GND, WP: STRIP_GND, VCC: STRIP_3V3, GND: STRIP_GND }

const board = getDef("open746i-c")!
const stripPin = (pad: string) => {
  const pins = board.pins.filter((p) => STRIPS.test(p.id) && p.mcu === pad)
  expect(pins, `${pad} reaches exactly one strip contact`).toHaveLength(1)
  return pins[0].id
}
const I2C_PADS = I2CS.flatMap(([, scl, sda]) => [scl, sda])
const watched = [...UARTS.map(([, tx]) => tx), ...SPIS.flatMap(([, sck, mosi]) => [sck, mosi]), ...PADS_WITHOUT_SPI1, ...I2C_PADS, ...TIMS.map(([, pad]) => pad)]

type Recording = { store: LogicStore; timeouts: number; nacks: number; sentAt: number; end: number }
type Bench = { pullUps: boolean; watchI2c: boolean; eepromOnI2c1: boolean; workers?: boolean }
const AS_BUILT: Bench = { pullUps: true, watchI2c: true, eepromOnI2c1: false }

async function record(bench: Bench = AS_BUILT): Promise<Recording> {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-peripherals.elf", firmwareData: elf.toString("base64") }
  const added = builder(GRID)
  if (bench.pullUps)
    for (const [index, pad] of I2C_PADS.entries()) {
      const r = added.place("resistor", 90, 4 + 3 * index, { value: I2C_PULL_UP })
      added.wire(u, stripPin(pad), r, "1")
      added.wire(r, "2", u, STRIP_3V3)
    }
  if (bench.eepromOnI2c1) {
    const [, scl, sda] = I2CS[0]
    const eeprom = added.place("eeprom-24c", 100, 4, { value: "24C02" })
    added.wire(u, stripPin(scl), eeprom, "SCL")
    added.wire(u, stripPin(sda), eeprom, "SDA")
    for (const [pin, strip] of Object.entries(EEPROM_STRAPPED_TO_0X51)) added.wire(eeprom, pin, u, strip)
  }
  doc.objects.push(...added.doc.objects)
  doc.wires.push(...added.doc.wires)
  const loop = new SimLoop()
  if (bench.workers) loop.spawnCore = spawnNodeCore
  loop.setDoc(doc)
  loop.setParts({ ...doc.parts, ...Object.fromEntries(FREED_FROM_THE_BOARD.map((jumper) => [partKey(u.id, jumper), { on: false }])) })
  const probed = bench.watchI2c ? watched : watched.filter((pad) => !(I2C_PADS as readonly string[]).includes(pad))
  loop.setProbes(probed.map((pad) => ({ id: pad, a: pinKey(u.id, stripPin(pad)), b: null })))
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  loop.advance(clock)
  while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    let snap: Snapshot | null = null
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
      snap = loop.snapshot()
      if (snap?.logic) store.push(snap.logic, snap.traceProbes)
    }
    expect(snap?.mcus[u.id]?.running, "core running").toBe(true)
    expect(snap?.damage, "the peripherals damage nothing").toEqual({})
    expect(store.dropped, "the analyser keeps every edge").toBe(false)
    return snap!
  }
  const words = async () => {
    const reply = await loop.inspect(u.id, { ranges: [{ addr: BENCH, size: BENCH_SIZE }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { applied: view.getUint32(4, true), ready: view.getUint32(12, true), timeouts: view.getUint32(16, true), nacks: view.getUint32(20, true) }
  }
  const boot = run(0.02)
  if (!bench.workers) {
    expect(boot.mcus[u.id]?.firmware).toBe("open746-peripherals.elf")
    expect(boot.mcus[u.id]?.sysclk, "HSI stays at 16 MHz").toBe(HSI_HZ)
  }
  expect((await words()).ready, "every peripheral is configured").toBe(1)
  const sentAt = store.end
  const word = (value: number) => new Uint8Array(new Uint32Array([value]).buffer)
  await loop.inspect(u.id, {
    write: [
      { kind: "memory", addr: BENCH + 8, bytes: word(Command.send) },
      { kind: "memory", addr: BENCH, bytes: word(1) },
    ],
  })
  for (let tries = 0; tries < 200; tries++) {
    run(0.001)
    const state = await words()
    if (state.applied === 1) {
      run(0.002)
      loop.dispose()
      return { store, timeouts: state.timeouts, nacks: state.nacks, sentAt, end: store.end }
    }
  }
  throw new Error(`the firmware never finished sending: ${JSON.stringify(await words())}`)
}

describe("every serial and timer instance leaves the F746 on a DS10916 pad through the Open746I-C strips", () => {
  let bench: Recording
  const edges = (pad: string) => {
    const series = bench.store.edges(pad)
    expect(series, `the analyser records ${pad}`).not.toBeNull()
    return series!
  }

  beforeAll(async () => {
    bench = await record()
  })

  it("finishes every transfer without a timeout", () => {
    expect(bench.timeouts, "UART, SPI and I²C timeout bits").toBe(0)
  })

  it("latches NACKF for every unanswered address: the master reads its own released SDA as the pull-up leaves it", () => {
    expect(bench.nacks, "no device on the strips acknowledges").toBe(ALL_I2C_NACKED)
  })

  it.each(UARTS)("%s sends its name from %s at 115200 8N1", (name, tx) => {
    const frames = decodeUart(edges(tx), { baud: UART_BAUD }, bench.sentAt, bench.end)
    expect(frames.filter((f) => f.kind === "error"), `${tx} (${stripPin(tx)}) frames`).toEqual([])
    expect(String.fromCharCode(...frames.map((f) => f.value!)), `${tx} (${stripPin(tx)}) carries ${name}`).toBe(name)
  })

  it.each(SPIS)("%s clocks on %s and shifts its byte out on %s", (name, sck, mosi, byte) => {
    const clock = edges(sck)
    expect([...clock.levels].filter((level) => level === 1), `${sck} (${stripPin(sck)}) clocks eight bits`).toHaveLength(8)
    const frames = decodeSpi(clock, edges(mosi), null, null, { cpol: 0, cpha: 0 }, bench.sentAt, bench.end)
    expect(frames.filter((f) => f.kind === "error"), `${name} frames`).toEqual([])
    expect(frames.map((f) => f.value), `${mosi} (${stripPin(mosi)}) carries ${name}'s byte`).toEqual([byte])
  })

  it.each(PADS_WITHOUT_SPI1)("%s in AF5 stays silent: DS10916 gives SPI1 no line there", (pad) => {
    expect(edges(pad).count, `${pad} (${stripPin(pad)}) edges`).toBe(0)
  })

  it.each(I2CS)("%s addresses its device on %s (SCL) and %s (SDA): START, a NACK, STOP", (name, scl, sda, address) => {
    const frames = decodeI2c(edges(sda), edges(scl), bench.sentAt, bench.end)
    expect(frames.map((f) => f.text), `${name} on ${stripPin(scl)} / ${stripPin(sda)}`).toEqual(["S", `0x${address.toString(16).toUpperCase()} W N`, "P"])
  })

  it.each(TIMS)("%s CH1 on %s keeps 1 kHz with %i µs high", (name, pad, highTicks) => {
    const pwm = edges(pad)
    let periods = 0
    for (let i = 0; i + 2 < pwm.count && periods < PWM_PERIODS_CHECKED; i++) {
      if (pwm.levels[i] !== 1 || pwm.times[i] < PADS_CONFIGURED_BY) continue
      expect(pwm.levels[i + 1], `${name}: a fall follows each rise`).toBe(0)
      expect(pwm.times[i + 2] - pwm.times[i], `${name} period on ${stripPin(pad)}, s`).toBeNear(PWM_PERIOD, INTERVAL_TOLERANCE)
      expect(pwm.times[i + 1] - pwm.times[i], `${name} high time on ${stripPin(pad)}, s`).toBeNear(highTicks * TIMER_TICK, INTERVAL_TOLERANCE)
      periods++
    }
    expect(periods, `${name} periods measured`).toBe(PWM_PERIODS_CHECKED)
  })
})

describe("an I²C master reads its own lines as the bus has them, watched by the analyser or not", () => {
  const decoded = (recording: Recording, scl: string, sda: string) => decodeI2c(recording.store.edges(sda)!, recording.store.edges(scl)!, recording.sentAt, recording.end).map((f) => f.text)

  it.each([
    ["4.7 kΩ pull-ups, the bus not watched", { pullUps: true, watchI2c: false, eepromOnI2c1: false }],
    ["only the pads' own 40 kΩ pull-ups, the bus watched", { pullUps: false, watchI2c: true, eepromOnI2c1: false }],
    ["only the pads' own 40 kΩ pull-ups, the bus not watched", { pullUps: false, watchI2c: false, eepromOnI2c1: false }],
    ["only the pads' own 40 kΩ pull-ups, the bus watched, the core in a worker thread", { pullUps: false, watchI2c: true, eepromOnI2c1: false, workers: true }],
    ["4.7 kΩ pull-ups, the bus not watched, the core in a worker thread", { pullUps: true, watchI2c: false, eepromOnI2c1: false, workers: true }],
  ] as const)("NACKF on every bus with %s", async (_, setup) => {
    const recording = await record(setup)
    expect(recording.timeouts, "every transfer finishes").toBe(0)
    expect(recording.nacks, "every unanswered address NACKed").toBe(ALL_I2C_NACKED)
    if (setup.watchI2c) for (const [name, scl, sda, address] of I2CS) expect(decoded(recording, scl, sda), name).toEqual(["S", `0x${address.toString(16).toUpperCase()} W N`, "P"])
  })

  it("a 24C02 strapped to 0x51 on I2C1 answers through the pads' own pull-ups alone, and the others still NACK", async () => {
    const recording = await record({ pullUps: false, watchI2c: true, eepromOnI2c1: true })
    const [name, scl, sda, address] = I2CS[0]
    expect(recording.timeouts, "every transfer finishes").toBe(0)
    expect(decoded(recording, scl, sda), name).toEqual(["S", `0x${address.toString(16).toUpperCase()} W A`, "P"])
    expect(recording.nacks, "I2C1 acknowledged, the other three not").toBe(I2C1_ANSWERED)
  })
})
