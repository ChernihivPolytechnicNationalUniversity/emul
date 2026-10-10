export type Complex = { re: number; im: number }

export const complex = (re: number, im = 0): Complex => ({ re, im })
const minus = (a: Complex, b: Complex) => complex(a.re - b.re, a.im - b.im)
export const times = (a: Complex, b: Complex) => complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const over = (a: Complex, b: Complex) => {
  const d = b.re * b.re + b.im * b.im
  return complex((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}
const magnitude = (a: Complex) => Math.hypot(a.re, a.im)

export function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0)
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] += x * y)))
  return out
}

export function add(a: readonly number[], b: readonly number[]): number[] {
  const length = Math.max(a.length, b.length)
  const at = (p: readonly number[], k: number) => p[k - (length - p.length)] ?? 0
  return Array.from({ length }, (_, k) => at(a, k) + at(b, k))
}

function valueAt(coefficients: readonly number[], x: Complex): Complex {
  return coefficients.reduce((acc, c) => complex(acc.re * x.re - acc.im * x.im + c, acc.re * x.im + acc.im * x.re), complex(0))
}

export function roots(coefficients: readonly number[]): Complex[] {
  const monic = coefficients.map((c) => c / coefficients[0])
  const degree = monic.length - 1
  const bound = 2 * Math.max(...monic.slice(1).map((c, k) => Math.abs(c) ** (1 / (k + 1))))
  const found = Array.from({ length: degree }, (_, k) => {
    const angle = (2 * Math.PI * k) / degree + 0.4
    return complex(0.5 * bound * Math.cos(angle), 0.5 * bound * Math.sin(angle))
  })
  for (let iteration = 0; iteration < 1000; iteration++) {
    let largestStep = 0
    for (let i = 0; i < degree; i++) {
      const others = found.reduce((product, y, j) => (j === i ? product : times(product, minus(found[i], y))), complex(1))
      const step = over(valueAt(monic, found[i]), others)
      found[i] = minus(found[i], step)
      largestStep = Math.max(largestStep, magnitude(step) / Math.max(magnitude(found[i]), 1e-300))
    }
    if (largestStep < 1e-15) break
  }
  return found
}

export function leftHalfPlaneSquareRoot(u: Complex): Complex {
  const r = magnitude(u)
  const re = Math.sqrt(Math.max(0, (r + u.re) / 2))
  const im = Math.sign(u.im || 1) * Math.sqrt(Math.max(0, (r - u.re) / 2))
  return re > 0 ? complex(-re, -im) : complex(re, im)
}

export function realQuadratics(zeros: readonly Complex[]): [number, number][] {
  const scale = Math.max(...zeros.map(magnitude), 1e-300)
  const isReal = (z: Complex) => Math.abs(z.im) <= 1e-9 * scale
  const upper = zeros.filter((z) => !isReal(z) && z.im > 0)
  const real = zeros.filter(isReal).map((z) => z.re).sort((a, b) => a - b)
  if (real.length % 2 !== 0 || 2 * upper.length + real.length !== zeros.length) throw new Error("zeros do not come in conjugate pairs")
  const pairs: [number, number][] = upper.map((z) => [-2 * z.re, z.re * z.re + z.im * z.im])
  for (let k = 0; k < real.length; k += 2) pairs.push([-(real[k] + real[k + 1]), real[k] * real[k + 1]])
  return pairs
}

export function exp(a: Complex): Complex {
  const m = Math.exp(a.re)
  return complex(m * Math.cos(a.im), m * Math.sin(a.im))
}

export function quadraticRoots(b1: number, b0: number): [Complex, Complex] {
  const discriminant = b1 * b1 - 4 * b0
  if (discriminant >= 0) {
    const r = Math.sqrt(discriminant)
    return [complex((-b1 + r) / 2), complex((-b1 - r) / 2)]
  }
  const i = Math.sqrt(-discriminant) / 2
  return [complex(-b1 / 2, i), complex(-b1 / 2, -i)]
}
