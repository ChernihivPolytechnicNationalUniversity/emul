/**
 * Parallel RGB panels on the field. The LTDC's pixel stream is not simulated as edges; a
 * panel finds the MCU whose LTDC pads are wired to its signal pins, asks that controller
 * for the composed frame, and shows it the way the glass would: through the colour lines
 * as they are actually wired (a swapped or missing line shows in the picture), only while
 * the clock and syncs arrive on pads the firmware has switched to the LTDC, and only for a
 * pixel clock the panel can lock to.
 */
import type { PadRef, Stm32 } from "@/mcu/stm32f429"
import { parsePad } from "@/mcu/stm32f429"
import type { PanelSignal, PanelSpec } from "@/schematic/types"

/** LTDC pads on the F4/F7 (DS9405 / DS10693 alternate-function tables): signal → pads with their AF. */
const LTDC_PADS: Record<PanelSignal, string[]> = {
  R0: ["PI15/14", "PG13/14", "PH2/14"],
  R1: ["PJ0/14", "PH3/14", "PA2/14"],
  R2: ["PJ1/14", "PH8/14", "PA1/14", "PC10/14"],
  R3: ["PJ2/14", "PH9/14", "PB0/9"],
  R4: ["PJ3/14", "PH10/14", "PA11/14", "PA5/14"],
  R5: ["PJ4/14", "PH11/14", "PA12/14", "PC0/14"],
  R6: ["PJ5/14", "PH12/14", "PA8/14", "PB1/9"],
  R7: ["PJ6/14", "PG6/14", "PE15/14"],
  G0: ["PJ7/14", "PE5/14"],
  G1: ["PJ8/14", "PE6/14"],
  G2: ["PJ9/14", "PH13/14", "PA6/14"],
  G3: ["PJ10/14", "PH14/14", "PG10/9", "PE11/14"],
  G4: ["PJ11/14", "PH15/14", "PB10/14"],
  G5: ["PK0/14", "PI0/14", "PB11/14"],
  G6: ["PK1/14", "PI1/14", "PC7/14"],
  G7: ["PK2/14", "PI2/14", "PD3/14"],
  B0: ["PE4/14", "PG14/14", "PJ12/14"],
  B1: ["PG12/14", "PJ13/14"],
  B2: ["PD6/14", "PG10/14", "PJ14/14"],
  B3: ["PG11/14", "PJ15/14"],
  B4: ["PG12/9", "PI4/14", "PK3/14"],
  B5: ["PA3/14", "PI5/14", "PK4/14"],
  B6: ["PB8/14", "PI6/14", "PK5/14"],
  B7: ["PB9/14", "PI7/14", "PK6/14"],
  CLK: ["PE14/14", "PG7/14", "PI14/14"],
  HS: ["PC6/14", "PI10/14", "PI12/14"],
  VS: ["PA4/14", "PI9/14", "PI13/14"],
  DE: ["PE13/14", "PF10/14", "PK7/14"],
}

/** Pad key (port*16+pin) → the LTDC signals it can carry, by AF. */
const BY_PAD = new Map<number, { signal: PanelSignal; af: number }[]>()
for (const [signal, pads] of Object.entries(LTDC_PADS) as [PanelSignal, string[]][])
  for (const entry of pads) {
    const [name, af] = entry.split("/")
    const pad = parsePad(name)
    if (!pad) continue
    const key = pad.port * 16 + pad.pin
    BY_PAD.set(key, [...(BY_PAD.get(key) ?? []), { signal, af: Number(af) }])
  }

/** Bit index of a colour signal in a 24-bit RGB word (R7 is bit 23, B0 bit 0). */
function colourBit(signal: PanelSignal): number {
  const n = Number(signal.slice(1))
  return signal[0] === "R" ? 16 + n : signal[0] === "G" ? 8 + n : n
}

/** One panel object: which MCU pad drives each of its signal pins (set on every rebuild). */
export class PanelInstance {
  readonly object: string
  readonly spec: PanelSpec
  /** Panel signal → the MCU and pad wired to it (the first found). */
  readonly wired = new Map<PanelSignal, { mcu: Stm32; pad: PadRef }>()
  private frame: Uint8ClampedArray | null = null
  private composed: Uint8ClampedArray | null = null
  private lastVersion = -1
  private lastStatus = ""
  private lastMap = ""
  private lastWall = 0
  /** Framebuffer stores seen since the last composition (kept across throttled captures). */
  private pending = false

  constructor(object: string, spec: PanelSpec) {
    this.object = object
    this.spec = spec
  }

  /** The MCU that drives the pixel clock pin, if any. */
  private get source(): Stm32 | null {
    return this.wired.get("CLK")?.mcu ?? null
  }

  /**
   * Which LTDC output line (bit of the 24-bit pixel, or "CLK"/"HS"/"VS"/"DE") each panel signal
   * actually receives right now: the pad on its pin must be in the LTDC's alternate function.
   */
  private lineMap(mcu: Stm32): { colour: Int8Array; syncs: Record<"CLK" | "HS" | "VS" | "DE", boolean> } {
    const colour = new Int8Array(24).fill(-1)
    const syncs = { CLK: false, HS: false, VS: false, DE: false }
    for (const [signal, w] of this.wired) {
      if (w.mcu !== mcu) continue
      const af = mcu.padAf(w.pad)
      if (af === null) continue
      const carries = BY_PAD.get(w.pad.port * 16 + w.pad.pin)?.find((c) => c.af === af)
      if (!carries) continue
      if (signal === "CLK" || signal === "HS" || signal === "VS" || signal === "DE") {
        if (carries.signal === signal) syncs[signal] = true
      } else if (carries.signal !== "CLK" && carries.signal !== "HS" && carries.signal !== "VS" && carries.signal !== "DE") {
        colour[colourBit(signal)] = colourBit(carries.signal)
      }
    }
    return { colour, syncs }
  }

