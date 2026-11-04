/**
 * Chip profiles: what tells one STM32 from another once the shared core and peripheral
 * models are in place. A profile is data only — memory map, core identity, device id — so
 * the SoC class stays one and the same for every part.
 *
 * Sources: RM0090 §2.3 (F42x memory map), RM0385 §2.3 (F74x memory map), DS9405/DS10693 for
 * the pin-outs, ARM DDI0439 (Cortex-M4) and DDI0489 (Cortex-M7) for the ID registers.
 */

import { DS8626_SUPPLY, type SupplyTables } from "./supply"

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
  cpuDataOnly?: true
}

export type CoreProfile = {
  name: string
  irqCount: number
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
  pinCapacitance: number
  /**
   * Typical supply currents, A, at 25 °C with every peripheral clocked (DS9405 §6.3.6,
   * DS10916 §6.3.6): run and sleep as [floor, per MHz of HCLK]; Stop with the main regulator,
   * the low-power regulator, and under-drive; Standby with the RTC running.
   */
  idd: { run: [number, number]; sleep: [number, number]; stop: number; stopLp: number; stopUd?: number; standby: number }
  supply?: SupplyTables
  coreRegulator?: { volts: number; inrushAmps: number }
  /** Wake-up latency, s: leaving Stop on the main regulator, the low-power regulator, under-drive; leaving Standby. */
  wakeup: { stop: number; stopLp: number; stopUd?: number; standby: number }
  /** Internal pull-up on NRST, Ω. */
  nrstPullUp: number
  /** Internal pull-down on BOOT0, Ω, on parts that have one. */
  boot0PullDown?: number
  bootVoltageMax?: number
  inputThresholdsOfVdd: { rising: number; falling: number }
  outputOhms?: number
  adcInternal: { vrefint: number; v25: number; avgSlope: number }
  pads?: PadClasses
  pvd?: { rising: readonly number[]; falling: readonly number[] }
}

export type PadClasses = {
  ft: { aboveVdd: number }
  tta: { pads: string[]; voltageMax: number }
  injectedCurrentMax: number
  /** PC13–PC15 and the like, behind the backup-domain power switch; without switch figures (F4 datasheets give none) only the current limit applies. */
  backupDomain: { pads: string[]; currentMax: number; switchOhms?: number; switchDrop?: number }
  otgId: { pads: string[]; pullOhms: number }
  releaseFromHighDrainsAtSpeed: Record<string, number>
}

export type AfMap = "f40x" | "f401" | "f411" | "f42x" | "f74x"

/**
 * The blocks a die has out of the full F42x/F7 set: GPIO ports by letter, timer/USART/SPI
 * instances by name, ADC count, DAC, the FMC/FSMC (and whether it drives SDRAM), LTDC + DMA2D.
 * Absent on a profile → `blocksOf` gives the line's set.
 */
export type ChipBlocks = {
  gpio: string
  tim: string[]
  usart: string[]
  spi: string[]
  adcs: number
  dac: boolean
  fmc: "sdram" | "sram" | null
  lcd: boolean
}

export type LptimProfile = {
  base: number
  irq: number
  clockSelectOffset: number
  clockSelectShift: number
  enableBit: number
  pads: { pad: string; af: number; signal: "OUT" | "IN1" | "IN2" | "ETR" }[]
}

export type FactoryBytes = {
  otp: { base: number; size: number }
  uid: { at: number; words: [number, number, number] }
  flashSizeKb: { at: number; value: number }
  vrefintCal: { at: number; value: number }
  tsCal1: { at: number; value: number; celsius: number }
  tsCal2: { at: number; value: number; celsius: number }
  calibrationVdda: number
  packageData?: { at: number; value: number }
}

export type NoiseMixture = { weights: number[]; sigmasLsb: number[] }

export type AdcProfile = {
  /** F40x: temperature sensor on ADC1_IN16 and VBAT/2 on IN18 (RM0090 §13.3.3, §13.11); else both on IN18, VBAT/4. */
  tempOnIn16?: boolean
  regularTriggers: (string | null)[]
  injectedTriggers: (string | null)[]
  sampleHold?: { switchOhms: number; farads: number }
  noise?: { seed: number; alone: NoiseMixture; throughDacBuffer: NoiseMixture }
}

export type DacProfile = {
  buffered?: { gain: number; offsetCodes: number; floorVolts: number; headroomVolts: number }
}

