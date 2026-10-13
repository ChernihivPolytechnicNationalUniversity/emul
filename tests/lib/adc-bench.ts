import { readFileSync } from "node:fs"
import { join } from "node:path"

export type BenchPath = "vrefint" | "pa4"

const ROWS = readFileSync(join(import.meta.dirname, "..", "data", "open746-bench", "adc-dac-2026-10-06.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [dacCode, channel, sample, code] = line.split(",")
    return { dacCode: Number(dacCode), channel: channel as BenchPath, sample: Number(sample), code: Number(code) }
  })

export const BENCH_DAC_CODES = [...new Set(ROWS.map((r) => r.dacCode))].sort((a, b) => a - b)
export const BENCH_RAIL_CODES = [0, 4095]

export function benchCodes(path: BenchPath, dacCode: number): number[] {
  return ROWS.filter((r) => r.channel === path && r.dacCode === dacCode).map((r) => r.code)
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function quantile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function benchResiduals(path: BenchPath): number[] {
  const levels = path === "pa4" ? BENCH_DAC_CODES.filter((c) => !BENCH_RAIL_CODES.includes(c)) : BENCH_DAC_CODES
  return levels.flatMap((level) => {
    const codes = benchCodes(path, level)
    const m = median(codes)
    return codes.map((c) => c - m)
  })
}

export const BENCH_SINGLE_READING_SPREAD_LSB = Math.max(...benchResiduals("vrefint").map(Math.abs))
