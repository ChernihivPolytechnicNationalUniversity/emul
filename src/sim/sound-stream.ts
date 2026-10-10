export type SoundMessage = { t: "samples"; samples: Float32Array; pitch: number } | { t: "pause" } | { t: "reset" }

export const FULL_SCALE_PASCALS = 20e-6 * 10 ** (90 / 20) * Math.SQRT2

const RING_SECONDS = 2.5
const TARGET_SECONDS = 0.06
const LOW_SECONDS = 0.025
const HIGH_SECONDS = 0.15
const CROSSFADE_SECONDS = 0.004
const FALLBACK_PERIOD_SECONDS = 0.01
const FADE_SECONDS = 0.02
const LOWEST_PITCH = 20
const ANTI_ALIAS_OF_OUTPUT_RATE = 0.42

class LowPass {
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(cutoff: number, rate: number) {
    const k = Math.tan((Math.PI * cutoff) / rate)
    const norm = 1 / (1 + Math.SQRT2 * k + k * k)
    this.b0 = k * k * norm
    this.b1 = 2 * this.b0
    this.b2 = this.b0
    this.a1 = 2 * (k * k - 1) * norm
    this.a2 = (1 - Math.SQRT2 * k + k * k) * norm
  }

  run(x: number) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0
  }
}

export class SoundStream {
  readonly sourceRate: number
  readonly outputRate: number
  private readonly ring: Float32Array
  private readonly mask: number
  private readonly antiAlias: LowPass
  private readonly step: number
  private readonly target: number
  private readonly low: number
  private readonly high: number
  private readonly crossfadeFrames: number
  private readonly fadeFrames: number
  private written = 0
  private readAt = 0
  private pitch = 0
  private playing = false
  private ghostAt = 0
  private ghostLeft = 0
  private fadingOut = false
  private gain = 1
  jumps = 0

  constructor(sourceRate: number, outputRate: number) {
    this.sourceRate = sourceRate
    this.outputRate = outputRate
    let size = 1
    while (size < RING_SECONDS * sourceRate) size *= 2
    this.ring = new Float32Array(size)
    this.mask = size - 1
    this.antiAlias = new LowPass(Math.min(ANTI_ALIAS_OF_OUTPUT_RATE * outputRate, 0.45 * sourceRate), sourceRate)
    this.step = sourceRate / outputRate
    this.target = TARGET_SECONDS * sourceRate
    this.low = LOW_SECONDS * sourceRate
    this.high = HIGH_SECONDS * sourceRate
    this.crossfadeFrames = Math.max(1, Math.round(CROSSFADE_SECONDS * outputRate))
    this.fadeFrames = Math.max(1, Math.round(FADE_SECONDS * outputRate))
  }

  receive(message: SoundMessage) {
    if (message.t === "samples") this.write(message.samples, message.pitch)
    else if (message.t === "pause") this.fadingOut = this.playing
    else this.reset()
  }

  write(samples: Float32Array, pitch: number) {
    for (let k = 0; k < samples.length; k++) this.ring[(this.written + k) & this.mask] = this.antiAlias.run(samples[k] / FULL_SCALE_PASCALS)
    this.written += samples.length
    if (pitch >= LOWEST_PITCH) this.pitch = pitch
    if (this.fadingOut) {
      this.fadingOut = false
      this.gain = 1
    }
    if (!this.playing && this.written >= this.target + 2) {
      this.playing = true
      this.readAt = this.written - this.target
      this.ghostLeft = 0
    }
  }

  reset() {
    this.ring.fill(0)
    this.antiAlias.reset()
    this.written = 0
    this.readAt = 0
    this.pitch = 0
    this.playing = false
    this.ghostLeft = 0
    this.fadingOut = false
    this.gain = 1
  }

  buffered(): number {
    return this.playing ? this.written - this.readAt : 0
  }

  render(out: Float32Array) {
    if (!this.playing) {
      out.fill(0)
      return
    }
    this.keepNearTarget()
    const oldest = this.written - this.ring.length + 4
    for (let n = 0; n < out.length; n++) {
      let sample = this.at(this.readAt)
      if (this.ghostLeft > 0) {
        const ghost = this.ghostLeft / this.crossfadeFrames
        sample = sample * (1 - ghost) + this.at(Math.max(oldest, this.ghostAt)) * ghost
        this.ghostAt += this.step
        this.ghostLeft--
      }
      this.readAt = Math.min(this.readAt + this.step, this.written - 2)
      if (this.fadingOut) {
        this.gain = Math.max(0, this.gain - 1 / this.fadeFrames)
        if (this.gain === 0) {
          out.fill(0, n)
          this.reset()
          return
        }
      }
      out[n] = Math.tanh(sample) * this.gain
    }
  }

  private keepNearTarget() {
    const available = this.written - this.readAt
    const period = this.pitch >= LOWEST_PITCH ? this.sourceRate / this.pitch : FALLBACK_PERIOD_SECONDS * this.sourceRate
    let jump = 0
    if (available < this.low) jump = -Math.ceil((this.target - available) / period) * period
    else if (available > this.high) jump = Math.floor((available - this.target) / period) * period
    const oldest = this.written - this.ring.length + 4
    while (jump < 0 && this.readAt + jump < Math.max(1, oldest)) jump += period
    if (jump === 0) return
    this.ghostAt = this.readAt
    this.ghostLeft = this.crossfadeFrames
    this.readAt += jump
    this.jumps++
  }

  private at(position: number): number {
    const i = Math.floor(position)
    const f = position - i
    const r = this.ring
    const m = this.mask
    const y0 = r[(i - 1) & m]
    const y1 = r[i & m]
    const y2 = r[(i + 1) & m]
    const y3 = r[(i + 2) & m]
    return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)))
  }
}
