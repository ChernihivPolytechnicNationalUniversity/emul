/**
 * Chip profiles: what tells one STM32 from another once the shared core and peripheral
 * models are in place. A profile is data only — memory map, core identity, device id — so
 * the SoC class stays one and the same for every part.
 *
 * Sources: RM0090 §2.3 (F42x memory map), RM0385 §2.3 (F74x memory map), DS9405/DS10693 for
 * the pin-outs, ARM DDI0439 (Cortex-M4) and DDI0489 (Cortex-M7) for the ID registers.
 */

export type MemoryRegion = {
  name: string
  base: number
  size: number
  kind: "flash" | "ram" | "rom"
  /** Other base addresses the same bytes appear at (boot alias, ITCM alias). */
  aliases?: number[]
  /**
   * Behind an external memory controller: "sdram1"/"sdram2" hang on the FMC's SDRAM banks
   * and answer only once the controller has initialised them.
   */
  external?: "sdram1" | "sdram2"
}

export type CoreProfile = {
  name: string
  /** SCB CPUID. */
  cpuid: number
  /** MVFR0..2: which FP extension the core reports. */
  mvfr: [number, number, number]
  /** Cortex-M7 has L1 caches (CLIDR/CCSIDR/cache-maintenance registers); M4 has none. */
  cache: boolean
  /** ARMv7-M bit-banding of SRAM and the peripheral window: present on M3/M4, dropped on M7. */
  bitBand: boolean
}

/**
 * Electrical side of the part, from the datasheet's "absolute maximum ratings" and "supply
 * current" sections. The schematic model of every MCU component is generated from these, so
 * a new part only needs its numbers here.
 */
export type ChipElectrical = {
  /** Nominal VDD the part is run at, V. */
  vdd: number
  /** Absolute maximum VDD, V; above it the die is destroyed. */
  vddMax: number
  /** Absolute maximum on any I/O pin against VSS, V (FT pins). */
  pinVoltageMax: number
  /** Absolute maximum current through one I/O pin, A. */
  pinCurrentMax: number
  /**
   * Typical supply currents, A, at 25 °C with every peripheral clocked (DS9405 §6.3.6,
   * DS10916 §6.3.6): run and sleep as [floor, per MHz of HCLK]; Stop with the main regulator,
   * the low-power regulator, and under-drive; Standby with the RTC running.
   */
  idd: { run: [number, number]; sleep: [number, number]; stop: number; stopLp: number; stopUd: number; standby: number }
  /** Wake-up latency, s: leaving Stop on the main regulator, the low-power regulator, under-drive; leaving Standby. */
  wakeup: { stop: number; stopLp: number; stopUd: number; standby: number }
  /** Internal pull-up on NRST, Ω. */
  nrstPullUp: number
  /** Internal pull-down on BOOT0, Ω, on parts that have one. */
  boot0PullDown?: number
}

export type ChipProfile = {
  id: string
  /** Part number as printed on the package. */
  name: string
  core: CoreProfile
  memory: MemoryRegion[]
  /** DBGMCU IDCODE (device id in bits 11:0, revision in 31:16). */
  idcode: number
  /** Vector table the core boots from with BOOT0 low (F7: the BOOT_ADD0 option byte's default). */
  bootVector: number
  /**
   * Boot selection: "pins" (F4: BOOT0/BOOT1 pick flash, system memory or SRAM) or "options"
   * (F7: BOOT0 picks BOOT_ADD0 or BOOT_ADD1 from the option bytes, in 16 KB units).
   */
  boot: "pins" | "options"
  /** Flash controller geometry (RM0090 §3.3, RM0385 §3.3). */
  flash: {
    /** Controller register map: "v1" (F4: WDG_SW, two banks, boot by pins) or "v2" (F7: IWDG/WWDG_SW, BOOT_ADD0/1). */
    map: "v1" | "v2"
    /** Sector sizes of one bank in order; a second bank repeats them (SNB codes 16 + index). */
    sectors: number[]
    banks: 1 | 2
    /** System memory: where the ST bootloader lives, entered with BOOT0 high. */
    system: { base: number; size: number }
    /** Where the option bytes read back from. */
    optionBytes: number
  }
  /** USART register map: "v1" (F4: SR/DR) or "v2" (F7: ISR/ICR/RDR/TDR). */
  usart: "v1" | "v2"
  /** SPI register map: "v1" (F4: DFF, one-word holding registers) or "v2" (F7: DS, FIFOs). */
  spi: "v1" | "v2"
  /** I²C register map: "v1" (F4: CR1 START/STOP, SR1/SR2, CCR) or "v2" (F7: CR2 NBYTES, ISR, TIMINGR). */
  i2c: "v1" | "v2"
  /** PWR register map: "v1" (F4: CR/CSR, one WKUP pin) or "v2" (F7: CR1/CSR1 plus CR2/CSR2 for six WKUP pins). */
  pwr: "v1" | "v2"
  electrical: ChipElectrical
}

