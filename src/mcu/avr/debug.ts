/**
 * The AVR core as the debug unit sees it (`DebugTarget`): byte addresses over the word-addressed
 * flash, as avr-gcc's ELF and DWARF count program memory. A call leaves its return address on
 * the stack, high byte at SP+1 (pushed last), low byte at SP+2 (DS40002198C, CALL/RCALL/ICALL).
 * The core keeps no record of interrupt nesting, so `context` is 0 throughout: an interrupt
 * taken mid-step is seen through `onException`, a return from one by the stack.
 */
import type { DebugTarget } from "../debugger"
import type { AvrCpu } from "./cpu"

/** CALL k: 1001 010k kkkk 111k + 16-bit k. */
const isCall = (w: number) => (w & 0xfe0e) === 0x940e
/** RCALL k: 1101 kkkk kkkk kkkk. */
const isRcall = (w: number) => (w & 0xf000) === 0xd000
/** ICALL 0x9509, EICALL 0x9519. */
const isIcall = (w: number) => w === 0x9509 || w === 0x9519
const BREAK = 0x9598

export class AvrDebugTarget implements DebugTarget {
  readonly cpu: AvrCpu
  readonly callSizes = [4, 2] as const
  readonly context = 0
  constructor(cpu: AvrCpu) {
    this.cpu = cpu
  }
  get pc() {
    return this.cpu.pc << 1
  }
  setPc(addr: number) {
    this.cpu.pc = (addr >>> 1) & this.cpu.pcMask
  }
  get sp() {
    return this.cpu.sp
  }
  get breakpoints() {
    return this.cpu.breakpoints
  }
  get dbgActive() {
    return this.cpu.dbgActive
  }
  set dbgActive(v: boolean) {
    this.cpu.dbgActive = v
  }
  get stop() {
    return this.cpu.stop
  }
  set stop(v: boolean) {
    this.cpu.stop = v
  }
  /** The interpreter runs one instruction at a time: nothing compiled crosses a boundary. */
  dbgSplit = null
  flushBlocks() {}
  exceptionDue() {
    return this.cpu.interruptDue()
  }
  private word(addr: number) {
    return this.cpu.flash[(addr >>> 1) & this.cpu.pcMask]
  }
  callSize(addr: number) {
    if (addr & 1) return 0
    const w = this.word(addr)
    return isCall(w) ? 4 : isRcall(w) || isIcall(w) ? 2 : 0
  }
  breakSize(addr: number) {
    return !(addr & 1) && this.word(addr) === BREAK ? 2 : 0
  }
  callReturn(): number | null {
    const cpu = this.cpu
    const sp = cpu.sp
    if (sp + 2 > cpu.ramEnd) return null
    return (((cpu.data[sp + 1] << 8) | cpu.data[sp + 2]) & cpu.pcMask) << 1
  }
  /** The AVR has no fault exceptions to catch. */
  caughtFault() {
    return null
  }
}
