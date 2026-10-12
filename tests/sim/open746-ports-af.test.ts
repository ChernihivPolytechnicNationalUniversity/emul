import { describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { decodeSpi, decodeUart } from "@/sim/protocols"
import { buffer, example } from "../lib/firmware"

const SCHEMATIC_PINOUT = {
  "P21-31": "PE1",
  "P21-30": "PE0",
  "P18-21": "PF7",
  "P18-20": "PF8",
  "P18-23": "PF9",
  "P21-32": "PI5",
} as const
const UART_TX = "P21-31"
const UART_RX = "P21-30"
const SPI_SCK = "P18-21"
const SPI_MISO = "P18-20"
const SPI_MOSI = "P18-23"
const TIM_CH1 = "P21-32"
const UART_MESSAGE = "Open746 AF8\r\n"
const SPI_MESSAGE = [0x00, 0xff, 0x55, 0xaa, 0x81, 0x7e, 0x13, 0xc4]
const HSI_HZ = 16e6
const TIMER_TICK = 16 / HSI_HZ
const PWM_PERIOD = 1000 * TIMER_TICK
const PWM_HIGH = 250 * TIMER_TICK
const INTERVAL_TOLERANCE = 2 * TIMER_TICK
const DUTY_TOLERANCE = INTERVAL_TOLERANCE * (1 + PWM_HIGH / PWM_PERIOD) / (PWM_PERIOD - INTERVAL_TOLERANCE)
const Command = { uart: 1, spi: 2 } as const
const elf = example("open746-af.elf")
const BENCH = parseElf(buffer(elf)).symbols.find((s) => s.name === "bench")!.value
const BENCH_SIZE = 80
const FREED_FROM_THE_BOARD = ["JMP3_1", "JMP3_2", "JMP3_3", "JMP3_4", "JMP4_1", "JMP4_2", "JMP4_3", "JMP4_4", "JMP4_5", "JMP6"]

async function afBench(spiConnected = true) {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-af.elf", firmwareData: elf.toString("base64") }
  const board = getDef(u.def)!
  for (const [id, pad] of Object.entries(SCHEMATIC_PINOUT)) {
    expect(board.pins.find((p) => p.id === id), `${id} reaches ${pad}`).toMatchObject({ mcu: pad })
  }
  const load = builder(GRID)
  load.wire(u, UART_TX, u, UART_RX)
  if (spiConnected) load.wire(u, SPI_MOSI, u, SPI_MISO)
  doc.wires.push(...load.doc.wires)

  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts({
    ...doc.parts,
    ...Object.fromEntries(FREED_FROM_THE_BOARD.map((jumper) => [partKey(u.id, jumper), { on: false }])),
  })
  loop.setProbes(Object.keys(SCHEMATIC_PINOUT).map((id) => ({ id, a: pinKey(u.id, id), b: null })))
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  let sequence = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    let snap: Snapshot | null = null
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
      snap = loop.snapshot()
      expect(snap, "the circuit produces a snapshot").not.toBeNull()
      if (snap!.logic) store.push(snap!.logic, snap!.traceProbes)
    }
    expect(snap!.mcus[u.id]?.running, "core running").toBe(true)
    expect(snap!.damage, "the peripheral wiring damages nothing").toEqual({})
    expect(store.dropped, "the analyser keeps every edge").toBe(false)
    return snap!
  }
  const read = async () => {
    const reply = await loop.inspect(u.id, { ranges: [{ addr: BENCH, size: BENCH_SIZE }] })
    expect(reply, "the debugger can read the firmware bench").not.toBeNull()
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const uartCount = view.getUint32(16, true)
    const spiCount = view.getUint32(20, true)
    return {
      applied: view.getUint32(4, true),
      ready: view.getUint32(12, true),
      uartCount,
      spiCount,
      uartStatus: view.getUint32(24, true),
      spiStatus: view.getUint32(28, true),
      uart: [...bytes.slice(32, 32 + Math.min(uartCount, 32))],
      spi: [...bytes.slice(64, 64 + Math.min(spiCount, 16))],
    }
  }
  const order = async (command: number) => {
    sequence++
    const word = (value: number) => {
      const bytes = new Uint8Array(4)
      new DataView(bytes.buffer).setUint32(0, value, true)
      return bytes
    }
    await loop.inspect(u.id, {
      write: [
        { kind: "memory", addr: BENCH + 8, bytes: word(command) },
        { kind: "memory", addr: BENCH, bytes: word(sequence) },
      ],
    })
    for (let tries = 0; tries < 100; tries++) {
      run(0.001)
      const result = await read()
      if (result.applied === sequence) return result
    }
    throw new Error(`the firmware never completed AF command ${command}: ${JSON.stringify(await read())}`)
  }
  const edges = (id: string) => {
    const series = store.edges(id)
    expect(series, `the analyser records ${id}`).not.toBeNull()
    return series!
  }
  const boot = run(0.02)
  expect(boot.mcus[u.id]?.firmware).toBe("open746-af.elf")
  expect(boot.mcus[u.id]?.sysclk, "HSI stays at 16 MHz").toBe(HSI_HZ)
  expect((await read()).ready, "all three peripherals are configured").toBe(1)
  return { run, order, edges, store }
}

