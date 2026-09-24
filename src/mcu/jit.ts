/**
 * Block compiler: turns a straight run of decoded instructions into one JavaScript function
 * (through `new Function`) so the engine runs it as a whole rather than calling one closure
 * per instruction. Instructions the decoder gave a `js` snippet are inlined — registers in
 * the `r` array, flags on the core, constants folded in; the rest are called through their
 * closure exactly as the interpreter would. Everything the plain step loop checks between
 * instructions is still checked, but only where it can matter: the cycle deadline (SysTick,
 * a peripheral event, the end of the run slice) after every instruction, and stop / pending
 * exception / sleep / IT state after anything that could have touched the bus.
 *
 * Snippet contract (see the decoder): statements over `c` (the Cpu), `r` (c.r), `bus`,
 * `s` (c.s) and `H` (jitHelpers); a snippet that leaves the straight line sets `c.pc` and ends with `$EXIT`;
 * `jsMem` marks snippets that may access the bus or fault, so the PC is set before them and
 * the peripheral-side checks run after them.
 */
import { LINE_FREE, LINE_PLAIN, type Cpu } from "./cpu"
import { FPX, jitHelpers, type Instr } from "./decode"

/** A compiled block: `run` executes from `addrs[0]` until it leaves the line or `target` cycles. */
export type Compiled = (c: Cpu, r: Uint32Array, bus: Cpu["bus"], s: Float32Array, I: Instr[], H: typeof jitHelpers, target: number) => void

/** The most wait states a flash access can cost (FLASH_ACR.LATENCY is four bits). */
const MAX_WAIT = 15

