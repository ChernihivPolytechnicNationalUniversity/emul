/**
 * The debugger: DWARF read off the example images, breakpoints on source lines and functions,
 * stepping by line and by instruction, call stacks, variables and expressions, fault catch,
 * BKPT; values set at a stop — on a bare core, through the circuit with the bench freezing on a
 * stop, and with the core in a worker thread. Last, the debugger settings a schematic file
 * brings, repaired as the document loads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { STM32F429ZI } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { DebugInfo } from "@/debug/info"
import { assignment, registerAssignment } from "@/debug/assign"
import { evaluateExpression, Pending } from "@/debug/eval"
import { MemorySnapshot } from "@/debug/memory"
import type { BreakpointSpec, DebugStop, DebugWrite, StepRequest } from "@/debug/protocol"
import { normalizeDebug } from "@/debug/saved"
import { unwind } from "@/debug/unwind"
import { leBytes, show } from "@/debug/values"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { buffer, example } from "../lib/firmware"

/** Omit over each kind of a union, not only the keys the kinds share. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Spot = Without<BreakpointSpec, "id" | "enabled">

const bp = (spec: Spot, id = "b1") => ({ ...spec, id, enabled: true }) as BreakpointSpec
const names = (frames: { name: string; interruptedBy: string | null }[]) => frames.map((f) => (f.interruptedBy ? `[${f.interruptedBy}] ` : "") + f.name).join(" ← ")

const blinkElf = example("nucleo-blink.elf")
const info = new DebugInfo(new Uint8Array(blinkElf))

/** A bare F429 with the blink image, as the debugger drives it: run until it stops, step. */
function bareBlink() {
  const mcu = new Stm32(STM32F429ZI)
  mcu.setClockSources({ hz: 8e6, kind: "clock", startup: 0 }, null)
  mcu.load(buffer(blinkElf), "nucleo-blink.elf")
  const where = () => {
    const l = info.lines.lineAt(mcu.cpu.pc)
    return l ? `${l.path.split("/").pop()}:${l.line}` : `0x${mcu.cpu.pc.toString(16)}`
  }
  /** Run until the core stops for the debugger, at most `seconds` of its time. */
  const runToStop = (seconds: number) => {
    const end = mcu.time + seconds
    while (mcu.time < end && !mcu.debugStop && mcu.cpu.halted === null) mcu.runUntil(Math.min(end, mcu.time + 0.002))
    return mcu.debugStop
  }
  const step = (s: StepRequest, seconds = 2) => {
    mcu.debug({ op: "step", step: s })
    return runToStop(seconds)
  }
  return { mcu, where, runToStop, step }
}

