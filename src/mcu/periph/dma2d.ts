/**
 * DMA2D — Chrom-ART accelerator (RM0090 §11, RM0385 §9): fills and copies rectangles of
 * pixels with format conversion and alpha blending, which is what the BSP LCD drivers use
 * to clear the screen and draw bitmaps. A transfer runs to completion the moment START is
 * written (the bus is not shared, so nothing observes it in flight), then TCIF is set and
 * the interrupt raised if enabled. CLUT loads work the same way.
 */
import type { Bus } from "../bus"
import { RegBlock, type RegDef } from "./regblock"
import { pixelToArgb, PIXEL_BYTES, type PixelFormat } from "./ltdc"

const DMA2D_BASE = 0x4002b000
export const DMA2D_IRQ = 90

const CR_START = 1
const CR_TCIE = 1 << 9
const CR_CTCIE = 1 << 12
const ISR_TCIF = 2
const ISR_CTCIF = 1 << 4
const ISR_CEIF = 1 << 5

const REGS: RegDef[] = [
  { name: "CR", offset: 0x00, rw: 0x00033f07 },
  { name: "ISR", offset: 0x04, rw: 0 },
  { name: "IFCR", offset: 0x08, rw: 0x3f },
  { name: "FGMAR", offset: 0x0c },
  { name: "FGOR", offset: 0x10, rw: 0x3fff },
  { name: "BGMAR", offset: 0x14 },
  { name: "BGOR", offset: 0x18, rw: 0x3fff },
  { name: "FGPFCCR", offset: 0x1c, rw: 0xff03ff3f },
  { name: "FGCOLR", offset: 0x20, rw: 0x00ffffff },
  { name: "BGPFCCR", offset: 0x24, rw: 0xff03ff3f },
  { name: "BGCOLR", offset: 0x28, rw: 0x00ffffff },
  { name: "FGCMAR", offset: 0x2c },
  { name: "BGCMAR", offset: 0x30 },
  { name: "OPFCCR", offset: 0x34, rw: 7 },
  { name: "OCOLR", offset: 0x38 },
  { name: "OMAR", offset: 0x3c },
  { name: "OOR", offset: 0x40, rw: 0x3fff },
  { name: "NLR", offset: 0x44, rw: 0x3fffffff },
  { name: "LWR", offset: 0x48, rw: 0xfff },
  { name: "AMTCR", offset: 0x4c, rw: 0xff01 },
]

/** Input colour modes beyond the LTDC's: L4, A8, A4. */
const CM_L4 = 8
const CM_A8 = 9
const CM_A4 = 10

export class Dma2d extends RegBlock {
  bus: Bus | null = null
  raiseIrq: ((irq: number) => void) | null = null
  onUnsupported: ((what: string) => void) | null = null
  private readonly cluts = [new Uint32Array(256), new Uint32Array(256)]
  /** Transfers done, for the inspector. */
  transfers = 0

  constructor() {
    super("DMA2D", DMA2D_BASE, 0x1000, REGS)
  }

  reset() {
    super.reset()
    this.transfers = 0
  }

  protected onWrite(d: RegDef, next: number, _old: number, written: number): number | void {
    switch (d.name) {
      case "IFCR":
        this.regs[0x04 >>> 2] &= ~written
        return 0
      case "CR":
        if (next & CR_START) {
          this.regs[0x00 >>> 2] = next & ~CR_START
          this.transfer((next >>> 16) & 3)
          return this.regs[0x00 >>> 2]
        }
        return
      case "FGPFCCR":
      case "BGPFCCR":
        // START (bit 5) loads the CLUT from FG/BGCMAR: CS + 1 entries of ARGB8888 or RGB888 (CCM).
        if (next & (1 << 5)) {
          const fg = d.name === "FGPFCCR"
          const addr = this.get(fg ? "FGCMAR" : "BGCMAR")
          const entries = ((next >>> 8) & 0xff) + 1
          const rgb888 = (next & (1 << 4)) !== 0
          const clut = this.cluts[fg ? 0 : 1]
          for (let i = 0; i < entries; i++) {
            const a = addr + i * (rgb888 ? 3 : 4)
            const b = this.bus?.read(a, 1) ?? 0
            const g = this.bus?.read(a + 1, 1) ?? 0
            const r = this.bus?.read(a + 2, 1) ?? 0
            const al = rgb888 ? 0xff : (this.bus?.read(a + 3, 1) ?? 0)
            clut[i] = ((al << 24) | (r << 16) | (g << 8) | b) >>> 0
          }
          this.regs[0x04 >>> 2] |= ISR_CTCIF
          if (this.get("CR") & CR_CTCIE) this.raiseIrq?.(DMA2D_IRQ)
          return next & ~(1 << 5)
        }
        return
    }
  }

