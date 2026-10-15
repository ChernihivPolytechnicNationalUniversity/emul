/**
 * AVR instructions as text, in avr-objdump's spelling (so a listing from the toolchain and the
 * debugger's view read the same): no aliases (ADD Rd,Rd stays `add`, not `lsl`), the SREG bit
 * set/clear and branch forms by name, relative jumps as `.+N` from the next instruction, and
 * the comment objdump puts after `;` (the value in decimal, a target address). Encodings from
 * the AVR Instruction Set Manual (DS40002198C); a word that encodes nothing is `.word`.
 * Addresses are bytes; `target` is where a jump or call goes, for the view to name.
 */
export type AvrInsn = { size: 2 | 4; mnemonic: string; operands: string; comment: string; target: number | null }

const SREG_SET = ["sec", "sez", "sen", "sev", "ses", "seh", "set", "sei"]
const SREG_CLEAR = ["clc", "clz", "cln", "clv", "cls", "clh", "clt", "cli"]
const BRANCH_SET = ["brcs", "breq", "brmi", "brvs", "brlt", "brhs", "brts", "brie"]
const BRANCH_CLEAR = ["brcc", "brne", "brpl", "brvc", "brge", "brhc", "brtc", "brid"]

const hex2 = (v: number) => `0x${v.toString(16).padStart(2, "0")}`
const HEX2 = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, "0")}`
/** C's `%#x`: plain 0 without the prefix. */
const altHex = (v: number) => (v === 0 ? "0" : `0x${v.toString(16)}`)

/** Whether the word starts a two-word instruction (LDS, STS, JMP, CALL). */
export function avrTwoWord(w: number) {
  return (w & 0xfc0f) === 0x9000 || (w & 0xfe0c) === 0x940c
}

/** The instruction at byte address `addr`: `w1` its first word, `w2` the next. */
export function avrDisasm(w1: number, w2: number, addr: number): AvrInsn {
  const one = (mnemonic: string, operands = "", comment = "", target: number | null = null): AvrInsn => ({ size: 2, mnemonic, operands, comment, target })
  const d5 = (w1 >> 4) & 0x1f
  const r5 = (w1 & 0x0f) | ((w1 >> 5) & 0x10)
  const two = `r${d5}, r${r5}`
  const k8 = ((w1 >> 4) & 0xf0) | (w1 & 0x0f)
  const d16 = 16 + ((w1 >> 4) & 0x0f)
  const rel = (k: number) => {
    // As objdump counts it: past address 0 a backward jump goes negative, shown as 32 bits.
    const target = (addr + 2 + k * 2) >>> 0
    return { text: `.${k * 2 >= 0 ? "+" : ""}${k * 2}`, target }
  }
  const word = () => one(".word", `0x${w1.toString(16).padStart(4, "0")}`, "????")

  switch (w1 >> 12) {
    case 0x0:
      if (w1 === 0) return one("nop")
      switch ((w1 >> 8) & 0xf) {
        case 0x1:
          return one("movw", `r${((w1 >> 4) & 0xf) * 2}, r${(w1 & 0xf) * 2}`)
        case 0x2:
          return one("muls", `r${d16}, r${16 + (w1 & 0xf)}`)
        case 0x3: {
          const ops = `r${16 + ((w1 >> 4) & 7)}, r${16 + (w1 & 7)}`
          return one(["mulsu", "fmul", "fmuls", "fmulsu"][((w1 >> 6) & 2) | ((w1 >> 3) & 1)], ops)
        }
        case 0x0:
          return word()
      }
      return one(["", "cpc", "sbc", "add"][(w1 >> 10) & 3], two)
    case 0x1:
      return one(["cpse", "cp", "sub", "adc"][(w1 >> 10) & 3], two)
    case 0x2:
      return one(["and", "eor", "or", "mov"][(w1 >> 10) & 3], two)
    case 0x3:
    case 0x4:
    case 0x5:
    case 0x6:
    case 0x7:
    case 0xe:
      return one({ 3: "cpi", 4: "sbci", 5: "subi", 6: "ori", 7: "andi", 14: "ldi" }[w1 >> 12]!, `r${d16}, ${HEX2(k8)}`, String(k8))
    case 0x8:
    case 0xa: {
      const q = (w1 & 7) | ((w1 >> 7) & 0x18) | ((w1 >> 8) & 0x20)
      const ptr = w1 & 8 ? "Y" : "Z"
      const store = (w1 & 0x200) !== 0
      if (q === 0) return store ? one("st", `${ptr}, r${d5}`) : one("ld", `r${d5}, ${ptr}`)
      return store ? one("std", `${ptr}+${q}, r${d5}`, hex2(q)) : one("ldd", `r${d5}, ${ptr}+${q}`, hex2(q))
    }
    case 0x9:
      return group9(w1, w2, one, d5, two, word)
    case 0xb: {
      const a = (w1 & 0x0f) | ((w1 >> 5) & 0x30)
      return w1 & 0x800 ? one("out", `${hex2(a)}, r${d5}`, String(a)) : one("in", `r${d5}, ${hex2(a)}`, String(a))
    }
    case 0xc:
    case 0xd: {
      const k = ((w1 & 0xfff) << 20) >> 20
      const j = rel(k)
      return one(w1 >> 12 === 0xc ? "rjmp" : "rcall", j.text, `0x${j.target.toString(16)}`, j.target)
    }
    case 0xf: {
      if (!(w1 & 0x800)) {
        const k = ((w1 >> 3) & 0x7f) << 25 >> 25
        const j = rel(k)
        return one((w1 & 0x400 ? BRANCH_CLEAR : BRANCH_SET)[w1 & 7], j.text, `0x${j.target.toString(16)}`, j.target)
      }
      if (w1 & 8) return word()
      return one(["bld", "bst", "sbrc", "sbrs"][(w1 >> 9) & 3], `r${d5}, ${w1 & 7}`)
    }
  }
  return word()
}

