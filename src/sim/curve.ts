export class MonotoneCurve {
  private readonly x: Float64Array
  private readonly y: Float64Array
  private readonly m: Float64Array

  constructor(points: readonly (readonly [x: number, y: number])[]) {
    const n = points.length
    this.x = Float64Array.from(points, (p) => p[0])
    this.y = Float64Array.from(points, (p) => p[1])
    this.m = new Float64Array(n)
    const secant = new Float64Array(n - 1)
    for (let k = 0; k < n - 1; k++) secant[k] = (this.y[k + 1] - this.y[k]) / (this.x[k + 1] - this.x[k])
    this.m[0] = secant[0]
    this.m[n - 1] = secant[n - 2]
    for (let k = 1; k < n - 1; k++) {
      const a = secant[k - 1]
      const b = secant[k]
      const hl = this.x[k] - this.x[k - 1]
      const hr = this.x[k + 1] - this.x[k]
      this.m[k] = (3 * (hl + hr)) / ((2 * hr + hl) / a + (hr + 2 * hl) / b)
    }
  }

  private segment(x: number): number {
    let k = 0
    while (k < this.x.length - 2 && x > this.x[k + 1]) k++
    return k
  }

  yAt(x: number): number {
    const { x: xs, y, m } = this
    const last = xs.length - 1
    if (x <= xs[0]) return y[0] + (x - xs[0]) * m[0]
    if (x >= xs[last]) return y[last] + (x - xs[last]) * m[last]
    const k = this.segment(x)
    const h = xs[k + 1] - xs[k]
    const t = (x - xs[k]) / h
    const t2 = t * t
    const t3 = t2 * t
    return (2 * t3 - 3 * t2 + 1) * y[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * y[k + 1] + (t3 - t2) * h * m[k + 1]
  }

  slopeAt(x: number): number {
    const { x: xs, y, m } = this
    const last = xs.length - 1
    if (x <= xs[0]) return m[0]
    if (x >= xs[last]) return m[last]
    const k = this.segment(x)
    const h = xs[k + 1] - xs[k]
    const t = (x - xs[k]) / h
    const t2 = t * t
    const slope = ((6 * t2 - 6 * t) * y[k]) / h + (3 * t2 - 4 * t + 1) * m[k] + ((-6 * t2 + 6 * t) * y[k + 1]) / h + (3 * t2 - 2 * t) * m[k + 1]
    return Math.max(slope, 0.05 * ((y[k + 1] - y[k]) / h))
  }

  xAt(y: number): number {
    const { x: xs, y: ys, m } = this
    const last = xs.length - 1
    if (y <= ys[0]) return xs[0] + (y - ys[0]) / m[0]
    if (y >= ys[last]) return xs[last] + (y - ys[last]) / m[last]
    let k = 0
    while (k < last - 1 && y > ys[k + 1]) k++
    let lo = xs[k]
    let hi = xs[k + 1]
    let x = lo + ((y - ys[k]) / (ys[k + 1] - ys[k])) * (hi - lo)
    for (let iter = 0; iter < 50; iter++) {
      const err = this.yAt(x) - y
      if (Math.abs(err) < 1e-13) break
      if (err > 0) hi = x
      else lo = x
      let next = x - err / this.slopeAt(x)
      if (!(next > lo && next < hi)) next = (lo + hi) / 2
      x = next
    }
    return x
  }
}

export class CurrentCurve {
  private readonly curve: MonotoneCurve

  constructor(points: readonly (readonly [amps: number, volts: number])[]) {
    this.curve = new MonotoneCurve(points)
  }

  volts(amps: number): number {
    return this.curve.yAt(amps)
  }

  amps(volts: number, out: Float64Array) {
    const amps = this.curve.xAt(volts)
    out[0] = amps
    out[1] = 1 / this.curve.slopeAt(amps)
  }
}

export class LogCurrentCurve {
  private readonly curve: MonotoneCurve
  private readonly topAmps: number
  private readonly topVolts: number
  private readonly topConductance: number

  constructor(points: readonly (readonly [amps: number, volts: number])[]) {
    this.curve = new MonotoneCurve(points.map(([amps, volts]) => [Math.log(amps), volts]))
    const [amps, volts] = points[points.length - 1]
    this.topAmps = amps
    this.topVolts = volts
    this.topConductance = amps / this.curve.slopeAt(Math.log(amps))
  }

  volts(amps: number): number {
    if (amps >= this.topAmps) return this.topVolts + (amps - this.topAmps) / this.topConductance
    return this.curve.yAt(Math.log(amps))
  }

  amps(volts: number, out: Float64Array) {
    if (volts >= this.topVolts) {
      out[0] = this.topAmps + (volts - this.topVolts) * this.topConductance
      out[1] = this.topConductance
      return
    }
    const u = this.curve.xAt(volts)
    const amps = Math.exp(u)
    out[0] = amps
    out[1] = amps / this.curve.slopeAt(u)
  }
}
