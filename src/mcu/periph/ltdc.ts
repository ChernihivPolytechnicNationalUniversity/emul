/**
 * LTDC — LCD-TFT display controller (RM0090 §16, RM0385 §18). Two layers of a framebuffer
 * in memory, blended over a background colour and pushed out as parallel RGB with the sync
 * timings programmed in SSCR/BPCR/AWCR/TWCR. The pixel stream itself is not simulated as
 * edges on 28 pins — a panel component asks the controller for the composed frame and for
 * the timing, and judges it as a panel would (resolution, polarity, pixel clock range).
 *
 * Layer registers are shadowed: what firmware writes takes effect on SRCR's IMR
 * (immediately) or VBR (at the next vertical blanking, here: immediately as well, since a
 * frame is composed as a whole). The line interrupt fires once per frame at LIPCR, timed
 * from the pixel clock; the register-reload interrupt on every reload.
 */
import type { Bus } from "../bus"
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

const LTDC_BASE = 0x40016800
export const LTDC_IRQ = 88
export const LTDC_ER_IRQ = 89

const GCR_LTDCEN = 1
const IER_LIE = 1
const IER_RRIE = 8

/** Layer register offsets relative to the layer base (0x84 for layer 1, 0x104 for layer 2). */
const L_CR = 0x00
const L_WHPCR = 0x04
const L_WVPCR = 0x08
const L_CKCR = 0x0c
const L_PFCR = 0x10
const L_CACR = 0x14
const L_DCCR = 0x18
const L_BFCR = 0x1c
const L_CFBAR = 0x28
const L_CFBLR = 0x2c
const L_CFBLNR = 0x30
const L_CLUTWR = 0x40
const LAYER_BASE = [0x84, 0x104]

function layerRegs(i: number): RegDef[] {
  const b = LAYER_BASE[i]
  const n = `L${i + 1}`
  return [
    { name: `${n}CR`, offset: b + L_CR, rw: 0x13 },
    { name: `${n}WHPCR`, offset: b + L_WHPCR, rw: 0x0fff0fff },
    { name: `${n}WVPCR`, offset: b + L_WVPCR, rw: 0x07ff07ff },
    { name: `${n}CKCR`, offset: b + L_CKCR, rw: 0x00ffffff },
    { name: `${n}PFCR`, offset: b + L_PFCR, rw: 7 },
    { name: `${n}CACR`, offset: b + L_CACR, reset: 0xff, rw: 0xff },
    { name: `${n}DCCR`, offset: b + L_DCCR },
    { name: `${n}BFCR`, offset: b + L_BFCR, reset: 0x607, rw: 0x707 },
    { name: `${n}CFBAR`, offset: b + L_CFBAR },
    { name: `${n}CFBLR`, offset: b + L_CFBLR, rw: 0x1fff1fff },
    { name: `${n}CFBLNR`, offset: b + L_CFBLNR, rw: 0x7ff },
    { name: `${n}CLUTWR`, offset: b + L_CLUTWR },
  ]
}

const REGS: RegDef[] = [
  { name: "SSCR", offset: 0x08, rw: 0x0fff07ff },
  { name: "BPCR", offset: 0x0c, rw: 0x0fff07ff },
  { name: "AWCR", offset: 0x10, rw: 0x0fff07ff },
  { name: "TWCR", offset: 0x14, rw: 0x0fff07ff },
  { name: "GCR", offset: 0x18, reset: 0x2220, rw: 0xf0010001 },
  { name: "SRCR", offset: 0x24, rw: 3 },
  { name: "BCCR", offset: 0x2c, rw: 0x00ffffff },
  { name: "IER", offset: 0x34, rw: 0xf },
  { name: "ISR", offset: 0x38, rw: 0 },
  { name: "ICR", offset: 0x3c, rw: 0xf },
  { name: "LIPCR", offset: 0x40, rw: 0x7ff },
  { name: "CPSR", offset: 0x44, rw: 0 },
  { name: "CDSR", offset: 0x48, reset: 1, rw: 0 },
  ...layerRegs(0),
  ...layerRegs(1),
]

/** Pixel formats of LxPFCR: ARGB8888, RGB888, RGB565, ARGB1555, ARGB4444, L8, AL44, AL88. */
export type PixelFormat = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
export const PIXEL_BYTES = [4, 3, 2, 2, 2, 1, 1, 2]
export const PIXEL_FORMAT_NAMES = ["ARGB8888", "RGB888", "RGB565", "ARGB1555", "ARGB4444", "L8", "AL44", "AL88"]