export type ChipProfile = {
  family?: "stm32"
  notBonded?: readonly string[]
  /**
   * Which reference-manual variant the part follows where one manual covers several lines:
   * F405/F407 vs F42x/F43x in RM0090 (blocks present, PWR/RCC/FLASH/SYSCFG/ADC/I²C/FSMC details), F7.
   */
  line: "f40x" | "f401" | "f411" | "f42x" | "f7"
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
    /** Width of FLASH_ACR LATENCY: 3 bits on F40x, 4 on F42x and F7 (RM0090 §3.9.1/§3.9.2, RM0385 §3.7.1). */
    latencyBits: 3 | 4
  }
  /** RCC reset values that differ between parts (RM0090 §6.3 vs §7.3); absent → the RCC table default. */
  rccResets?: Partial<Record<"AHB1LPENR" | "APB1LPENR" | "APB2LPENR" | "PLLI2SCFGR", number>>
  /** I²C instances: I2C1–3 on F4 (RM0090 Table 1), I2C1–4 on F7 (RM0385 Table 1). */
  i2cCount: 3 | 4
  /** USART register map: "v1" (F4: SR/DR) or "v2" (F7: ISR/ICR/RDR/TDR). */
  usart: "v1" | "v2"
  /** SPI register map: "v1" (F4: DFF, one-word holding registers) or "v2" (F7: DS, FIFOs). */
  spi: "v1" | "v2"
  /** I²C register map: "v1" (F4: CR1 START/STOP, SR1/SR2, CCR) or "v2" (F7: CR2 NBYTES, ISR, TIMINGR). */
  i2c: "v1" | "v2"
  /** PWR register map: "v1" (F4: CR/CSR, one WKUP pin) or "v2" (F7: CR1/CSR1 plus CR2/CSR2 for six WKUP pins). */
  pwr: "v1" | "v2"
  tim: "v1" | "v2"
  af: AfMap
  rtcBackupRegisters: number
  /** Backup SRAM (RM0090 §5.1.2); null on parts without one (F411: RM0383 Table 1). */
  backupSram: { base: number; size: number } | null
  blocks?: ChipBlocks
  lptim?: LptimProfile
  factory?: FactoryBytes
  adc: AdcProfile
  dac: DacProfile
  electrical: ChipElectrical
}

export const CORTEX_M4F: CoreProfile = {
  name: "Cortex-M4F",
  irqCount: 91,
  cpuid: 0x410fc241, // r0p1
  mvfr: [0x10110021, 0x11000011, 0], // FPv4-SP-D16
  cache: false,
  bitBand: true,
}

/** The F405/F407's NVIC: 82 interrupt lines, 0–81, FPU last (RM0090 §12.1.1, Table 62). */
export const CORTEX_M4F_F40X: CoreProfile = { ...CORTEX_M4F, irqCount: 82 }

/** The F401's NVIC: 85 interrupt lines, 0–84, SPI4 last (RM0368 Rev 6 §10.1.3 Table 38). */
export const CORTEX_M4F_F401: CoreProfile = { ...CORTEX_M4F, irqCount: 85 }

/** The F411's NVIC: 86 interrupt lines, 0–85, SPI5 last (stm32f411xe.h IRQn_Type, cmsis-device-f4 v2.6.11). */
export const CORTEX_M4F_F411: CoreProfile = { ...CORTEX_M4F, irqCount: 86 }

export const CORTEX_M7: CoreProfile = {
  name: "Cortex-M7",
  irqCount: 98,
  cpuid: 0x410fc271, // r1p1, as fitted in STM32F74x/75x
  mvfr: [0x10110221, 0x12000011, 0x00000040], // FPv5-D16: single and double precision
  cache: true,
  bitBand: false,
}

const DATASHEET_ADC_INTERNAL = { vrefint: 1.21, v25: 0.76, avgSlope: 2.5e-3 }

const BACKUP_SRAM_4KB = { base: 0x40024000, size: 4 * 1024 }

const DS10916_TABLE_23_PVD_TYPICAL = {
  rising: [2.14, 2.3, 2.45, 2.6, 2.76, 2.93, 3.03, 3.14],
  falling: [2.04, 2.19, 2.35, 2.51, 2.66, 2.84, 2.93, 3.03],
}

const PIN_LAB_2026_10_12 = { vddaMv: 3290.4, risingMv: 1734.9, fallingMv: 1340.3, backupDomainDropMv: 8, driverOhms: 19.3 }

const SUSPECTS_ON_THE_BENCH_2026_10_12 = { PA13: 3, PB3: 3, PA14: 2 }

const BACKUP_SWITCH_AS_MEASURED_ON_THE_F746 = { switchOhms: 22, switchDrop: PIN_LAB_2026_10_12.backupDomainDropMv / 1000 }

const DS8626_DS9405_PADS: PadClasses = {
  ft: { aboveVdd: 4.0 },
  tta: { pads: ["PA4", "PA5"], voltageMax: 4.0 },
  injectedCurrentMax: 5e-3,
  backupDomain: { pads: ["PC13", "PC14", "PC15", "PI8"], currentMax: 3e-3, ...BACKUP_SWITCH_AS_MEASURED_ON_THE_F746 },
  otgId: { pads: [], pullOhms: 0 },
  releaseFromHighDrainsAtSpeed: {},
}

const CCM_ON_THE_CPU_DATA_BUS: MemoryRegion = { name: "CCM", base: 0x10000000, size: 64 * 1024, kind: "ram", cpuDataOnly: true }

const RM0090_FACTORY: MemoryRegion = { name: "FACTORY", base: 0x1fff7800, size: 0x230, kind: "rom" }

