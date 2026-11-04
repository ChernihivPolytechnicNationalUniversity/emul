export type EnableRegister = "AHB1ENR" | "AHB2ENR" | "AHB3ENR" | "APB1ENR" | "APB2ENR"
export type EnableRegisters = Record<EnableRegister, number>

type Bus = "ahb" | "apb1" | "apb2"
type PerMhz = { scale1: number; scale2: number }

export type PeripheralDraw = {
  name: string
  register: EnableRegister
  bits: readonly number[]
  bus: Bus
  microampsPerMhz: PerMhz
  i2s?: { spi: 2 | 3; microampsPerMhz: PerMhz }
}

export type ByFrequency = { mhz: readonly number[]; milliamps: readonly number[] }
export type ByVoltage = { volts: readonly number[]; microamps: readonly number[] }
type BackupRows = { sramAndRtc: ByVoltage; rtc: ByVoltage; sram: ByVoltage; neither: ByVoltage }

export type SupplyTables = {
  runFromCacheOrRam: ByFrequency
  runUncached: ByFrequency
  sleep: ByFrequency
  measuredInScale1AboveMhz: number
  scale2Saving: { fraction: number; fromMhz: number }
  peripherals: readonly PeripheralDraw[]
  busMatrix: { microampsPerMhz: PerMhz; masters: readonly (readonly [EnableRegister, number])[] }
  analog: { adcOn: number; adcConverting: number; dacChannel: number; compensationCell: number; hsi: number; lsi: number; hseCrystal: number }
  pll: { vcoMhz: readonly [number, number]; amps: readonly [number, number]; inRunTablesAboveMhz: number }
  flashProgramErase: { x8: number; x16: number; x32: number }
  stop: { mainRegulator: { flashStopped: number; flashPoweredDown: number }; lowPowerRegulator: { flashStopped: number; flashPoweredDown: number } }
  standby: BackupRows
  vbat: BackupRows
}

export type SupplyState = {
  hclk: number
  pclk1: number
  pclk2: number
  enabled: EnableRegisters
  enabledInSleep: EnableRegisters
  scale1: boolean
  instructionCacheOrRam: boolean
  hsi: boolean
  hseCrystal: boolean
  lsi: boolean
  lse: boolean
  backupRegulator: boolean
  pllVco: number | null
  pllDrivesHclk: boolean
  plli2sVco: number | null
  i2sMode: { 2: boolean; 3: boolean }
  adcsOn: number
  adcsConverting: number
  dacChannels: number
  compensationCell: boolean
}

function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]) return ys[0]
  const last = xs.length - 1
  let i = 1
  while (i < last && xs[i] < x) i++
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
  return ys[i - 1] + t * (ys[i] - ys[i - 1])
}

function alongVolts(curve: ByVoltage, volts: number): number {
  const { volts: xs, microamps: ys } = curve
  let i = 1
  while (i < xs.length - 1 && volts > xs[i]) i++
  const t = (volts - xs[i - 1]) / (xs[i] - xs[i - 1])
  return Math.max(0, ys[i - 1] + t * (ys[i] - ys[i - 1])) * 1e-6
}

function inScale(t: SupplyTables, table: ByFrequency, scale1: boolean): number[] {
  return table.milliamps.map((ma, i) => {
    const mhz = table.mhz[i]
    const measuredInScale1 = mhz > t.measuredInScale1AboveMhz
    if (measuredInScale1 === scale1 || mhz < t.scale2Saving.fromMhz) return ma
    const kept = 1 - t.scale2Saving.fraction
    return scale1 ? ma / kept : ma * kept
  })
}

export function baseAmps(t: SupplyTables, table: ByFrequency, hclk: number, scale1: boolean): number {
  return interpolate(table.mhz, inScale(t, table, scale1), hclk / 1e6) * 1e-3
}

function busMhz(bus: Bus, s: SupplyState) {
  return (bus === "ahb" ? s.hclk : bus === "apb1" ? s.pclk1 : s.pclk2) / 1e6
}

function clocked(s: SupplyState, register: EnableRegister, bit: number, inSleep: boolean) {
  const on = s.enabled[register] & (inSleep ? s.enabledInSleep[register] : ~0)
  return (on & (1 << bit)) !== 0
}

