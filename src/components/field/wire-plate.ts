import type { Run } from "@/schematic/circuit"
import { toPath, trimRouteEnds, type Point, type RoutedWire } from "@/schematic/geometry"
import { runPath } from "@/schematic/wire-look"

export type WirePlate = { readonly key: string; readonly run: string; readonly d: string; readonly casing: string; readonly whole: boolean; readonly start: boolean; readonly end: boolean }

type Step = { readonly to: Point; readonly control?: Point }

export type Share = { readonly from: Point; readonly steps: readonly Step[] }

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y
const halfway = (p: Point, q: Point): Point => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 })

const COMMAND = /[MLQ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

function parsed(d: string): Share | null {
  const tokens = d.match(COMMAND)
  if (!tokens || tokens[0] !== "M") return null
  const at = (i: number): Point => ({ x: Number(tokens[i]), y: Number(tokens[i + 1]) })
  const from = at(1)
  const steps: Step[] = []
  for (let i = 3; i < tokens.length; ) {
    const command = tokens[i]
    if (command === "L") {
      steps.push({ to: at(i + 1) })
      i += 3
    } else if (command === "Q") {
      steps.push({ control: at(i + 1), to: at(i + 3) })
      i += 5
    } else return null
  }
  return { from, steps }
}

export function segmentShares(d: string, pts: readonly Point[]): Share[] | null {
  const path = parsed(d)
  if (!path || pts.length < 2) return null
  const last = pts.length - 2
  const shares: { from: Point; steps: Step[] }[] = [{ from: path.from, steps: [] }]
  let at = path.from
  for (const step of path.steps) {
    const k = shares.length - 1
    const vertex = k < last ? pts[k + 1] : null
    if (vertex && step.control && same(step.control, vertex)) {
      const a = halfway(at, step.control)
      const b = halfway(step.control, step.to)
      const middle = halfway(a, b)
      shares[k].steps.push({ control: a, to: middle })
      shares.push({ from: middle, steps: [{ control: b, to: step.to }] })
    } else if (vertex && !step.control && same(step.to, vertex)) {
      shares[k].steps.push(step)
      shares.push({ from: step.to, steps: [] })
    } else shares[k].steps.push(step)
    at = step.to
  }
  return shares.length === last + 1 ? shares : null
}

export function sharePath(shares: readonly Share[]): string {
  if (!shares.length) return ""
  const out = [`M${shares[0].from.x} ${shares[0].from.y}`]
  for (const share of shares)
    for (const { to, control } of share.steps) out.push(control ? `Q${control.x} ${control.y} ${to.x} ${to.y}` : `L${to.x} ${to.y}`)
  return out.join(" ")
}

function chainsOf(run: Run, selected: ReadonlySet<string>): [number, number][] {
  const chains: [number, number][] = []
  run.segments.forEach((s, i) => {
    if (!selected.has(s.id)) return
    const open = chains.at(-1)
    if (open && open[1] === i - 1) open[1] = i
    else chains.push([i, i])
  })
  return chains
}

const alongPoints = (run: Run, pts: readonly Point[]) =>
  run.segments.length === pts.length - 1 && run.segments.every((s, i) => (same(s.a, pts[i]) && same(s.b, pts[i + 1])) || (same(s.b, pts[i]) && same(s.a, pts[i + 1])))

export function plateOf(run: Run, route: RoutedWire, selected: ReadonlySet<string>, radius: number, trim: number): WirePlate[] {
  const chains = chainsOf(run, selected)
  if (!chains.length) return []
  const pts = route.pts
  const drawn = runPath(pts, radius, route.leads)
  const trimmed = trimRouteEnds(pts, trim)
  const casing = toPath(trimmed, radius)
  const last = run.segments.length - 1
  const whole: WirePlate = { key: run.id, run: run.id, d: drawn, casing, whole: true, start: true, end: true }
  if (chains.length === 1 && chains[0][0] === 0 && chains[0][1] === last) return [whole]
  const plates = alongPoints(run, pts) ? segmentShares(drawn, pts) : null
  const casings = plates && segmentShares(casing, trimmed)
  if (!plates || !casings) return [whole]
  return chains.map(([first, end]) => ({ key: run.segments[first].id, run: run.id, d: sharePath(plates.slice(first, end + 1)), casing: sharePath(casings.slice(first, end + 1)), whole: false, start: first === 0, end: end === last }))
}

export function wirePlates(runs: Iterable<Run>, routeOf: (run: string) => RoutedWire | undefined, selected: ReadonlySet<string>, radius: number, trim: number): WirePlate[] {
  const plates: WirePlate[] = []
  for (const run of runs) {
    const route = routeOf(run.id)
    if (route) plates.push(...plateOf(run, route, selected, radius, trim))
  }
  return plates
}