const SYNTHETIC_UID_F40X: [number, number, number] = [0x00410032, 0x5732510d, 0x34313533]
const SYNTHETIC_UID_F429: [number, number, number] = [0x00360027, 0x3235510f, 0x31343938]

const TWELVE_BIT_CODES = 4095

function rm0090FactoryBytes(flashSizeKb: number, uid: [number, number, number]): FactoryBytes {
  const typical = DATASHEET_ADC_INTERNAL
  const calibrationVdda = 3.3
  const code = (volts: number) => Math.round((volts / calibrationVdda) * TWELVE_BIT_CODES)
  const sensorAt = (celsius: number) => code(typical.v25 + (celsius - 25) * typical.avgSlope)
  return {
    otp: { base: 0x1fff7800, size: 0x210 },
    uid: { at: 0x1fff7a10, words: uid },
    flashSizeKb: { at: 0x1fff7a22, value: flashSizeKb },
    vrefintCal: { at: 0x1fff7a2a, value: code(typical.vrefint) },
    tsCal1: { at: 0x1fff7a2c, value: sensorAt(30), celsius: 30 },
    tsCal2: { at: 0x1fff7a2e, value: sensorAt(110), celsius: 110 },
    calibrationVdda,
  }
}

const RM0090_ADC_TRIGGERS = {
  regularTriggers: ["TIM1_CH1", "TIM1_CH2", "TIM1_CH3", "TIM2_CH2", "TIM2_CH3", "TIM2_CH4", "TIM2_TRGO", "TIM3_CH1", "TIM3_TRGO", "TIM4_CH4", "TIM5_CH1", "TIM5_CH2", "TIM5_CH3", "TIM8_CH1", "TIM8_TRGO", "EXTI11"],
  injectedTriggers: ["TIM1_CH4", "TIM1_TRGO", "TIM2_CH1", "TIM2_TRGO", "TIM3_CH2", "TIM3_CH4", "TIM4_CH1", "TIM4_CH2", "TIM4_CH3", "TIM4_TRGO", "TIM5_CH4", "TIM5_TRGO", "TIM8_CH2", "TIM8_CH3", "TIM8_CH4", "EXTI15"],
}

const RM0385_ADC_TRIGGERS = {
  regularTriggers: ["TIM1_CH1", "TIM1_CH2", "TIM1_CH3", "TIM2_CH2", "TIM5_TRGO", "TIM4_CH4", "TIM3_CH4", "TIM8_TRGO", "TIM8_TRGO2", "TIM1_TRGO", "TIM1_TRGO2", "TIM2_TRGO", "TIM4_TRGO", "TIM6_TRGO", null, "EXTI11"],
  injectedTriggers: ["TIM1_TRGO", "TIM1_CH4", "TIM2_TRGO", "TIM2_CH1", "TIM3_CH4", "TIM4_TRGO", null, "TIM8_CH4", "TIM1_TRGO2", "TIM8_TRGO", "TIM8_TRGO2", "TIM3_CH3", "TIM5_TRGO", "TIM3_CH1", "TIM6_TRGO", null],
}

const DS10916_SAMPLE_AND_HOLD = { switchOhms: 6e3, farads: 4e-12 }

const ADC_NOISE_ON_THE_BENCH_2026_10_06 = {
  seed: 0x5eed0746,
  alone: { weights: [0.7727, 0.2273], sigmasLsb: [1.331, 3.859] },
  throughDacBuffer: { weights: [0.5523, 0.4409, 0.0068], sigmasLsb: [1.309, 8.379, 28.965] },
}

const DAC_BUFFER_ON_THE_BENCH_2026_10_06 = { gain: 1.0165, offsetCodes: -29.6, floorVolts: 0.0262, headroomVolts: 0.0243 }

/** STM32F429ZIT6 (NUCLEO-F429ZI): 2 MB flash, 192 KB SRAM + 64 KB CCM. RM0090 §2.3.1. */
export const STM32F429ZI: ChipProfile = {
  line: "f42x",
  id: "stm32f429zi",
  name: "STM32F429ZIT6",
  core: CORTEX_M4F,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 2 * 1024 * 1024, kind: "flash", aliases: [0x00000000] },
    { name: "SRAM", base: 0x20000000, size: 192 * 1024, kind: "ram" },
    CCM_ON_THE_CPU_DATA_BUS,
    { name: "SYSTEM", base: 0x1fff0000, size: 30 * 1024, kind: "rom" },
    RM0090_FACTORY,
    { name: "OPT", base: 0x1fffc000, size: 16, kind: "rom" },
  ],
  idcode: 0x20016419, // STM32F42x/43x, rev 3
  bootVector: 0x08000000,
  boot: "pins",
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128].map((k) => k * 1024), banks: 2, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000, latencyBits: 4 },
  // RM0090 Rev 22 §6.3.15/§6.3.17/§6.3.18 (F42x).
  rccResets: { AHB1LPENR: 0x7eef97ff, APB1LPENR: 0xf6fec9ff, APB2LPENR: 0x04777f33 },
  i2cCount: 3,
  usart: "v1",
  spi: "v1",
  i2c: "v1",
  pwr: "v1",
  tim: "v1",
  af: "f42x",
  rtcBackupRegisters: 20,
  backupSram: BACKUP_SRAM_4KB,
  factory: rm0090FactoryBytes(2048, SYNTHETIC_UID_F429),
  adc: RM0090_ADC_TRIGGERS,
  dac: {},
  // DS9405 §6.2 (Tables 11, 12, 14), §6.3.6 (Tables 26–33: 180 MHz, all peripherals on), §6.3.15.
  electrical: {
    vdd: 3.3,
    vddMax: 4.0,
    pinVoltageMax: 5.5,
    pinCurrentMax: 0.025,
    pinCapacitance: 5e-12,
    idd: { run: [4e-3, 0.5e-3], sleep: [3e-3, 0.2e-3], stop: 1.2e-3, stopLp: 0.55e-3, stopUd: 0.13e-3, standby: 3e-6 },
    wakeup: { stop: 13e-6, stopLp: 21e-6, stopUd: 110e-6, standby: 300e-6 },
    nrstPullUp: 40e3,
    inputThresholdsOfVdd: { rising: 0.7, falling: 0.3 },
    adcInternal: DATASHEET_ADC_INTERNAL,
    pads: DS8626_DS9405_PADS,
  },
}

