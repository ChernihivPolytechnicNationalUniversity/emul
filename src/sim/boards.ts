/**
 * The chips boards carry beside their MCU, wired to the boards' own pins and nodes
 * (docs/stm32f4-discovery/board-checklist.md §9, docs/netduino-plus-2/board-checklist.md §3–4).
 */
import type { DigitalPart } from "./digital-part"
import { Cs43l22 } from "./cs43l22"
import { Enc28j60 } from "./enc28j60"
import { LisAccelerometer, type LisVariant } from "./lis-accel"
import { Mp45dt02 } from "./mp45dt02"
import { OnboardParts } from "./onboard"

/**
 * Board tilt to the accelerometer's axes: roll about X, pitch about Y, flat = +1 g on Z. U5 sits
 * unrotated on the MB997 (rev-E board file, rotation 0), so board and chip axes are taken as one;
 * the datasheets give the chip's axes, the board file no arrow, so the signs are this convention.
 */
export function gravity(rollDeg: number, pitchDeg: number) {
  const r = (rollDeg * Math.PI) / 180
  const p = (pitchDeg * Math.PI) / 180
  return { x: -Math.sin(p), y: Math.sin(r) * Math.cos(p), z: Math.cos(r) * Math.cos(p) }
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number.parseFloat(v ?? "")
  return Number.isFinite(n) ? n : fallback
}

/** A tone in pascals: `db` dB SPL (94 dB = 1 Pa rms) at `hz`; 0 dB or below is silence. */
export function tone(db: number, hz: number) {
  if (db <= 0) return () => 0
  const peak = Math.SQRT2 * 10 ** ((db - 94) / 20)
  return (t: number) => peak * Math.sin(2 * Math.PI * hz * t)
}

/**
 * STM32F4-Discovery: U5 (LIS302DL on rev A/B, LIS3DSH on C–E) on SPI1 PA5/PA6/PA7, CS PE3, INT1/2
 * PE0/PE1; U9 MP45DT02, CLK PB10, DOUT PC3; U7 CS43L22 on I2C1 PB6/PB9 (0x4A), RESET̅ PD4, I2S3
 * MCK PC7, SCK PC10, SD PC12, WS PA4. All on the 3V rail, always powered.
 *
 * MCLK: the MCU does not toggle MCK at 256·Fs edge by edge; with MCKOE it holds the pad high,
 * and the codec is told MCLK = 256·Fs (RM0090 §28.4.4: with MCKOE, Fs = MCK/256) from the LRCK
 * period it sees. MCK low or released: no MCLK.
 */
export class DiscoveryParts extends OnboardParts {
  readonly variant: LisVariant
  private mck = false
  private lastLrck: number | null = null
  private lrck = false
  constructor(object: string, props: Record<string, string>) {
    const variant: LisVariant = props.accel === "lis3dsh" ? "lis3dsh" : "lis302dl"
    super(object, {
      accel: new LisAccelerometer(object, { sck: "$U5-SCK", miso: "$U5-MISO", mosi: "$U5-MOSI", cs: "$U5-CS", int1: "$U5-INT1", int2: "$U5-INT2" }, variant),
      mic: new Mp45dt02(object, { clk: "$U9-CLK", dout: "$U9-DOUT" }),
      codec: new Cs43l22(object, { sda: "$U7-SDA", scl: "$U7-SCL", reset: "$U7-RESET", mclk: "$U7-MCLK", sclk: "$U7-SCLK", sdin: "$U7-SDIN", lrck: "$U7-LRCK" }),
    })
    this.variant = variant
    this.configure(props)
  }
  configure(props: Record<string, string>) {
    super.configure(props)
    ;(this.chips.accel as LisAccelerometer).setAcceleration(gravity(num(props.roll, 0), num(props.pitch, 0)))
    ;(this.chips.mic as Mp45dt02).setSound(tone(num(props.sound, 0), num(props.tone, 1000)))
  }
  input(pin: string, level: boolean, time: number) {
    const codec = this.chips.codec as Cs43l22
    if (pin === "$U7-MCLK") {
      this.mck = level
      if (!level) codec.setMclk(0, time)
      return
    }
    if (pin === "$U7-LRCK" && level && !this.lrck) {
      if (this.lastLrck !== null && this.mck) codec.setMclk(256 / (time - this.lastLrck), time)
      this.lastLrck = time
    }
    if (pin === "$U7-LRCK") this.lrck = level
    super.input(pin, level, time)
  }
  /** The headphone jack: what the codec plays, to the bench's speaker. */
  pressure() {
    return (this.chips.codec as Cs43l22).pressure()
  }
  outdated(props: Record<string, string>) {
    return (props.accel === "lis3dsh" ? "lis3dsh" : "lis302dl") !== this.variant
  }
}

/**
 * Netduino Plus 2: U5 ENC28J60 on SPI1 (SCK PA5, MOSI PA7, MISO PB4, CS PC8, INT PA4, RESET PD2),
 * powered from +3V3_ETHERNET (Q6A, on while PC15 is low) and clocked from MCO1 on PA8.
 *
 * MCO1 is not modelled in the RCC: the chip is given its 25 MHz whenever it is powered (the board's
 * firmware always selects HSE on MCO1 before using it). Its LEDB drives the ACT LED (D7).
 */
export class NetduinoParts extends OnboardParts {
  /** ENC28J60 VDD operating range 3.1–3.6 V (DS39662E Table 16-1): below 3.1 V it is taken as off. */
  static readonly MIN_VDD = 3.1
  readonly senses = ["$3v3eth"]
  constructor(object: string, props: Record<string, string>) {
    super(object, { enc: new Enc28j60(object, { cs: "$U5-CS", sck: "$U5-SCK", mosi: "$U5-MOSI", miso: "$U5-MISO", int: "$U5-INT", reset: "$U5-RESET", clkin: "$U5-CLKIN" }) })
    this.enc.setPower(false, 0)
    this.enc.setClock(25e6, 0)
    this.configure(props)
  }
  get enc() {
    return this.chips.enc as Enc28j60
  }
  sense(volts: (pin: string) => number, time: number) {
    this.enc.setPower(volts("$3v3eth") >= NetduinoParts.MIN_VDD, time)
  }
  parts() {
    return { ACT: { on: this.enc.leds().b, level: this.enc.leds().b ? 1 : 0 } }
  }
}

export function boardParts(def: string, object: string, props: Record<string, string>): DigitalPart | null {
  switch (def) {
    case "stm32f4-discovery":
      return new DiscoveryParts(object, props)
    case "netduino-plus-2":
      return new NetduinoParts(object, props)
    default:
      return null
  }
}
