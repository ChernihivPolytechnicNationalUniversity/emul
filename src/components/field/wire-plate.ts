import type { Run } from "@/schematic/circuit"
import type { Point, RoutedWire } from "@/schematic/geometry"
import { runPath } from "@/schematic/wire-look"
import { SELECTION_BANDS } from "./selection-geometry"
import { SELECTED_WIRE_PX } from "./wire-style"

export type PlateNotch = { readonly at: Point; readonly out: Point; readonly across?: Axis }

export type Axis = "x" | "y"

export type MeetsAt = (at: Point) => Axis | null

export type WirePlate = { readonly key: string; readonly run: string; readonly d: string; readonly whole: boolean; readonly caps: readonly Point[]; readonly notches: readonly PlateNotch[]; readonly box: PlateBox }

export type PlateBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export const PLATE_REACH = (SELECTED_WIRE_PX + 2 * Math.max(...SELECTION_BANDS.map((band) => band.margin))) / 2 + 1

export type OpenEnd = (at: Point) => boolean

const NOWHERE_OPEN: OpenEnd = () => false

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

function boxAround(points: readonly Point[], margin: number): PlateBox {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs) - margin
  const y = Math.min(...ys) - margin
  return { x, y, w: Math.max(...xs) + margin - x, h: Math.max(...ys) + margin - y }
}

function slantedEnd(at: Point, from: Point, meets: MeetsAt): PlateNotch | null {
  const out = { x: Math.sign(at.x - from.x), y: Math.sign(at.y - from.y) }
  if (out.x === 0 || out.y === 0) return null
  const across = meets(at)
  return across ? { at, out, across } : { at, out }
}

const MEETS_NOTHING_KNOWN: MeetsAt = () => null

export function plateOf(run: Run, route: RoutedWire, selected: ReadonlySet<string>, radius: number, open: OpenEnd = NOWHERE_OPEN, meets: MeetsAt = MEETS_NOTHING_KNOWN): WirePlate[] {
  const chains = chainsOf(run, selected)
  if (!chains.length) return []
  const pts = route.pts
  const drawn = runPath(pts, radius, route.leads)
  const last = run.segments.length - 1
  const first = pts[0]
  const final = pts[pts.length - 1]
  const startOpen = !route.leads?.start && open(first)
  const endOpen = !route.leads?.end && open(final)
  const capsOf = (start: boolean, end: boolean) => [...(start && startOpen ? [first] : []), ...(end && endOpen ? [final] : [])]
  const startNotch = !route.leads?.start && !startOpen && pts.length > 1 ? slantedEnd(first, pts[1], meets) : null
  const endNotch = !route.leads?.end && !endOpen && pts.length > 1 ? slantedEnd(final, pts[pts.length - 2], meets) : null
  const notchesOf = (start: boolean, end: boolean) => [...(start && startNotch ? [startNotch] : []), ...(end && endNotch ? [endNotch] : [])]
  const box = boxAround([...pts, ...(route.leads?.start ? [route.leads.start] : []), ...(route.leads?.end ? [route.leads.end] : [])], 2 * PLATE_REACH)
  const whole: WirePlate = { key: run.id, run: run.id, d: drawn, whole: true, caps: capsOf(true, true), notches: notchesOf(true, true), box }
  if (chains.length === 1 && chains[0][0] === 0 && chains[0][1] === last) return [whole]
  const plates = alongPoints(run, pts) ? segmentShares(drawn, pts) : null
  if (!plates) return [whole]
  return chains.map(([from, to]) => ({ key: run.segments[from].id, run: run.id, d: sharePath(plates.slice(from, to + 1)), whole: false, caps: capsOf(from === 0, to === last), notches: notchesOf(from === 0, to === last), box }))
}

export function notchPath(notches: readonly PlateNotch[], reach: number, everywhere: PlateBox): string {
  const square = (x0: number, y0: number, x1: number, y1: number) => `M${x0} ${y0} H${x1} V${y1} H${x0} Z`
  const { x, y, w, h } = everywhere
  return [
    square(x, y, x + w, y + h),
    ...notches.flatMap(({ at, out, across }) =>
      across === "x"
        ? [square(at.x - reach, at.y, at.x + reach, at.y + out.y * reach)]
        : across === "y"
          ? [square(at.x, at.y - reach, at.x + out.x * reach, at.y + reach)]
          : [square(at.x - reach, at.y - reach, at.x + reach, at.y + reach), square(at.x, at.y, at.x - out.x * reach, at.y - out.y * reach)],
    ),
  ].join(" ")
}

export function wirePlates(runs: Iterable<Run>, routeOf: (run: string) => RoutedWire | undefined, selected: ReadonlySet<string>, radius: number, open: OpenEnd = NOWHERE_OPEN, meets: MeetsAt = MEETS_NOTHING_KNOWN): WirePlate[] {
  const plates: WirePlate[] = []
  for (const run of runs) {
    const route = routeOf(run.id)
    if (route) plates.push(...plateOf(run, route, selected, radius, open, meets))
  }
  return plates
}