const DS8626_ELECTRICAL: ChipElectrical = {
  vdd: 3.3,
  // DS8626 Rev 12 §6.2 Tables 11–12, §6.3.1 Table 14.
  vddMax: 4.0,
  pinVoltageMax: 5.5,
  pinCurrentMax: 0.025,
  pinCapacitance: 5e-12,
  // Tables 20/22 (all peripherals on, ART on), least-squares over 25–168 MHz; Table 23 (Stop, flash in
  // Stop mode); Table 24 (Standby at 3.3 V, backup SRAM off, LSE + RTC on). No under-drive on F40x.
  idd: { run: [0, 0.49e-3], sleep: [0, 0.335e-3], stop: 0.45e-3, stopLp: 0.31e-3, standby: 3.3e-6 },
  // Table 29: Stop main/low-power regulator (flash in Stop), Standby typical.
  wakeup: { stop: 13e-6, stopLp: 17e-6, standby: 375e-6 },
  // Table 51; Table 48 (tested VIH 0.7 VDD, VIL 0.3 VDD).
  nrstPullUp: 40e3,
  inputThresholdsOfVdd: { rising: 0.7, falling: 0.3 },
  // Tables 69, 72: V25, average slope, VREFINT.
  adcInternal: DATASHEET_ADC_INTERNAL,
  // Table 19 typical PVD thresholds, PLS 0–7.
  pvd: {
    rising: [2.14, 2.3, 2.45, 2.6, 2.76, 2.93, 3.03, 3.14],
    falling: [2.04, 2.19, 2.35, 2.51, 2.66, 2.84, 2.93, 3.03],
  },
  pads: DS8626_DS9405_PADS,
  supply: DS8626_SUPPLY,
  coreRegulator: { volts: 1.26, inrushAmps: 0.16 },
}

/**
 * The F405/F407 die (RM0090 Rev 22, DS8626 Rev 12): 1 MB flash in one bank of 12 sectors, SRAM1 112 KB +
 * SRAM2 16 KB back to back at 0x2000_0000, CCM 64 KB. DEV_ID 0x413 (RM0090 §38.6.1); REV_ID 0x101F is
 * silicon rev 5/6, the latest in ES0182 Rev 19 Table 2 (every rev from Z on has the same errata).
 */
const F40X_DIE = {
  line: "f40x",
  core: CORTEX_M4F_F40X,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 1024 * 1024, kind: "flash", aliases: [0x00000000] },
    { name: "SRAM", base: 0x20000000, size: 128 * 1024, kind: "ram" },
    CCM_ON_THE_CPU_DATA_BUS,
    { name: "SYSTEM", base: 0x1fff0000, size: 30 * 1024, kind: "rom" },
    RM0090_FACTORY,
    { name: "OPT", base: 0x1fffc000, size: 16, kind: "rom" },
  ],
  idcode: 0x101f0413,
  bootVector: 0x08000000,
  boot: "pins",
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128].map((k) => k * 1024), banks: 1, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000, latencyBits: 3 },
  // RM0090 Rev 22 §7.3.15/§7.3.17/§7.3.18/§7.3.23 (F40x).
  rccResets: { AHB1LPENR: 0x7e6791ff, APB1LPENR: 0x36fec9ff, APB2LPENR: 0x00075f33, PLLI2SCFGR: 0x20003000 },
  i2cCount: 3,
  usart: "v1",
  spi: "v1",
  i2c: "v1",
  pwr: "v1",
  tim: "v1",
  af: "f40x",
  rtcBackupRegisters: 20,
  backupSram: BACKUP_SRAM_4KB,
  factory: rm0090FactoryBytes(1024, SYNTHETIC_UID_F40X),
  adc: { ...RM0090_ADC_TRIGGERS, tempOnIn16: true },
  dac: {},
  electrical: DS8626_ELECTRICAL,
} satisfies Omit<ChipProfile, "id" | "name">

