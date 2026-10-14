/**
 * AVR chip profiles: what tells one megaAVR from another once the core and the peripheral
 * classes are shared — memory sizes, signature, vector table, which ports exist, boot section
 * sizes, factory fuses and the electrical ratings. Data only; `AvrMcu` assembles the part.
 *
 * ATmega328P: DS40002061B (Microchip, 2020) — §8 memories, §12 vectors (Table 12-6), §27/§28
 * boot loader and fuses (Tables 27-13, 28-6, 28-8, 28-9), §29/§30 electrical characteristics.
 */

export type AvrPortSpec = {
  /** Port letter; pads are named "PB5" and numbered like the STM32 ones (A = 0, B = 1, …). */
  letter: string
  /** Data-space address of PINx; DDRx and PORTx follow it. */
  pin: number
  /** Pins that exist on the package (PC7 does not on the 328P). */
  mask: number
}

export type AvrElectrical = {
  /** Nominal supply the part is run at, V. */
  vdd: number
  /** Maximum operating voltage (absolute maximum rating), V. */
  vddMax: number
  /** Voltage on any pin except RESET: −0.5 V to VCC + 0.5 V (§29.1). */
  pinAboveVcc: number
  /** RESET withstands up to 13 V (high-voltage programming). */
  resetVoltageMax: number
  /** DC current per I/O pin, A. */
  pinCurrentMax: number
  /** DC current through the VCC and GND pins, A. */
  supplyCurrentMax: number
  /** I/O pin capacitance, F (Table 29-14 Ci). */
  pinCapacitance: number
  /** Guaranteed input thresholds as fractions of VCC (Table 30-1, VCC 2.4–5.5 V): high at or above, low at or below. */
  inputThresholdsOfVdd: { rising: number; falling: number }
  /** I/O pin pull-up, Ω (RPU 20–50 kΩ). */
  pullUp: number
  /** RESET pin pull-up, Ω (RRST 30–60 kΩ). */
  resetPullUp: number
  /** Output driver resistance, Ω, from VOL/VOH at 20 mA, VCC = 5 V. */
  outputOhms: number
  /** Typical supply current, A, from Table 29-8 (VCC = 5 V for run/idle per MHz, 3 V for the sleep modes). */
  idd: { activePerMHz: number; idlePerMHz: number; powerDownWdt: number; powerDown: number; powerSave: number }
  /** Power-on reset threshold, rising/falling, V (VPOT). */
  por: { rising: number; falling: number }
  /** Brown-out levels by BODLEVEL fuse code (typical VBOT), V; hysteresis 50 mV. */
  bod: Record<number, number>
  bodHysteresis: number
  /** Bandgap reference, V (VBG). */
  bandgap: number
}

export type AvrProfile = {
  family: "avr"
  id: string
  name: string
  flashBytes: number
  /** Last SRAM address in data space. */
  ramEnd: number
  eepromBytes: number
  /** Flash page size in words (SPM page buffer). */
  pageWords: number
  signature: [number, number, number]
  /** Interrupt vector names, vector 1 (RESET) first. */
  vectors: string[]
  ports: AvrPortSpec[]
  /** Boot section start (word address) by BOOTSZ1:0 (Table 27-13). */
  bootStart: [number, number, number, number]
  /** Fuse bytes as shipped from the factory (Tables 28-5…28-7). */
  factoryFuses: { low: number; high: number; extended: number; lock: number }
  /** Factory OSCCAL calibration byte (the value that gives 8.0 MHz at 3 V, 25 °C). */
  osccal: number
  /** Silicon revisions released to production, oldest first (the last is the current one). */
  revisions: string[]
  /** Errata by number (DS80000855C), with the revisions they apply to. */
  errata: Record<string, string[]>
  electrical: AvrElectrical
}

export const ATMEGA328P: AvrProfile = {
  family: "avr",
  id: "ATMEGA328P",
  name: "ATmega328P",
  flashBytes: 32 * 1024,
  ramEnd: 0x08ff,
  eepromBytes: 1024,
  pageWords: 64,
  signature: [0x1e, 0x95, 0x0f],
  vectors: [
    "RESET",
    "INT0",
    "INT1",
    "PCINT0",
    "PCINT1",
    "PCINT2",
    "WDT",
    "TIMER2_COMPA",
    "TIMER2_COMPB",
    "TIMER2_OVF",
    "TIMER1_CAPT",
    "TIMER1_COMPA",
    "TIMER1_COMPB",
    "TIMER1_OVF",
    "TIMER0_COMPA",
    "TIMER0_COMPB",
    "TIMER0_OVF",
    "SPI_STC",
    "USART_RX",
    "USART_UDRE",
    "USART_TX",
    "ADC",
    "EE_READY",
    "ANALOG_COMP",
    "TWI",
    "SPM_READY",
  ],
  ports: [
    { letter: "B", pin: 0x23, mask: 0xff },
    { letter: "C", pin: 0x26, mask: 0x7f },
    { letter: "D", pin: 0x29, mask: 0xff },
  ],
  // BOOTSZ = 00: 2048 words at 0x3800, 01: 1024 at 0x3C00, 10: 512 at 0x3E00, 11: 256 at 0x3F00.
  bootStart: [0x3800, 0x3c00, 0x3e00, 0x3f00],
  // Low 0x62: CKDIV8 programmed, SUT 10, CKSEL 0010 (internal 8 MHz RC) → 1 MHz.
  // High 0xD9: SPIEN programmed, BOOTSZ 00, BOOTRST unprogrammed. Extended 0xFF: BOD off.
  factoryFuses: { low: 0x62, high: 0xd9, extended: 0xff, lock: 0xff },
  osccal: 0x80,
  // Silicon Errata DS80000855C §1: Rev. A, B, D (C was never released); §2 per erratum.
  revisions: ["A", "B", "D"],
  errata: { "2.2.1": ["D"], "2.3.1": ["A", "B"], "2.4.1": ["A", "B", "D"] },
  electrical: {
    vdd: 5,
    vddMax: 6,
    pinAboveVcc: 0.5,
    resetVoltageMax: 13,
    pinCurrentMax: 0.04,
    supplyCurrentMax: 0.2,
    pinCapacitance: 10e-12,
    inputThresholdsOfVdd: { rising: 0.6, falling: 0.3 },
    pullUp: 35e3,
    resetPullUp: 45e3,
    // VOL ≤ 0.9 V at 20 mA sink (VCC 5 V, 85 °C) → 45 Ω; VOH ≥ 4.2 V at 20 mA source → 40 Ω.
    outputOhms: 45,
    // Table 29-8: active 8 MHz, 5 V: 5.2 mA; idle 8 MHz, 5 V: 1.2 mA; power-down 3 V: 4.2 µA (WDT on), 0.1 µA; power-save 32 kHz TOSC 3 V: 0.9 µA.
    idd: { activePerMHz: 5.2e-3 / 8, idlePerMHz: 1.2e-3 / 8, powerDownWdt: 4.2e-6, powerDown: 0.1e-6, powerSave: 0.9e-6 },
    por: { rising: 1.4, falling: 1.3 },
    bod: { 0b110: 1.8, 0b101: 2.7, 0b100: 4.3 },
    bodHysteresis: 0.05,
    bandgap: 1.1,
  },
}

export const AVR_CHIPS: AvrProfile[] = [ATMEGA328P]

export function avrChipById(id: string): AvrProfile | undefined {
  return AVR_CHIPS.find((c) => c.id === id)
}