describe("blink on a bare F429: breakpoints and steps", () => {
  const { mcu, where, runToStop, step } = bareBlink()
  let stop: DebugStop | null = null
  let t0 = 0

  it("resolves main.c:27 to one address and stops there", () => {
    mcu.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "Src/main.c", line: 27 })] })
    expect(mcu.debugger.addresses()).toHaveLength(1)
    stop = runToStop(2)
    expect(stop?.reason).toBe("breakpoint")
    expect(stop?.breakpoint).toBe("b1")
    expect(where()).toBe("main.c:27")
  })

  it("steps over line by line: main.c:28, main.c:29", () => {
    t0 = mcu.time
    stop = step({ kind: "over" })
    expect(stop?.reason).toBe("step")
    expect(where()).toBe("main.c:28")
    step({ kind: "over" })
    expect(where()).toBe("main.c:29")
  })

  it("steps over HAL_Delay(500): the loop's branch back on main.c:25, 500 ms later", () => {
    // At -O2 the loop's branch back is a statement of `while (1)` of its own, as GDB shows it too.
    stop = step({ kind: "over" })
    expect(stop?.reason).toBe("step")
    expect(where()).toBe("main.c:25")
    expect(mcu.time - t0).toBeNear(0.5, 0.01)
  })

  it("steps over to main.c:27, where the breakpoint is", () => {
    step({ kind: "over" })
    expect(where()).toBe("main.c:27")
  })

  it("steps into HAL_GPIO_TogglePin, onto the first statement of its body", () => {
    step({ kind: "into" })
    const fn = info.functionAt(mcu.cpu.pc)
    expect(fn?.name).toBe("HAL_GPIO_TogglePin")
    // A leaf at -O2 has no prologue: its first statement is at its entry.
    expect(info.lines.isStmtStart(mcu.cpu.pc)).toBe(true)
    expect(info.lines.lineAt(mcu.cpu.pc)?.line ?? 0).toBeGreaterThan(fn!.declLine)
  })

  it("steps out, back in main at the return address", () => {
    // Step out: to the return address, once the stack is back where it was at the call.
    const ret = (mcu.cpu.r[14] & ~1) >>> 0
    step({ kind: "until", addr: ret, sp: mcu.cpu.r[13] })
    expect(info.functionAt(mcu.cpu.pc)?.name).toBe("main")
    expect(mcu.cpu.pc).toBe(ret)
  })

  it("steps one instruction", () => {
    const pc0 = mcu.cpu.pc
    stop = step({ kind: "instruction" })
    const size = mcu.cpu.instrAt(pc0)!.size
    expect(stop?.reason).toBe("step")
    expect(mcu.cpu.pc === pc0 + size || info.functionAt(mcu.cpu.pc)?.low === mcu.cpu.pc, `0x${pc0.toString(16)} → 0x${mcu.cpu.pc.toString(16)}`).toBe(true)
  })

  it("continues to the breakpoint again, a blink later", () => {
    mcu.debug({ op: "resume" })
    stop = runToStop(2)
    expect(stop?.reason).toBe("breakpoint")
    expect(where()).toBe("main.c:27")
  })

  it("stops on a BKPT in the program, and a step goes on past it", () => {
    mcu.debug({ op: "breakpoints", list: [] })
    const at = 0x20002000
    mcu.bus.write16(at, 0xbe07) // bkpt #7
    mcu.bus.write16(at + 2, 0xbf00) // nop
    mcu.bus.write16(at + 4, 0xe7fe) // b .
    mcu.cpu.pc = mcu.cpu.nextPc = at
    mcu.debug({ op: "resume" })
    stop = runToStop(0.01)
    expect(stop?.reason).toBe("bkpt")
    expect(stop?.pc).toBe(at)
    stop = step({ kind: "instruction" }, 0.01)
    expect(stop?.reason).toBe("step")
    expect(mcu.cpu.pc).toBe(at + 4)
  })

  it("takes an interrupt due at a breakpoint first: after a WFI, the SysTick that woke the core has run", () => {
    const at = 0x20002100
    mcu.bus.write16(at, 0xbf30) // wfi
    mcu.bus.write16(at + 2, 0xbf00) // nop
    mcu.bus.write16(at + 4, 0xe7fc) // b at
    const tick = info.symbols.find((s) => s.name === "uwTick")!.value
    const before = mcu.bus.peek(tick, 4)!
    mcu.debug({ op: "breakpoints", list: [bp({ kind: "address", address: at + 2 })] })
    mcu.cpu.pc = mcu.cpu.nextPc = at
    mcu.debug({ op: "resume" })
    stop = runToStop(0.01)
    expect(stop?.reason).toBe("breakpoint")
    expect(stop?.pc).toBe(at + 2)
    expect(mcu.cpu.ipsr, "back in thread mode").toBe(0)
    expect(mcu.bus.peek(tick, 4)! - before, "uwTick counted once").toBe(1)
  })
})