export function peripheralAmps(t: SupplyTables, s: SupplyState, inSleep: boolean): number {
  const column = (per: PerMhz) => (s.scale1 ? per.scale1 : per.scale2)
  let microamps = 0
  for (const p of t.peripherals) {
    if (!p.bits.some((bit) => clocked(s, p.register, bit, inSleep))) continue
    const draw = p.i2s && s.i2sMode[p.i2s.spi] ? p.i2s.microampsPerMhz : p.microampsPerMhz
    microamps += column(draw) * busMhz(p.bus, s)
  }
  if (t.busMatrix.masters.some(([register, bit]) => clocked(s, register, bit, inSleep))) microamps += column(t.busMatrix.microampsPerMhz) * busMhz("ahb", s)
  return microamps * 1e-6
}

export function bondedEnables(t: SupplyTables, notBonded: readonly string[]): EnableRegisters {
  const mask: EnableRegisters = { AHB1ENR: ~0, AHB2ENR: ~0, AHB3ENR: ~0, APB1ENR: ~0, APB2ENR: ~0 }
  for (const p of t.peripherals) if (notBonded.includes(p.name)) for (const bit of p.bits) mask[p.register] &= ~(1 << bit)
  return mask
}

export function pllAmps(t: SupplyTables, vcoHz: number): number {
  const [lo, hi] = t.pll.vcoMhz
  const share = Math.min(1, Math.max(0, (vcoHz / 1e6 - lo) / (hi - lo)))
  return t.pll.amps[0] + share * (t.pll.amps[1] - t.pll.amps[0])
}

function lowSpeedAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  const rtc = alongVolts(t.standby.rtc, vdd) - alongVolts(t.standby.neither, vdd)
  return (s.lsi ? t.analog.lsi : 0) + (s.lse ? rtc : 0)
}

function backupRegulatorAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  if (!s.backupRegulator) return 0
  return alongVolts(t.standby.sram, vdd) - alongVolts(t.standby.neither, vdd)
}

export function analogAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  const a = t.analog
  let amps = s.adcsOn * a.adcOn + s.adcsConverting * a.adcConverting + s.dacChannels * a.dacChannel
  if (s.compensationCell) amps += a.compensationCell
  if (s.hsi) amps += a.hsi
  if (s.hseCrystal) amps += a.hseCrystal
  if (s.pllVco !== null && !(s.pllDrivesHclk && s.hclk / 1e6 > t.pll.inRunTablesAboveMhz)) amps += pllAmps(t, s.pllVco)
  if (s.plli2sVco !== null) amps += pllAmps(t, s.plli2sVco)
  return amps + lowSpeedAmps(t, s, vdd) + backupRegulatorAmps(t, s, vdd)
}

export function runAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  const table = s.instructionCacheOrRam ? t.runFromCacheOrRam : t.runUncached
  return baseAmps(t, table, s.hclk, s.scale1) + peripheralAmps(t, s, false) + analogAmps(t, s, vdd)
}

export function sleepAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  return baseAmps(t, t.sleep, s.hclk, s.scale1) + peripheralAmps(t, s, true) + analogAmps(t, s, vdd)
}

export function stopAmps(t: SupplyTables, s: SupplyState, lowPowerRegulator: boolean, flashPoweredDown: boolean, vdd: number): number {
  const regulator = lowPowerRegulator ? t.stop.lowPowerRegulator : t.stop.mainRegulator
  const core = flashPoweredDown ? regulator.flashPoweredDown : regulator.flashStopped
  const analogLeftOn = s.adcsOn * t.analog.adcOn + s.dacChannels * t.analog.dacChannel
  return core + analogLeftOn + lowSpeedAmps(t, s, vdd) + backupRegulatorAmps(t, s, vdd)
}

const backupRow = (rows: BackupRows, backupRegulator: boolean, lse: boolean) => (backupRegulator ? (lse ? rows.sramAndRtc : rows.sram) : lse ? rows.rtc : rows.neither)

export function standbyAmps(t: SupplyTables, s: SupplyState, vdd: number): number {
  return alongVolts(backupRow(t.standby, s.backupRegulator, s.lse), vdd) + (s.lsi ? t.analog.lsi : 0)
}