function group9(w1: number, w2: number, one: (m: string, o?: string, c?: string, t?: number | null) => AvrInsn, d5: number, two: string, word: () => AvrInsn): AvrInsn {
  const low = w1 & 0xf
  switch ((w1 >> 9) & 7) {
    case 0: // 1001 000d: loads
    case 1: {
      // 1001 001r: stores
      const store = (w1 & 0x200) !== 0
      if (low === 0) {
        const k = `0x${w2.toString(16).toUpperCase().padStart(4, "0")}`
        const comment = `0x${(0x800000 + w2).toString(16)}`
        return { ...(store ? one("sts", `${k}, r${d5}`, comment) : one("lds", `r${d5}, ${k}`, comment)), size: 4 }
      }
      if (low === 0xf) return one(store ? "push" : "pop", `r${d5}`)
      const ptr: Record<number, string> = { 1: "Z+", 2: "-Z", 9: "Y+", 10: "-Y", 12: "X", 13: "X+", 14: "-X" }
      if (ptr[low]) return store ? one("st", `${ptr[low]}, r${d5}`) : one("ld", `r${d5}, ${ptr[low]}`)
      if (!store) {
        if (low === 4) return one("lpm", `r${d5}, Z`)
        if (low === 5) return one("lpm", `r${d5}, Z+`)
        if (low === 6) return one("elpm", `r${d5}, Z`)
        if (low === 7) return one("elpm", `r${d5}, Z+`)
      } else if (low >= 4 && low <= 7) return one(["xch", "las", "lac", "lat"][low - 4], `Z, r${d5}`)
      return word()
    }
    case 2: {
      // 1001 010x
      if ((w1 & 0xc) === 0xc) {
        const k = (((w1 >> 3) & 0x3e) | (w1 & 1)) * 0x10000 + w2
        const target = k * 2
        return { ...one(w1 & 2 ? "call" : "jmp", altHex(target), `0x${target.toString(16)}`, target), size: 4 }
      }
      const single: Record<number, string> = { 0: "com", 1: "neg", 2: "swap", 3: "inc", 5: "asr", 6: "lsr", 7: "ror", 10: "dec" }
      if (single[low] !== undefined) return one(single[low], `r${d5}`)
      if (low === 8) {
        if (!(w1 & 0x100)) return one((w1 & 0x80 ? SREG_CLEAR : SREG_SET)[(w1 >> 4) & 7])
        const misc: Record<number, string> = { 0x9508: "ret", 0x9518: "reti", 0x9588: "sleep", 0x9598: "break", 0x95a8: "wdr", 0x95c8: "lpm", 0x95d8: "elpm", 0x95e8: "spm", 0x95f8: "spm" }
        if (w1 === 0x95f8) return one("spm", "Z+")
        return misc[w1] ? one(misc[w1]) : word()
      }
      if (low === 9) {
        const m: Record<number, string> = { 0x9409: "ijmp", 0x9419: "eijmp", 0x9509: "icall", 0x9519: "eicall" }
        return m[w1] ? one(m[w1]) : word()
      }
      if (low === 0xb && !(w1 & 0x100)) {
        const k = (w1 >> 4) & 0xf
        return one("des", HEX2(k), String(k))
      }
      return word()
    }
    case 3: {
      // ADIW/SBIW: 1001 011x KKdd KKKK
      const k = ((w1 >> 2) & 0x30) | (w1 & 0xf)
      return one(w1 & 0x100 ? "sbiw" : "adiw", `r${24 + ((w1 >> 4) & 3) * 2}, ${hex2(k)}`, String(k))
    }
    case 4:
    case 5: {
      // CBI/SBIC/SBI/SBIS: 1001 10xx AAAA Abbb
      const a = (w1 >> 3) & 0x1f
      return one(["cbi", "sbic", "sbi", "sbis"][(w1 >> 8) & 3], `${hex2(a)}, ${w1 & 7}`, String(a))
    }
    default:
      return one("mul", two)
  }
}