describe("writes at a stop on a bare F429", () => {
  // RAM and registers read back in the same reply, a peripheral register does what a store to
  // it does, flash and ROM refuse, the PC moves the stop.
  const { mcu: w, runToStop } = bareBlink()
  const presses = info.symbols.find((s) => s.name === "button_presses")!.value
  beforeAll(() => {
    w.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "Src/main.c", line: 27 })] })
    runToStop(2)
  })

  it("sets RAM, r0 and the flags, read back at once", () => {
    const r = w.inspect({ write: [{ kind: "memory", addr: presses, bytes: new Uint8Array([42, 0, 0, 0]) }, { kind: "register", reg: "r0", value: 0x1234 }, { kind: "register", reg: "xpsr", value: 0xf0000000 }], regs: true, ranges: [{ addr: presses, size: 4 }] })
    expect(r.writeErrors ?? []).toEqual([])
    expect(r.memory[0].bytes[0]).toBe(42)
    expect(r.regs!.r[0]).toBe(0x1234)
    expect(r.regs!.xpsr >>> 28, "NZCV").toBe(0xf)
    expect(r.regs!.xpsr & 0x1ff, "IPSR is the core's").toBe(0)
  })

  it("sets GPIOB->ODR: LD1's pad follows at once", () => {
    const PB0 = parsePad("PB0")!
    const was = w.padDrive(PB0)
    const odr = w.bus.peek(0x40020414, 4)!
    w.inspect({ write: [{ kind: "memory", addr: 0x40020414, bytes: leBytes(BigInt(odr ^ 1), 4) }] })
    expect(w.padDrive(PB0)).not.toBe(was)
  })

  it("refuses flash, ROM and addresses nothing answers at", () => {
    const refused = w.inspect({ write: [0x08000000, 0x1fff0000, 0x30000000].map((addr) => ({ kind: "memory" as const, addr, bytes: new Uint8Array([0]) })) }).writeErrors ?? []
    expect(refused).toHaveLength(3)
    expect(refused[0]).toMatch(/flash/)
    expect(refused[1]).toMatch(/read-only/)
    expect(refused[2]).toMatch(/nothing/)
  })

  it("sets the PC: the core is stopped there, and goes on from there round the loop to the breakpoint", () => {
    const line29 = info.lines.resolve("Src/main.c", 29)!.addrs[0]
    w.inspect({ write: [{ kind: "register", reg: "pc", value: line29 | 1 }] })
    expect(w.cpu.pc).toBe(line29)
    expect(w.debugStop?.pc).toBe(line29)
    expect(info.lines.lineAt(w.cpu.pc)?.line).toBe(29)
    w.debug({ op: "resume" })
    const back = runToStop(2)
    expect(back?.reason).toBe("breakpoint")
    expect(info.lines.lineAt(w.cpu.pc)?.line).toBe(27)
  })
})

it("keeps the compiled speed with a breakpoint set elsewhere", () => {
  // Breakpoints cost nothing where they are not: 1.5 s of blinking with one set on a function never called.
  const timed = (list: BreakpointSpec[]) => {
    const { mcu: m } = bareBlink()
    m.debug({ op: "breakpoints", list })
    const t = performance.now()
    while (m.time < 1.5 && !m.debugStop) m.runUntil(m.time + 0.01)
    return performance.now() - t
  }
  // The best of three each, taken in turns: the other test files share the machine.
  timed([])
  let free = Infinity
  let armed = Infinity
  for (let i = 0; i < 3; i++) {
    free = Math.min(free, timed([]))
    armed = Math.min(armed, timed([bp({ kind: "function", name: "Error_Handler" })]))
  }
  expect(armed, `${free.toFixed(0)} ms free, ${armed.toFixed(0)} ms armed`).toBeLessThan(free * 1.5 + 30)
})