/** STM32F407VGT6 (STM32F4-Discovery): LQFP100, PA–PE + PH0/PH1 bonded (DS8626 Table 2, Table 7). */
export const STM32F407VG: ChipProfile = { ...F40X_DIE, id: "stm32f407vg", name: "STM32F407VGT6" }

/** STM32F405RGT6 (Olimex STM32-H405, Netduino Plus 2): LQFP64, PA–PC + PD2 + PH0/PH1 bonded, no ETH/DCMI. */
export const STM32F405RG: ChipProfile = { ...F40X_DIE, id: "stm32f405rg", name: "STM32F405RGT6", notBonded: ["ETH_MAC", "DCMI"] }

const DS10314_ELECTRICAL: ChipElectrical = {
  vdd: 3.3,
  // DS10314 Rev 8 §6.2 Tables 11–12 (VDD abs max 4.0 V, FT/TC inputs 5.5 V operating per Table 14, 25 mA a pin).
  vddMax: 4.0,
  pinVoltageMax: 5.5,
  pinCurrentMax: 0.025,
  pinCapacitance: 5e-12,
  // Table 23 (Run, VDD 3.6 V, external clock + PLL, all peripherals on, ART on without prefetch) and Table 26
  // (Sleep), least-squares over 20–100 MHz: 0.200 and 0.118 mA/MHz, floors within ±0.1 mA of zero. Table 28
  // (Stop, flash in Stop mode, main / low-power regulator). Table 30 (Standby at 3.6 V, LSE + RTC on).
  idd: { run: [0, 0.2e-3], sleep: [0, 0.118e-3], stop: 113.7e-6, stopLp: 43.1e-6, standby: 2.8e-6 },
  // Table 34: Stop on the main / low-power regulator (flash not in deep power-down), Standby, typical.
  wakeup: { stop: 13.5e-6, stopLp: 21e-6, standby: 314e-6 },
  // Table 56 NRST RPU 40 kΩ typ; Table 53 VIL 0.3 VDD / VIH 0.7 VDD.
  nrstPullUp: 40e3,
  inputThresholdsOfVdd: { rising: 0.7, falling: 0.3 },
  // Table 71 (V25 0.76 V, Avg_Slope 2.5 mV/°C) and the VREFINT table (1.21 V typ).
  adcInternal: DATASHEET_ADC_INTERNAL,
  // Table 19 typical PVD thresholds, PLS 0–7.
  pvd: {
    rising: [2.14, 2.3, 2.45, 2.6, 2.76, 2.93, 3.03, 3.14],
    falling: [2.04, 2.19, 2.35, 2.51, 2.66, 2.82, 2.93, 3.03],
  },
  pads: {
    // Table 11: FT and TC inputs to VDD + 4.0 V (PA0/PB5 are TC; ES0287 2.2.13/2.2.14 only add a lifetime caveat above VDD).
    ft: { aboveVdd: 4.0 },
    tta: { pads: [], voltageMax: 4.0 },
    // Table 12: injected current on FT/TC pins −5 / +0 mA.
    injectedCurrentMax: 5e-3,
    // Table 8 note 2 / §6.3.16: PC13–PC15 sink at most 3 mA, never source.
    backupDomain: { pads: ["PC13", "PC14", "PC15"], currentMax: 3e-3 },
    // Table 53: PA10 (OTG_FS_ID) pulls 7/10/14 kΩ.
    otgId: { pads: ["PA10"], pullOhms: 10e3 },
    releaseFromHighDrainsAtSpeed: {},
  },
}

/**
 * The F401 (DS9716 Rev 11 for xB/C, DS10086 Rev 5 for xD/E, VDD 3.3 V): run and sleep from Tables 23 and 26 (external
 * clock, all peripherals on, ART on without prefetch) as least-squares lines over 20–84 MHz; Stop from Table 28 (flash in
 * Stop mode, main / low-power regulator); Standby Table 30; wake-up Table 34; PVD Table 19; pads as the F411's except PA0
 * and PB5, which are FT here (Table 8). Everything else as DS10314.
 */
const f401Electrical = (run: [number, number], sleep: [number, number]): ChipElectrical => ({
  ...DS10314_ELECTRICAL,
  idd: { run, sleep, stop: 111e-6, stopLp: 42e-6, standby: 2.8e-6 },
  wakeup: { stop: 13.5e-6, stopLp: 21e-6, standby: 314e-6 },
  pvd: { rising: [2.14, 2.3, 2.45, 2.6, 2.76, 2.93, 3.03, 3.14], falling: [2.04, 2.19, 2.35, 2.51, 2.66, 2.84, 2.93, 3.03] },
})

/**
 * STM32F411CEU6 (WeAct Black Pill): UFQFPN48, PA, PB, PC13–15, PH0/1 bonded. 512 KB flash in one bank
 * of 8 sectors, 128 KB SRAM at 0x2000_0000, no CCM and no backup SRAM. Blocks per RM0383 Table 1 and
 * the stm32f411xe.h memory map: TIM1–5, TIM9–11, USART1/2/6, SPI1–5, I2C1–3, ADC1, no DAC/FSMC.
 */
