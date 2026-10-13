import { describe, expect, it } from "vitest"
import { LogicStore } from "@/components/logic/logic-store"
import { STM32F429ZI, STM32F746IG } from "@/mcu/chip"
import { parseElf } from "@/mcu/elf"
import { Lptim } from "@/mcu/periph/lptim"
import { Rcc } from "@/mcu/periph/rcc"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import afTable from "../data/ds10916/ds10916-rev5-af.json"
import { buffer, example } from "../lib/firmware"

const REG = { ISR: 0, ICR: 4, IER: 8, CFGR: 12, CR: 16, CMP: 20, ARR: 24, CNT: 28 }
const CFGR = { CKSEL: 1, TIMOUT: 1 << 19, WAVE: 1 << 20, WAVPOL: 1 << 21, PRELOAD: 1 << 22, COUNTMODE: 1 << 23, ENC: 1 << 24 }
const FLAG = { CMPM: 1, ARRM: 2, EXTTRIG: 4, CMPOK: 8, ARROK: 16, UP: 32, DOWN: 64 }
const LPTIM1_BASE = 0x40002400
const EXTI_BASE = 0x40013c00
const EXTI_REG = { IMR: 0x00, EMR: 0x04, RTSR: 0x08, FTSR: 0x0c, SWIER: 0x10, PR: 0x14 }

function peripheral(cfgr = 0, arr = 99, cmp = 49, ier = 0, start = 4) {
  const timer = new Lptim(STM32F746IG.lptim!)
  const interrupts: number[] = []
  timer.raiseIrq = (irq) => interrupts.push(irq)
  timer.setClock(16e6, 16e6, true)
  const write = (reg: keyof typeof REG, value: number) => timer.write(REG[reg], value, 4)
  const read = (reg: keyof typeof REG) => timer.read(REG[reg], 4)
  write("CFGR", cfgr)
  write("IER", ier)
  write("CR", 1)
  write("ARR", arr)
  write("CMP", cmp)
  if (!(cfgr & CFGR.CKSEL)) timer.tick(5)
  write("CR", 1 | start)
  if (!(cfgr & CFGR.CKSEL)) timer.tick(3)
  return { timer, interrupts, write, read }
}

