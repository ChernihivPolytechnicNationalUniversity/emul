/**
 * The whole debugger on the ATmega328P, as the UI drives it: line breakpoints from avr-gcc's
 * DWARF, the stack unwound by its call frame information, expressions over the data space
 * (0x800000 in the debugger's addresses) and flash, values set at a stop. The program is
 * firmware/avr/debug/debug.c at -O0 and -Os (`pnpm firmware-avr`).
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ATMEGA328P } from "@/mcu/avr/chip"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { createAvr } from "@/mcu/avr/parts"
import { assignment, registerAssignment } from "@/debug/assign"
import { evaluateExpression } from "@/debug/eval"
import { DebugInfo } from "@/debug/info"
import { MemorySnapshot } from "@/debug/memory"
import type { BreakpointSpec, DebugStop, DebugWrite } from "@/debug/protocol"
import { unwind, type StackFrame } from "@/debug/unwind"
import { Pending, show } from "@/debug/values"
import { FIRMWARE, buffer } from "../lib/firmware"

const BUILD = join(FIRMWARE, "avr", "build")
const SRC = "debug/debug.c"

type Spot = { kind: "line"; line: number } | { kind: "function"; name: string }
const bp = (s: Spot, id: string): BreakpointSpec => (s.kind === "line" ? { id, kind: "line", path: SRC, line: s.line, enabled: true } : { id, kind: "function", name: s.name, enabled: true })
const names = (frames: StackFrame[]) => frames.map((f) => f.name).join(" ← ")

/** What the UI does at a stop: registers and the data space from the core, the stack unwound, expressions evaluated. */
function stopView(m: AvrMcu, di: DebugInfo) {
  const reply = m.inspect({ regs: true, ranges: [{ addr: 0x800000, size: 0x900 }] })
  const mem = new MemorySnapshot(di.firmware.segments, reply.memory)
  // As the session does: what the unwinding reached for and did not have is fetched, and the stack walked again.
  let frames = unwind(di, reply.regs!, mem)
  for (let round = 0; round < 4; round++) {
    const misses = mem.takeMisses()
    if (!misses.length) break
    for (const c of m.inspect({ ranges: misses }).memory) mem.add(c)
    frames = unwind(di, reply.regs!, mem)
  }
  const value = (expr: string, frame = 0) => {
    for (let round = 0; ; round++) {
      const f = frames[frame]
      const env = { info: di, mem, frame: f }
      let shown: string
      try {
        const v = evaluateExpression(env, { locals: f.level ? di.variablesOf(f.level) : [] }, expr)
        const s = show(env, v)
        if (!s.pending) return s.text
        shown = s.text
      } catch (e) {
        if (!(e instanceof Pending)) return `<${(e as Error).message}>`
        shown = "…"
      }
      const misses = mem.takeMisses()
      if (!misses.length || round > 4) return shown
      for (const c of m.inspect({ ranges: misses }).memory) mem.add(c)
    }
  }
  return { frames, mem, value, regs: reply.regs! }
}

