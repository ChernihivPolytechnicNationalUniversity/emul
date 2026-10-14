/** Hand encodings of AVR instructions (DS40002198C §6) for tests that need a few exact instructions. */
export const nop = () => [0x0000]
export const ldi = (d: number, K: number) => [0xe000 | ((K & 0xf0) << 4) | ((d - 16) << 4) | (K & 0x0f)]
/** OUT A,Rr with A the I/O address (0x00–0x3F). */
export const out = (A: number, r: number) => [0xb800 | ((A & 0x30) << 5) | (r << 4) | (A & 0x0f)]
export const in_ = (d: number, A: number) => [0xb000 | ((A & 0x30) << 5) | (d << 4) | (A & 0x0f)]
export const sbi = (A: number, b: number) => [0x9a00 | (A << 3) | b]
export const cbi = (A: number, b: number) => [0x9800 | (A << 3) | b]
export const sts = (k: number, r: number) => [0x9200 | (r << 4), k]
export const lds = (d: number, k: number) => [0x9000 | (d << 4), k]
export const rjmp = (k: number) => [0xc000 | (k & 0x0fff)]
export const sei = () => [0x9478]
export const cli = () => [0x94f8]
export const sleep = () => [0x9588]
export const brk = () => [0x9598]
export const spm = () => [0x95e8]
/** LPM Rd, Z */
export const lpm = (d: number) => [0x9004 | (d << 4)]
/** A program as one word array. */
export const prog = (...parts: number[][]) => parts.flat()