  /**
   * What the panel shows now: a fresh RGBA frame when the picture changed since the last
   * capture (null otherwise), and the panel's verdict. `wall` throttles the composition.
   */
  capture(wall: number, powered: boolean): { frame: ArrayBuffer | null; status: string } {
    const { width, height } = this.spec
    const mcu = this.source
    const done = (status: string, frame: Uint8ClampedArray | null) => {
      const changed = status !== this.lastStatus || frame !== null
      this.lastStatus = status
      return { frame: changed && frame ? (frame.buffer.slice(0) as ArrayBuffer) : null, status }
    }
    // No logic supply: the glass is dark and says nothing (the backlight is off too).
    if (!powered) return done("off", this.blank(false))
    // Powered but without a pixel clock, the panel's drivers show whatever they latch: noise.
    if (!mcu || !mcu.firmware) return done("no signal", this.blank(true))
    const t = mcu.ltdc.timing()
    const map = this.lineMap(mcu)
    if (!t.enabled || !map.syncs.CLK) return done("no signal", this.blank(true))
    if (!map.syncs.HS || !map.syncs.VS || !map.syncs.DE) return done(`no sync (${(["HS", "VS", "DE"] as const).filter((k) => !map.syncs[k]).join(", ")} not driven)`, this.blank(true))
    if (t.pixelHz < this.spec.pixelHz[0] || t.pixelHz > this.spec.pixelHz[1]) return done(`pixel clock ${(t.pixelHz / 1e6).toFixed(1)} MHz out of range`, this.blank(true))
    const mapKey = map.colour.join(",")
    if (mcu.bus.takeDirty()) this.pending = true
    if (this.frame && mcu.ltdc.version === this.lastVersion && !this.pending && mapKey === this.lastMap) return done("ok", null)
    // Compose at most ~12 times a second; a busy framebuffer would otherwise eat the loop.
    if (this.frame && wall - this.lastWall < 80) return done("ok", null)
    this.pending = false
    this.lastWall = wall
    this.lastVersion = mcu.ltdc.version
    this.lastMap = mapKey
    if (!this.composed || this.composed.length !== t.width * t.height * 4) this.composed = new Uint8ClampedArray(t.width * t.height * 4)
    if (!this.frame) this.frame = new Uint8ClampedArray(width * height * 4)
    mcu.ltdc.compose(this.composed, t.width, t.height)
    // The panel latches its own width per line and its own height of lines: a wrong active
    // size shows as a cropped or short picture, as it does on the glass.
    const identity = map.colour.every((v, i) => v === i)
    const out = this.frame
    out.fill(0)
    const w = Math.min(width, t.width)
    const h = Math.min(height, t.height)
    for (let y = 0; y < h; y++) {
      let si = y * t.width * 4
      let oi = y * width * 4
      if (identity) {
        out.set(this.composed.subarray(si, si + w * 4), oi)
        continue
      }
      for (let x = 0; x < w; x++, si += 4, oi += 4) {
        const rgb = (this.composed[si] << 16) | (this.composed[si + 1] << 8) | this.composed[si + 2]
        let v = 0
        for (let b = 0; b < 24; b++) {
          const from = map.colour[b]
          if (from >= 0 && (rgb >>> from) & 1) v |= 1 << b
        }
        out[oi] = (v >>> 16) & 0xff
        out[oi + 1] = (v >>> 8) & 0xff
        out[oi + 2] = v & 0xff
        out[oi + 3] = 255
      }
    }
    return done("ok", out)
  }

  private noiseFrame: Uint8ClampedArray | null = null

  /**
   * What an unsynced panel shows: black when unpowered, a field of static when its drivers
   * run without data. Returned once per state change (the caller skips unchanged frames).
   */
  private blank(noise: boolean): Uint8ClampedArray | null {
    const status = noise ? "noise" : "dark"
    if (this.lastStatus === "" || this.frame || this.lastBlank !== status) {
      this.frame = null
      this.lastVersion = -1
      this.lastBlank = status
      const b = new Uint8ClampedArray(this.spec.width * this.spec.height * 4)
      if (noise) {
        if (!this.noiseFrame) {
          this.noiseFrame = new Uint8ClampedArray(b.length)
          let seed = 0x9e3779b9
          for (let i = 0; i < b.length; i += 4) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            const v = 150 + (seed >>> 24) / 4
            this.noiseFrame[i] = v
            this.noiseFrame[i + 1] = v
            this.noiseFrame[i + 2] = v
            this.noiseFrame[i + 3] = 255
          }
        }
        b.set(this.noiseFrame)
      } else for (let i = 3; i < b.length; i += 4) b[i] = 255
      return b
    }
    return null
  }
  private lastBlank = ""
}