describe.each(["O0", "Os"])("the AVR debugger's test program at -%s", (opt) => {
  const file = join(BUILD, `debug-${opt}.elf`)
  if (!existsSync(file)) {
    it.skip(`needs ${file}: \`pnpm firmware-avr\``, () => {})
    return
  }
  const image = readFileSync(file)
  const di = new DebugInfo(new Uint8Array(image))
  const m = createAvr(ATMEGA328P)
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: 16e6, kind: "crystal" })
  m.load(buffer(image), `debug-${opt}.elf`)
  const run = (seconds: number) => {
    const end = m.time + seconds
    while (m.time < end && !m.debugStop && m.cpu.halted === null) m.runUntil(Math.min(end, m.time + 0.002))
    return m.debugStop
  }
  const at = () => {
    const l = di.lines.lineAt(m.cpu.pc * 2)
    return l ? `${l.path.split("/").pop()}:${l.line}` : `0x${(m.cpu.pc * 2).toString(16)}`
  }
  let view: ReturnType<typeof stopView>
  let s: DebugStop | null = null
  const runTo = (spot: Spot) => {
    m.debug({ op: "breakpoints", list: [bp(spot, "here")] })
    m.debug({ op: "resume" })
    s = run(1)
    view = stopView(m, di)
    return s
  }
  const set = (expr: string, text: string, frame = 0): string | null => {
    for (let round = 0; round < 4; round++) {
      const f = view.frames[frame]
      const env = { info: di, mem: view.mem, frame: f }
      const scope = { locals: f?.level ? di.variablesOf(f.level) : [] }
      let writes: DebugWrite[]
      try {
        writes = /^(r\d+|sp|pc|sreg)$/i.test(expr) ? registerAssignment(env, scope, expr, text) : assignment(env, scope, evaluateExpression(env, scope, expr), text)
      } catch (e) {
        if (!(e instanceof Pending)) return (e as Error).message
        for (const c of m.inspect({ ranges: view.mem.takeMisses() }).memory) view.mem.add(c)
        continue
      }
      const errors = m.inspect({ write: writes }).writeErrors ?? []
      view = stopView(m, di)
      return errors.length ? errors.join("; ") : null
    }
    return "memory not read"
  }

  it("reads the image as the AVR's: DWARF lines for debug.c, a frame table", () => {
    expect(di.arch.id).toBe("avr")
    expect(di.lines.resolve(SRC, 92)?.addrs.length).toBeGreaterThan(0)
  })

  it("stops at the top of the loop", () => {
    s = runTo({ kind: "line", line: 92 })
    expect(s?.reason).toBe("breakpoint")
    expect(at()).toBe("debug.c:92")
    expect(view.regs.arch).toBe("avr")
    expect(view.frames[0]?.name).toBe("main")
  })

  const cases: [string, string | RegExp][] = [
    ["first.name", '"first"'],
    ["first.at", "{x = 1, y = -2}"],
    ["first.path[2].y", "6"],
    ["first.mode", "MODE_RUN"],
    // uint8_t is unsigned char: shown with its character, as GDB shows it.
    ["first.flags.level", "5 '\\005'"],
    ["first.flags.count", "300"],
    ["first.flags.tag", "66 'B'"],
    ["first.gain", "1.5"],
    ["first.total", "-1234567890123"],
    ["second.next->name", '"first"'],
    ["second.next == &first", "1"],
    ["&first", /^0x0080[0-9a-f]{4} <first>$/],
    ["first.combine", /^0x0000[0-9a-f]{4} <add>$/],
    ["greeting", /^0x0080[0-9a-f]{4} "hello, debugger"$/],
    ["word.real", "1.5"],
    ["word.bytes[3]", "63 '?'"],
    ["banner", '"in flash"'],
    ["sizeof(int)", "2"],
    ["sizeof(first.next)", "2"],
    ["sizeof(sample_t)", String(di.typeNamed("sample_t")?.size)],
    ["first.path[1].x * 10 + 2", "32"],
    ["MODE_FAULT - MODE_RUN", "4"],
  ]
  for (const [expr, want] of cases)
    it(`reads ${expr} as ${want}`, () => {
      if (typeof want === "string") expect(view.value(expr)).toBe(want)
      else expect(view.value(expr)).toMatch(want)
    })

  const sets: [string, string, string][] = [
    ["first.at.x", "-300", "-300"],
    ["first.flags.level", "2", "2 '\\002'"],
    ["first.mode", "MODE_FAULT", "MODE_FAULT"],
    ["first.gain", "9 / 4.0", "2.25"],
    ["first.total", "first.total + 1", "-1234567890122"],
    ["first.flags.tag", "'Z'", "90 'Z'"],
    ["first.name", '"abc"', '"abc"'],
    ["second.next", "0", "0x0"],
    ["first.path[1].y", "-7", "-7"],
  ]
  for (const [expr, text, want] of sets)
    it(`sets ${expr} = ${text}`, () => {
      expect(set(expr, text)).toBeNull()
      expect(view.value(expr)).toBe(want)
    })

  it("keeps what is beside a value set, and points second.next back at first", () => {
    expect(view.value("first.flags.ready")).toBe("1 '\\001'")
    expect(view.value("first.flags.count")).toBe("300")
    expect(set("second.next", "&first")).toBeNull()
    expect(view.value("second.next->name")).toBe('"abc"')
    expect(set("first.mode", "MODE_RUN")).toBeNull()
  })

  it("refuses to store into flash", () => {
    expect(set("banner[0]", "'X'")).toMatch(/flash/)
  })

  it(`sets w = 1000 at debug.c:96${opt === "O0" ? ", and the program goes on with it" : ""}`, () => {
    s = runTo({ kind: "line", line: 96 })
    expect(s?.reason).toBe("breakpoint")
    const total0 = BigInt(view.value("first.total"))
    const f0 = opt === "O0" ? BigInt(view.value("f")) : 0n
    const c0 = opt === "O0" ? BigInt(view.value("c")) : 0n
    const w = view.value("w")
    if (w.startsWith("<")) return expect(w).toMatch(/optimized out/)
    expect(set("w", "1000")).toBeNull()
    expect(view.value("w")).toBe("1000")
    m.debug({ op: "breakpoints", list: [] })
    m.debug({ op: "step", step: { kind: "over" } })
    run(1)
    view = stopView(m, di)
    expect(at()).toBe("debug.c:97")
    if (opt === "O0") expect(BigInt(view.value("first.total")) - total0).toBe(f0 + 1000n + c0)
  })

  it("stops in walk with its parameters and locals", () => {
    s = runTo({ kind: "line", line: 73 })
    expect(s?.reason).toBe("breakpoint")
    expect(view.frames[0]?.name).toBe("walk")
    expect(view.frames[1]?.name).toBe("main")
    expect(view.value("steps")).toMatch(/^(4|<.*>)$/)
    expect(view.value("s->name")).toBe('"abc"')
  })

  if (opt === "O0")
    describe("in the recursion", () => {
      it("stops at debug.c:61 in factorial(2), four activations under main", () => {
        s = runTo({ kind: "line", line: 61 })
        for (let i = 0; i < 3 && s?.reason === "breakpoint"; i++) {
          m.debug({ op: "resume" })
          s = run(1)
        }
        view = stopView(m, di)
        expect(at()).toBe("debug.c:61")
        const facts = view.frames.filter((f) => f.name === "factorial")
        expect(facts, names(view.frames)).toHaveLength(4)
        expect(view.frames[4]?.name, names(view.frames)).toBe("main")
        expect(facts.map((_, i) => view.value("n", i)).join(" ")).toBe("2 3 4 5")
      })

      it("steps out of two activations: back in factorial(3), then factorial(4)", () => {
        m.debug({ op: "breakpoints", list: [] })
        const out = () => {
          m.debug({ op: "step", step: { kind: "until", addr: view.frames[1].pc, sp: view.frames[0].cfa ?? undefined } })
          s = run(1)
          view = stopView(m, di)
        }
        out()
        expect(s?.reason).toBe("step")
        expect(view.value("n")).toBe("3")
        expect(view.frames.filter((f) => f.name === "factorial")).toHaveLength(3)
        out()
        expect(view.value("n")).toBe("4")
      })

      it("steps into factorial from main, onto its first statement", () => {
        runTo({ kind: "line", line: 93 })
        m.debug({ op: "breakpoints", list: [] })
        m.debug({ op: "step", step: { kind: "into" } })
        run(1)
        view = stopView(m, di)
        expect(at()).toBe("debug.c:61")
        expect(view.value("n")).toBe("5")
      })
    })

  it("stops in the Timer 0 handler, with main under it", () => {
    s = runTo({ kind: "function", name: "__vector_16" })
    expect(s?.reason).toBe("breakpoint")
    expect(view.frames[0]?.name).toBe("__vector_16")
    expect(view.frames.some((f) => f.name === "main"), names(view.frames)).toBe(true)
  })

  it("sets a register and SREG in the core", () => {
    const r24 = view.regs.r[24]
    expect(set("r24", "0x5a")).toBeNull()
    expect(view.regs.r[24]).toBe(0x5a)
    expect(set("r24", String(r24))).toBeNull()
    const sreg = view.regs.arch === "avr" ? view.regs.sreg : 0
    expect(set("sreg", String(sreg ^ 0x40))).toBeNull()
    expect(view.regs.arch === "avr" && view.regs.sreg).toBe(sreg ^ 0x40)
    expect(set("sreg", String(sreg))).toBeNull()
  })
})
