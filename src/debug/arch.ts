/**
 * What the debugger's architecture-neutral half (DWARF, values, the stack) needs to know about
 * a core: how wide a pointer is, and how a pointer the program holds maps onto the one address
 * space the debugger reads through. On ARM that is the identity. On the AVR it is avr-gdb's
 * convention, which avr-gcc's ELF and DWARF already use for symbols: flash from 0, data space
 * at 0x800000, EEPROM at 0x810000. A data pointer holds the 16-bit data address, a function
 * pointer the word address; SP and the frame pointer Y hold data addresses.
 */
import { EM_AVR } from "@/mcu/elf"

export type DebugArch = {
  id: "arm" | "avr"
  /** Bytes in a pointer. */
  pointerSize: number
  /** A pointer the program holds, as a debugger address: `code` for a function pointer. */
  pointerToAddress(raw: number, code: boolean): number
  /** A debugger address as the pointer the program would hold. */
  addressToPointer(addr: number, code: boolean): number
  /** An address computed from registers (a stack or frame pointer plus an offset): a data address. */
  dataAddress(raw: number): number
  /** A DWARF register number's name. */
  regName(n: number): string
}

export const ARM: DebugArch = {
  id: "arm",
  pointerSize: 4,
  pointerToAddress: (raw) => raw >>> 0,
  addressToPointer: (addr) => addr >>> 0,
  dataAddress: (raw) => raw >>> 0,
  regName(n) {
    if (n < 13) return `r${n}`
    if (n === 13) return "sp"
    if (n === 14) return "lr"
    if (n === 15) return "pc"
    if (n >= 64 && n < 96) return `s${n - 64}`
    if (n >= 256 && n < 288) return `d${n - 256}`
    return `reg${n}`
  },
}

/** Where the AVR's data space starts in the debugger's addresses. */
export const AVR_DATA = 0x800000
/** avr-gcc's DWARF numbers past r0–r31: SP (two bytes) and the return-address column. */
export const AVR_DW_SP = 32
export const AVR_DW_RA = 36

export const AVR: DebugArch = {
  id: "avr",
  pointerSize: 2,
  // NULL stays 0 whichever space it would point into.
  pointerToAddress: (raw, code) => ((raw & 0xffff) === 0 ? 0 : code ? (raw & 0xffff) * 2 : AVR_DATA + (raw & 0xffff)),
  addressToPointer: (addr, code) => (code ? (addr >>> 1) & 0xffff : addr & 0xffff),
  dataAddress: (raw) => (raw < AVR_DATA ? AVR_DATA + (raw & 0xffff) : raw),
  regName: (n) => (n < 32 ? `r${n}` : n === AVR_DW_SP ? "sp" : n === AVR_DW_RA ? "pc" : `reg${n}`),
}

export function archOf(machine: number | undefined): DebugArch {
  return machine === EM_AVR ? AVR : ARM
}
