/**
 * Hand encodings of the mid-range PIC instructions, bit for bit from DS40044G Table 15-2 (and
 * DS33023A §29 for OPTION and TRIS), for tests that need a few exact instructions.
 * `d` is 0 for W, 1 for f; `f` is the 7-bit file address inside the bank.
 */
const byteOp = (op: number) => (f: number, d: 0 | 1 = 1) => [(op << 8) | (d << 7) | (f & 0x7f)]
const bitOp = (op: number) => (f: number, b: number) => [(op << 10) | ((b & 7) << 7) | (f & 0x7f)]
const litOp = (op: number) => (k: number) => [(op << 8) | (k & 0xff)]

export const W = 0 as const
export const F = 1 as const

export const addwf = byteOp(0b00_0111)
export const andwf = byteOp(0b00_0101)
export const clrf = (f: number) => [0b00_0001_1000_0000 | (f & 0x7f)]
export const clrw = () => [0b00_0001_0000_0000]
export const comf = byteOp(0b00_1001)
export const decf = byteOp(0b00_0011)
export const decfsz = byteOp(0b00_1011)
export const incf = byteOp(0b00_1010)
export const incfsz = byteOp(0b00_1111)
export const iorwf = byteOp(0b00_0100)
export const movf = byteOp(0b00_1000)
export const movwf = (f: number) => [0b00_0000_1000_0000 | (f & 0x7f)]
export const nop = () => [0b00_0000_0000_0000]
export const rlf = byteOp(0b00_1101)
export const rrf = byteOp(0b00_1100)
export const subwf = byteOp(0b00_0010)
export const swapf = byteOp(0b00_1110)
export const xorwf = byteOp(0b00_0110)

export const bcf = bitOp(0b01_00)
export const bsf = bitOp(0b01_01)
export const btfsc = bitOp(0b01_10)
export const btfss = bitOp(0b01_11)

export const addlw = litOp(0b11_1110)
export const andlw = litOp(0b11_1001)
export const iorlw = litOp(0b11_1000)
export const movlw = litOp(0b11_0000)
export const retlw = litOp(0b11_0100)
export const sublw = litOp(0b11_1100)
export const xorlw = litOp(0b11_1010)
export const call = (k: number) => [0b10_0000_0000_0000 | (k & 0x7ff)]
export const goto = (k: number) => [0b10_1000_0000_0000 | (k & 0x7ff)]
export const clrwdt = () => [0b00_0000_0110_0100]
export const retfie = () => [0b00_0000_0000_1001]
export const return_ = () => [0b00_0000_0000_1000]
export const sleep = () => [0b00_0000_0110_0011]
/** OPTION: W → OPTION_REG (DS33023A §29.5). */
export const option = () => [0b00_0000_0110_0010]
/** TRIS f: W → the TRIS register of port f (5 or 6 here; DS33023A §29.5). */
export const tris = (f: number) => [0b00_0000_0110_0000 | (f & 7)]

/** A program as one word array. */
export const prog = (...parts: number[][]) => parts.flat()

// File addresses inside a bank (Figure 4-2).
export const INDF = 0x00
export const TMR0 = 0x01
export const PCL = 0x02
export const STATUS = 0x03
export const FSR = 0x04
export const PORTA = 0x05
export const PORTB = 0x06
export const PCLATH = 0x0a
export const INTCON = 0x0b
export const PIR1 = 0x0c
export const OPTION_REG = 0x81
export const TRISA = 0x85
export const TRISB = 0x86
export const PIE1 = 0x8c
export const PCON = 0x8e
// STATUS bits (Register 4-1).
export const C = 0
export const DC = 1
export const Z = 2
export const PD = 3
export const TO = 4
export const RP0 = 5
export const RP1 = 6
export const IRP = 7