  /** Read one input pixel as ARGB with the layer's alpha mode and colour applied. */
  private inputPixel(addr: number, cm: number, pfccr: number, colr: number, clut: Uint32Array, sub: number): number {
    const bus = this.bus!
    let argb: number
    if (cm === CM_L4) {
      const byte = bus.read8(addr)
      const idx = sub ? byte & 0xf : byte >>> 4
      argb = clut[idx]
    } else if (cm === CM_A8) {
      argb = ((bus.read8(addr) << 24) | (colr & 0xffffff)) >>> 0
    } else if (cm === CM_A4) {
      const byte = bus.read8(addr)
      const a = (sub ? byte & 0xf : byte >>> 4) * 17
      argb = ((a << 24) | (colr & 0xffffff)) >>> 0
    } else {
      const bpp = PIXEL_BYTES[cm]
      const b = new Uint8Array(4)
      for (let i = 0; i < bpp; i++) b[i] = bus.read8(addr + i)
      argb = pixelToArgb(b, 0, cm as PixelFormat, cm >= 5 ? clut : null)
    }
    // Alpha mode: 0 keep, 1 replace with ALPHA, 2 multiply by ALPHA.
    const am = (pfccr >>> 16) & 3
    const alpha = pfccr >>> 24
    if (am === 1) argb = ((alpha << 24) | (argb & 0xffffff)) >>> 0
    else if (am === 2) argb = ((Math.round(((argb >>> 24) * alpha) / 255) << 24) | (argb & 0xffffff)) >>> 0
    return argb
  }

  /** Write one output pixel in OPFCCR's colour mode. */
  private outputPixel(addr: number, cm: number, argb: number) {
    const bus = this.bus!
    const a = argb >>> 24
    const r = (argb >>> 16) & 0xff
    const g = (argb >>> 8) & 0xff
    const b = argb & 0xff
    switch (cm) {
      case 0:
        bus.write32(addr, argb)
        return
      case 1:
        bus.write8(addr, b)
        bus.write8(addr + 1, g)
        bus.write8(addr + 2, r)
        return
      case 2:
        bus.write16(addr, ((r >>> 3) << 11) | ((g >>> 2) << 5) | (b >>> 3))
        return
      case 3:
        bus.write16(addr, ((a >>> 7) << 15) | ((r >>> 3) << 10) | ((g >>> 3) << 5) | (b >>> 3))
        return
      case 4:
        bus.write16(addr, ((a >>> 4) << 12) | ((r >>> 4) << 8) | ((g >>> 4) << 4) | (b >>> 4))
        return
    }
  }

  /** Bytes per pixel of an input colour mode; L4/A4 are half a byte and handled by the caller. */
  private static inBytes(cm: number) {
    return cm === CM_A8 ? 1 : cm === CM_L4 || cm === CM_A4 ? 0.5 : PIXEL_BYTES[cm]
  }