export function compileBlock(addrs: ArrayLike<number>, instrs: Instr[], lineShift: number): Compiled {
  const n = instrs.length
  // A block whose last branch targets its own start runs as a loop: the back edge is a
  // `continue` after the same checks any instruction makes.
  const loop = instrs[n - 1].jsBranch?.target === addrs[0]
  const out: string[] = ['"use strict";', "let dl = c.deadline(target), e = 0;", loop ? "for (;;) {" : ""]
  const exit = (i: number) => `c.instructions += ${i + 1}; return;`
  /** A snippet's own exit (a taken branch) still owes the instruction's base cycles. */
  const exitSnippet = (i: number) => `c.cycles += ${instrs[i].cycles}; ${exit(i)}`
  const service = (i: number, pc: number) => `if (c.cycles >= dl && (dl = c.tick(target)) < 0) { c.pc = ${pc}; ${exit(i)} }`
  const lineOf = (i: number) => addrs[i] >>> lineShift
  /** What follows an access the bus flagged as beyond plain memory: the clock or pending state may have moved. */
  const afterSlow = (i: number, N: number) => {
    const next = i + 1 < n && lineOf(i + 1) === lineOf(i) ? addrs[i + 1] : -1
    return `if ((dl = c.slowTick(target, ${next})) < 0) { c.pc = ${N}; ${exit(i)} }`
  }
  /** Straight-line snippets: register-only or plain loads and stores, no exits of their own. */
  const straight = (i: number) => {
    const x = instrs[i]
    return x.js !== undefined && x.jsBranch === undefined && !x.js.includes("$EXIT")
  }

  /** Instruction `i` with every check after it, exactly as the interpreter would make them. */
  const checked = (i: number): string => {
    const instr = instrs[i]
    const A = addrs[i]
    const N = (A + instr.size) >>> 0
    const js = instr.js?.replaceAll("$A", String(A))
    const br = instr.jsBranch
    const next = i + 1 < n ? addrs[i + 1] : -1
    if (br !== undefined) {
      // A static branch: the block may go on at the target (a call, a jump, a loop's back
      // edge) or at the fall-through; whichever the layout did not follow leaves the block.
      const taken = `${br.link ? `r[14] = ${(N | 1) >>> 0};` : ""} c.cycles += ${instr.cycles + br.extra};`
      const leaveTaken = `${taken} c.pc = ${br.target}; ${exit(i)}`
      const leaveNext = `c.cycles += ${instr.cycles}; c.pc = ${N}; ${exit(i)}`
      const goOn = service(i, next)
      const back = `${taken} ${service(i, addrs[0])} c.instructions += ${n}; continue;`
      if (br.cond === null) {
        if (loop && i === n - 1) return back
        if (br.target === next) return `${taken} ${goOn}`
        return leaveTaken
      }
      if (loop && i === n - 1) return `if (${br.cond}) { ${back} } ${leaveNext}`
      if (br.target === next) return `if (!(${br.cond})) { ${leaveNext} } ${taken} ${goOn}`
      if (N === next) return `if (${br.cond}) { ${leaveTaken} } c.cycles += ${instr.cycles}; ${goOn}`
      return `if (${br.cond}) { ${leaveTaken} } ${leaveNext}`
    }
    if (js !== undefined && !instr.jsMem) return `{ ${synced(js).replaceAll("$EXIT", exitSnippet(i))} } c.cycles += ${instr.cycles}; ${service(i, N)}`
    if (js !== undefined) {
      // The bus flags an access that went beyond plain memory (a peripheral, a stall): only
      // then can the deadline have moved or an exception be pending. The PC is left where
      // the access can report a fault against it.
      return `c.pc = ${A}; { ${synced(js).replaceAll("$EXIT", exitSnippet(i))} } c.cycles += ${instr.cycles}; if (bus.slow) { ${afterSlow(i, N)} } else ${service(i, N)}`
    }
    return (
      `c.pc = ${A}; c.nextPc = ${N}; ${FLUSH} I[${i}].exec(c); ${RELOAD} c.cycles += ${instr.cycles}; if (c.nextPc !== ${N}) { c.pc = c.nextPc; ${exit(i)} } ` +
      `${afterSlow(i, N)} if (c.sleeping || c.itstate !== 0) { c.pc = ${N}; ${exit(i)} }`
    )
  }

  /**
   * A run of straight-line instructions on one flash line, unchecked while its cycles cannot
   * reach the deadline and the FPU is on. An access the bus flags as slow takes its checks
   * and hands the rest of the run to the checked form, entered at the next instruction.
   */
  const segment = (from: number, to: number): string => {
    let sum = 0
    // Every read may land in flash and pay its wait states (never more than 15) without the bus flagging it.
    let stall = 0
    for (let k = from; k < to; k++) {
      sum += instrs[k].cycles
      stall += instrs[k].js!.split("bus.read").length - 1
    }
    const fp = instrs.slice(from, to).some((x) => x.js!.startsWith(FPX))
    const fast: string[] = []
    let owed = 0
    let marked = false
    for (let k = from; k < to; k++) {
      const x = instrs[k]
      const A = addrs[k]
      const N = (A + x.size) >>> 0
      let js = x.js!
      if (js.startsWith(FPX)) {
        js = js.slice(FPX.length)
        if (!marked) fast.push("c.control |= 4;")
        marked = true
      }
      js = js.replaceAll("$A", String(A))
      if (!x.jsMem) {
        fast.push(`{ ${js} }`)
        owed += x.cycles
        continue
      }
      if (owed) fast.push(`c.cycles += ${owed};`)
      owed = 0
      fast.push(`c.pc = ${A}; { ${js} } c.cycles += ${x.cycles};`)
      if (k + 1 < to) fast.push(`if (bus.slow) { ${afterSlow(k, N)} e = ${k + 1 - from}; break seg; }`)
      else fast.push(`if (bus.slow) { ${afterSlow(k, N)} }`)
    }
    if (owed) fast.push(`c.cycles += ${owed};`)
    const cases: string[] = []
    for (let k = from; k < to; k++) cases.push(`case ${k - from}: ${checked(k)}`)
    return `e = 0; seg: if (c.cycles + ${sum + stall * MAX_WAIT} < dl${fp ? " && c.fpOn" : ""}) { ${fast.join(" ")} e = -1; } if (e >= 0) switch (e) { ${cases.join("\n")} }`
  }

  // A line change the block makes, charged without the lookup while the accelerator and the
  // timing are as when this site last looked (`Cpu.artEpoch`): free, or flash's wait states
  // unless the prefetch has the next line.
  let sites = 0
  const fetch = (A: number, line: number) => {
    const k = 2 * sites++
    return (
      `{ const e = c.artEpoch; if (E[${k}] === e) { if (E[${k + 1}] === ${LINE_PLAIN} && !(c.fetchPrefetch && ${line} === c.lastLine + 1)) c.cycles += c.fetchLatency; c.lastLine = ${line}; } ` +
      `else { c.cycles += c.fetchCost(${A}, ${line}); E[${k}] = c.lineKind === ${LINE_FREE} || c.lineKind === ${LINE_PLAIN} ? c.artEpoch : -1; E[${k + 1}] = c.lineKind; } }`
    )
  }
  let prevLine = -1
  for (let i = 0; i < n; ) {
    const A = addrs[i]
    const line = lineOf(i)
    // Flash timing: a new line pays its wait states. Inside the block only line changes can
    // matter (a cache reset by a store into the flash controller is caught on the slow path
    // below); at entry the last line fetched before the block is checked.
    if (i === 0) out.push(`if (c.timed && ${line} !== c.lastLine) ${fetch(A, line)}`)
    else if (line !== prevLine) out.push(`if (c.timed) ${fetch(A, line)}`)
    prevLine = line
    let j = i
    while (j < n && straight(j) && lineOf(j) === line) j++
    if (j - i > 1) {
      out.push(segment(i, j))
      i = j
    } else {
      out.push(checked(i))
      i++
    }
  }
  const last = instrs[n - 1]
  if (last.jsBranch === undefined) out.push(`c.pc = ${(addrs[n - 1] + last.size) >>> 0}; c.instructions += ${n};`)
  else if (!loop) out.push(`c.instructions += ${n};`)
  if (loop) out.push("}")
  const make = new Function("E", `return function (c, r, bus, s, I, H, target) { ${localise(out.join("\n"))} }`)
  return make(new Float64Array(2 * sites).fill(-1)) as Compiled
}

