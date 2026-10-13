import { describe, expect, it } from "vitest"
import { STM32F429ZI, STM32F746IG, type ChipProfile } from "@/mcu/chip"
import { Stm32 } from "@/mcu/stm32f429"

const RCC_APB1ENR = 0x40023840
const USART3 = 0x40004800
const USART3EN = 1 << 18
type Register = "CR1" | "CR2" | "CR3" | "RQR"
const OFFSETS: Record<string, Partial<Record<Register, number>>> = {
  [STM32F429ZI.name]: { CR1: 0x0c, CR2: 0x10, CR3: 0x14 },
  [STM32F746IG.name]: { CR1: 0x00, CR2: 0x04, CR3: 0x08, RQR: 0x18 },
}
const SHARED_MODES: [Register, number, string][] = [
  ["CR2", 1 << 11, "USART3 synchronous mode (CK)"],
  ["CR2", 1 << 14, "USART3 LIN mode"],
  ["CR3", 1 << 1, "USART3 IrDA mode"],
  ["CR3", 1 << 3, "USART3 half-duplex mode"],
  ["CR3", 1 << 5, "USART3 smartcard mode"],
  ["CR3", 1 << 8, "USART3 RTS flow control"],
  ["CR3", 1 << 9, "USART3 CTS flow control"],
]
const F4_MODES: [Register, number, string][] = [
  ...SHARED_MODES,
  ["CR1", 1 << 0, "USART3 break character (SBK)"],
  ["CR1", 1 << 1, "USART3 mute mode (RWU)"],
]
const F7_MODES: [Register, number, string][] = [
  ...SHARED_MODES,
  ["CR1", 1 << 13, "USART3 mute mode (MME)"],
  ["CR2", 1 << 15, "USART3 TX/RX pin swap (SWAP)"],
  ["CR2", 1 << 20, "USART3 auto baud rate detection (ABREN)"],
  ["CR2", 1 << 23, "USART3 receiver timeout (RTOEN)"],
  ["CR3", 1 << 14, "USART3 RS-485 driver enable (DEM)"],
  ["RQR", 1 << 1, "USART3 break character (SBKRQ)"],
]
const F4_MODELLED: [Register, number][] = [
  ["CR1", (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 15)],
  ["CR2", 3 << 12],
  ["CR3", (1 << 0) | (1 << 6) | (1 << 7) | (1 << 11)],
]
const F7_MODELLED: [Register, number][] = [
  ["CR1", (1 << 0) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 10) | (1 << 12) | (1 << 14) | (1 << 15) | (1 << 28)],
  ["CR2", (3 << 12) | (1 << 16) | (1 << 17) | (1 << 18) | (1 << 19) | (0x0a << 24)],
  ["CR3", (1 << 0) | (1 << 6) | (1 << 7) | (1 << 11) | (1 << 12) | (1 << 13)],
  ["RQR", 1 << 3],
]

function usart3(chip: ChipProfile) {
  const mcu = new Stm32(chip)
  mcu.bus.write(RCC_APB1ENR, USART3EN, 4)
  const address = (register: Register) => USART3 + OFFSETS[chip.name][register]!
  return {
    write: (register: Register, value: number) => mcu.bus.write(address(register), value, 4),
    read: (register: Register) => mcu.bus.read(address(register), 4) >>> 0,
    reported: () => mcu.unmodelled.summary().map((s) => s.block),
  }
}

function reported(chip: ChipProfile, register: Register, bits: number) {
  const u = usart3(chip)
  u.write(register, bits)
  return u.reported()
}

describe.each([
  { name: STM32F429ZI.name, chip: STM32F429ZI, modes: F4_MODES, modelled: F4_MODELLED },
  { name: STM32F746IG.name, chip: STM32F746IG, modes: F7_MODES, modelled: F7_MODELLED },
])("$name: a USART mode the model lacks is reported, not ignored", ({ chip, modes, modelled }) => {
  it.each(modes)("%s bit %i: %s", (register, bit, what) => expect(reported(chip, register, bit)).toEqual([what]))

  it.each(modelled)("the modelled %s bits %i report nothing", (register, bits) => expect(reported(chip, register, bits)).toEqual([]))
})

describe("STM32F746 USART control registers", () => {
  it("reports MSB first with parity, which the reference manual leaves the parity bit's place open for", () => {
    const u = usart3(STM32F746IG)
    u.write("CR2", 1 << 19)
    expect(u.reported(), "MSB first alone is modelled").toEqual([])
    u.write("CR1", 1 << 10)
    expect(u.reported()).toEqual(["USART3 MSB first with parity"])
  })

  it.each([
    ["CR1", 0xffffffff, 0x1ffffffd],
    ["CR2", 0xffffffff, 0xffffff70],
    ["CR3", 0xffffffff, 0x000effff],
  ] as const)("%s keeps its reserved bits at zero", (register, written, readBack) => {
    const u = usart3(STM32F746IG)
    u.write(register, written)
    expect(u.read(register).toString(16)).toBe(readBack.toString(16))
  })
})