describe("STM32F746 LPTIM1 register and clock contract", () => {
  it("exists only on the F746, including its RCC clock mux", () => {
    const f7 = new Stm32(STM32F746IG)
    const f4 = new Stm32(STM32F429ZI)
    expect(f7.bus.peripheralAt(0x40002400)?.name).toBe("LPTIM1")
    expect(f4.lptim).toBeNull()
    expect(f4.bus.peripheralAt(0x40002400)?.name).not.toBe("LPTIM1")
    expect(f7.rcc.def(0x90)?.name).toBe("DCKCFGR2")
    expect(f4.rcc.def(0x90)).toBeUndefined()
    expect(f7.lptim!.get("ARR")).toBe(1)
    expect(f7.lptim!.registerList().map((d) => d.name)).toEqual(Object.keys(REG))
  })

  it("maps every LPTIM1 AF signal exactly as DS10916 Table 12", () => {
    const expected = afTable.flatMap((row) => Object.entries(row.af).filter(([, signal]) => signal.startsWith("LPTIM1_")).map(([af, signal]) => `${row.pin}:${af}:${signal}`)).sort()
    expect(STM32F746IG.lptim!.pads.map((p) => `${p.pad}:AF${p.af}:LPTIM1_${p.signal}`).sort()).toEqual(expected)
  })

  it("bounds NVIC registers by the chip's interrupt count", () => {
    for (const chip of [STM32F429ZI, STM32F746IG]) {
      const mcu = new Stm32(chip)
      const last = chip.id === "stm32f746ig" ? 97 : 90
      expect(mcu.bus.read(0xe000e004, 4)).toBe(chip.id === "stm32f746ig" ? 3 : 2)
      mcu.cpu.scs.raiseIrq(last)
      expect(mcu.cpu.scs.pending[last + 16]).toBe(1)
      mcu.cpu.scs.raiseIrq(last + 1)
      expect(mcu.cpu.scs.pendingCount).toBe(1)
    }
  })

  it("selects PCLK1, LSI, HSI and LSE with oscillator readiness and APB gating", () => {
    const rcc = new Rcc(STM32F746IG.lptim)
    rcc.write(0x40, 1 << 9, 4)
    rcc.write(8, 5 << 10, 4)
    const select = (source: number, stopped = false) => {
      rcc.write(0x90, source << 24, 4)
      return rcc.lptimClock(stopped).hz
    }
    expect(select(0)).toBe(4e6)
    expect(select(1)).toBe(0)
    rcc.write(0x74, 1, 4)
    expect(select(1)).toBe(32000)
    expect(select(2)).toBe(16e6)
    expect(select(3)).toBe(0)
    rcc.write(0x70, 1, 4)
    expect(select(3)).toBe(32768)
    expect(select(0, true)).toBe(0)
    expect(select(2, true)).toBe(0)
    expect(select(1, true)).toBe(32000)
    expect(select(3, true)).toBe(32768)
    rcc.write(0x40, 0, 4)
    expect(select(3)).toBe(0)
  })

  it("requires separate enable and start writes and completes ARR/CMP writes asynchronously", () => {
    const timer = new Lptim(STM32F746IG.lptim!)
    timer.setClock(16e6, 16e6, true)
    timer.write(REG.ARR, 100, 4)
    expect(timer.get("ARR")).toBe(1)
    timer.write(REG.CR, 5, 4)
    timer.tick(100)
    expect(timer.get("CNT")).toBe(0)
    timer.write(REG.ARR, 99, 4)
    timer.write(REG.CMP, 49, 4)
    expect(timer.get("ISR")).toBe(0)
    timer.tick(3)
    expect(timer.get("ISR")).toBe(FLAG.ARROK | FLAG.CMPOK)
    timer.write(REG.CR, 5, 4)
    timer.tick(2)
    expect(timer.get("CNT")).toBe(0)
    timer.tick(2)
    expect(timer.get("CNT")).toBe(1)
    expect(timer.get("CR")).toBe(1)
  })

  it("keeps ISR/CNT read-only, ICR write-one-to-clear and CFGR/IER locked while enabled", () => {
    const { timer, read, write } = peripheral()
    write("CFGR", 0xffffffff)
    write("IER", 0x7f)
    write("CNT", 555)
    write("ISR", 0)
    expect(read("CFGR")).toBe(0)
    expect(read("IER")).toBe(0)
    expect(read("CNT")).toBe(0)
    write("ICR", FLAG.ARROK)
    expect(read("ISR")).toBe(FLAG.CMPOK)
    expect(read("ICR")).toBe(0)
    timer.write(REG.CR, 0, 2)
    expect(read("CR")).toBe(1)
    write("CR", 0)
    write("CFGR", 0xffffffff)
    expect(read("CFGR")).toBe(0x01feeedf)
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])("divides the counter clock by PRESC encoding %i", (presc) => {
    const { timer, read } = peripheral(presc << 9)
    timer.tick(40 * (1 << presc))
    expect(read("CNT")).toBe(40)
    timer.tick(60 * (1 << presc))
    expect(read("CNT")).toBe(0)
  })

  it("delays preloaded ARR/CMP changes until the current period ends", () => {
    const { timer, read, write } = peripheral(CFGR.PRELOAD, 99, 49)
    timer.tick(60)
    expect(timer.level).toBe(true)
    write("ARR", 199)
    write("CMP", 149)
    timer.tick(40)
    expect(read("CNT")).toBe(0)
    expect(timer.level).toBe(false)
    timer.tick(149)
    expect(timer.level).toBe(false)
    timer.tick(1)
    expect(timer.level).toBe(true)
    timer.tick(50)
    expect(read("CNT")).toBe(0)
  })

  it("applies immediate ARR changes after synchronization without waiting for a wrap", () => {
    const { timer, read, write } = peripheral(0, 99, 49)
    timer.tick(10)
    write("ARR", 199)
    timer.tick(90)
    expect(read("CNT")).toBe(100)
    timer.tick(100)
    expect(read("CNT")).toBe(0)
  })

  it("switches between continuous and single counting without restarting the period", () => {
    const { timer, read, write } = peripheral()
    timer.tick(25)
    write("CR", 3)
    expect(read("CNT")).toBe(25)
    timer.tick(100)
    expect(read("CNT")).toBe(0)
    write("CR", 3)
    timer.tick(28)
    expect(read("CNT")).toBe(25)
    write("CR", 5)
    timer.tick(100)
    expect(read("CNT")).toBe(25)
  })

  it("does not assert a retroactive interrupt when an old flag is enabled", () => {
    const { interrupts, read, write } = peripheral()
    expect(read("ISR") & FLAG.ARROK).toBe(FLAG.ARROK)
    write("CR", 0)
    write("IER", FLAG.ARROK)
    expect(interrupts).toEqual([])
  })

  it.each([0, 1, 2])("decodes both encoder inputs with CKPOL=%i and wraps in either direction", (polarity) => {
    const { timer, read, write } = peripheral(CFGR.ENC | (polarity << 1), 7, 3, FLAG.UP | FLAG.DOWN)
    const sequence = (levels: number[]) => {
      for (const level of levels) {
        timer.pinEdge("IN1", !!(level & 1))
        timer.pinEdge("IN2", !!(level & 2))
        timer.tick(2)
      }
    }
    sequence([1, 3, 2, 0])
    expect(read("CNT")).toBe(polarity === 2 ? 4 : 2)
    sequence([2, 3, 1, 0])
    expect(read("CNT")).toBe(0)
    expect(read("ISR") & FLAG.DOWN).toBe(FLAG.DOWN)
    write("ICR", 0x7f)
    sequence([2, 3, 1, 0])
    expect(read("CNT")).toBe(polarity === 2 ? 4 : 6)
    expect(read("ISR") & FLAG.ARRM).toBe(FLAG.ARRM)
    sequence([1, 3, 2, 0])
    expect(read("CNT")).toBe(0)
    expect(read("ISR") & FLAG.UP).toBe(FLAG.UP)
  })

  it.each([0, CFGR.WAVPOL])("produces one pulse or a latched set-once output with polarity %i", (polarity) => {
    for (const wave of [0, CFGR.WAVE]) {
      const { timer, read } = peripheral(polarity | wave, 99, 49, 0, 2)
      expect(timer.level).toBe(!!polarity)
      timer.tick(50)
      expect(timer.level).toBe(!polarity)
      timer.tick(1000)
      expect(timer.level).toBe(!!polarity !== !!wave)
      expect(read("CNT")).toBe(0)
      expect(read("ISR") & 3).toBe(3)
    }
  })

  it.each([0, 1, 2])("selects rising, falling or both external counter edges with CKPOL=%i", (polarity) => {
    const { timer, read } = peripheral(CFGR.COUNTMODE | (polarity << 1), 999, 499)
    for (let i = 0; i < 10; i++) {
      timer.pinEdge("IN1", true)
      timer.tick(2)
      timer.pinEdge("IN1", false)
      timer.tick(2)
    }
    expect(read("CNT")).toBe(polarity === 2 ? 20 : 10)
  })

  it("counts an external kernel clock without any internal oscillator, losing the first five edges", () => {
    const { timer, read } = peripheral(CFGR.CKSEL, 99, 49)
    timer.setClock(0, 16e6, true)
    for (let i = 0; i < 20; i++) {
      timer.pinEdge("IN1", true)
      timer.pinEdge("IN1", false)
    }
    expect(read("CNT")).toBe(15)
    expect(read("ISR") & (FLAG.ARROK | FLAG.CMPOK)).toBe(FLAG.ARROK | FLAG.CMPOK)
  })

  it("prescales the falling-edge external kernel clock", () => {
    const { timer, read } = peripheral(CFGR.CKSEL | (1 << 1) | (2 << 9))
    timer.setClock(0, 16e6, true)
    for (let i = 0; i < 25; i++) {
      timer.pinEdge("IN1", true)
      timer.pinEdge("IN1", false)
    }
    expect(read("CNT")).toBe(5)
  })

  it.each([1, 2, 3])("rejects input glitches shorter than CKFLT=%i requires", (filter) => {
    const { timer, read } = peripheral(CFGR.COUNTMODE | (filter << 3), 99, 49)
    const samples = 1 << filter
    timer.pinEdge("IN1", true)
    timer.tick(samples - 1)
    timer.pinEdge("IN1", false)
    timer.tick(samples + 1)
    expect(read("CNT")).toBe(0)
    timer.pinEdge("IN1", true)
    timer.tick(samples)
    expect(read("CNT")).toBe(1)
  })

  it.each([1, 2, 3])("filters the external trigger with TRGFLT=%i and synchronizes its start", (filter) => {
    const { timer, read } = peripheral((1 << 17) | (filter << 6))
    const samples = 1 << filter
    timer.pinEdge("ETR", true)
    timer.tick(samples - 1)
    timer.pinEdge("ETR", false)
    timer.tick(20)
    expect(read("ISR") & FLAG.EXTTRIG).toBe(0)
    timer.pinEdge("ETR", true)
    timer.tick(samples)
    expect(read("ISR") & FLAG.EXTTRIG).toBe(FLAG.EXTTRIG)
    expect(read("CNT")).toBe(0)
    timer.tick(2)
    expect(read("CNT")).toBe(0)
    timer.tick(1)
    expect(read("CNT")).toBe(1)
  })

  it("ignores a trigger while counting unless TIMOUT restarts it", () => {
    for (const timeout of [0, CFGR.TIMOUT]) {
      const { timer, read, write } = peripheral((1 << 17) | timeout)
      timer.pinEdge("ETR", true)
      timer.tick(22)
      expect(read("CNT")).toBe(20)
      write("ICR", FLAG.EXTTRIG)
      timer.pinEdge("ETR", false)
      timer.pinEdge("ETR", true)
      expect(read("CNT")).toBe(timeout ? 0 : 20)
      expect(read("ISR") & FLAG.EXTTRIG).toBe(timeout ? FLAG.EXTTRIG : 0)
    }
  })

  it("rearms triggered one-shots but ignores later triggers in set-once mode", () => {
    for (const wave of [0, CFGR.WAVE]) {
      const { timer, read, write } = peripheral((1 << 17) | wave, 9, 4, 0, 2)
      timer.pinEdge("ETR", true)
      timer.tick(22)
      write("ICR", 0x7f)
      timer.pinEdge("ETR", false)
      timer.pinEdge("ETR", true)
      timer.tick(5)
      expect(read("CNT")).toBe(wave ? 0 : 3)
      expect(read("ISR") & FLAG.EXTTRIG).toBe(wave ? 0 : FLAG.EXTTRIG)
    }
  })

  it.each([1, 2, 3])("selects the trigger edge with TRIGEN=%i", (polarity) => {
    const { timer, read, write } = peripheral((polarity << 17) | CFGR.TIMOUT)
    timer.pinEdge("ETR", true)
    expect(read("ISR") & FLAG.EXTTRIG).toBe(polarity === 2 ? 0 : FLAG.EXTTRIG)
    write("ICR", FLAG.EXTTRIG)
    timer.tick(5)
    timer.pinEdge("ETR", false)
    expect(read("ISR") & FLAG.EXTTRIG).toBe(polarity === 1 ? 0 : FLAG.EXTTRIG)
  })

  it("reports unavailable RTC tamper triggers and reserved selections", () => {
    for (let source = 3; source < 8; source++) {
      const timer = new Lptim(STM32F746IG.lptim!)
      const unsupported: string[] = []
      timer.onUnsupported = (what) => unsupported.push(what)
      timer.setClock(16e6, 16e6, true)
      timer.write(REG.CFGR, (source << 13) | (1 << 17), 4)
      timer.write(REG.CR, 1, 4)
      expect(unsupported).toHaveLength(1)
      expect(unsupported[0]).toContain(source < 6 ? "RTC_TAMP" : "reserved")
    }
  })
})