export const CORTEX_M4F: CoreProfile = {
  name: "Cortex-M4F",
  cpuid: 0x410fc241, // r0p1
  mvfr: [0x10110021, 0x11000011, 0], // FPv4-SP-D16
  cache: false,
  bitBand: true,
}

export const CORTEX_M7: CoreProfile = {
  name: "Cortex-M7",
  cpuid: 0x410fc271, // r1p1, as fitted in STM32F74x/75x
  mvfr: [0x10110221, 0x12000011, 0x00000040], // FPv5-D16: single and double precision
  cache: true,
  bitBand: false,
}

/** STM32F429ZIT6 (NUCLEO-F429ZI): 2 MB flash, 192 KB SRAM + 64 KB CCM. RM0090 §2.3.1. */
export const STM32F429ZI: ChipProfile = {
  id: "stm32f429zi",
  name: "STM32F429ZIT6",
  core: CORTEX_M4F,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 2 * 1024 * 1024, kind: "flash", aliases: [0x00000000] },
    { name: "SRAM", base: 0x20000000, size: 192 * 1024, kind: "ram" },
    { name: "CCM", base: 0x10000000, size: 64 * 1024, kind: "ram" },
    { name: "SYSTEM", base: 0x1fff0000, size: 30 * 1024, kind: "rom" },
    { name: "OPT", base: 0x1fffc000, size: 16, kind: "rom" },
  ],
  idcode: 0x20016419, // STM32F42x/43x, rev 3
  bootVector: 0x08000000,
  boot: "pins",
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128].map((k) => k * 1024), banks: 2, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000 },
  usart: "v1",
  spi: "v1",
  i2c: "v1",
  pwr: "v1",
  // DS9405 §6.2 (Tables 11, 12, 14), §6.3.6 (Tables 26–33: 180 MHz, all peripherals on), §6.3.15.
  electrical: {
    vdd: 3.3,
    vddMax: 4.0,
    pinVoltageMax: 5.5,
    pinCurrentMax: 0.025,
    idd: { run: [4e-3, 0.5e-3], sleep: [3e-3, 0.2e-3], stop: 1.2e-3, stopLp: 0.55e-3, stopUd: 0.13e-3, standby: 3e-6 },
    wakeup: { stop: 13e-6, stopLp: 21e-6, stopUd: 110e-6, standby: 300e-6 },
    nrstPullUp: 40e3,
  },
}

/**
 * STM32F746IGT6 (LQFP176): 1 MB flash on the AXI bus at 0x0800_0000 with its ITCM alias at
 * 0x0020_0000, 16 KB ITCM-RAM, and 320 KB of RAM at 0x2000_0000 that firmware sees as one
 * block (DTCM 64 KB, SRAM1 240 KB, SRAM2 16 KB back to back). RM0385 §2.3.1.
 */
export const STM32F746IG: ChipProfile = {
  id: "stm32f746ig",
  name: "STM32F746IGT6",
  core: CORTEX_M7,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 1024 * 1024, kind: "flash", aliases: [0x00200000] },
    { name: "ITCM", base: 0x00000000, size: 16 * 1024, kind: "ram" },
    { name: "RAM", base: 0x20000000, size: 320 * 1024, kind: "ram" },
    { name: "SYSTEM", base: 0x1ff00000, size: 60 * 1024, kind: "rom", aliases: [0x00100000] },
    { name: "OPT", base: 0x1fff0000, size: 32, kind: "rom" },
  ],
  idcode: 0x10010449, // STM32F74x/75x, rev A
  // BOOT_ADD0 option bytes default to 0x0080 (× 16 KB): the ITCM alias of flash, same bytes as 0x0800_0000.
  bootVector: 0x00200000,
  boot: "options",
  flash: { map: "v2", sectors: [32, 32, 32, 32, 128, 256, 256, 256].map((k) => k * 1024), banks: 1, system: { base: 0x00100000, size: 60 * 1024 }, optionBytes: 0x1fff0000 },
  usart: "v2",
  spi: "v2",
  i2c: "v2",
  pwr: "v2",
  // DS10916 §6.2 (Tables 12, 13, 15), §6.3.6 (Tables 25–32: 216 MHz, all peripherals on), §6.3.15.
  electrical: {
    vdd: 3.3,
    vddMax: 4.0,
    pinVoltageMax: 5.5,
    pinCurrentMax: 0.025,
    idd: { run: [5e-3, 0.5e-3], sleep: [4e-3, 0.2e-3], stop: 1.5e-3, stopLp: 0.5e-3, stopUd: 0.14e-3, standby: 3.5e-6 },
    wakeup: { stop: 12e-6, stopLp: 20e-6, stopUd: 110e-6, standby: 300e-6 },
    nrstPullUp: 40e3,
    boot0PullDown: 40e3,
  },
}

export const CHIPS: ChipProfile[] = [STM32F429ZI, STM32F746IG]

export function chipById(id: string): ChipProfile | undefined {
  return CHIPS.find((c) => c.id === id)
}
