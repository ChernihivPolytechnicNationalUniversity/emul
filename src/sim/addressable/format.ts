/**
 * A frame as a chip reads it: an optional header every chip reads (the current gains of the
 * WS291x parts), then one word per chip, each cut into fields MSB first. `PlainFormat` is a
 * level per channel; `GainFormat` scales each channel's current by the header's gain.
 */
import { channelsOf, type Channel, type ChipSpec, type FieldSpec } from "./spec"

/** What a chip's outputs do: the PWM duty (0..1) and the current scale (0..1) of each channel. */
export type ChannelDrive = { duty: number; scale: number }

/** Values of a block of fields as shifted in, and where each bit goes. */
export class FieldBlock {
  readonly fields: readonly FieldSpec[]
  readonly bits: number
  private readonly at: Uint8Array

  constructor(fields: readonly FieldSpec[]) {
    this.fields = fields
    this.bits = fields.reduce((n, f) => n + f.bits, 0)
    this.at = new Uint8Array(this.bits)
    let i = 0
    fields.forEach((f, k) => {
      for (let b = 0; b < f.bits; b++) this.at[i++] = k
    })
  }

  blank(): number[] {
    return new Array<number>(this.fields.length).fill(0)
  }

  /** Shift bit number `index` (0 = first on the wire) of the block into `values`. */
  push(values: number[], index: number, bit: number) {
    const k = this.at[index]
    values[k] = values[k] * 2 + bit
  }

  /** The value of a channel's field of a role, or undefined if the block has none. */
  value(values: readonly number[], channel: Channel, role: FieldSpec["role"]): { value: number; bits: number } | undefined {
    const k = this.fields.findIndex((f) => f.channel === channel && f.role === role)
    return k < 0 ? undefined : { value: values[k], bits: this.fields[k].bits }
  }

  describe(values: readonly number[]) {
    return this.fields.flatMap((f, k) => (f.channel && f.role !== "check" ? [{ channel: f.channel, role: f.role as "level" | "gain", value: values[k], bits: f.bits }] : []))
  }
}

export abstract class FrameFormat {
  readonly word: FieldBlock
  readonly header: FieldBlock | null
  /** Data channels in canonical order (R, G, B, W, W2). */
  readonly channels: readonly Channel[]
  protected readonly fullScale: number | undefined

  constructor(spec: ChipSpec) {
    this.word = new FieldBlock(spec.fields)
    this.header = spec.header?.length ? new FieldBlock(spec.header) : null
    this.channels = channelsOf(spec)
    this.fullScale = spec.fullScale
  }

  /** What the outputs do for a complete word (and the frame's header), in `channels` order. */
  abstract decode(word: readonly number[], header: readonly number[] | null): ChannelDrive[]

  protected duty(word: readonly number[], c: Channel) {
    const f = this.word.value(word, c, "level")
    return f ? Math.min(1, f.value / (this.fullScale ?? 2 ** f.bits - 1)) : 0
  }
}

/** Each channel's level is its duty: n bits, 0 off, full scale fully on. */
export class PlainFormat extends FrameFormat {
  decode(word: readonly number[]): ChannelDrive[] {
    return this.channels.map((c) => ({ duty: this.duty(word, c), scale: 1 }))
  }
}

/**
 * A level per channel and a current gain per channel in the frame header: the gain code
 * scales the output current linearly, the full code giving the full current (the gain tables
 * of WS2913/WS2916A run 0 → 0 mA, 0x1F → full in near-equal steps).
 */
export class GainFormat extends FrameFormat {
  decode(word: readonly number[], header: readonly number[] | null): ChannelDrive[] {
    return this.channels.map((c) => {
      const g = header && this.header ? this.header.value(header, c, "gain") : undefined
      return { duty: this.duty(word, c), scale: g ? g.value / (2 ** g.bits - 1) : 1 }
    })
  }
}

export function formatFor(spec: ChipSpec): FrameFormat {
  return spec.header?.some((f) => f.role === "gain") ? new GainFormat(spec) : new PlainFormat(spec)
}
