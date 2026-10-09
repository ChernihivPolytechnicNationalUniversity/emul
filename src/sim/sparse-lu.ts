const PIVOT_RATIO = 1e-3
const PIVOT_FLOOR = 1e-18

const acceptable = (pivot: number, largest: number) => Math.abs(pivot) > PIVOT_FLOOR && Math.abs(pivot) >= PIVOT_RATIO * largest

export class SparseLU {
  private readonly n: number
  private readonly lu: Float64Array
  private readonly seen: Uint8Array
  private readonly fill: Uint8Array
  private readonly pivotRow: Int32Array
  private readonly pivotCol: Int32Array
  private readonly lowerStart: Int32Array
  private readonly upperStart: Int32Array
  private readonly lower: Int32Array
  private readonly upper: Int32Array
  private readonly rowLeft: Uint8Array
  private readonly colLeft: Uint8Array
  private readonly rowCount: Int32Array
  private readonly colCount: Int32Array
  private readonly entries: Int32Array
  private entryCount = 0
  private ordered = false
  private grew = false
  valid = false
  orderings = 0

  constructor(n: number) {
    this.n = n
    this.lu = new Float64Array(n * n)
    this.seen = new Uint8Array(n * n)
    this.fill = new Uint8Array(n * n)
    this.pivotRow = new Int32Array(n)
    this.pivotCol = new Int32Array(n)
    this.lowerStart = new Int32Array(n + 1)
    this.upperStart = new Int32Array(n + 1)
    this.lower = new Int32Array(n * n)
    this.upper = new Int32Array(n * n)
    this.rowLeft = new Uint8Array(n)
    this.colLeft = new Uint8Array(n)
    this.rowCount = new Int32Array(n)
    this.colCount = new Int32Array(n)
    this.entries = new Int32Array(n * n)
  }

  touch(cell: number) {
    if (this.seen[cell] !== 0) return
    this.seen[cell] = 1
    this.grew = true
  }

  register(A: Float64Array) {
    for (let i = 0; i < A.length; i++) if (A[i] !== 0) this.touch(i)
  }

  factorize(A: Float64Array): boolean {
    this.valid = (this.ordered && !this.grew && this.refactor(A)) || this.order(A)
    return this.valid
  }

  solve(z: Float64Array, x: Float64Array): boolean {
    if (!this.valid) return false
    const { n, lu, pivotRow, pivotCol, lowerStart, upperStart, lower, upper } = this
    for (let k = 0; k < n; k++) {
      const b = z[pivotRow[k]]
      if (b === 0) continue
      const c = pivotCol[k]
      for (let j = lowerStart[k]; j < lowerStart[k + 1]; j++) z[lower[j]] -= lu[lower[j] * n + c] * b
    }
    for (let k = n - 1; k >= 0; k--) {
      const row = pivotRow[k] * n
      let s = z[pivotRow[k]]
      for (let q = upperStart[k]; q < upperStart[k + 1]; q++) s -= lu[row + upper[q]] * x[upper[q]]
      x[pivotCol[k]] = s / lu[row + pivotCol[k]]
    }
    return true
  }

  private refactor(A: Float64Array): boolean {
    const { n, lu, pivotRow, pivotCol, lowerStart, lower, entries } = this
    for (let k = 0; k < this.entryCount; k++) lu[entries[k]] = A[entries[k]]
    for (let k = 0; k < n; k++) {
      const c = pivotCol[k]
      const pivot = lu[pivotRow[k] * n + c]
      let largest = Math.abs(pivot)
      for (let j = lowerStart[k]; j < lowerStart[k + 1]; j++) largest = Math.max(largest, Math.abs(lu[lower[j] * n + c]))
      if (!acceptable(pivot, largest)) return false
      this.eliminate(k, pivot)
    }
    return true
  }

  private order(A: Float64Array): boolean {
    const { n, lu, fill, pivotRow, pivotCol, lowerStart, upperStart, lower, upper, rowLeft, colLeft, rowCount, colCount } = this
    this.orderings++
    this.ordered = false
    this.grew = false
    lu.set(A)
    fill.set(this.seen)
    rowLeft.fill(1)
    colLeft.fill(1)
    let lowerEnd = 0
    let upperEnd = 0
    lowerStart[0] = 0
    upperStart[0] = 0
    for (let k = 0; k < n; k++) {
      rowCount.fill(0)
      colCount.fill(0)
      for (let r = 0; r < n; r++) {
        if (!rowLeft[r]) continue
        for (let c = 0; c < n; c++) {
          if (!colLeft[c] || !fill[r * n + c]) continue
          rowCount[r]++
          colCount[c]++
        }
      }
      const chosen = this.choosePivot(true) ?? this.choosePivot(false)
      if (!chosen) return false
      const [bestRow, bestCol] = chosen
      pivotRow[k] = bestRow
      pivotCol[k] = bestCol
      rowLeft[bestRow] = 0
      colLeft[bestCol] = 0
      for (let r = 0; r < n; r++) if (rowLeft[r] && fill[r * n + bestCol]) lower[lowerEnd++] = r
      for (let c = 0; c < n; c++) if (colLeft[c] && fill[bestRow * n + c]) upper[upperEnd++] = c
      lowerStart[k + 1] = lowerEnd
      upperStart[k + 1] = upperEnd
      for (let j = lowerStart[k]; j < lowerEnd; j++) for (let q = upperStart[k]; q < upperEnd; q++) fill[lower[j] * n + upper[q]] = 1
      this.eliminate(k, lu[bestRow * n + bestCol])
    }
    this.entryCount = 0
    for (let i = 0; i < fill.length; i++) if (fill[i]) this.entries[this.entryCount++] = i
    this.ordered = true
    return true
  }

  private choosePivot(onDiagonal: boolean): [number, number] | null {
    const { n, lu, rowLeft, colLeft, rowCount, colCount } = this
    let best: [number, number] | null = null
    let bestCost = Infinity
    let bestShare = 0
    for (let c = 0; c < n; c++) {
      if (!colLeft[c]) continue
      let largest = 0
      for (let r = 0; r < n; r++) if (rowLeft[r]) largest = Math.max(largest, Math.abs(lu[r * n + c]))
      for (let r = onDiagonal ? c : 0; r < (onDiagonal ? c + 1 : n); r++) {
        if (!rowLeft[r]) continue
        const a = lu[r * n + c]
        if (!acceptable(a, largest)) continue
        const cost = (rowCount[r] - 1) * (colCount[c] - 1)
        const share = Math.abs(a) / largest
        if (cost < bestCost || (cost === bestCost && share > bestShare)) {
          best = [r, c]
          bestCost = cost
          bestShare = share
        }
      }
    }
    return best
  }

  private eliminate(k: number, pivot: number) {
    const { n, lu, pivotRow, pivotCol, lowerStart, upperStart, lower, upper } = this
    const top = pivotRow[k] * n
    const c = pivotCol[k]
    const u0 = upperStart[k]
    const u1 = upperStart[k + 1]
    for (let j = lowerStart[k]; j < lowerStart[k + 1]; j++) {
      const row = lower[j] * n
      const f = lu[row + c] / pivot
      lu[row + c] = f
      if (f === 0) continue
      for (let q = u0; q < u1; q++) lu[row + upper[q]] -= f * lu[top + upper[q]]
    }
  }
}
