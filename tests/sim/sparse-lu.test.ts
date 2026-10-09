import { describe, expect, it } from "vitest"
import { SparseLU } from "@/sim/sparse-lu"

function denseSolve(A: Float64Array, b: Float64Array): Float64Array {
  const n = b.length
  const m = Array.from({ length: n }, (_, r) => [...A.subarray(r * n, r * n + n), b[r]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    ;[m[c], m[p]] = [m[p], m[c]]
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n]
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k]
    x[r] = s / m[r][r]
  }
  return x
}

function solveWith(lu: SparseLU, A: Float64Array, b: Float64Array) {
  lu.register(A)
  expect(lu.factorize(A), "factorized").toBe(true)
  const x = new Float64Array(b.length)
  expect(lu.solve(Float64Array.from(b), x), "solved").toBe(true)
  return x
}

function expectSame(got: Float64Array, want: Float64Array, rel = 1e-10) {
  const scale = Math.max(...want.map(Math.abs))
  for (let i = 0; i < want.length; i++) expect.soft(got[i], `x[${i}]`).toBeNear(want[i], rel * scale)
}

function expectBackwardStable(A: Float64Array, x: Float64Array, b: Float64Array) {
  const n = b.length
  const size = Math.max(...A.map(Math.abs)) * Math.max(...x.map(Math.abs))
  for (let r = 0; r < n; r++) {
    let residual = -b[r]
    for (let c = 0; c < n; c++) residual += A[r * n + c] * x[c]
    expect.soft(residual, `residual of row ${r}`).toBeNear(0, 1e-13 * size)
  }
}

function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function ladder(n: number, rand: () => number) {
  const A = new Float64Array(n * n)
  const stamp = (a: number, b: number, g: number) => {
    A[a * n + a] += g
    if (b >= 0) {
      A[b * n + b] += g
      A[a * n + b] -= g
      A[b * n + a] -= g
    }
  }
  for (let i = 0; i < n; i++) stamp(i, i + 1 < n ? i + 1 : -1, 10 ** (rand() * 6 - 3))
  for (let k = 0; k < n / 2; k++) stamp(Math.floor(rand() * n), Math.floor(rand() * n), 10 ** (rand() * 6 - 3))
  return A
}

describe("sparse LU against dense Gaussian elimination", () => {
  it("solves random conductance networks of 5 to 120 nodes as well as dense elimination does", () => {
    const rand = random(7)
    for (const n of [5, 12, 30, 53, 120]) {
      const A = ladder(n, rand)
      const b = Float64Array.from({ length: n }, () => rand() - 0.5)
      const x = solveWith(new SparseLU(n), A, b)
      expectBackwardStable(A, x, b)
      expectSame(x, denseSolve(A, b), 1e-8)
    }
  })

  it("solves an MNA system whose voltage-source branch row has a zero diagonal", () => {
    const n = 3
    const at = (r: number, c: number) => r * n + c
    const A = new Float64Array(n * n)
    const g1 = 1 / 1e3
    const g2 = 1 / 2.2e3
    A[at(0, 0)] = g1
    A[at(0, 1)] = -g1
    A[at(1, 0)] = -g1
    A[at(1, 1)] = g1 + g2
    A[at(0, 2)] = 1
    A[at(2, 0)] = 1
    const b = Float64Array.from([0, 0, 5])
    const x = solveWith(new SparseLU(n), A, b)
    expect(x[0], "V(source)").toBeNear(5, 1e-12)
    expect(x[1], "divider").toBeNear((5 * g1) / (g1 + g2), 1e-12)
    expect(x[2], "source current").toBeNear(-5 / 3.2e3, 1e-15)
  })

  it("keeps its pivot order while the values move and stays exact", () => {
    const rand = random(11)
    const n = 40
    const lu = new SparseLU(n)
    const base = ladder(n, rand)
    for (let step = 0; step < 50; step++) {
      const A = base.map((v, i) => (v === 0 ? 0 : v * (1 + 0.05 * Math.sin(step + i))))
      const b = Float64Array.from({ length: n }, () => rand() - 0.5)
      const x = solveWith(lu, A, b)
      expectBackwardStable(A, x, b)
      expectSame(x, denseSolve(A, b), 1e-8)
    }
    expect(lu.orderings, "one ordering for fifty factorizations").toBe(1)
  })

  it("orders again when a stored pivot collapses against its column", () => {
    const n = 3
    const A = Float64Array.from([4, 1, 0, 1, 3, 1, 0, 1, 2])
    const lu = new SparseLU(n)
    const b = Float64Array.from([1, 2, 3])
    expectSame(solveWith(lu, A, b), denseSolve(A, b))
    const collapsed = Float64Array.from([1e-9, 1, 0, 1, 3, 1, 0, 1, 2])
    expectSame(solveWith(lu, collapsed, b), denseSolve(collapsed, b))
    expect(lu.orderings, "reordered on the collapsed pivot").toBe(2)
  })

  it("orders again when a stamp lands outside the pattern it knows", () => {
    const n = 4
    const at = (r: number, c: number) => r * n + c
    const A = Float64Array.from([2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2, -1, 0, 0, -1, 2])
    const lu = new SparseLU(n)
    const b = Float64Array.from([1, 0, 0, 1])
    expectSame(solveWith(lu, A, b), denseSolve(A, b))
    const closed = Float64Array.from(A)
    closed[at(0, 3)] -= 0.5
    closed[at(3, 0)] -= 0.5
    closed[0] += 0.5
    closed[15] += 0.5
    expectSame(solveWith(lu, closed, b), denseSolve(closed, b))
    expect(lu.orderings, "reordered for the new entries").toBe(2)
    expectSame(solveWith(lu, A, b), denseSolve(A, b))
    expect(lu.orderings, "the open switch is a zero inside the known pattern").toBe(2)
  })

  it("reports a singular matrix instead of solving it", () => {
    const n = 2
    const lu = new SparseLU(n)
    const singular = Float64Array.from([1, 1, 1, 1])
    lu.register(singular)
    expect(lu.factorize(singular)).toBe(false)
    expect(lu.solve(Float64Array.from([1, 1]), new Float64Array(n))).toBe(false)
    expectSame(solveWith(lu, Float64Array.from([1, 1, 1, 2]), Float64Array.from([1, 2])), Float64Array.from([0, 1]))
  })
})
