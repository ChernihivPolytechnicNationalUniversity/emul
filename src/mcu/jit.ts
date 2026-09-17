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
import type { Cpu } from "./cpu"
import { jitHelpers, type Instr } from "./decode"

/** A compiled block: `run` executes from `addrs[0]` until it leaves the line or `target` cycles. */
export type Compiled = (c: Cpu, r: Uint32Array, bus: Cpu["bus"], s: Float32Array, I: Instr[], H: typeof jitHelpers, target: number) => void

export function compileBlock(addrs: ArrayLike<number>, instrs: Instr[], lineShift: number): Compiled {
  const n = instrs.length
  // A block whose last branch targets its own start runs as a loop: the back edge is a
  // `continue` after the same checks any instruction makes.
  const loop = instrs[n - 1].jsBranch?.target === addrs[0]
  const out: string[] = ['"use strict";', "let dl = c.deadline(target);", loop ? "for (;;) {" : ""]
  const exit = (i: number) => `c.instructions += ${i + 1}; return;`
  /** A snippet's own exit (a taken branch) still owes the instruction's base cycles. */
  const exitSnippet = (i: number) => `c.cycles += ${instrs[i].cycles}; ${exit(i)}`
  let prevLine = -1
  for (let i = 0; i < n; i++) {
    const instr = instrs[i]
    const A = addrs[i]
    const N = (A + instr.size) >>> 0
    const line = A >>> lineShift
    // Flash timing: a new line pays its wait states. Inside the block only line changes can
    // matter (a cache reset by a store into the flash controller is caught on the slow path
    // below); at entry the last line fetched before the block is checked.
    if (i === 0) out.push(`if (c.timed && ${line} !== c.lastLine) c.cycles += c.fetchCost(${A}, ${line});`)
    else if (line !== prevLine) out.push(`if (c.timed) c.cycles += c.fetchCost(${A}, ${line});`)
    prevLine = line
    const js = instr.js?.replaceAll("$A", String(A))
    const br = instr.jsBranch
    const next = i + 1 < n ? addrs[i + 1] : -1
    // After an access that reset the flash caches the next fetch pays again even on the same
    // line (a new line is charged by the static check above anyway).
    const nextLine = next >= 0 ? next >>> lineShift : -1
    const reset = nextLine === line ? `if (c.lastLine === -1 && c.timed) c.cycles += c.fetchCost(${next}, ${nextLine});` : ""
    // At the deadline the due SysTick/peripheral events are serviced in place; the block goes
    // on unless the slice is over or something (an exception now pending, a stop request)
    // needs the step path.
    const service = `if (c.cycles >= dl) { c.service(); dl = c.deadline(target); if (c.cycles >= target || c.stop || c.scs.pendingCount !== 0) { c.pc = ${N}; ${exit(i)} } }`
    if (br !== undefined) {
      // A static branch: the block may go on at the target (a call, a jump, a loop's back
      // edge) or at the fall-through; whichever the layout did not follow leaves the block.
      const taken = `${br.link ? `r[14] = ${(N | 1) >>> 0};` : ""} c.cycles += ${instr.cycles + br.extra};`
      const leaveTaken = `${taken} c.pc = ${br.target}; ${exit(i)}`
      const leaveNext = `c.cycles += ${instr.cycles}; c.pc = ${N}; ${exit(i)}`
      const goOn = `if (c.cycles >= dl) { c.service(); dl = c.deadline(target); if (c.cycles >= target || c.stop || c.scs.pendingCount !== 0) { c.pc = ${next}; ${exit(i)} } }`
      const back = `${taken} if (c.cycles >= dl) { c.service(); dl = c.deadline(target); if (c.cycles >= target || c.stop || c.scs.pendingCount !== 0) { c.pc = ${addrs[0]}; ${exit(i)} } } c.instructions += ${n}; continue;`
      if (br.cond === null) {
        if (loop && i === n - 1) out.push(back)
        else if (br.target === next) out.push(`${taken} ${goOn}`)
        else out.push(leaveTaken)
      } else if (loop && i === n - 1) out.push(`if (${br.cond}) { ${back} } ${leaveNext}`)
      else if (br.target === next) out.push(`if (!(${br.cond})) { ${leaveNext} } ${taken} ${goOn}`)
      else if (N === next) out.push(`if (${br.cond}) { ${leaveTaken} } c.cycles += ${instr.cycles}; ${goOn}`)
      else out.push(`if (${br.cond}) { ${leaveTaken} } ${leaveNext}`)
    } else if (js !== undefined && !instr.jsMem) {
      out.push(`{ ${js.replaceAll("$EXIT", exitSnippet(i))} }`)
      out.push(`c.cycles += ${instr.cycles};`)
      out.push(service)
    } else if (js !== undefined) {
      // The bus flags an access that went beyond plain memory (a peripheral, a stall): only
      // then can the deadline have moved or an exception be pending. The PC is left where
      // the access can report a fault against it.
      out.push(`c.pc = ${A};`)
      out.push(`{ ${js.replaceAll("$EXIT", exitSnippet(i))} }`)
      out.push(`c.cycles += ${instr.cycles};`)
      out.push(`if (bus.slow) { bus.slow = false; ${reset} dl = c.deadline(target); ${service} if (c.stop || c.scs.pendingCount !== 0) { c.pc = ${N}; ${exit(i)} } } else ${service}`)
    } else {
      out.push(`c.pc = ${A}; c.nextPc = ${N}; I[${i}].exec(c); c.cycles += ${instr.cycles};`)
      out.push(`if (c.nextPc !== ${N}) { c.pc = c.nextPc; ${exit(i)} }`)
      out.push(`bus.slow = false; ${reset} dl = c.deadline(target);`)
      out.push(service)
      out.push(`if (c.stop || c.sleeping || c.itstate !== 0 || c.scs.pendingCount !== 0) { c.pc = ${N}; ${exit(i)} }`)
    }
  }
  const last = instrs[n - 1]
  if (last.jsBranch === undefined) out.push(`c.pc = ${(addrs[n - 1] + last.size) >>> 0}; c.instructions += ${n};`)
  else if (!loop) out.push(`c.instructions += ${n};`)
  if (loop) out.push("}")
  return new Function("c", "r", "bus", "s", "I", "H", "target", out.join("\n")) as Compiled
}