/** Around code that may read or change the core's registers and flags itself (a closure, an exception return). */
const FLUSH = "$FLUSH;"
const RELOAD = "$RELOAD;"
/** Snippet calls that touch nothing but the PC (or throw): the rest of `c.…(` calls are synced. */
const PURE_CALL = /^c\.(fpDenied|readPc)\($/

/** A snippet that calls into the core gets the locals written back before and read again after. */
function synced(js: string) {
  const calls = js.match(/\bc\.\w+\(/g)
  if (!calls || calls.every((m) => PURE_CALL.test(m))) return js
  return `${FLUSH} ${js.replaceAll("$EXIT", `${RELOAD} $EXIT`)} ${RELOAD}`
}

/**
 * The block with the registers and the APSR flags it touches in locals, which the engine keeps
 * in machine registers: read at entry, written back on every way out (`finally` covers the
 * returns and a fault thrown mid-block) and around the calls marked `FLUSH`/`RELOAD`. Every
 * snippet stores registers as unsigned 32-bit values, as the `Uint32Array` would keep them.
 */
function localise(body: string): string {
  const regs = [...new Set([...body.matchAll(/\br\[(\d+)\]/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  const flags = (["n", "z", "c", "v"] as const).filter((f) => new RegExp(`\\bc\\.${f}\\b`).test(body))
  if (!regs.length && !flags.length) return body.replaceAll(FLUSH, "").replaceAll(RELOAD, "")
  const store = [...regs.map((k) => `r[${k}] = r${k};`), ...flags.map((f) => `c.${f} = f${f};`)].join(" ")
  const load = [...regs.map((k) => `r${k} = r[${k}];`), ...flags.map((f) => `f${f} = c.${f};`)].join(" ")
  const decl = [...regs.map((k) => `r${k} = r[${k}]`), ...flags.map((f) => `f${f} = c.${f}`)].join(", ")
  let code = body.replace(/\br\[(\d+)\]/g, "r$1")
  for (const f of flags) code = code.replace(new RegExp(`\\bc\\.${f}\\b`, "g"), `f${f}`)
  code = code.replaceAll(FLUSH, store).replaceAll(RELOAD, load)
  const strict = '"use strict";'
  return `${strict} let ${decl}; try { ${code.replace(strict, "")} } finally { ${store} }`
}