  private transfer(mode: number) {
    if (!this.bus) return
    const nlr = this.get("NLR")
    const lines = nlr & 0xffff
    const pixels = (nlr >>> 16) & 0x3fff
    const ocm = this.get("OPFCCR") & 7
    if (ocm > 4) {
      this.regs[0x04 >>> 2] |= ISR_CEIF
      this.onUnsupported?.(`DMA2D output colour mode ${ocm}`)
      return
    }
    const obpp = PIXEL_BYTES[ocm]
    const oor = this.get("OOR") & 0x3fff
    let oaddr = this.get("OMAR") >>> 0
    const fgpfccr = this.get("FGPFCCR")
    const bgpfccr = this.get("BGPFCCR")
    const fcm = fgpfccr & 0xf
    const bcm = bgpfccr & 0xf
    const fbpp = Dma2d.inBytes(fcm)
    const bbpp = Dma2d.inBytes(bcm)
    const fgor = this.get("FGOR") & 0x3fff
    const bgor = this.get("BGOR") & 0x3fff
    let faddr = this.get("FGMAR") >>> 0
    let baddr = this.get("BGMAR") >>> 0
    const fcolr = this.get("FGCOLR")
    const bcolr = this.get("BGCOLR")
    const ocolr = this.get("OCOLR") >>> 0
    // Register-to-memory: the colour is already in the output format.
    const fill = mode === 3 ? (ocm === 0 ? ocolr : ocm === 1 ? (0xff000000 | (ocolr & 0xffffff)) >>> 0 : 0) : 0
    // The two bulk cases straight through memory: a fill in a 32/24-bit format, and a copy
    // between identical formats with the alpha untouched. Anything else goes pixel by pixel.
    const bulkFill = mode === 3 && ocm <= 1
    const bulkCopy = mode === 0 && fcm === ocm && ((fgpfccr >>> 16) & 3) === 0 && obpp === fbpp
    for (let y = 0; y < lines; y++) {
      const rowBytes = pixels * obpp
      if (bulkFill) {
        const out = this.bus.span(oaddr, rowBytes, true)
        if (out) {
          const { bytes, offset } = out
          if (obpp === 4) {
            const view = new DataView(bytes.buffer, bytes.byteOffset)
            for (let x = 0; x < pixels; x++) view.setUint32(offset + x * 4, fill, true)
          } else {
            const b = fill & 0xff
            const g = (fill >>> 8) & 0xff
            const r = (fill >>> 16) & 0xff
            for (let x = 0, o = offset; x < pixels; x++, o += 3) {
              bytes[o] = b
              bytes[o + 1] = g
              bytes[o + 2] = r
            }
          }
          oaddr += (pixels + oor) * obpp
          faddr += Math.ceil((pixels + fgor) * fbpp)
          baddr += Math.ceil((pixels + bgor) * bbpp)
          continue
        }
      } else if (bulkCopy) {
        const out = this.bus.span(oaddr, rowBytes, true)
        const src = this.bus.span(faddr, rowBytes, false)
        if (out && src) {
          out.bytes.set(src.bytes.subarray(src.offset, src.offset + rowBytes), out.offset)
          oaddr += (pixels + oor) * obpp
          faddr += Math.ceil((pixels + fgor) * fbpp)
          baddr += Math.ceil((pixels + bgor) * bbpp)
          continue
        }
      }
      for (let x = 0; x < pixels; x++) {
        let argb: number
        if (mode === 3) {
          if (ocm <= 1) argb = fill
          else {
            // 16-bit formats take the colour as packed bits: write it straight.
            this.bus.write16(oaddr + x * obpp, ocolr & 0xffff)
            continue
          }
        } else {
          const fa = faddr + Math.floor(x * fbpp)
          argb = this.inputPixel(fa, fcm, fgpfccr, fcolr, this.cluts[0], x & 1)
          if (mode === 2) {
            const ba = baddr + Math.floor(x * bbpp)
            const bg = this.inputPixel(ba, bcm, bgpfccr, bcolr, this.cluts[1], x & 1)
            // Alpha blending as RM0385 §9.3.6: out = fg·αf + bg·αb·(1 − αf), normalised by the result alpha.
            const af = (argb >>> 24) / 255
            const ab = (bg >>> 24) / 255
            const ao = af + ab * (1 - af)
            const mix = (f: number, b: number) => (ao > 0 ? Math.round((f * af + b * ab * (1 - af)) / ao) : 0)
            argb = ((Math.round(ao * 255) << 24) | (mix((argb >>> 16) & 0xff, (bg >>> 16) & 0xff) << 16) | (mix((argb >>> 8) & 0xff, (bg >>> 8) & 0xff) << 8) | mix(argb & 0xff, bg & 0xff)) >>> 0
          }
        }
        this.outputPixel(oaddr + x * obpp, ocm, argb)
      }
      oaddr += (pixels + oor) * obpp
      faddr += Math.ceil((pixels + fgor) * fbpp)
      baddr += Math.ceil((pixels + bgor) * bbpp)
    }
    this.transfers++
    this.regs[0x04 >>> 2] |= ISR_TCIF
    if (this.get("CR") & CR_TCIE) this.raiseIrq?.(DMA2D_IRQ)
  }
}