const elf = example("open746-lptim.elf")
const benchAddress = parseElf(buffer(elf)).symbols.find((s) => s.name === "bench")!.value
const STOP = { masked: 0, wfiInterrupt: 1, wfeEvent: 2, wfeMasked: 3 } as const
const fields = { request: 0, applied: 1, command: 2, cfgr: 3, source: 4, arr: 5, cmp: 6, start: 7, ier: 8, argument: 9, ready: 10, count: 11, flags: 12, irqFlags: 13, irqCount: 14, woke: 21, timeouts: 22, irqWakeupPending: 23, wakeupPending: 24 }
const BENCH_WORDS = 25
const EXTI_LINE_23 = 1 << 23
const board = getDef("open746i-c")!
const stripPin = (pad: string) => board.pins.find((p) => /^P(18|19|20|21)-\d+$/.test(p.id) && p.mcu === pad)!.id

async function boardBench(alternate = false) {
  const doc = lab1Board.build(GRID)
  const mcu = doc.objects.find((o) => o.def === "open746i-c")!
  mcu.props = { ...mcu.props, firmware: "open746-lptim.elf", firmwareData: elf.toString("base64") }
  const added = builder(GRID)
  const targets = alternate ? ["PG12", "PH2", "PG14"] : ["PD12", "PE1", "PE0"]
  for (const [index, source] of ["PC6", "PC7", "PC8"].entries()) added.wire(mcu, stripPin(source), mcu, stripPin(targets[index]))
  doc.wires.push(...added.doc.wires)
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts({ ...doc.parts, ...Object.fromEntries(["JMP2_1", "JMP2_2", "JMP2_3", "JMP2_4", "JMP3_1", "JMP3_2", "JMP3_3", "JMP3_4", "JMP4_1", "JMP4_2", "JMP4_3", "JMP4_4", "JMP4_5", "JMP5_A4", "JMP5_A5", "JMP6", "OTG_VBUS", "OTG_PWR", "OTG_FLG"].map((name) => [partKey(mcu.id, name), { on: false }])) })
  loop.setProbes(["PD13", "PG13", "PC6", "PC7", "PC8"].map((pad) => ({ id: pad, a: pinKey(mcu.id, stripPin(pad)), b: null })))
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  let request = 0
  loop.advance(clock)
  while (loop.booting) await new Promise((resolve) => setTimeout(resolve, 10))
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
      const snap = loop.snapshot()!
      if (snap.logic) store.push(snap.logic, snap.traceProbes)
      expect(snap.mcus[mcu.id]?.running).toBe(true)
      expect(snap.damage).toEqual({})
    }
    expect(store.dropped).toBe(false)
  }
  const wordsAt = async (addr: number, count: number) => {
    const reply = await loop.inspect(mcu.id, { ranges: [{ addr, size: count * 4 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: count }, (_, index) => view.getUint32(index * 4, true))
  }
  const words = () => wordsAt(benchAddress, BENCH_WORDS)
  const register = async (addr: number) => (await wordsAt(addr, 1))[0]
  const send = async (cmd: number, values: Partial<Record<keyof typeof fields, number>> = {}, seconds = 0.01) => {
    await loop.inspect(mcu.id, { write: Object.entries({ ...values, command: cmd, request: ++request }).map(([field, value]) => ({ kind: "memory" as const, addr: benchAddress + 4 * fields[field as keyof typeof fields], bytes: new Uint8Array(new Uint32Array([value]).buffer) })) })
    run(seconds)
    return words()
  }
  const command = async (cmd: number, values: Partial<Record<keyof typeof fields, number>> = {}, seconds = 0.01) => {
    const result = await send(cmd, values, seconds)
    expect(result[fields.applied], `firmware command ${cmd}, flags ${result[fields.flags]}`).toBe(request)
    expect(result[fields.timeouts]).toBe(0)
    return result
  }
  run(0.02)
  expect((await words())[fields.ready]).toBe(1)
  return { loop, store, run, send, command, words, register }
}

describe("LPTIM1 firmware on the Open746I-C strips", () => {
  it.each([
    ["PCLK1", 0, 4e6, 3, 499, 124],
    ["LSI", 1, 32000, 0, 127, 31],
    ["HSI", 2, 16e6, 5, 499, 124],
    ["LSE", 3, 32768, 0, 127, 31],
  ] as const)("outputs PWM on PD13 and PG13 from %s with the configured frequency and duty", async (_, source, hz, presc, arr, cmp) => {
    const bench = await boardBench()
    await bench.command(1, { source, cfgr: presc << 9, arr, cmp, start: 4 }, source === 3 ? 2.1 : 0.02)
    const after = bench.store.end
    bench.run(0.05)
    for (const pad of ["PD13", "PG13"]) {
      const edges = bench.store.edges(pad)!
      let checked = 0
      for (let i = 0; i + 2 < edges.count && checked < 8; i++) {
        if (edges.times[i] < after || edges.levels[i] !== 1) continue
        expect(edges.times[i + 2] - edges.times[i], `${pad} period`).toBeNear((arr + 1) * (1 << presc) / hz, 2e-6)
        expect(edges.times[i + 1] - edges.times[i], `${pad} high time`).toBeNear((arr - cmp) * (1 << presc) / hz, 2e-6)
        checked++
      }
      expect(checked).toBe(8)
    }
    bench.loop.setRunning(false)
  })

  it.each([false, true])("counts external clock pulses and quadrature through both AF pad groups (alternate=%s)", async (alternate) => {
    const bench = await boardBench(alternate)
    await bench.command(1, { source: 0, cfgr: CFGR.CKSEL, arr: 999, cmp: 499, start: 4 })
    expect((await bench.command(10, { argument: 25 }))[fields.count]).toBe(20)
    await bench.command(1, { cfgr: CFGR.ENC | (2 << 1), arr: 999, cmp: 499, start: 4, ier: FLAG.UP | FLAG.DOWN })
    expect((await bench.command(9, { argument: 7 }))[fields.count]).toBe(28)
    const reverse = await bench.command(9, { argument: 0x80000003 })
    expect(reverse[fields.count]).toBe(16)
    expect(reverse[fields.irqFlags] & FLAG.DOWN).toBe(FLAG.DOWN)
    const forward = await bench.command(9, { argument: 2 })
    expect(forward[fields.count]).toBe(24)
    expect(forward[fields.irqFlags] & (FLAG.UP | FLAG.DOWN)).toBe(FLAG.UP | FLAG.DOWN)
    bench.loop.setRunning(false)
  })

  it.each([0, CFGR.WAVE])("generates one-pulse/set-once from ETR and services the real NVIC vector (WAVE=%i)", async (wave) => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: wave | (1 << 17), arr: 127, cmp: 31, start: 2, ier: 0x1f })
    const after = bench.store.end
    await bench.command(11, { argument: 1 })
    const result = await bench.command(2)
    expect(result[fields.count]).toBe(0)
    expect(result[fields.irqFlags] & 0x1f).toBe(0x1f)
    for (let flag = 0; flag < 5; flag++) expect(result[14 + flag]).toBeGreaterThan(0)
    expect(result[fields.flags] & 0x1f).toBe(0)
    const edges = bench.store.edges("PD13")!
    const pulse = Array.from({ length: edges.count }, (_, i) => ({ at: edges.times[i], high: edges.levels[i] })).filter((edge) => edge.at > after)
    expect(pulse.map((edge) => edge.high)).toEqual(wave ? [1] : [1, 0])
    if (!wave) expect(pulse[1].at - pulse[0].at).toBeNear(96 / 32000, 2e-6)
    bench.loop.setRunning(false)
  })

  it.each([1, 2])("starts from RTC alarm trigger selection %i", async (select) => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: (select << 13) | (1 << 17), arr: 127, cmp: 31, start: 2, ier: FLAG.EXTTRIG })
    const result = await bench.command(12, { argument: select - 1 })
    expect(result[fields.irqFlags] & FLAG.EXTTRIG).toBe(FLAG.EXTTRIG)
    bench.loop.setRunning(false)
  })

  it.each([1, 3])("runs from low-speed clock selection %i during Stop and wakes firmware through EXTI line 23 and its compare interrupt", async (source) => {
    const bench = await boardBench()
    const hz = source === 1 ? 32000 : 32768
    await bench.command(1, { source, cfgr: 0, arr: hz - 1, cmp: hz / 2 - 1, start: 2, ier: FLAG.CMPM }, source === 3 ? 2.1 : 0.01)
    const result = await bench.command(6, { argument: 1 }, 0.6)
    expect.soft(result[fields.woke], "woken from Stop once").toBe(1)
    expect.soft(result[fields.irqFlags] & FLAG.CMPM, "CMPM serviced by the LPTIM1 handler").toBe(FLAG.CMPM)
    expect.soft(result[fields.irqWakeupPending], "EXTI PR23 pending when the handler ran").toBe(EXTI_LINE_23)
    expect.soft(result[fields.wakeupPending], "EXTI PR23 cleared by the handler's write of 1").toBe(0)
    bench.loop.setRunning(false)
  })

  it("stays in Stop when EXTI line 23 is masked, though LPTIM1 keeps counting and flags its compare match", async () => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: 0, arr: 31999, cmp: 15999, start: 2, ier: FLAG.CMPM })
    const result = await bench.send(6, { argument: 0 }, 1.2)
    expect.soft(result[fields.applied], "the Stop command never returns").toBe(result[fields.request] - 1)
    expect.soft(result[fields.woke], "not woken from Stop").toBe(0)
    expect.soft(result[fields.irqCount], "CMPM handler never entered").toBe(0)
    expect.soft((await bench.register(LPTIM1_BASE + REG.ISR)) & (FLAG.CMPM | FLAG.ARRM), "LPTIM1 reached compare and autoreload in Stop").toBe(FLAG.CMPM | FLAG.ARRM)
    expect.soft((await bench.register(EXTI_BASE + EXTI_REG.PR)) & EXTI_LINE_23, "EXTI PR23 stays clear with IMR23 masked").toBe(0)
    bench.loop.setRunning(false)
  })

  it("wakes a WFE from Stop through EXTI line 23's event mask alone, with no pending bit, then takes the compare interrupt", async () => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: 0, arr: 31999, cmp: 15999, start: 2, ier: FLAG.CMPM })
    const result = await bench.command(6, { argument: STOP.wfeEvent }, 0.6)
    expect.soft(result[fields.woke], "woken from Stop once").toBe(1)
    expect.soft(result[fields.irqWakeupPending], "an event sets no EXTI PR23").toBe(0)
    expect.soft(result[fields.irqFlags] & FLAG.CMPM, "CMPM serviced once awake").toBe(FLAG.CMPM)
    bench.loop.setRunning(false)
  })

  it("keeps a WFE in Stop when EXTI line 23's event mask is clear too", async () => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: 0, arr: 31999, cmp: 15999, start: 2, ier: FLAG.CMPM })
    const result = await bench.send(6, { argument: STOP.wfeMasked }, 1.2)
    expect.soft(result[fields.woke], "not woken from Stop").toBe(0)
    expect.soft(result[fields.irqCount], "CMPM handler never entered").toBe(0)
    expect.soft((await bench.register(LPTIM1_BASE + REG.ISR)) & FLAG.CMPM, "LPTIM1 reached compare in Stop").toBe(FLAG.CMPM)
    bench.loop.setRunning(false)
  })

  it("services LPTIM1's interrupt in Run mode through NVIC position 93 whether EXTI line 23 is masked or not", async () => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: 0, arr: 127, cmp: 31, start: 2, ier: FLAG.CMPM })
    const result = await bench.command(2, {}, 0.01)
    expect.soft(result[fields.irqFlags] & FLAG.CMPM, "CMPM serviced with IMR23 masked").toBe(FLAG.CMPM)
    expect.soft(result[fields.irqWakeupPending], "EXTI PR23 never set with IMR23 masked").toBe(0)
    bench.loop.setRunning(false)
  })

  it("gates the kernel clock and resets the peripheral through RCC from firmware", async () => {
    const bench = await boardBench()
    await bench.command(1, { source: 1, cfgr: 0, arr: 127, cmp: 31, start: 4 })
    await bench.command(7)
    const pausedEdges = bench.store.edges("PD13")!.count
    bench.run(0.02)
    expect(bench.store.edges("PD13")!.count).toBe(pausedEdges)
    await bench.command(7)
    expect(bench.store.edges("PD13")!.count).toBeGreaterThan(pausedEdges)
    const result = await bench.command(8)
    expect(result[fields.count]).toBe(0)
    expect(result[fields.flags]).toBe(0)
    const resetEdges = bench.store.edges("PD13")!.count
    bench.run(0.02)
    expect(bench.store.edges("PD13")!.count).toBe(resetEdges)
    bench.loop.setRunning(false)
  })
})