export const STM32F411CE: ChipProfile = {
  line: "f411",
  id: "stm32f411ce",
  name: "STM32F411CEU6",
  core: CORTEX_M4F_F411,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 512 * 1024, kind: "flash", aliases: [0x00000000] },
    { name: "SRAM", base: 0x20000000, size: 128 * 1024, kind: "ram" },
    { name: "SYSTEM", base: 0x1fff0000, size: 30 * 1024, kind: "rom" },
    { name: "OPT", base: 0x1fffc000, size: 16, kind: "rom" },
  ],
  // RM0383 Rev 4 §23.6.1: DEV_ID 0x431, REV_ID 0x1000 = revision A.
  idcode: 0x10000431,
  bootVector: 0x08000000,
  boot: "pins",
  // RM0383 Rev 4 §3.3 Table 4 (sectors 0–7), §3.8.1 (LATENCY[3:0]: four bits, though stm32f411xe.h masks three).
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128, 128, 128].map((k) => k * 1024), banks: 1, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000, latencyBits: 4 },
  // RM0383 Rev 4 §6.3.13 (AHB1LPENR), §6.3.15 (APB1LPENR), §6.3.16 (APB2LPENR), §6.3.20 (PLLI2SCFGR).
  rccResets: { AHB1LPENR: 0x0061900f, APB1LPENR: 0x10e2c80f, APB2LPENR: 0x00077930, PLLI2SCFGR: 0x24003000 },
  i2cCount: 3,
  usart: "v1",
  spi: "v1",
  i2c: "v1",
  pwr: "v1",
  tim: "v1",
  af: "f411",
  rtcBackupRegisters: 20,
  backupSram: null,
  blocks: {
    gpio: "ABCDEH",
    tim: ["TIM1", "TIM2", "TIM3", "TIM4", "TIM5", "TIM9", "TIM10", "TIM11"],
    usart: ["USART1", "USART2", "USART6"],
    spi: ["SPI1", "SPI2", "SPI3", "SPI4", "SPI5"],
    adcs: 1,
    dac: false,
    fmc: null,
    lcd: false,
  },
  // RM0383 Rev 4 §11.12.3 EXTSEL/JEXTSEL: RM0090's list with the TIM8 codes reserved; temperature on IN18
  // with VBAT/4 (§11.9 Figure 38 note 1, §11.10), so no `tempOnIn16`.
  adc: {
    regularTriggers: RM0090_ADC_TRIGGERS.regularTriggers.map((t) => (t?.startsWith("TIM8") ? null : t)),
    injectedTriggers: RM0090_ADC_TRIGGERS.injectedTriggers.map((t) => (t?.startsWith("TIM8") ? null : t)),
  },
  dac: {},
  electrical: DS10314_ELECTRICAL,
}

const F401_BLOCKS: ChipBlocks = {
  gpio: "ABCDEH",
  tim: ["TIM1", "TIM2", "TIM3", "TIM4", "TIM5", "TIM9", "TIM10", "TIM11"],
  usart: ["USART1", "USART2", "USART6"],
  spi: ["SPI1", "SPI2", "SPI3", "SPI4"],
  adcs: 1,
  dac: false,
  fmc: null,
  lcd: false,
}

/**
 * The F401 die as the F411's (RM0368 Rev 6 against RM0383 Rev 4; docs/blackpill-f401/f401-vs-f411.md): no SPI5 (85 IRQ
 * lines), PLLI2S on PLLCFGR.PLLM, no FMSSR/FISSR, its own DMA and AF tables. REV_ID 0x1001: markings "1" and "Z"
 * (ES0222/ES0299 Table 2), the later silicon.
 */
const F401_DIE = {
  line: "f401",
  core: CORTEX_M4F_F401,
  bootVector: 0x08000000,
  boot: "pins",
  rccResets: { AHB1LPENR: 0x0061900f, APB1LPENR: 0x10e2c80f, APB2LPENR: 0x00077930, PLLI2SCFGR: 0x24003000 },
  i2cCount: 3,
  usart: "v1",
  spi: "v1",
  i2c: "v1",
  pwr: "v1",
  tim: "v1",
  af: "f401",
  rtcBackupRegisters: 20,
  backupSram: null,
  blocks: F401_BLOCKS,
  adc: STM32F411CE.adc,
  dac: {},
} satisfies Partial<ChipProfile>

const f401Memory = (flashKb: number, sramKb: number): MemoryRegion[] => [
  { name: "FLASH", base: 0x08000000, size: flashKb * 1024, kind: "flash", aliases: [0x00000000] },
  { name: "SRAM", base: 0x20000000, size: sramKb * 1024, kind: "ram" },
  { name: "SYSTEM", base: 0x1fff0000, size: 30 * 1024, kind: "rom" },
  { name: "OPT", base: 0x1fffc000, size: 16, kind: "rom" },
]