export function vbatAmps(t: SupplyTables, backupRegulator: boolean, lse: boolean, vbat: number): number {
  return alongVolts(backupRow(t.vbat, backupRegulator, lse), vbat)
}

const RESET_HCLK = 16e6

export function resetRunAmps(t: SupplyTables): number {
  return baseAmps(t, t.runUncached, RESET_HCLK, true) + t.analog.hsi
}

export const BACKUP_REGULATOR = 1
export const BACKUP_LSE = 2

export function backupDomainAmps(t: SupplyTables, state: number, vbat: number): number {
  return vbatAmps(t, (state & BACKUP_REGULATOR) !== 0, (state & BACKUP_LSE) !== 0, vbat)
}

export const PSIZE_X64 = 3

export function flashProgramEraseAmps(t: SupplyTables, psize: number): number {
  return psize === 0 ? t.flashProgramErase.x8 : psize === 1 ? t.flashProgramErase.x16 : t.flashProgramErase.x32
}

const ahb1 = (name: string, bit: number, scale1: number, scale2: number): PeripheralDraw => ({ name, register: "AHB1ENR", bits: [bit], bus: "ahb", microampsPerMhz: { scale1, scale2 } })
const ahb2 = (name: string, bit: number, scale1: number, scale2: number): PeripheralDraw => ({ name, register: "AHB2ENR", bits: [bit], bus: "ahb", microampsPerMhz: { scale1, scale2 } })
const apb1 = (name: string, bit: number, scale1: number, scale2: number): PeripheralDraw => ({ name, register: "APB1ENR", bits: [bit], bus: "apb1", microampsPerMhz: { scale1, scale2 } })
const apb2 = (name: string, bit: number, scale1: number, scale2: number): PeripheralDraw => ({ name, register: "APB2ENR", bits: [bit], bus: "apb2", microampsPerMhz: { scale1, scale2 } })
const DS8626_TABLE_24_25_VOLTS = [1.8, 2.4, 3.3]
const FREQUENCIES_MHZ = [2, 4, 8, 16, 25, 30, 60, 90, 120, 144, 168]