describe("LPTIM1 inputs sampled from their pads when the timer is configured and enabled", () => {
  const LPTIM1 = 0x40002400
  const GPIOD = 0x40020c00
  const GPIOE = 0x40021000
  const pd12 = parsePad("PD12")!
  const pe1 = parsePad("PE1")!

  function pulledUpInputs(cfgr: number) {
    const mcu = new Stm32(STM32F746IG)
    mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
    mcu.run(1e-5)
    const w = (addr: number, value: number) => mcu.bus.write(addr >>> 0, value >>> 0, 4)
    const r = (addr: number) => mcu.bus.read(addr >>> 0, 4) >>> 0
    const afPullUp = (port: number, pin: number) => {
      w(port + 0x0c, (r(port + 0x0c) & ~(3 << (2 * pin))) | (1 << (2 * pin)))
      const afr = port + (pin < 8 ? 0x20 : 0x24)
      const shift = 4 * (pin & 7)
      w(afr, (r(afr) & ~(0xf << shift)) | (3 << shift))
      w(port, (r(port) & ~(3 << (2 * pin))) | (2 << (2 * pin)))
    }
    w(0x40023830, r(0x40023830) | (1 << 3) | (1 << 4))
    w(0x40023840, r(0x40023840) | (1 << 9))
    afPullUp(GPIOD, 12)
    afPullUp(GPIOE, 1)
    w(LPTIM1 + REG.CFGR, cfgr)
    w(LPTIM1 + REG.CR, 1)
    mcu.run(1e-4)
    w(LPTIM1 + REG.ARR, 1000)
    mcu.run(1e-4)
    w(LPTIM1 + REG.CR, 5)
    mcu.run(1e-4)
    const count = () => r(LPTIM1 + REG.CNT)
    const edges = (sequence: [typeof pd12, boolean][]) => {
      sequence.forEach(([pad, level], i) => mcu.setPadAt(pad, level, mcu.time + (i + 1) * 1e-5))
      mcu.run((sequence.length + 2) * 1e-5)
    }
    return { mcu, count, edges }
  }

  it("counts the first falling edge of a pulled-up IN1 (COUNTMODE, CKPOL = falling)", () => {
    const { mcu, count, edges } = pulledUpInputs(CFGR.COUNTMODE | (1 << 1))
    expect(mcu.gpio[3].inputLevel(12)).toBe(true)
    expect(count()).toBe(0)
    edges([[pd12, false]])
    expect(count()).toBe(1)
    edges([
      [pd12, true],
      [pd12, false],
    ])
    expect(count()).toBe(2)
  })

  it("counts all four transitions of an encoder that rests at IN1 = IN2 = 1", () => {
    const { count, edges } = pulledUpInputs(CFGR.ENC | (2 << 1))
    edges([
      [pd12, false],
      [pe1, false],
      [pd12, true],
      [pe1, true],
    ])
    expect(count()).toBe(4)
  })
})