/** STM32F401CCU6 (WeAct Black Pill): 256 KB in sectors 0–5, 64 KB SRAM, DEV_ID 0x423 (RM0368 §2.3, §3.3 Table 5, §23.6.1). */
export const STM32F401CC: ChipProfile = {
  ...F401_DIE,
  id: "stm32f401cc",
  name: "STM32F401CCU6",
  memory: f401Memory(256, 64),
  idcode: 0x10010423,
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128].map((k) => k * 1024), banks: 1, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000, latencyBits: 4 },
  // DS9716 Tables 23/26 at 3.3 V: 0.235 mA/MHz over 1.9 mA, 0.159 mA/MHz over 2.1 mA.
  electrical: f401Electrical([1.897e-3, 0.2351e-3], [2.122e-3, 0.1594e-3]),
}

/** STM32F401CEU6 (WeAct Black Pill V3.0): 512 KB in sectors 0–7, 96 KB SRAM, DEV_ID 0x433. */
export const STM32F401CE: ChipProfile = {
  ...F401_DIE,
  id: "stm32f401ce",
  name: "STM32F401CEU6",
  memory: f401Memory(512, 96),
  idcode: 0x10010433,
  flash: { map: "v1", sectors: [16, 16, 16, 16, 64, 128, 128, 128].map((k) => k * 1024), banks: 1, system: { base: 0x1fff0000, size: 30 * 1024 }, optionBytes: 0x1fffc000, latencyBits: 4 },
  // DS10086 Tables 23/26 at 3.3 V: 0.252 mA/MHz over 1.4 mA, 0.166 mA/MHz over 1.9 mA.
  electrical: f401Electrical([1.371e-3, 0.2519e-3], [1.931e-3, 0.1656e-3]),
}

/**
 * STM32F746IGT6 (LQFP176): 1 MB flash on the AXI bus at 0x0800_0000 with its ITCM alias at
 * 0x0020_0000, 16 KB ITCM-RAM, and 320 KB of RAM at 0x2000_0000 that firmware sees as one
 * block (DTCM 64 KB, SRAM1 240 KB, SRAM2 16 KB back to back). RM0385 §2.3.1.
 */
export const STM32F746IG: ChipProfile = {
  line: "f7",
  id: "stm32f746ig",
  name: "STM32F746IGT6",
  core: CORTEX_M7,
  memory: [
    { name: "FLASH", base: 0x08000000, size: 1024 * 1024, kind: "flash", aliases: [0x00200000] },
    { name: "ITCM", base: 0x00000000, size: 16 * 1024, kind: "ram" },
    { name: "RAM", base: 0x20000000, size: 320 * 1024, kind: "ram" },
    { name: "SYSTEM", base: 0x1ff00000, size: 60 * 1024, kind: "rom", aliases: [0x00100000] },
    { name: "FACTORY", base: 0x1ff0f000, size: 2 * 1024, kind: "rom", aliases: [0x0010f000] },
    { name: "OPT", base: 0x1fff0000, size: 32, kind: "rom" },
  ],
  idcode: 0x10016449,
  // BOOT_ADD0 option bytes default to 0x0080 (× 16 KB): the ITCM alias of flash, same bytes as 0x0800_0000.
  bootVector: 0x00200000,
  boot: "options",
  flash: { map: "v2", sectors: [32, 32, 32, 32, 128, 256, 256, 256].map((k) => k * 1024), banks: 1, system: { base: 0x00100000, size: 60 * 1024 }, optionBytes: 0x1fff0000, latencyBits: 4 },
  i2cCount: 4,
  usart: "v2",
  spi: "v2",
  i2c: "v2",
  pwr: "v2",
  tim: "v2",
  af: "f74x",
  rtcBackupRegisters: 32,
  backupSram: BACKUP_SRAM_4KB,
  lptim: {
    base: 0x40002400,
    irq: 93,
    clockSelectOffset: 0x90,
    clockSelectShift: 24,
    enableBit: 9,
    pads: [
      { pad: "PD12", af: 3, signal: "IN1" },
      { pad: "PG12", af: 3, signal: "IN1" },
      { pad: "PE1", af: 3, signal: "IN2" },
      { pad: "PH2", af: 3, signal: "IN2" },
      { pad: "PE0", af: 3, signal: "ETR" },
      { pad: "PG14", af: 3, signal: "ETR" },
      { pad: "PD13", af: 3, signal: "OUT" },
      { pad: "PG13", af: 3, signal: "OUT" },
    ],
  },
  factory: {
    otp: { base: 0x1ff0f000, size: 0x420 },
    uid: { at: 0x1ff0f420, words: [0x003c0027, 0x3138510a, 0x34303331] },
    flashSizeKb: { at: 0x1ff0f442, value: 1024 },
    vrefintCal: { at: 0x1ff0f44a, value: 1499 },
    tsCal1: { at: 0x1ff0f44c, value: 938, celsius: 30 },
    tsCal2: { at: 0x1ff0f44e, value: 1192, celsius: 110 },
    calibrationVdda: 3.3,
    packageData: { at: 0x1ff0f7e0, value: 0xfb77 },
  },
  adc: { ...RM0385_ADC_TRIGGERS, sampleHold: DS10916_SAMPLE_AND_HOLD, noise: ADC_NOISE_ON_THE_BENCH_2026_10_06 },
  dac: { buffered: DAC_BUFFER_ON_THE_BENCH_2026_10_06 },
  // DS10916 §6.2 (Tables 12, 13, 15), §6.3.6 (Tables 25–32: 216 MHz, all peripherals on), §6.3.15.
  electrical: {
    vdd: 3.3,
    vddMax: 4.0,
    pinVoltageMax: 5.5,
    pinCurrentMax: 0.025,
    pinCapacitance: 5e-12,
    idd: { run: [5e-3, 0.5e-3], sleep: [4e-3, 0.2e-3], stop: 1.5e-3, stopLp: 0.5e-3, stopUd: 0.14e-3, standby: 3.5e-6 },
    wakeup: { stop: 12e-6, stopLp: 20e-6, stopUd: 110e-6, standby: 300e-6 },
    nrstPullUp: 40e3,
    boot0PullDown: 40e3,
    bootVoltageMax: 9.0,
    inputThresholdsOfVdd: { rising: PIN_LAB_2026_10_12.risingMv / PIN_LAB_2026_10_12.vddaMv, falling: PIN_LAB_2026_10_12.fallingMv / PIN_LAB_2026_10_12.vddaMv },
    outputOhms: PIN_LAB_2026_10_12.driverOhms,
    adcInternal: DATASHEET_ADC_INTERNAL,
    pvd: DS10916_TABLE_23_PVD_TYPICAL,
    pads: {
      ft: { aboveVdd: 4.0 },
      tta: { pads: ["PA4", "PA5"], voltageMax: 4.0 },
      injectedCurrentMax: 5e-3,
      backupDomain: { pads: ["PC13", "PC14", "PC15", "PI8"], currentMax: 3e-3, ...BACKUP_SWITCH_AS_MEASURED_ON_THE_F746 },
      otgId: { pads: ["PA10", "PB12"], pullOhms: 10e3 },
      releaseFromHighDrainsAtSpeed: SUSPECTS_ON_THE_BENCH_2026_10_12,
    },
  },
}

