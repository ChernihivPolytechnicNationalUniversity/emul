/** SREG bits and the core registers that live in the I/O window (DS40002061B §7.3.1, §7.5). */
export const SREG_C = 0x01
export const SREG_Z = 0x02
export const SREG_N = 0x04
export const SREG_V = 0x08
export const SREG_S = 0x10
export const SREG_H = 0x20
export const SREG_T = 0x40
export const SREG_I = 0x80

/** Data-space addresses of SREG and the stack pointer. */
export const SREG = 0x5f
export const SPL = 0x5d
export const SPH = 0x5e