/** What the UI does at a stop: registers and RAM from the core, the stack unwound, expressions evaluated. */
function stopView(m: Stm32, di: DebugInfo) {
  const ram = m.chip.memory.filter((r) => r.kind === "ram" && !r.external).map((r) => ({ addr: r.base, size: r.size }))
  const reply = m.inspect({ regs: true, ranges: ram })
  const mem = new MemorySnapshot(di.firmware.segments, reply.memory)
  const frames = unwind(di, reply.regs!, mem)
  /** An expression in a frame, as the watch list shows it; memory the snapshot lacks is fetched as the session would. */
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

describe.each(["O0", "O2"])("the debugger's test program at -%s", (opt) => {
  const di = new DebugInfo(new Uint8Array(example(`debug-${opt}.elf`)))
  const m = new Stm32(STM32F429ZI)
  m.load(buffer(example(`debug-${opt}.elf`)), `debug-${opt}.elf`)
  const run = (seconds: number) => {
    const end = m.time + seconds
    while (m.time < end && !m.debugStop && m.cpu.halted === null) m.runUntil(Math.min(end, m.time + 0.002))
    return m.debugStop
  }
  const at = () => {
    const l = di.lines.lineAt(m.cpu.pc)
    return l ? `${l.path.split("/").pop()}:${l.line}` : `0x${m.cpu.pc.toString(16)}`
  }
  /** Break at a line (or a function) and go on to it. */
  const runTo = (spec: Spot) => {
    m.debug({ op: "breakpoints", list: [bp(spec, "here")] })
    m.debug({ op: "resume" })
    const s = run(1)
    view = stopView(m, di)
    return s
  }
  let view: ReturnType<typeof stopView>
  let s: DebugStop | null = null

  /**
   * Set a value as the variables view does: planned over the stop's memory in a frame (what it
   * lacks fetched, as the session would), written by the core, the stop read again. Null when set.
   */
  const set = (expr: string, text: string, frame = 0): string | null => {
    for (let round = 0; round < 4; round++) {
      const f = view.frames[frame]
      const env = { info: di, mem: view.mem, frame: f }
      const scope = { locals: f?.level ? di.variablesOf(f.level) : [] }
      let writes: DebugWrite[]
      try {
        writes = /^(r\d+|sp|lr|pc|xpsr|s\d+)$/i.test(expr) ? registerAssignment(env, scope, expr, text) : assignment(env, scope, evaluateExpression(env, scope, expr), text)
      } catch (e) {
        if (!(e instanceof Pending)) return (e as Error).message
        for (const c of m.inspect({ ranges: view.mem.takeMisses() }).memory) view.mem.add(c)
        continue
      }
      const errors = m.inspect({ write: writes }).writeErrors ?? []
      const was = view.frames.length
      view = stopView(m, di)
      if (view.frames.length !== was) return `the stack changed: ${names(view.frames)}`
      return errors.length ? errors.join("; ") : null
    }
    return "memory not read"
  }

  it("stops at the top of the loop", () => {
    // The top of the loop, first time round: the globals as initialised.
    m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 102 }, "top")] })
    s = run(1)
    view = stopView(m, di)
    expect(s?.reason).toBe("breakpoint")
    expect(at()).toBe("debug.c:102")
  })

  // Globals of every kind.
  const cases: [string, string | RegExp][] = [
    ["first.name", '"first"'],
    ["first.at", "{x = 1, y = -2}"],
    ["first.path[2].y", "6"],
    ["first.mode", "MODE_RUN"],
    ["first.flags.level", "5"],
    ["first.flags.count", "300"],
    ["first.flags.tag", "66 'B'"],
    ["first.gain", "1.5"],
    ["first.scale", "0.25"],
    ["first.total", "-1234567890123"],
    ["second.next->name", '"first"'],
    ["second.next == &first", "1"],
    ["first.combine", /^0x[0-9a-f]+ <add>$/],
    ["greeting", /^0x0800[0-9a-f]{4} "hello, debugger"$/],
    ["word.real", "1.5"],
    ["word.bytes[3]", "63 '?'"],
    ["sizeof(sample_t)", String(di.typeNamed("sample_t")?.size)],
    ["(unsigned char)-1", "255 '\\377'"],
    ["first.path[1].x * 10 + 2", "32"],
    ["UINT32_MAX", "4294967295"],
    ["MODE_FAULT - MODE_RUN", "4"],
  ]
  for (const [expr, want] of cases)
    it(`reads ${expr} as ${want}`, () => {
      if (typeof want === "string") expect(view.value(expr)).toBe(want)
      else expect(view.value(expr)).toMatch(want)
    })

  // Setting values: every kind, C's conversions, a bit-field's neighbours kept, a string into a char array.
  const sets: [string, string, string][] = [
    ["first.at.x", "-300", "-300"],
    ["first.flags.level", "2", "2"],
    ["first.mode", "MODE_FAULT", "MODE_FAULT"],
    ["first.gain", "9 / 4.0", "2.25"],
    ["first.scale", "1", "1"],
    ["first.total", "first.total + 1", "-1234567890122"],
    ["first.flags.tag", "'Z'", "90 'Z'"],
    ["first.name", '"abc"', '"abc"'],
    ["word.real", "3", "3"],
    ["second.at", "first.at", "{x = -300, y = -2}"],
    ["second.next", "0", "0x0"],
    ["first.path[1].y", "-7", "-7"],
  ]
  for (const [expr, text, want] of sets)
    it(`sets ${expr} = ${text}`, () => {
      expect(set(expr, text)).toBeNull()
      expect(view.value(expr)).toBe(want)
    })

  it("keeps what is beside a value set: the element's other member, the bit-field's neighbours", () => {
    expect(view.value("first.path[1].x")).toBe("3")
    expect(view.value("first.flags.ready")).toBe("1")
    expect(view.value("first.flags.count")).toBe("300")
  })

  it("refuses a string too long for the array, and a struct of another type", () => {
    expect(set("first.name", '"a name far too long"')).toMatch(/do not fit/)
    expect(set("first.at", "first.flags")).toMatch(/cannot assign/)
    expect(set("first.mode", "MODE_RUN")).toBeNull()
  })

  // A local set at a stop is what the program goes on with. At -O2 `w` lives in r12, and `f` is
  // the constant GCC folded factorial(5) into.
  it(`sets w = 1000 at debug.c:106 (${opt === "O2" ? "in r12" : "on the stack"})`, () => {
    s = runTo({ kind: "line", path: "debug/debug.c", line: 106 })
    expect(s?.reason).toBe("breakpoint")
    const total0 = BigInt(view.value("first.total"))
    const f0 = BigInt(view.value("f"))
    const c0 = BigInt(view.value("c"))
    expect(set("w", "1000")).toBeNull()
    expect(view.value("w")).toBe("1000")
    if (opt === "O2") expect(view.regs.r[12]).toBe(1000)
    m.debug({ op: "breakpoints", list: [] })
    m.debug({ op: "step", step: { kind: "over" } })
    run(1)
    view = stopView(m, di)
    // At -O2 GCC has added w in before the line's first statement: setting a value the code is
    // done with changes nothing (as in GDB), so only the register itself can be checked there.
    if (opt === "O0") expect(BigInt(view.value("first.total")) - total0, "total grows by f + 1000 + c").toBe(f0 + 1000n + c0)
  })

  if (opt === "O2")
    it("refuses f, a folded constant, and until, optimized out", () => {
      runTo({ kind: "line", path: "debug/debug.c", line: 106 })
      expect(set("f", "7")).toMatch(/constant/)
      expect(set("until", "7")).toMatch(/optimized out/)
    })
  else
    it("jumps: the PC set to debug.c:107, line 106 does not run", () => {
      runTo({ kind: "line", path: "debug/debug.c", line: 106 })
      const skipFrom = BigInt(view.value("first.total"))
      const line107 = di.lines.resolve("debug/debug.c", 107)!.addrs[0]
      expect(set("pc", `0x${line107.toString(16)}`)).toBeNull()
      expect(at()).toBe("debug.c:107")
      m.debug({ op: "breakpoints", list: [] })
      m.debug({ op: "step", step: { kind: "over" } })
      run(1)
      view = stopView(m, di)
      expect(BigInt(view.value("first.total")), "total as it was").toBe(skipFrom)
      expect(at()).toBe("debug.c:108")
    })

  // A member of a struct the compiler split into registers (p in r1:r2 in walk at -O2): the
  // struct goes back whole. A value the code only computes (steps, at -O2) has no home.
  it(`sets p.x = 100 in walk${opt === "O2" ? " (p in r1:r2)" : ""}`, () => {
    runTo({ kind: "line", path: "debug/debug.c", line: 73 })
    const py = view.value("p.y")
    expect(set("p.x", "100")).toBeNull()
    expect(view.value("p.x")).toBe("100")
    expect(view.value("p.y")).toBe(py)
    if (opt === "O2") expect(set("steps", "2")).toMatch(/computes/)
  })

  // The recursion, three calls deep: every activation with its own `n`. At -O2 GCC folds
  // factorial(5) into 120, and the function is never called.
  if (opt === "O0")
    describe("in the recursion", () => {
      it("stops at debug.c:61 in factorial(2), four activations under main down to Reset_Handler", () => {
        s = runTo({ kind: "line", path: "debug/debug.c", line: 61 })
        for (let i = 0; i < 3 && s?.reason === "breakpoint"; i++) {
          m.debug({ op: "resume" })
          s = run(1)
        }
        view = stopView(m, di)
        expect(s?.reason).toBe("breakpoint")
        expect(at()).toBe("debug.c:61")
        const facts = view.frames.filter((f) => f.name === "factorial")
        expect(facts, names(view.frames)).toHaveLength(4)
        expect(view.frames[4]?.name).toBe("main")
        expect(facts.map((_, i) => view.value("n", i)).join(" "), "each with its own n").toBe("2 3 4 5")
        expect(view.frames[view.frames.length - 1]?.name).toBe("Reset_Handler")
      })

      it("steps out of two activations: back in factorial(3), then factorial(4)", () => {
        // The breakpoint goes first, or the next call down would stop there (as it does in GDB).
        m.debug({ op: "breakpoints", list: [] })
        const out = () => {
          const f = view.frames[1]
          m.debug({ op: "step", step: { kind: "until", addr: f.pc, sp: view.frames[0].cfa ?? undefined } })
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
    })

  it("stops in SysTick_Handler, with the main it interrupted marked under it", () => {
    s = runTo({ kind: "function", name: "SysTick_Handler" })
    expect(s?.reason).toBe("breakpoint")
    expect(view.frames[0]?.name).toBe("SysTick_Handler")
    expect(view.frames[1]?.interruptedBy).toBe("SysTick")
    expect(view.frames[1]?.name).toBe("main")
  })

  it("sets registers of the frames: the handler's r0 in the core, main's r12 in the frame the hardware stacked", () => {
    const r0 = view.regs.r[0]
    const r12 = view.frames[1]!.regs.r[12]!
    expect(set("r0", "0x1234")).toBeNull()
    expect(view.regs.r[0]).toBe(0x1234)
    expect(set("r12", "0x5a5a", 1)).toBeNull()
    expect(view.frames[1]?.regs.r[12]).toBe(0x5a5a)
    expect(view.regs.r[12]).not.toBe(0x5a5a)
    // Put back: main may be counting with it.
    expect(set("r12", String(r12), 1)).toBeNull()
    expect(set("r0", String(r0))).toBeNull()
  })

  // A C++ method, found by its qualified name; members without `this->`.
  if (opt === "O0")
    it("stops in geo::Rect::area, called from shapes_area from main, and reads members through this", () => {
      s = runTo({ kind: "function", name: "geo::Rect::area" })
      expect(s?.reason).toBe("breakpoint")
      expect(view.frames[0]?.name).toBe("geo::Rect::area")
      expect(view.frames[1]?.name).toBe("shapes_area")
      expect(view.frames[2]?.name).toBe("main")
      expect(view.value("w_")).toBe("2")
      expect(view.value("this->h_")).toBe("3.5")
      expect(view.value("id_"), "the base class's").toBe("1")
    })
  else
    it("resolves the method breakpoint (the call is devirtualized and inlined, the method's own code uncalled)", () => {
      m.debug({ op: "breakpoints", list: [bp({ kind: "function", name: "geo::Rect::area" }, "area")] })
      expect(m.debugger.addresses()).toHaveLength(1)
      m.debug({ op: "breakpoints", list: [] })
    })

  it("catches a fault set off through the debugger at the handler, with the faulting code under it", () => {
    m.debug({ op: "breakpoints", list: [] })
    m.debug({ op: "catch", faults: true })
    expect(set("fault_now", "1")).toBeNull()
    expect(view.value("fault_now")).toBe("1")
    m.debug({ op: "resume" })
    s = run(1)
    view = stopView(m, di)
    expect(s?.reason).toBe("exception")
    expect(s?.exception).toBe(3)
    expect(view.frames.some((f) => f.interruptedBy === "HardFault"), names(view.frames)).toBe(true)
    expect(view.frames.some((f) => f.name === "main")).toBe(true)
  })
})

describe.each([
  ["the loop's thread", false],
  ["a worker thread", true],
])("blink on the Nucleo, core in %s: the bench and the debugger", (_, workers) => {
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware: "nucleo-blink.elf", firmwareData: blinkElf.toString("base64") }
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  const stops: { object: string; stop: DebugStop }[][] = []
  loop.onDebugStop = (s) => stops.push(s)
  let clock = 0
  /** Wall-clock ticks until the bench stops for the debugger (or `seconds` of bench time pass). */
  const untilStop = (seconds: number) => {
    const n = stops.length
    const start = loop.snapshot(true)?.time ?? 0
    for (let i = 0; i < 100000 && loop.running && stops.length === n; i++) {
      clock += 30
      loop.advance(clock)
      if ((loop.snapshot(true)?.time ?? 0) - start > seconds) break
    }
    return stops.length > n ? stops[stops.length - 1] : null
  }
  const led = () => loop.snapshot(true)!.parts[partKey(u.id, "LD1")]?.on ?? false
  const lineOf = async () => {
    const r = await loop.inspect(u.id, { regs: true })
    const l = info.lines.lineAt(r?.regs?.r[15] ?? 0)
    return l ? `${l.path.split("/").pop()}:${l.line}` : `0x${(r?.regs?.r[15] ?? 0).toString(16)}`
  }
  let frozen = 0

  beforeAll(async () => {
    // Breakpoints can be set before the board's core exists: they are there before its first instruction.
    loop.debug(u.id, { op: "breakpoints", list: [bp({ kind: "line", path: "Core/Src/main.c", line: 27 }, "blink")] })
    loop.debug(u.id, { op: "catch", faults: true })
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    while (loop.booting) await new Promise((r) => setTimeout(r, 10))
    loop.advance(clock)
  })
  afterAll(() => loop.dispose())

  it("stops the bench at the breakpoint, and keeps it frozen while stopped", async () => {
    const st = untilStop(2)
    expect(st?.[0].stop.reason).toBe("breakpoint")
    expect(loop.running).toBe(false)
    expect(await lineOf()).toBe("main.c:27")
    frozen = loop.snapshot(true)!.time
    clock += 500
    loop.advance(clock)
    expect(loop.snapshot(true)!.time).toBe(frozen)
  })

  it("steps over HAL_GPIO_TogglePin(LD1) to main.c:28 in microseconds of bench time, LD1 toggled at once", async () => {
    const before = led()
    loop.debug(u.id, { op: "step", step: { kind: "over" } })
    const st = untilStop(1)
    expect(st?.[0].stop.reason).toBe("step")
    expect(await lineOf()).toBe("main.c:28")
    expect(loop.snapshot(true)!.time - frozen).toBeLessThan(1e-3)
    expect(led()).not.toBe(before)
  })

  it("steps over HAL_Delay(500): the bench runs 500 ms with it", () => {
    loop.debug(u.id, { op: "step", step: { kind: "over" } })
    untilStop(1)
    const t29 = loop.snapshot(true)!.time
    loop.debug(u.id, { op: "step", step: { kind: "over" } })
    untilStop(2)
    expect(loop.snapshot(true)!.time - t29).toBeNear(0.5, 0.005)
  })

  it("continues: the whole bench goes on, and stops at the breakpoint again", async () => {
    loop.setRunning(true)
    const st = untilStop(2)
    expect(st?.[0].stop.reason).toBe("breakpoint")
    expect(await lineOf()).toBe("main.c:27")
  })

  it("reads registers and RAM at a pause, which is not a stop", async () => {
    loop.debug(u.id, { op: "breakpoints", list: [] })
    loop.setRunning(true)
    for (let i = 0; i < 10; i++) loop.advance((clock += 30))
    loop.setRunning(false)
    const paused = await loop.inspect(u.id, { regs: true, ranges: [{ addr: 0x20000000, size: 64 }] })
    expect(paused?.regs).toBeTruthy()
    expect(paused?.memory[0]?.bytes.length).toBe(64)
    expect(paused?.stop).toBeNull()
  })

  it("sets button_presses and r1 while paused, through the loop to the core, read back in the same reply", async () => {
    const presses = info.symbols.find((x) => x.name === "button_presses")!.value
    const written = await loop.inspect(u.id, { write: [{ kind: "memory", addr: presses, bytes: new Uint8Array([7, 0, 0, 0]) }, { kind: "register", reg: "r1", value: 0xabcd }], regs: true, ranges: [{ addr: presses, size: 4 }] })
    expect(written?.writeErrors ?? []).toEqual([])
    expect(written?.memory[0]?.bytes[0]).toBe(7)
    expect(written?.regs?.r[1]).toBe(0xabcd)
  })
})