/** The active (reloaded) configuration of one layer. */
export type LayerConfig = {
  enabled: boolean
  colorKey: boolean
  clut: boolean
  /** Window in pixels of the active area (already offset by the back porches). */
  x0: number
  x1: number
  y0: number
  y1: number
  format: PixelFormat
  /** Constant alpha 0–255. */
  alpha: number
  /** Default colour ARGB for pixels outside the framebuffer's line length. */
  defaultColor: number
  bf1: number
  bf2: number
  address: number
  /** Bytes per line in memory (CFBP) and bytes of pixels per line (CFBLL − 3). */
  pitch: number
  lineBytes: number
  lines: number
  keyColor: number
}

export type LtdcTiming = {
  enabled: boolean
  pixelHz: number
  /** Active area in pixels. */
  width: number
  height: number
  hsync: number
  hbp: number
  hfp: number
  vsync: number
  vbp: number
  vfp: number
  /** Frame rate, Hz (0 without a pixel clock). */
  frameHz: number
  /** Polarities: true = active high (the GCR bits), pixel clock inverted. */
  hsPositive: boolean
  vsPositive: boolean
  dePositive: boolean
  pcInverted: boolean
}

/** Convert one framebuffer pixel of the given format (little-endian bytes at `i`) to 0xAARRGGBB. */
/** An RGBA pixel as one little-endian word of a `Uint8ClampedArray`'s buffer. */
const rgba = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0

/** Every RGB565 value as the RGBA word `pixelToArgb` and an opaque blend make of it. */
const RGB565 = (() => {
  const t = new Uint32Array(65536)
  for (let v = 0; v < 65536; v++) {
    const r = (v >>> 11) & 0x1f
    const g = (v >>> 5) & 0x3f
    const b = v & 0x1f
    t[v] = rgba((r << 3) | (r >>> 2), (g << 2) | (g >>> 4), (b << 3) | (b >>> 2))
  }
  return t
})()