describe("Open746I-C alternate functions reach the pin strips", () => {
  it("UART8 sends and receives its string through PE1 P21-31 wired to PE0 P21-30, AF8 at 115200 8N1", async () => {
    const bench = await afBench()
    const result = await bench.order(Command.uart)
    expect(result.uartStatus, "no framing, parity, noise, overrun or timeout error").toBe(0)
    expect(result.uartCount).toBe(UART_MESSAGE.length)
    expect.soft(String.fromCharCode(...result.uart), "the firmware receives the bytes present on the strip").toBe(UART_MESSAGE)
    for (const id of [UART_TX, UART_RX]) {
      const frames = decodeUart(bench.edges(id), { baud: 115200 }, 0, bench.store.end)
      expect(frames.filter((frame) => frame.kind === "error"), `${id} has valid 8N1 frames`).toEqual([])
      expect(String.fromCharCode(...frames.map((frame) => frame.value!)), `${id} carries the transmitted text`).toBe(UART_MESSAGE)
    }
  })

  it.each([true, false])("SPI5 clocks bytes through PF9 P18-23 and PF8 P18-20, AF5, with loopback connected: %s", async (connected) => {
    const bench = await afBench(connected)
    const result = await bench.order(Command.spi)
    expect(result.spiStatus, "no mode fault, overrun or timeout error").toBe(0)
    expect(result.spiCount).toBe(SPI_MESSAGE.length)
    if (connected) expect.soft(result.spi, "MISO receives every MOSI byte through the strip wire").toEqual(SPI_MESSAGE)
    else {
      expect(result.spi, "without the wire MISO cannot receive the MOSI sequence").not.toEqual(SPI_MESSAGE)
      expect(result.spi, "the disconnected MISO is pulled down").toEqual(SPI_MESSAGE.map(() => 0))
    }
    const clock = bench.edges(SPI_SCK)
    expect([...clock.levels].filter((level) => level === 1), "PF7 P18-21 clocks eight bits per byte").toHaveLength(8 * SPI_MESSAGE.length)
    const frames = decodeSpi(clock, bench.edges(SPI_MOSI), bench.edges(SPI_MISO), null, { cpol: 0, cpha: 0 }, 0, bench.store.end)
    expect(frames.filter((frame) => frame.kind === "error"), "complete SPI frames").toEqual([])
    expect(frames.filter((frame) => frame.channel === 0).map((frame) => frame.value), "MOSI on the strip").toEqual(SPI_MESSAGE)
    expect.soft(frames.filter((frame) => frame.channel === 1).map((frame) => frame.value), "MISO on the strip matches the firmware").toEqual(result.spi)
    expect(frames.filter((frame) => frame.channel === 1).map((frame) => frame.value), "MISO on the strip follows the wire").toEqual(connected ? SPI_MESSAGE : SPI_MESSAGE.map(() => 0))
  })

  it("TIM8 CH1 keeps PI5 P21-32, AF3, at 1 kHz and 25% duty within two 1 µs timer ticks", async () => {
    const bench = await afBench()
    await bench.order(Command.uart)
    await bench.order(Command.spi)
    bench.run(0.025)
    const pwm = bench.edges(TIM_CH1)
    let periods = 0
    for (let i = 0; i + 2 < pwm.count; i++) {
      if (pwm.levels[i] !== 1 || pwm.times[i] < 0.005) continue
      expect(pwm.levels[i + 1], "a falling edge follows each rise").toBe(0)
      expect(pwm.levels[i + 2], "the next edge starts the next period").toBe(1)
      const period = pwm.times[i + 2] - pwm.times[i]
      const high = pwm.times[i + 1] - pwm.times[i]
      expect(period, "(PSC + 1) × (ARR + 1) / 16 MHz, seconds").toBeNear(PWM_PERIOD, INTERVAL_TOLERANCE)
      expect(high, "(PSC + 1) × CCR1 / 16 MHz, seconds").toBeNear(PWM_HIGH, INTERVAL_TOLERANCE)
      expect(high / period, "CCR1 / (ARR + 1)").toBeNear(0.25, DUTY_TOLERANCE)
      periods++
    }
    expect(periods, "PWM continues while both serial peripherals run and afterwards").toBeGreaterThanOrEqual(30)
    expect(pwm.times[pwm.count - 1], "PWM is still running at the end").toBeGreaterThan(bench.store.end - PWM_PERIOD)
  })
})
