/**
 * Mid-range PIC chip profiles: what tells one PIC16F62x from another once the core and the
 * peripheral classes are shared — memory sizes, the RAM map, device ID, configuration word
 * layout and electrical ratings. Data only; `PicMcu` assembles the part.
 *
 * PIC16F627A/628A/648A: DS40044G (Microchip, 2009) — §3 Table 3-1, §4 Figures 4-2/4-3 and
 * Table 4-1. PIC16F627/628: DS40300C (2003) — §3 and §4, same map.
 */

export type PicProfile = {
  family: "pic"
  id: string
  name: string
  /** Program memory, 14-bit words: the PC wraps there (§4.1). */
  flashWords: number
  eepromBytes: number
  /** General purpose RAM ranges, 9-bit file addresses, inclusive (Table 4-1). */
  gpr: [number, number][]
  /** 16 bytes of common RAM at 70h–7Fh, seen again at these addresses (Table 4-1). */
  commonMirrors: number[]
}

/** Bank 0 20h–7Fh (70h–7Fh common), bank 1 A0h–EFh, bank 2 120h–14Fh: 224 bytes. */
const GPR_224: [number, number][] = [
  [0x20, 0x7f],
  [0xa0, 0xef],
  [0x120, 0x14f],
]
/** The 648A fills bank 2 to 16Fh: 256 bytes (Figure 4-3). */
const GPR_256: [number, number][] = [
  [0x20, 0x7f],
  [0xa0, 0xef],
  [0x120, 0x16f],
]
const COMMON = [0xf0, 0x170, 0x1f0]

export const PIC16F627A: PicProfile = { family: "pic", id: "PIC16F627A", name: "PIC16F627A", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, commonMirrors: COMMON }
export const PIC16F628A: PicProfile = { family: "pic", id: "PIC16F628A", name: "PIC16F628A", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, commonMirrors: COMMON }
export const PIC16F648A: PicProfile = { family: "pic", id: "PIC16F648A", name: "PIC16F648A", flashWords: 4096, eepromBytes: 256, gpr: GPR_256, commonMirrors: COMMON }
export const PIC16F627: PicProfile = { family: "pic", id: "PIC16F627", name: "PIC16F627", flashWords: 1024, eepromBytes: 128, gpr: GPR_224, commonMirrors: COMMON }
export const PIC16F628: PicProfile = { family: "pic", id: "PIC16F628", name: "PIC16F628", flashWords: 2048, eepromBytes: 128, gpr: GPR_224, commonMirrors: COMMON }

export const PIC_CHIPS: PicProfile[] = [PIC16F627, PIC16F628, PIC16F627A, PIC16F628A, PIC16F648A]

export function picChipById(id: string): PicProfile | undefined {
  return PIC_CHIPS.find((c) => c.id === id)
}