export const DS8626_SUPPLY: SupplyTables = {
  runFromCacheOrRam: { mhz: FREQUENCIES_MHZ, milliamps: [2, 2, 3, 5, 6, 8, 14, 20, 26, 31, 40] },
  runUncached: { mhz: FREQUENCIES_MHZ, milliamps: [2, 3, 4, 7, 10, 12, 22, 30, 37, 40, 46] },
  sleep: { mhz: FREQUENCIES_MHZ, milliamps: [1, 1, 1, 2, 2, 3, 5, 7, 8, 9, 12] },
  measuredInScale1AboveMhz: 144,
  scale2Saving: { fraction: 0.1, fromMhz: 30 },
  peripherals: [
    ahb1("GPIOA", 0, 2.7, 2.4),
    ahb1("GPIOB", 1, 2.5, 2.22),
    ahb1("GPIOC", 2, 2.54, 2.28),
    ahb1("GPIOD", 3, 2.55, 2.28),
    ahb1("GPIOE", 4, 2.68, 2.4),
    ahb1("GPIOF", 5, 2.53, 2.28),
    ahb1("GPIOG", 6, 2.51, 2.22),
    ahb1("GPIOH", 7, 2.51, 2.22),
    ahb1("GPIOI", 8, 2.5, 2.22),
    ahb1("CRC", 12, 0.41, 0.4),
    ahb1("BKPSRAM", 18, 0.63, 0.58),
    ahb1("DMA1", 21, 37.44, 33.58),
    ahb1("DMA2", 22, 37.69, 33.93),
    { name: "ETH_MAC", register: "AHB1ENR", bits: [25, 26, 27, 28], bus: "ahb", microampsPerMhz: { scale1: 20.43, scale2: 18.39 } },
    { name: "OTG_HS+ULPI", register: "AHB1ENR", bits: [29, 30], bus: "ahb", microampsPerMhz: { scale1: 28.33, scale2: 25.38 } },
    ahb2("DCMI", 0, 5.87, 5.35),
    ahb2("RNG", 6, 1.5, 1.67),
    ahb2("OTG_FS", 7, 26.45, 26.67),
    { name: "FSMC", register: "AHB3ENR", bits: [0], bus: "ahb", microampsPerMhz: { scale1: 12.46, scale2: 11.31 } },
    apb1("TIM2", 0, 16.71, 16.5),
    apb1("TIM3", 1, 12.33, 11.94),
    apb1("TIM4", 2, 13.45, 12.92),
    apb1("TIM5", 3, 17.14, 16.58),
    apb1("TIM6", 4, 2.43, 3.06),
    apb1("TIM7", 5, 2.43, 2.22),
    apb1("TIM12", 6, 6.62, 6.83),
    apb1("TIM13", 7, 5.05, 5.47),
    apb1("TIM14", 8, 5.26, 5.61),
    apb1("WWDG", 11, 1.0, 0.83),
    { ...apb1("SPI2", 14, 2.43, 2.22), i2s: { spi: 2, microampsPerMhz: { scale1: 2.43, scale2: 2.22 } } },
    { ...apb1("SPI3", 15, 2.43, 2.22), i2s: { spi: 3, microampsPerMhz: { scale1: 2.26, scale2: 2.22 } } },
    apb1("USART2", 17, 2.69, 2.78),
    apb1("USART3", 18, 2.74, 2.78),
    apb1("UART4", 19, 3.24, 3.33),
    apb1("UART5", 20, 2.69, 2.78),
    apb1("I2C1", 21, 2.67, 2.5),
    apb1("I2C2", 22, 2.83, 2.78),
    apb1("I2C3", 23, 2.81, 2.78),
    apb1("CAN1", 25, 5.12, 5.56),
    apb1("CAN2", 26, 4.81, 5.28),
    apb1("PWR", 28, 1.0, 0.56),
    apb1("DAC", 29, 1.67, 1.67),
    apb2("TIM1", 0, 16.79, 15.51),
    apb2("TIM8", 1, 17.88, 16.53),
    apb2("USART1", 4, 3.51, 3.72),
    apb2("USART6", 5, 3.55, 3.75),
    apb2("ADC1", 8, 4.67, 4.58),
    apb2("ADC2", 9, 4.67, 4.58),
    apb2("ADC3", 10, 4.43, 4.44),
    apb2("SDIO", 11, 7.08, 7.92),
    apb2("SPI1", 12, 1.32, 1.39),
    apb2("SYSCFG", 14, 0.74, 0.56),
    apb2("TIM9", 16, 7.64, 7.28),
    apb2("TIM10", 17, 4.89, 4.82),
    apb2("TIM11", 18, 5.19, 4.82),
  ],
  busMatrix: { microampsPerMhz: { scale1: 13.1, scale2: 11.81 }, masters: [["AHB1ENR", 21], ["AHB1ENR", 22], ["AHB1ENR", 25], ["AHB1ENR", 29]] },
  analog: { adcOn: 1.6e-3, adcConverting: 0.3e-3, dacChannel: 0.8e-3, compensationCell: 0.22e-3, hsi: 60e-6, lsi: 0.4e-6, hseCrystal: 532e-6 },
  pll: { vcoMhz: [100, 432], amps: [(0.15 + 0.4) / 2 * 1e-3 + (0.3 + 0.4) / 2 * 1e-3, (0.45 + 0.75) / 2 * 1e-3 + (0.55 + 0.85) / 2 * 1e-3], inRunTablesAboveMhz: 25 },
  flashProgramErase: { x8: 5e-3, x16: 8e-3, x32: 12e-3 },
  stop: { mainRegulator: { flashStopped: 0.45e-3, flashPoweredDown: 0.4e-3 }, lowPowerRegulator: { flashStopped: 0.31e-3, flashPoweredDown: 0.28e-3 } },
  standby: {
    sramAndRtc: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [3.0, 3.4, 4.0] },
    rtc: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [2.4, 2.7, 3.3] },
    sram: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [2.4, 2.6, 3.0] },
    neither: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [1.7, 1.9, 2.2] },
  },
  vbat: {
    sramAndRtc: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [1.29, 1.42, 1.68] },
    rtc: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [0.62, 0.73, 0.96] },
    sram: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [0.79, 0.81, 0.86] },
    neither: { volts: DS8626_TABLE_24_25_VOLTS, microamps: [0.1, 0.1, 0.1] },
  },
}
