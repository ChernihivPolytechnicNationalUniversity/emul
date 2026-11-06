import { Buckets, KeptChecker } from "./checker"
import { GRID, routeBox, touches, type Rect, type RoutedWire } from "./geometry"
import { translationOf } from "./pin-index"
import type { Schematic } from "./types"
import { autoNetColor, type WireColorKey } from "./wire-colors"
import { wireOrder, type Wiring } from "./wire-edits"

const colours = new WeakMap<object, WireColorKey>()

export class FieldState {
  private readonly routes = new Buckets<RoutedWire>(32 * GRID)
  private readonly byId = new Map<string, RoutedWire>()
  private wiring: Wiring | undefined
  private readonly checker = new KeptChecker()
  private visibleCache: { view: Rect; wiring: Wiring; routes: readonly RoutedWire[] } | undefined

  commit(doc: Schematic, wiring: Wiring) {
    const prior = this.wiring
    let contiguous = false
    if (this.wiring !== wiring) {
      const previous = this.wiring?.source
      const from = wiring.changes?.from
      const shift = translationOf(doc.objects, doc.wires)
      contiguous = !!previous && this.wiring!.graph === wiring.graph && this.wiring!.index.version === wiring.index.version && (
        (previous.objects === from?.objects && previous.wires === from.wires) ||
        (shift?.from === previous.objects && shift.fromWires === previous.wires) ||
        (previous.objects === doc.objects && previous.wires === doc.wires)
      )
      if (!contiguous) {
        this.routes.clear()
        this.byId.clear()
      }
      for (const id of wiring.removedRoutes) {
        const old = this.byId.get(id)
        if (old) {
          this.routes.remove(routeBox(old), old)
          this.byId.delete(id)
        }
      }
      for (const route of contiguous ? wiring.changedRoutes : wiring.routes) {
        const old = this.byId.get(route.id)
        if (old) this.routes.remove(routeBox(old), old)
        this.byId.set(route.id, route)
        this.routes.add(routeBox(route), route)
      }
      this.wiring = wiring
    }
    const index = wiring.index.spatial
    const order = wireOrder(doc.wires)
    const circuit = wiring.circuit
    const checking = performance.now()
    const findings = this.checker.update(doc, wiring)
    const checkedIn = performance.now() - checking
    const autoColor = {
      get: (net: string): WireColorKey => {
        const token = wiring.view.token(net)
        const cached = token && colours.get(token)
        if (cached) return cached
        const colour = autoNetColor(wiring.nets.kindsOf(net))
        if (token) colours.set(token, colour)
        return colour
      },
    }
    const visible = (view: Rect) => {
      const cached = this.visibleCache
      const sameView = cached && cached.view.x === view.x && cached.view.y === view.y && cached.view.w === view.w && cached.view.h === view.h
      if (sameView && cached.wiring === wiring) return { objects: index.query(view), routes: cached.routes }
      let routes: readonly RoutedWire[]
      if (sameView && contiguous && cached.wiring === prior) {
        const replaced = new Set([...wiring.removedRoutes, ...wiring.changedRoutes.map((route) => route.id)])
        routes = [...cached.routes.filter((route) => !replaced.has(route.id)), ...wiring.changedRoutes.filter((route) => touches(routeBox(route), view))]
      } else routes = [...this.routes.near(view)].filter((route) => touches(routeBox(route), view))
      const ranked = routes.map((route) => {
        const run = wiring.runById.get(route.id)!
        if (!run.segments[0].color) {
          const net = wiring.nets.netOfWire(route.id)
          if (net !== undefined) autoColor.get(net)
        }
        return { route, rank: Math.min(...run.segments.map((segment) => order.get(segment)!)) }
      })
      ranked.sort((a, b) => a.rank - b.rank)
      const ordered = ranked.map((item) => item.route)
      this.visibleCache = { view: { ...view }, wiring, routes: ordered }
      return { objects: index.query(view), routes: ordered }
    }
    return { index, circuit, findings, checkedIn, autoColor, visible }
  }
}