export function pixelToArgb(bytes: Uint8Array, i: number, format: PixelFormat, clut: Uint32Array | null): number {
  switch (format) {
    case 0:
      return ((bytes[i + 3] << 24) | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0
    case 1:
      return (0xff000000 | (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) >>> 0
    case 2: {
      const v = bytes[i] | (bytes[i + 1] << 8)
      const r = (v >>> 11) & 0x1f
      const g = (v >>> 5) & 0x3f
      const b = v & 0x1f
      return (0xff000000 | (((r << 3) | (r >>> 2)) << 16) | (((g << 2) | (g >>> 4)) << 8) | ((b << 3) | (b >>> 2))) >>> 0
    }
    case 3: {
      const v = bytes[i] | (bytes[i + 1] << 8)
      const a = v & 0x8000 ? 0xff : 0
      const r = (v >>> 10) & 0x1f
      const g = (v >>> 5) & 0x1f
      const b = v & 0x1f
      return ((a << 24) | (((r << 3) | (r >>> 2)) << 16) | (((g << 3) | (g >>> 2)) << 8) | ((b << 3) | (b >>> 2))) >>> 0
    }
    case 4: {
      const v = bytes[i] | (bytes[i + 1] << 8)
      const a = (v >>> 12) & 0xf
      const r = (v >>> 8) & 0xf
      const g = (v >>> 4) & 0xf
      const b = v & 0xf
      return (((a * 17) << 24) | ((r * 17) << 16) | ((g * 17) << 8) | (b * 17)) >>> 0
    }
    case 5:
      return clut ? clut[bytes[i]] : (0xff000000 | (bytes[i] * 0x010101)) >>> 0
    case 6: {
      const a = (bytes[i] >>> 4) * 17
      const l = bytes[i] & 0xf
      const c = clut ? clut[l] & 0xffffff : l * 17 * 0x010101
      return ((a << 24) | c) >>> 0
    }
    case 7: {
      const c = clut ? clut[bytes[i]] & 0xffffff : bytes[i] * 0x010101
      return ((bytes[i + 1] << 24) | c) >>> 0
    }
  }
  return 0
}

export class Ltdc extends RegBlock implements Clocked {
  bus: Bus | null = null
  raiseIrq: ((irq: number) => void) | null = null
  onActive: ((on: boolean) => void) | null = null
  onUnsupported: ((what: string) => void) | null = null
  /** Bumped on every reload and every write that changes what the panel sees. */
  version = 0
  readonly layers: LayerConfig[] = [Ltdc.layerOff(), Ltdc.layerOff()]
  private readonly cluts = [new Uint32Array(256), new Uint32Array(256)]
  private hclk = 16e6
  /** Position in the frame, in pixel clocks (fractional between ticks). */
  private pixelPos = 0
  private frames = 0

  constructor() {
    super("LTDC", LTDC_BASE, 0x400, REGS)
  }

  private static layerOff(): LayerConfig {
    return { enabled: false, colorKey: false, clut: false, x0: 0, x1: 0, y0: 0, y1: 0, format: 0, alpha: 255, defaultColor: 0, bf1: 6, bf2: 7, address: 0, pitch: 0, lineBytes: 0, lines: 0, keyColor: 0 }
  }

  reset() {
    super.reset()
    if (this.layers) {
      this.layers[0] = Ltdc.layerOff()
      this.layers[1] = Ltdc.layerOff()
      this.cluts[0].fill(0)
      this.cluts[1].fill(0)
    }
    this.pixelPos = 0
    this.frames = 0
    this.version++
    this.onActive?.(false)
  }

  /** Pixel clock as RCC has it now (PLLSAI R output through DIVR, zero when off or ungated). */
  pixelClock: () => number = () => 0

  /** The core clock the ticks come in. */
  setClock(hclk: number) {
    this.hclk = hclk
    this.onActive?.(this.running())
  }

  private get pixelHz() {
    return this.pixelClock()
  }

  private running() {
    return (this.get("GCR") & GCR_LTDCEN) !== 0 && this.pixelHz > 0
  }

  /** The programmed timing, as the panel sees it. */
  timing(): LtdcTiming {
    const sscr = this.get("SSCR")
    const bpcr = this.get("BPCR")
    const awcr = this.get("AWCR")
    const twcr = this.get("TWCR")
    const gcr = this.get("GCR")
    const hsw = ((sscr >>> 16) & 0xfff) + 1
    const vsh = (sscr & 0x7ff) + 1
    const ahbp = ((bpcr >>> 16) & 0xfff) + 1
    const avbp = (bpcr & 0x7ff) + 1
    const aaw = ((awcr >>> 16) & 0xfff) + 1
    const aah = (awcr & 0x7ff) + 1
    const totalW = ((twcr >>> 16) & 0xfff) + 1
    const totalH = (twcr & 0x7ff) + 1
    const width = Math.max(0, aaw - ahbp)
    const height = Math.max(0, aah - avbp)
    const enabled = this.running()
    return {
      enabled,
      pixelHz: this.pixelHz,
      width,
      height,
      hsync: hsw,
      hbp: ahbp - hsw,
      hfp: totalW - aaw,
      vsync: vsh,
      vbp: avbp - vsh,
      vfp: totalH - aah,
      frameHz: this.pixelHz > 0 && totalW * totalH > 0 ? this.pixelHz / (totalW * totalH) : 0,
      hsPositive: (gcr & (1 << 31)) !== 0,
      vsPositive: (gcr & (1 << 30)) !== 0,
      dePositive: (gcr & (1 << 29)) !== 0,
      pcInverted: (gcr & (1 << 28)) !== 0,
    }
  }

  /** Whole-frame pixel count and pixels per line, for the position counters. */
  private frameSize() {
    const twcr = this.get("TWCR")
    return { totalW: ((twcr >>> 16) & 0xfff) + 1, totalH: (twcr & 0x7ff) + 1 }
  }

  /** Copy the shadow layer registers into the active configuration. */
  private reload() {
    const bpcr = this.get("BPCR")
    const ahbp = ((bpcr >>> 16) & 0xfff) + 1
    const avbp = (bpcr & 0x7ff) + 1
    for (let i = 0; i < 2; i++) {
      const b = LAYER_BASE[i] >>> 2
      const cr = this.regs[b + (L_CR >>> 2)]
      const whpcr = this.regs[b + (L_WHPCR >>> 2)]
      const wvpcr = this.regs[b + (L_WVPCR >>> 2)]
      const bfcr = this.regs[b + (L_BFCR >>> 2)]
      const cfblr = this.regs[b + (L_CFBLR >>> 2)]
      const format = (this.regs[b + (L_PFCR >>> 2)] & 7) as PixelFormat
      const l = this.layers[i]
      l.enabled = (cr & 1) !== 0
      l.colorKey = (cr & 2) !== 0
      l.clut = (cr & 0x10) !== 0
      // Window edges are given in total-frame coordinates: subtract the back porch.
      l.x0 = (whpcr & 0xfff) - ahbp
      l.x1 = ((whpcr >>> 16) & 0xfff) - ahbp + 1
      l.y0 = (wvpcr & 0x7ff) - avbp
      l.y1 = ((wvpcr >>> 16) & 0x7ff) - avbp + 1
      l.format = format
      l.alpha = this.regs[b + (L_CACR >>> 2)] & 0xff
      l.defaultColor = this.regs[b + (L_DCCR >>> 2)] >>> 0
      l.bf1 = (bfcr >>> 8) & 7
      l.bf2 = bfcr & 7
      l.address = this.regs[b + (L_CFBAR >>> 2)] >>> 0
      l.pitch = (cfblr >>> 16) & 0x1fff
      l.lineBytes = Math.max(0, (cfblr & 0x1fff) - 3)
      l.lines = this.regs[b + (L_CFBLNR >>> 2)] & 0x7ff
      l.keyColor = this.regs[b + (L_CKCR >>> 2)] & 0xffffff
      if (l.enabled && l.colorKey) this.onUnsupported?.(`LTDC layer ${i + 1} colour keying`)
    }
    this.version++
    this.regs[0x38 >>> 2] |= IER_RRIE
    if (this.get("IER") & IER_RRIE) this.raiseIrq?.(LTDC_IRQ)
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    for (let i = 0; i < 2; i++) {
      if (d.offset === LAYER_BASE[i] + L_CLUTWR) {
        // CLUT entry: index in bits 31:24, RGB below. Written straight through (no shadow).
        this.cluts[i][written >>> 24] = (0xff000000 | (written & 0xffffff)) >>> 0
        this.version++
        return 0
      }
    }
    switch (d.name) {
      case "SRCR":
        if (next & 3) this.reload()
        return 0
      case "ICR":
        this.regs[0x38 >>> 2] &= ~written
        return 0
      case "GCR":
        if ((next & GCR_LTDCEN) !== (old & GCR_LTDCEN)) {
          this.pixelPos = 0
          this.onActive?.((next & GCR_LTDCEN) !== 0 && this.pixelHz > 0)
        }
        if ((next & (1 << 16)) && !(old & (1 << 16))) this.onUnsupported?.("LTDC dithering")
        this.version++
        return
      case "SSCR":
      case "BPCR":
      case "AWCR":
      case "TWCR":
      case "BCCR":
        this.version++
        return
    }
  }

  protected onRead(d: RegDef, current: number): number {
    if (d.name === "CPSR" || d.name === "CDSR") {
      const { totalW, totalH } = this.frameSize()
      const pos = Math.floor(this.pixelPos)
      const x = pos % totalW
      const y = Math.floor(pos / totalW) % totalH
      if (d.name === "CPSR") return ((x << 16) | y) >>> 0
      const t = this.timing()
      const sscr = this.get("SSCR")
      const hsw = ((sscr >>> 16) & 0xfff) + 1
      const vsh = (sscr & 0x7ff) + 1
      const inActive = t.enabled && x >= t.hsync + t.hbp && x < t.hsync + t.hbp + t.width && y >= t.vsync + t.vbp && y < t.vsync + t.vbp + t.height
      const hsync = x < hsw
      const vsync = y < vsh
      // Status bits are the signal levels as programmed (active-low sync reads 0 during sync).
      const level = (active: boolean, positive: boolean) => (active === positive ? 1 : 0)
      return (level(vsync, t.vsPositive) << 2) | (level(hsync, t.hsPositive) << 3) | (level(inActive, t.dePositive) << 1) | (inActive || !t.enabled ? 1 : 0)
    }
    return current
  }

  // --- timing --------------------------------------------------------------------------------

  tick(cycles: number) {
    if (!this.running()) return
    const { totalW, totalH } = this.frameSize()
    const frame = totalW * totalH
    const before = this.pixelPos
    const after = before + (cycles * this.pixelHz) / this.hclk
    const lineAt = (this.get("LIPCR") & 0x7ff) * totalW
    // The line interrupt: once per frame, when the position passes LIPCR's line.
    const framesBefore = Math.floor(before / frame)
    const framesAfter = Math.floor(after / frame)
    const ier = this.get("IER")
    for (let f = framesBefore; f <= framesAfter; f++) {
      const at = f * frame + lineAt
      if (at > before && at <= after) {
        this.regs[0x38 >>> 2] |= IER_LIE
        if (ier & IER_LIE) this.raiseIrq?.(LTDC_IRQ)
      }
    }
    this.frames += framesAfter - framesBefore
    this.pixelPos = after % (frame * 4096)
  }

  cyclesUntilEvent(): number {
    if (!this.running() || !(this.get("IER") & IER_LIE)) return Infinity
    const { totalW, totalH } = this.frameSize()
    const frame = totalW * totalH
    const lineAt = (this.get("LIPCR") & 0x7ff) * totalW
    const inFrame = this.pixelPos % frame
    let ahead = lineAt - inFrame
    if (ahead <= 0) ahead += frame
    return Math.max(1, Math.ceil((ahead * this.hclk) / this.pixelHz))
  }

  /** Frames output since reset (for the inspector's refresh-rate check). */
  get frameCount() {
    return this.frames
  }

  // --- composition ---------------------------------------------------------------------------

  /**
   * Compose the frame the controller is outputting: the background colour, then each enabled
   * layer's window read from memory and blended with its blending factors. `out` is RGBA, row
   * major, `width × height` of the active area. Returns false while the controller is off.
   */
  compose(out: Uint8ClampedArray, width: number, height: number): boolean {
    const t = this.timing()
    if (!t.enabled || !this.bus) return false
    const bccr = this.get("BCCR")
    const br = (bccr >>> 16) & 0xff
    const bg = (bccr >>> 8) & 0xff
    const bb = bccr & 0xff
    const words = new Uint32Array(out.buffer, out.byteOffset, width * height)
    words.fill(rgba(br, bg, bb))
    for (let li = 0; li < 2; li++) {
      const l = this.layers[li]
      if (!l.enabled) continue
      const bpp = PIXEL_BYTES[l.format]
      const clut = l.clut ? this.cluts[li] : null
      const x0 = Math.max(0, l.x0)
      const x1 = Math.min(width, l.x1)
      const y0 = Math.max(0, l.y0)
      const y1 = Math.min(height, l.y1)
      const dr = (l.defaultColor >>> 16) & 0xff
      const dg = (l.defaultColor >>> 8) & 0xff
      const db = l.defaultColor & 0xff
      const da = l.defaultColor >>> 24
      const pixelsPerLine = Math.floor(l.lineBytes / bpp)
      const winW = l.x1 - l.x0
      // An opaque layer without alpha of its own covers what is under it: its pixels go straight in.
      const opaque = l.alpha === 255 && (l.format === 1 || l.format === 2)
      for (let y = y0; y < y1; y++) {
        const line = y - l.y0
        const lineAddr = (l.address + line * l.pitch) >>> 0
        const mem = line < l.lines ? this.bus.frameBytes(lineAddr, pixelsPerLine * bpp) : null
        let x = x0
        if (opaque && mem) {
          const bytes = mem.bytes
          const end = Math.min(x1, l.x0 + pixelsPerLine)
          let w = y * width + x
          let i = mem.offset + (x - l.x0) * bpp
          if (l.format === 2) for (; x < end; x++, w++, i += 2) words[w] = RGB565[bytes[i] | (bytes[i + 1] << 8)]
          else for (; x < end; x++, w++, i += 3) words[w] = rgba(bytes[i + 2], bytes[i + 1], bytes[i])
        }
        let o = (y * width + x) * 4
        for (; x < x1; x++, o += 4) {
          const px = x - l.x0
          let argb: number
          if (mem && px < pixelsPerLine) argb = pixelToArgb(mem.bytes, mem.offset + px * bpp, l.format, clut)
          else if (px < winW) argb = ((da << 24) | (dr << 16) | (dg << 8) | db) >>> 0
          else continue
          const pa = argb >>> 24
          // BF1: 4 = constant alpha, 6 = pixel alpha × constant alpha; BF2 is its complement.
          const a = (l.bf1 === 6 ? (pa * l.alpha) / 255 : l.alpha) / 255
          const b = l.bf2 === 7 ? 1 - (pa * l.alpha) / 65025 : 1 - l.alpha / 255
          out[o] = ((argb >>> 16) & 0xff) * a + out[o] * b
          out[o + 1] = ((argb >>> 8) & 0xff) * a + out[o + 1] * b
          out[o + 2] = (argb & 0xff) * a + out[o + 2] * b
        }
      }
    }
    return true
  }
}