export const CHIPS: ChipProfile[] = [STM32F429ZI, STM32F746IG, STM32F407VG, STM32F405RG, STM32F411CE, STM32F401CC, STM32F401CE]

const ALL_TIMERS = ["TIM1", "TIM2", "TIM3", "TIM4", "TIM5", "TIM6", "TIM7", "TIM8", "TIM9", "TIM10", "TIM11", "TIM12", "TIM13", "TIM14"]
const ALL_USARTS = ["USART1", "USART2", "USART3", "UART4", "UART5", "USART6", "UART7", "UART8"]
const ALL_SPIS = ["SPI1", "SPI2", "SPI3", "SPI4", "SPI5", "SPI6"]

/**
 * F42x/F7: GPIOA–K, every timer, UART7/8, SPI1–6, three ADCs, DAC, FMC with SDRAM, LTDC/DMA2D.
 * F40x: GPIOA–I, no UART7/8 or SPI4–6, FSMC (no SDRAM), no LTDC/DMA2D (RM0090 Table 35, Table 62).
 */
export function blocksOf(chip: ChipProfile): ChipBlocks {
  if (chip.blocks) return chip.blocks
  const f40x = chip.line === "f40x"
  return {
    gpio: f40x ? "ABCDEFGHI" : "ABCDEFGHIJK",
    tim: ALL_TIMERS,
    usart: f40x ? ALL_USARTS.filter((u) => u !== "UART7" && u !== "UART8") : ALL_USARTS,
    spi: f40x ? ALL_SPIS.slice(0, 3) : ALL_SPIS,
    adcs: 3,
    dac: true,
    fmc: f40x ? "sram" : "sdram",
    lcd: !f40x,
  }
}

export function chipById(id: string): ChipProfile | undefined {
  return CHIPS.find((c) => c.id === id)
}

const ADC_FULL_SCALE = 4095
const V25_CELSIUS = 25

export function internalChannelVolts(chip: ChipProfile, celsius: number): { vrefint: number; temperature: number } {
  const factory = chip.factory
  if (!factory) {
    const typical = chip.electrical.adcInternal
    return { vrefint: typical.vrefint, temperature: typical.v25 + (celsius - V25_CELSIUS) * typical.avgSlope }
  }
  const volts = (code: number) => (code / ADC_FULL_SCALE) * factory.calibrationVdda
  const { tsCal1, tsCal2 } = factory
  const slope = (volts(tsCal2.value) - volts(tsCal1.value)) / (tsCal2.celsius - tsCal1.celsius)
  return { vrefint: volts(factory.vrefintCal.value), temperature: volts(tsCal1.value) + (celsius - tsCal1.celsius) * slope }
}

/** Any emulated MCU's profile: an STM32 one here, or an AVR one (`src/mcu/avr/chip.ts`). */
export type McuProfile = ChipProfile | import("./avr/chip").AvrProfile | import("./pic/chip").PicProfile