describe("EXTI line 23, LPTIM1's asynchronous event (RM0385 §11.8, Table 18)", () => {
  const RCC_APB1ENR = 0x40023840
  const APB1ENR_LPTIM1EN = 1 << 9
  const LPTIM1_IRQ = STM32F746IG.lptim!.irq

  function idleF746() {
    const mcu = new Stm32(STM32F746IG)
    mcu.load(buffer(example("adc-idle.elf")), "adc-idle.elf")
    mcu.run(1e-5)
    const w = (addr: number, value: number) => mcu.bus.write(addr >>> 0, value >>> 0, 4)
    const r = (addr: number) => mcu.bus.read(addr >>> 0, 4) >>> 0
    return { mcu, w, r }
  }

  it("holds line 23 in every EXTI register on the F746 and stops at line 22 on the F429", () => {
    for (const [chip, lines] of [
      [STM32F429ZI, 0x7fffff],
      [STM32F746IG, 0xffffff],
    ] as const) {
      const mcu = new Stm32(chip)
      for (const reg of ["IMR", "EMR", "RTSR", "FTSR"] as const) {
        mcu.bus.write(EXTI_BASE + EXTI_REG[reg], 0xffffffff, 4)
        expect.soft(mcu.bus.read(EXTI_BASE + EXTI_REG[reg], 4) >>> 0, `${chip.id} ${reg} implements lines 0…${chip === STM32F746IG ? 23 : 22}`).toBe(lines)
      }
    }
  })

  it("pends PR23 on a software trigger and clears it, with SWIER23, by writing 1", () => {
    const { w, r } = idleF746()
    w(EXTI_BASE + EXTI_REG.IMR, EXTI_LINE_23)
    w(EXTI_BASE + EXTI_REG.SWIER, EXTI_LINE_23)
    expect.soft(r(EXTI_BASE + EXTI_REG.PR), "PR23 set by SWIER23").toBe(EXTI_LINE_23)
    expect.soft(r(EXTI_BASE + EXTI_REG.SWIER), "SWIER23 held while PR23 is pending").toBe(EXTI_LINE_23)
    w(EXTI_BASE + EXTI_REG.PR, 0)
    expect.soft(r(EXTI_BASE + EXTI_REG.PR), "writing 0 leaves PR23").toBe(EXTI_LINE_23)
    w(EXTI_BASE + EXTI_REG.PR, EXTI_LINE_23)
    expect.soft(r(EXTI_BASE + EXTI_REG.PR), "PR23 cleared by writing 1").toBe(0)
    expect.soft(r(EXTI_BASE + EXTI_REG.SWIER), "SWIER23 cleared with it").toBe(0)
  })

  it.each([
    ["unmasked", EXTI_LINE_23],
    ["masked", 0],
  ] as const)("pends LPTIM1's own NVIC position 93 in Run mode with line 23 %s, and PR23 only through IM23", (_, imr) => {
    const { mcu, w, r } = idleF746()
    w(RCC_APB1ENR, r(RCC_APB1ENR) | APB1ENR_LPTIM1EN)
    w(EXTI_BASE + EXTI_REG.IMR, imr)
    w(EXTI_BASE + EXTI_REG.RTSR, EXTI_LINE_23)
    w(LPTIM1_BASE + REG.IER, FLAG.CMPM)
    w(LPTIM1_BASE + REG.CR, 1)
    mcu.run(1e-5)
    w(LPTIM1_BASE + REG.ARR, 99)
    w(LPTIM1_BASE + REG.CMP, 49)
    mcu.run(1e-5)
    w(LPTIM1_BASE + REG.CR, 5)
    mcu.run(1e-4)
    expect.soft(r(LPTIM1_BASE + REG.ISR) & FLAG.CMPM, "CMPM raised").toBe(FLAG.CMPM)
    expect.soft(mcu.cpu.scs.pending[16 + LPTIM1_IRQ], "LP Timer1 global interrupt pending at NVIC position 93").toBe(1)
    expect.soft(r(EXTI_BASE + EXTI_REG.PR) & EXTI_LINE_23, "PR23 follows IM23").toBe(imr)
    w(EXTI_BASE + EXTI_REG.PR, EXTI_LINE_23)
    expect.soft(r(EXTI_BASE + EXTI_REG.PR) & EXTI_LINE_23, "PR23 cleared by writing 1").toBe(0)
  })
})
