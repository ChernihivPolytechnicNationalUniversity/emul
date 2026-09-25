/**
 * The debugger: DWARF read off the example images, breakpoints on source lines and
 * functions, stepping by line and by instruction, call stacks, variables and expressions,
 * fault catch, BKPT — on a bare core, through the circuit with the bench freezing on a stop, and
 * with the core in a worker thread. Last, the debugger settings a schematic file brings,
 * repaired as the document loads.
 *
 *   pnpm debug
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { STM32F429ZI } from "@/mcu/chip"
import { parsePad, Stm32 } from "@/mcu/stm32f429"
import { DebugInfo } from "@/debug/info"
import { assignment, registerAssignment } from "@/debug/assign"
import { evaluateExpression, Pending } from "@/debug/eval"
import { MemorySnapshot } from "@/debug/memory"
import type { BreakpointSpec, DebugWrite, StepRequest } from "@/debug/protocol"
import { normalizeDebug } from "@/debug/saved"
import { unwind } from "@/debug/unwind"
import { leBytes, show } from "@/debug/values"
import { GRID } from "@/schematic/geometry"
import { nucleoBlink } from "@/schematic/examples"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "./lib/core-threads"

const image = (name: string) => readFileSync(join(import.meta.dirname, "..", "firmware", "examples", name))
const buffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

let failed = 0
let total = 0
const expect = (what: string, ok: boolean, got: string | number = "") => {
  total++
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(58)} ${got}`)
}

// --- a bare core: breakpoints and steps ----------------------------------------------------------

console.log("Blink on a bare F429: breakpoints and steps")
const blinkElf = image("nucleo-blink.elf")
const info = new DebugInfo(new Uint8Array(blinkElf))
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
const bp = (spec: Omit<BreakpointSpec, "id" | "enabled">, id = "b1") => ({ ...spec, id, enabled: true }) as BreakpointSpec

mcu.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "Src/main.c", line: 27 })] })
expect("line 27 resolves to one address", mcu.debugger.addresses().length === 1, mcu.debugger.addresses().map((a) => a.toString(16)).join(" "))
let stop = runToStop(2)
expect("stops at the breakpoint", stop?.reason === "breakpoint" && stop.breakpoint === "b1", `${stop?.reason} at ${where()}`)
expect("on main.c:27", where() === "main.c:27", where())
const t0 = mcu.time
stop = step({ kind: "over" })
expect("step over → main.c:28", stop?.reason === "step" && where() === "main.c:28", where())
stop = step({ kind: "over" })
expect("step over → main.c:29", where() === "main.c:29", where())
stop = step({ kind: "over" })
// At -O2 the loop's branch back is a statement of `while (1)` of its own, as GDB shows it too.
expect("step over HAL_Delay(500) → main.c:25, the loop's branch back", stop?.reason === "step" && where() === "main.c:25", `${stop?.reason} at ${where()}`)
expect("the delay ran its 500 ms of core time", Math.abs(mcu.time - t0 - 0.5) < 0.01, `${((mcu.time - t0) * 1e3).toFixed(1)} ms`)
stop = step({ kind: "over" })
expect("step over → main.c:27, where the breakpoint is", where() === "main.c:27", `${stop?.reason} at ${where()}`)
stop = step({ kind: "into" })
expect("step into HAL_GPIO_TogglePin", info.functionAt(mcu.cpu.pc)?.name === "HAL_GPIO_TogglePin", `${info.functionAt(mcu.cpu.pc)?.name} at ${where()}`)
const fn = info.functionAt(mcu.cpu.pc)!
// A leaf at -O2 has no prologue: its first statement is at its entry.
expect("stopped on the first statement of the body", info.lines.isStmtStart(mcu.cpu.pc) && (info.lines.lineAt(mcu.cpu.pc)?.line ?? 0) > fn.declLine, `${where()} (declared on line ${fn.declLine})`)
// Step out: to the return address, once the stack is back where it was at the call.
const ret = (mcu.cpu.r[14] & ~1) >>> 0
stop = step({ kind: "until", addr: ret, sp: mcu.cpu.r[13] })
expect("step out → back in main", info.functionAt(mcu.cpu.pc)?.name === "main" && mcu.cpu.pc === ret, `${info.functionAt(mcu.cpu.pc)?.name} at ${where()}`)
const pc0 = mcu.cpu.pc
stop = step({ kind: "instruction" })
const size = mcu.cpu.instrAt(pc0)!.size
expect("instruction step: one instruction", stop?.reason === "step" && (mcu.cpu.pc === pc0 + size || info.functionAt(mcu.cpu.pc)?.low === mcu.cpu.pc), `0x${pc0.toString(16)} → 0x${mcu.cpu.pc.toString(16)}`)
mcu.debug({ op: "resume" })
stop = runToStop(2)
expect("continue → the breakpoint again, a blink later", stop?.reason === "breakpoint" && where() === "main.c:27", `${stop?.reason} at ${where()}`)
// A BKPT in the program stops the core on it, as a breakpoint does; going on goes past it.
{
  mcu.debug({ op: "breakpoints", list: [] })
  const at = 0x20002000
  mcu.bus.write16(at, 0xbe07) // bkpt #7
  mcu.bus.write16(at + 2, 0xbf00) // nop
  mcu.bus.write16(at + 4, 0xe7fe) // b .
  mcu.cpu.pc = mcu.cpu.nextPc = at
  mcu.debug({ op: "resume" })
  stop = runToStop(0.01)
  expect("a BKPT stops the core on it", stop?.reason === "bkpt" && stop.pc === at, stop ? `${stop.reason} at 0x${stop.pc.toString(16)}` : "no stop")
  stop = step({ kind: "instruction" }, 0.01)
  expect("and a step goes on past it", stop?.reason === "step" && mcu.cpu.pc === at + 4, `0x${mcu.cpu.pc.toString(16)}`)
}
// An interrupt due at a breakpoint goes first, as on the part: a breakpoint after a WFI fires
// once the SysTick that woke the core has run.
{
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
  const ticks = mcu.bus.peek(tick, 4)! - before
  expect("a breakpoint after WFI: the SysTick that woke it ran first", stop?.reason === "breakpoint" && stop.pc === at + 2 && mcu.cpu.ipsr === 0 && ticks === 1, `${stop?.reason} at 0x${stop?.pc.toString(16)}, uwTick +${ticks}`)
}
// Writes at a stop, as the debugger makes them: RAM and registers read back in the same reply,
// a peripheral register does what a store to it does, flash and ROM refuse, the PC moves the stop.
{
  const w = new Stm32(STM32F429ZI)
  w.setClockSources({ hz: 8e6, kind: "clock", startup: 0 }, null)
  w.load(buffer(blinkElf), "nucleo-blink.elf")
  w.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "Src/main.c", line: 27 })] })
  const end = w.time + 2
  while (w.time < end && !w.debugStop) w.runUntil(Math.min(end, w.time + 0.002))
  const presses = info.symbols.find((s) => s.name === "button_presses")!.value
  const r = w.inspect({ write: [{ kind: "memory", addr: presses, bytes: new Uint8Array([42, 0, 0, 0]) }, { kind: "register", reg: "r0", value: 0x1234 }, { kind: "register", reg: "xpsr", value: 0xf0000000 }], regs: true, ranges: [{ addr: presses, size: 4 }] })
  expect("RAM, r0 and the flags set, read back at once", !r.writeErrors?.length && r.memory[0].bytes[0] === 42 && r.regs!.r[0] === 0x1234 && r.regs!.xpsr >>> 28 === 0xf && (r.regs!.xpsr & 0x1ff) === 0, `presses ${r.memory[0].bytes[0]}, r0 0x${r.regs!.r[0].toString(16)}, xPSR 0x${r.regs!.xpsr.toString(16)}`)
  const PB0 = parsePad("PB0")!
  const was = w.padDrive(PB0)
  const odr = w.bus.peek(0x40020414, 4)!
  w.inspect({ write: [{ kind: "memory", addr: 0x40020414, bytes: leBytes(BigInt(odr ^ 1), 4) }] })
  expect("GPIOB->ODR set: LD1's pad follows at once", w.padDrive(PB0) !== was, `${was} → ${w.padDrive(PB0)}`)
  const refused = w.inspect({ write: [0x08000000, 0x1fff0000, 0x30000000].map((addr) => ({ kind: "memory" as const, addr, bytes: new Uint8Array([0]) })) }).writeErrors ?? []
  expect("flash, ROM and nothing there refuse", refused.length === 3 && /flash/.test(refused[0]) && /read-only/.test(refused[1]) && /nothing/.test(refused[2]), refused.join(" | "))
  const line29 = info.lines.resolve("Src/main.c", 29)!.addrs[0]
  w.inspect({ write: [{ kind: "register", reg: "pc", value: line29 | 1 }] })
  expect("pc set: the core is stopped there now", w.cpu.pc === line29 && w.debugStop?.pc === line29 && info.lines.lineAt(w.cpu.pc)?.line === 29, `0x${w.cpu.pc.toString(16)}, main.c:${info.lines.lineAt(w.cpu.pc)?.line}`)
  w.debug({ op: "resume" })
  const back = (() => {
    const e = w.time + 2
    while (w.time < e && !w.debugStop) w.runUntil(Math.min(e, w.time + 0.002))
    return w.debugStop
  })()
  expect("and goes on from there, round the loop to the breakpoint", back?.reason === "breakpoint" && info.lines.lineAt(w.cpu.pc)?.line === 27, `${back?.reason} at main.c:${info.lines.lineAt(w.cpu.pc)?.line}`)
}

// Breakpoints cost nothing where they are not: a second of blinking with one set elsewhere.
const timed = (list: BreakpointSpec[]) => {
  const m = new Stm32(STM32F429ZI)
  m.setClockSources({ hz: 8e6, kind: "clock", startup: 0 }, null)
  m.load(buffer(blinkElf), "nucleo-blink.elf")
  m.debug({ op: "breakpoints", list })
  const w = performance.now()
  while (m.time < 1.5 && !m.debugStop) m.runUntil(m.time + 0.01)
  return { ms: performance.now() - w, instructions: m.cpu.instructions }
}
timed([])
const free = timed([])
const armed = timed([bp({ kind: "function", name: "Error_Handler" })])
expect("a breakpoint elsewhere keeps the compiled speed (within 40 %)", armed.ms < free.ms * 1.4 + 20, `${free.ms.toFixed(0)} ms free, ${armed.ms.toFixed(0)} ms armed`)

// --- the test program at -O0: call stacks, variables, expressions ----------------------------------

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
const names = (frames: { name: string; interruptedBy: string | null }[]) => frames.map((f) => (f.interruptedBy ? `[${f.interruptedBy}] ` : "") + f.name).join(" ← ")

for (const opt of ["O0", "O2"]) {
  console.log(`\nThe debugger's test program at -${opt}`)
  const elf = image(`debug-${opt}.elf`)
  const di = new DebugInfo(new Uint8Array(elf))
  const m = new Stm32(STM32F429ZI)
  m.load(buffer(elf), `debug-${opt}.elf`)
  const run = (seconds: number) => {
    const end = m.time + seconds
    while (m.time < end && !m.debugStop && m.cpu.halted === null) m.runUntil(Math.min(end, m.time + 0.002))
    return m.debugStop
  }
  const at = () => {
    const l = di.lines.lineAt(m.cpu.pc)
    return l ? `${l.path.split("/").pop()}:${l.line}` : `0x${m.cpu.pc.toString(16)}`
  }

  // The top of the loop, first time round: the globals as initialised.
  m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 102 }, "top")] })
  let s = run(1)
  let view = stopView(m, di)
  expect("stops at the top of the loop", s?.reason === "breakpoint" && at() === "debug.c:102", `${s?.reason} at ${at()}`)

  // Globals of every kind.
  const cases: [string, string][] = [
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
    ["first.combine", "0x"],
    ["greeting", '~^0x0800[0-9a-f]{4} "hello, debugger"$'],
    ["word.real", "1.5"],
    ["word.bytes[3]", "63 '?'"],
    ["sizeof(sample_t)", String(di.typeNamed("sample_t")?.size)],
    ["(unsigned char)-1", "255 '\\377'"],
    ["first.path[1].x * 10 + 2", "32"],
    ["UINT32_MAX", "4294967295"],
    ["MODE_FAULT - MODE_RUN", "4"],
  ]
  for (const [expr, want] of cases) {
    const got = view.value(expr)
    const ok = want.startsWith("~") ? new RegExp(want.slice(1)).test(got) : want.endsWith("0x") ? got.startsWith("0x") && got.includes("<add>") : got === want
    expect(`${expr} = ${want.replace(/^~/, "")}`, ok, got)
  }

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

  // Setting values: every kind, C's conversions, a bit-field's neighbours kept, a string into a char array.
  const sets: [string, string, string, string?][] = [
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
    ["first.path[1].y", "-7", "-7", "first.path[1].x"],
  ]
  for (const [expr, text, want, also] of sets) {
    const error = set(expr, text)
    const got = view.value(expr)
    expect(`set ${expr} = ${text}`, error === null && got === want, error ?? got)
    if (also) expect(`  and ${also} is as it was`, view.value(also) === "3", view.value(also))
  }
  expect("  the bit-field's neighbours are as they were", view.value("first.flags.ready") === "1" && view.value("first.flags.count") === "300", `ready ${view.value("first.flags.ready")}, count ${view.value("first.flags.count")}`)
  expect("a string too long for the array is refused", /do not fit/.test(set("first.name", '"a name far too long"') ?? ""), set("first.name", '"a name far too long"') ?? "set")
  expect("a struct from a struct of another type is refused", /cannot assign/.test(set("first.at", "first.flags") ?? ""), set("first.at", "first.flags") ?? "set")
  set("first.mode", "MODE_RUN")

  // A local set at a stop is what the program goes on with. At -O2 `w` lives in r12, and `f` is
  // the constant GCC folded factorial(5) into.
  m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 106 }, "sum")] })
  m.debug({ op: "resume" })
  s = run(1)
  view = stopView(m, di)
  const total0 = BigInt(view.value("first.total"))
  const f0 = BigInt(view.value("f"))
  const c0 = BigInt(view.value("c"))
  expect(`at debug.c:106, set w = 1000 (${opt === "O2" ? "in r12" : "on the stack"})`, s?.reason === "breakpoint" && set("w", "1000") === null && view.value("w") === "1000" && (opt === "O0" || view.regs.r[12] === 1000), `${view.value("w")}, r12 ${view.regs.r[12]}`)
  m.debug({ op: "breakpoints", list: [] })
  m.debug({ op: "step", step: { kind: "over" } })
  s = run(1)
  view = stopView(m, di)
  const grew = BigInt(view.value("first.total")) - total0
  // At -O2 GCC has added w in before the line's first statement: setting a value the code is
  // done with changes nothing (as in GDB), so only the register itself can be checked there.
  if (opt === "O0") expect("  the program adds that w: total grows by f + 1000 + c", grew === f0 + 1000n + c0, `+${grew} (f ${f0}, c ${c0})`)
  if (opt === "O2") {
    m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 106 }, "sum")] })
    m.debug({ op: "resume" })
    s = run(1)
    view = stopView(m, di)
    expect("f, a folded constant, cannot be set", /constant/.test(set("f", "7") ?? ""), set("f", "7") ?? "set")
    expect("until, optimized out, cannot be set", /optimized out/.test(set("until", "7") ?? ""), set("until", "7") ?? "set")
  } else {
    // A jump: the PC set to the next line's first instruction, and line 106 never runs.
    m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 106 }, "sum")] })
    m.debug({ op: "resume" })
    s = run(1)
    view = stopView(m, di)
    const skipFrom = BigInt(view.value("first.total"))
    const line107 = di.lines.resolve("debug/debug.c", 107)!.addrs[0]
    expect("jump: pc set to debug.c:107", set("pc", `0x${line107.toString(16)}`) === null && at() === "debug.c:107", at())
    m.debug({ op: "breakpoints", list: [] })
    m.debug({ op: "step", step: { kind: "over" } })
    s = run(1)
    view = stopView(m, di)
    expect("  line 106 did not run: total as it was", BigInt(view.value("first.total")) === skipFrom && at() === "debug.c:108", `${view.value("first.total")} at ${at()}`)
  }

  // A member of a struct the compiler split into registers (p in r1:r2 in walk at -O2): the
  // struct goes back whole. A value the code only computes (steps, at -O2) has no home.
  m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 73 }, "walk")] })
  m.debug({ op: "resume" })
  s = run(1)
  view = stopView(m, di)
  const py = view.value("p.y")
  expect(`in walk, set p.x = 100${opt === "O2" ? " (p in r1:r2)" : ""}`, set("p.x", "100") === null && view.value("p.x") === "100" && view.value("p.y") === py, `p = ${view.value("p")}`)
  if (opt === "O2") expect("steps, a computed value, cannot be set", /computes/.test(set("steps", "2") ?? ""), set("steps", "2") ?? "set")

  // The recursion, three calls deep: every activation with its own `n`. At -O2 GCC folds
  // factorial(5) into 120, and the function is never called.
  if (opt === "O0") {
    m.debug({ op: "breakpoints", list: [bp({ kind: "line", path: "debug/debug.c", line: 61 }, "fact")] })
    m.debug({ op: "resume" })
    s = run(1)
    for (let i = 0; i < 3 && s?.reason === "breakpoint"; i++) {
      m.debug({ op: "resume" })
      s = run(1)
    }
    view = stopView(m, di)
    expect("stops in the recursion", s?.reason === "breakpoint" && at() === "debug.c:61", `${s?.reason} at ${at()}`)
    const facts = view.frames.filter((f) => f.name === "factorial")
    expect("four factorial frames under main", facts.length === 4 && view.frames[4]?.name === "main", names(view.frames))
    expect("each with its own n: 2 3 4 5", facts.map((_, i) => view.value("n", i)).join(" ") === "2 3 4 5", facts.map((_, i) => view.value("n", i)).join(" "))
    expect("the stack ends at Reset_Handler", view.frames[view.frames.length - 1]?.name === "Reset_Handler", names(view.frames))
    // Step out of two activations: back in factorial(3), then factorial(4). The breakpoint
    // goes first, or the next call down would stop there (as it does in GDB).
    m.debug({ op: "breakpoints", list: [] })
    const out = () => {
      const f = view.frames[1]
      m.debug({ op: "step", step: { kind: "until", addr: f.pc, sp: view.frames[0].cfa ?? undefined } })
      s = run(1)
      view = stopView(m, di)
    }
    out()
    expect("step out → the caller's activation, n = 3", s?.reason === "step" && view.value("n") === "3" && view.frames.filter((f) => f.name === "factorial").length === 3, `${s?.reason}: n = ${view.value("n")}`)
    out()
    expect("step out again → n = 4", view.value("n") === "4", `n = ${view.value("n")}`)
  }

  // An interrupt: the handler's frame, then the loop it interrupted.
  m.debug({ op: "breakpoints", list: [bp({ kind: "function", name: "SysTick_Handler" }, "tick")] })
  m.debug({ op: "resume" })
  s = run(1)
  view = stopView(m, di)
  expect("stops in SysTick_Handler", s?.reason === "breakpoint" && view.frames[0]?.name === "SysTick_Handler", `${s?.reason}: ${names(view.frames)}`)
  expect("the interrupted frame is main, marked", view.frames[1]?.interruptedBy === "SysTick" && view.frames[1]?.name === "main", names(view.frames))
  // Registers of the frames: the handler's own in the core, main's r12 in the frame the hardware
  // stacked (and put back, main may be counting with it).
  const r0 = view.regs.r[0]
  const r12 = view.frames[1]!.regs.r[12]!
  expect("set r0 in the handler's frame", set("r0", "0x1234") === null && view.regs.r[0] === 0x1234, `0x${view.regs.r[0].toString(16)}`)
  expect("set r12 in main's frame: the stacked copy", set("r12", "0x5a5a", 1) === null && view.frames[1]?.regs.r[12] === 0x5a5a && view.regs.r[12] !== 0x5a5a, `main 0x${view.frames[1]?.regs.r[12]?.toString(16)}, handler 0x${view.regs.r[12].toString(16)}`)
  set("r12", String(r12), 1)
  set("r0", String(r0))

  // A C++ method, found by its qualified name; members without `this->`.
  m.debug({ op: "breakpoints", list: [bp({ kind: "function", name: "geo::Rect::area" }, "area")] })
  m.debug({ op: "resume" })
  s = run(1)
  view = stopView(m, di)
  if (opt === "O0") {
    expect("stops in geo::Rect::area", s?.reason === "breakpoint" && view.frames[0]?.name === "geo::Rect::area", `${s?.reason}: ${names(view.frames)}`)
    expect("called from shapes_area, from main", view.frames[1]?.name === "shapes_area" && view.frames[2]?.name === "main", names(view.frames))
    expect("w_ through this = 2", view.value("w_") === "2", view.value("w_"))
    expect("this->h_ = 3.5", view.value("this->h_") === "3.5", view.value("this->h_"))
    expect("the base class's id_ = 1", view.value("id_") === "1", view.value("id_"))
  } else {
    // At -O2 the virtual call on a known object is devirtualized and inlined: the method's own code stays in the vtable, uncalled.
    expect("the method breakpoint resolves", m.debugger.addresses().length === 1, m.debugger.addresses().map((a) => a.toString(16)).join(" "))
    m.debug({ op: "breakpoints", list: [] })
  }

  // A fault on demand, set through the debugger: caught at the handler, with the faulting code under it.
  m.debug({ op: "breakpoints", list: [] })
  m.debug({ op: "catch", faults: true })
  expect("set fault_now = 1", set("fault_now", "1") === null && view.value("fault_now") === "1", view.value("fault_now"))
  m.debug({ op: "resume" })
  s = run(1)
  view = stopView(m, di)
  expect("the fault is caught at the handler", s?.reason === "exception" && s.exception === 3, `${s?.reason} ${s?.exception} ${s?.detail ?? ""}`)
  expect("under it: crash, called from main", view.frames.some((f) => f.interruptedBy === "HardFault") && view.frames.some((f) => f.name === "main"), names(view.frames))
}

// --- through the circuit: the bench freezes on a stop, steps advance it ----------------------------

for (const workers of [false, true]) {
  console.log(`\nBlink on the Nucleo, core ${workers ? "in a worker thread" : "in the loop's thread"}: the bench and the debugger`)
  const doc = nucleoBlink.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  u.props = { ...u.props, firmware: "nucleo-blink.elf", firmwareData: blinkElf.toString("base64") }
  const loop = new SimLoop()
  if (workers) loop.spawnCore = spawnNodeCore
  const stops: { object: string; stop: { reason: string; pc: number } }[][] = []
  loop.onDebugStop = (s) => stops.push(s)
  // Breakpoints can be set before the board's core exists: they are there before its first instruction.
  loop.debug(u.id, { op: "breakpoints", list: [bp({ kind: "line", path: "Core/Src/main.c", line: 27 }, "blink")] })
  loop.debug(u.id, { op: "catch", faults: true })
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
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

  let st = untilStop(2)
  expect("the bench stops at the breakpoint", !!st && st[0].stop.reason === "breakpoint" && !loop.running, st ? `${st[0].stop.reason} at ${await lineOf()}` : "no stop")
  const frozen = loop.snapshot(true)!.time
  clock += 500
  loop.advance(clock)
  expect("and stays frozen while stopped", loop.snapshot(true)!.time === frozen, `${frozen.toFixed(6)} → ${loop.snapshot(true)!.time.toFixed(6)} s`)
  const before = led()
  loop.debug(u.id, { op: "step", step: { kind: "over" } })
  st = untilStop(1)
  expect("step over HAL_GPIO_TogglePin(LD1): main.c:28", st?.[0].stop.reason === "step" && (await lineOf()) === "main.c:28", st ? `${st[0].stop.reason} at ${await lineOf()}` : "no stop")
  expect("the step took microseconds of bench time", loop.snapshot(true)!.time - frozen < 1e-3, `${((loop.snapshot(true)!.time - frozen) * 1e6).toFixed(0)} µs`)
  expect("and LD1 shows the toggle at once", led() !== before, `${before ? "on" : "off"} → ${led() ? "on" : "off"}`)
  loop.debug(u.id, { op: "step", step: { kind: "over" } })
  st = untilStop(1)
  const t29 = loop.snapshot(true)!.time
  loop.debug(u.id, { op: "step", step: { kind: "over" } })
  st = untilStop(2)
  expect("step over HAL_Delay(500): the bench runs 500 ms with it", Math.abs(loop.snapshot(true)!.time - t29 - 0.5) < 0.005, `${((loop.snapshot(true)!.time - t29) * 1e3).toFixed(1)} ms`)
  // Continue: the whole bench goes on, and stops at the breakpoint again.
  loop.setRunning(true)
  st = untilStop(2)
  expect("continue → the breakpoint again", st?.[0].stop.reason === "breakpoint" && (await lineOf()) === "main.c:27", st ? `${st[0].stop.reason} at ${await lineOf()}` : "no stop")
  // A pause is not a stop: the cores can be looked at where they are.
  loop.debug(u.id, { op: "breakpoints", list: [] })
  loop.setRunning(true)
  for (let i = 0; i < 10; i++) loop.advance((clock += 30))
  loop.setRunning(false)
  const paused = await loop.inspect(u.id, { regs: true, ranges: [{ addr: 0x20000000, size: 64 }] })
  expect("paused: registers and RAM read", !!paused?.regs && paused.memory[0]?.bytes.length === 64 && paused.stop === null, `pc 0x${paused?.regs?.r[15].toString(16)}`)
  // Set while paused, through the loop to the core (in its worker too), read back in the same reply.
  const presses = info.symbols.find((x) => x.name === "button_presses")!.value
  const written = await loop.inspect(u.id, { write: [{ kind: "memory", addr: presses, bytes: new Uint8Array([7, 0, 0, 0]) }, { kind: "register", reg: "r1", value: 0xabcd }], regs: true, ranges: [{ addr: presses, size: 4 }] })
  expect("paused: button_presses and r1 set, read back", !written?.writeErrors?.length && written?.memory[0]?.bytes[0] === 7 && written?.regs?.r[1] === 0xabcd, `${written?.memory[0]?.bytes[0]}, r1 0x${written?.regs?.r[1].toString(16)}`)
  loop.dispose()
}

// --- a schematic file's debugger settings: repaired, not refused -----------------------------------

console.log("\nSettings from a schematic file")
{
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
  expect("breakpoints: the three that read as one kept", bps.map((b) => b.kind).join(",") === "line,function,address", bps.map((b) => b.kind).join(","))
  expect("a repeated id is replaced, a missing one made", new Set(bps.map((b) => b.id)).size === 3 && bps.every((b) => b.id), bps.map((b) => b.id.slice(0, 8)).join(" "))
  expect("enabled unless it says otherwise; the name trimmed", bps[1]?.enabled === true && bps[2]?.enabled === false && bps[1]?.kind === "function" && bps[1].name === "main")
  expect("sources: one per path, the last one, LF", d?.sources?.length === 1 && d.sources[0].content === "int b;\nint c;", JSON.stringify(d?.sources))
  expect("watches: the expressions only", JSON.stringify(d?.watches) === JSON.stringify(["GPIOB->ODR"]), JSON.stringify(d?.watches))
  expect("catchFaults: not a boolean, left to its default", d?.catchFaults === undefined)
  expect("not an object: nothing", normalizeDebug("x") === undefined && normalizeDebug([]) === undefined && normalizeDebug(null) === undefined)
}

console.log(`\n${total - failed}/${total} passed`)
if (failed) process.exit(1)