describe("settings from a schematic file: repaired, not refused", () => {
  const d = normalizeDebug({
    breakpoints: [
      { id: "a", kind: "line", path: "Core/Src/main.c", line: 27, enabled: true },
      { id: "a", kind: "function", name: " main " },
      { kind: "address", address: 0x08000400, enabled: false },
      { id: "x", kind: "line", path: "main.c", line: 0 },
      { id: "y", kind: "address", address: -1 },
      { id: "z", kind: "watch" },
      "main.c:12",
      null,
    ],
    sources: [{ path: "/src/a.c", content: "int a;\r\n" }, { path: "/src/a.c", content: "int b;\r\nint c;" }, { path: "", content: "" }, { path: "b.c" }],
    watches: ["GPIOB->ODR", "", 42, "  "],
    catchFaults: "no",
  })
  const bps = d?.breakpoints ?? []

  it("keeps the three breakpoints that read as one", () => expect(bps.map((b) => b.kind)).toEqual(["line", "function", "address"]))
  it("replaces a repeated id and makes a missing one", () => {
    expect(new Set(bps.map((b) => b.id)).size).toBe(3)
    expect(bps.every((b) => b.id)).toBe(true)
  })
  it("leaves a breakpoint enabled unless it says otherwise, and trims a name", () => {
    expect(bps[1]).toMatchObject({ kind: "function", name: "main", enabled: true })
    expect(bps[2]?.enabled).toBe(false)
  })
  it("keeps one source per path, the last one, with LF", () => expect(d?.sources).toEqual([{ path: "/src/a.c", content: "int b;\nint c;" }]))
  it("keeps the watches that are expressions", () => expect(d?.watches).toEqual(["GPIOB->ODR"]))
  it("leaves catchFaults that is not a boolean to its default", () => expect(d?.catchFaults).toBeUndefined())
  it("reads nothing from what is not an object", () => {
    expect(normalizeDebug("x")).toBeUndefined()
    expect(normalizeDebug([])).toBeUndefined()
    expect(normalizeDebug(null)).toBeUndefined()
  })
})
