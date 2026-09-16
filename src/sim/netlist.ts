import { GRID, pinContacts } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { pinKey, type Damage, type Element, type Limits, type NodeRef, type PlacedObject, type Schematic, type Value } from "@/schematic/types"
import { parseValue } from "./units"

/** Net index; GROUND is the reference node and has no matrix row. */
export const GROUND = -1

export type ResolvedLimits = { power?: number; current?: number; voltage?: number; reverse?: number; fail: "open" | "short"; fatal: boolean }

/** Common to every solved element: owner object, model element index, display ref, ratings. `hidden` keeps it out of the inspector. */
type Base = { id: string; object: string; element: number; ref: string; limits?: ResolvedLimits; hidden?: boolean }

/** `keys` are the node keys ("objectId:pinId") of the terminals, in the order listed per kind. */
export type Resolved =
  /** An R with `live` takes its value from the pin reader on every step (see `Element`). */
  | (Base & { kind: "R" | "C" | "L"; a: number; b: number; value: number; live?: string; keys: [string, string] })
  /** `amplitude` is 0 for a DC source. */
  | (Base & { kind: "V"; plus: number; minus: number; value: number; amplitude: number; frequency: number; phase: number; shape: "sine" | "pulse"; duty: number; index: number; keys: [string, string] })
  /** `index` is the extra unknown (secondary current) like a source's. */
  | (Base & { kind: "XFMR"; p1: number; p2: number; s1: number; s2: number; ratio: number; index: number; keys: [string, string, string, string] })
  | (Base & { kind: "D"; anode: number; cathode: number; is: number; n: number; zener?: number; part?: string; keys: [string, string] })
  /** With `rc`, `c` is an internal node behind the collector resistance and `cPin` the pin's net; readings report pin to pin. */
  | (Base & { kind: "Q"; polarity: 1 | -1; b: number; c: number; e: number; beta: number; cPin: number; keys: [string, string, string] })
  | (Base & { kind: "M"; polarity: 1 | -1; g: number; d: number; s: number; vth: number; k: number; lambda: number; keys: [string, string, string] })
  /** `ron` is the contact resistance; `strike` the voltage the open gap arcs over at (Infinity for an ideal switch). */
  | (Base & { kind: "SW"; a: number; b: number; part: string; closed: "on" | "pressed" | "off"; ron: number; strike: number; keys: [string, string] })
  /** MCU pad; what it drives is read live from the pin reader on every step. `vddNet` is the rail it switches to, when it has one. */
  | (Base & { kind: "GPIO"; node: number; nodeKey: string; vdd: number; vddNet: number | undefined; keys: [string] | [string, string] })
  /** `index` is the extra unknown (through current, in → out) like a source's. */
  | (Base & { kind: "REG"; in: number; out: number; gnd: number; value: number; dropout: number; imax: number; index: number; keys: [string, string] })

/**
 * What an MCU pad presents to the net: the push-pull driver, the weak internal pull, or
 * nothing at all (input, analog, released open-drain).
 */
/** What a pad drives: a logic driver, a weak pull, a sourced voltage (DAC output, volts), or nothing. */
export type GpioState = "high" | "low" | "pullup" | "pulldown" | number | null

export type Netlist = {
  /** Number of non-ground nodes. */
  nodes: number
  /** Number of voltage sources and transformers (extra MNA unknowns). */
  sources: number
  elements: Resolved[]
  /** pinKey -> net index, for every pin that belongs to a solved net. */
  pinNet: Map<string, number>
  /** Node keys tied to the reference node by GND elements (current sinks for wire flow). */
  groundKeys: Set<string>
  /** Pins joined by touching another pin rather than by a wire, keyed to their group. */
  contacts: Map<string, string>
}

const VT = 0.025852
/** Contact resistance of a switch that does not state its own. */
const SW_RON = 0.05
/**
 * Voltage at which the open gap of a small switch arcs over: the Paschen minimum for air is
 * ~330 V, and a snap-action contact opens a fraction of a millimetre — an inductive load
 * pushed past this keeps its current flowing through an arc instead of a clean break.
 */
const SW_STRIKE = 300
/** Test current at which a zener's nameplate voltage is specified (5 mA on small parts' datasheets). */
const ZENER_IZT = 5e-3

/** Shockley saturation current so that the diode drops `vf` at 10 mA with emission coefficient n. */
export function saturationCurrent(vf: number, n: number) {
  return 0.01 / (Math.exp(vf / (n * VT)) - 1)
}

/**
 * Breakdown is modelled as a mirrored junction, so it conducts ~0.7 V past its offset. The
 * offset is therefore set below the nameplate voltage by the junction drop at the test
 * current, and the part reads its rated voltage where the datasheet measured it.
 */
export function zenerOffset(vz: number, is: number, n: number) {
  return vz - n * VT * Math.log(ZENER_IZT / is + 1)
}

class UnionFind {
  private parent = new Map<string, string>()
  find(k: string): string {
    let p = this.parent.get(k)
    if (p === undefined) {
      this.parent.set(k, k)
      return k
    }
    if (p !== k) {
      p = this.find(p)
      this.parent.set(k, p)
    }
    return p
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

const GND_KEY = "\0gnd"

function resolveValue(v: Value, props: Record<string, string>): number {
  if (typeof v === "number") return v
  if (typeof v === "function") return v(props)
  const text = v.replace(/\{(\w+)\}/g, (_, k: string) => props[k] ?? "")
  return parseValue(text)
}

/**
 * Nets are formed by wires, component-internal SHORTs and GND elements. Only nets touched by a
 * conducting element get a matrix node; everything else is high impedance and reads 0 V.
 */
function resolveLimits(l: Limits | undefined, props: Record<string, string>): ResolvedLimits | undefined {
  if (!l) return undefined
  const num = (v: Value | undefined) => {
    if (v === undefined) return undefined
    const n = resolveValue(v, props)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return { power: num(l.power), current: num(l.current), voltage: num(l.voltage), reverse: num(l.reverse), fail: l.fail ?? "open", fatal: l.fatal ?? true }
}

/** The two nodes a shorted element bridges: a fried junction, welded contacts, a punched-through dielectric. */
function shortPair(el: Element): [NodeRef, NodeRef] | null {
  switch (el.kind) {
    case "R":
    case "C":
    case "L":
    case "SW":
      return [el.a, el.b]
    case "V":
      return [el.plus, el.minus]
    case "D":
      return [el.anode, el.cathode]
    case "Q":
      return [el.c, el.e]
    case "M":
      return [el.d, el.s]
    case "REG":
      return [el.in, el.out]
    // A pad's blown protection diode ties it to the rail it clamped to; without a rail node
    // there is nothing to short to and the driver is simply gone.
    case "GPIO":
      return el.vddNode ? [el.node, el.vddNode] : null
    default:
      return null
  }
}

/**
 * What a damaged object's element becomes. A broken element is dropped (open) or replaced by
 * a near-short; a fatal failure takes every other element with it, and the part's supply
 * element — a die that let the smoke out — becomes a short across the rails. Non-fatal
 * damage leaves the rest of the part working.
 */
function damaged(el: Element, index: number, dmg: Damage | undefined): Element | null {
  if (!dmg) return el
  if (el.kind === "SHORT" || el.kind === "GND") return el
  const hit = dmg.element === index ? dmg : dmg.also?.find((d) => d.element === index)
  if (hit) {
    if (hit.fail === "open") return null
    const pair = shortPair(el)
    return pair ? { kind: "R", a: pair[0], b: pair[1], value: 0.01 } : null
  }
  if (!dmg.fatal) return el
  if (el.kind === "R" && el.supply) return { kind: "R", a: el.a, b: el.b, value: 0.01 }
  return null
}

/**
 * Turn the schematic into nets and solver elements. `watched` are pin keys something is
 * looking at (oscilloscope probes): an MCU pad on such a net is solved even with nothing
 * else attached, so a bare pin can be probed.
 */
export function buildNetlist(doc: Schematic, damage: Record<string, Damage> = {}, grid = GRID, watched: Iterable<string> = []): Netlist {
  const uf = new UnionFind()
  const node = (obj: PlacedObject, ref: string) => `${obj.id}:${ref}`

  for (const w of doc.wires) uf.union(pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin))
  // Pins placed on top of each other are the same conductor, wire or no wire.
  const contacts = pinContacts(doc.objects, grid)
  for (const [key, root] of contacts) uf.union(key, root)

  type Pending = { obj: PlacedObject; el: Element; index: number; props: Record<string, string> }
  const pending: Pending[] = []
  const groundKeys = new Set<string>()
  for (const obj of doc.objects) {
    const def = getDef(obj.def)
    if (!def?.model) continue
    const props = { ...def.defaults, ...obj.props }
    def.model.forEach((raw, index) => {
      const el = damaged(raw, index, damage[obj.id])
      if (!el) return
      if (el.kind === "SHORT") {
        for (let i = 1; i < el.nodes.length; i++) uf.union(node(obj, el.nodes[0]), node(obj, el.nodes[i]))
      } else if (el.kind === "GND") {
        uf.union(node(obj, el.node), GND_KEY)
        groundKeys.add(node(obj, el.node))
      } else {
        pending.push({ obj, el, index, props })
      }
    })
  }

  // Nets that need a matrix row: touched by a conducting element.
  const active = new Set<string>()
  const touch = (obj: PlacedObject, ref: string) => active.add(uf.find(node(obj, ref)))
  let firstMinus: string | null = null
  const gpios: Pending[] = []
  for (const p of pending) {
    const { obj, el } = p
    switch (el.kind) {
      case "R":
      case "C":
      case "L":
      case "SW":
        touch(obj, el.a)
        touch(obj, el.b)
        break
      case "V":
        touch(obj, el.plus)
        touch(obj, el.minus)
        firstMinus ??= uf.find(node(obj, el.minus))
        break
      case "XFMR":
        touch(obj, el.p1)
        touch(obj, el.p2)
        touch(obj, el.s1)
        touch(obj, el.s2)
        break
      case "D":
        touch(obj, el.anode)
        touch(obj, el.cathode)
        break
      case "Q":
        touch(obj, el.b)
        touch(obj, el.c)
        touch(obj, el.e)
        break
      case "GPIO":
        gpios.push(p)
        if (el.vddNode) touch(obj, el.vddNode)
        break
      case "REG":
        touch(obj, el.in)
        touch(obj, el.out)
        touch(obj, el.gnd)
        break
    }
  }
  // A pad joins the matrix when something else is on its net, when a wire leaves it, or when
  // a probe watches it; a pad with nothing attached has nothing to compute and is left out.
  const wanted = new Set<string>()
  for (const w of doc.wires) {
    wanted.add(uf.find(pinKey(w.from.object, w.from.pin)))
    wanted.add(uf.find(pinKey(w.to.object, w.to.pin)))
  }
  for (const key of watched) wanted.add(uf.find(key))
  for (const { obj, el } of gpios) {
    if (el.kind !== "GPIO") continue
    const root = uf.find(node(obj, el.node))
    if (active.has(root) || wanted.has(root)) touch(obj, el.node)
  }

  // Reference node: explicit ground, else the first source's minus, else nothing.
  let groundRoot = uf.find(GND_KEY)
  if (!active.has(groundRoot) && firstMinus) groundRoot = firstMinus
  const index = new Map<string, number>()
  for (const root of active) if (root !== groundRoot) index.set(root, index.size)
  const netOf = (obj: PlacedObject, ref: string) => {
    const root = uf.find(node(obj, ref))
    return root === groundRoot ? GROUND : (index.get(root) ?? GROUND)
  }

  const elements: Resolved[] = []
  let sources = 0
  // Internal nodes an element adds for itself come after the ones the wiring made.
  let nodes = index.size
  for (const { obj, el, index, props } of pending) {
    const base: Base = {
      id: `${obj.id}:${index}`,
      object: obj.id,
      element: index,
      ref: props.ref ?? getDef(obj.def)?.name ?? obj.def,
      limits: "limits" in el ? resolveLimits(el.limits, props) : undefined,
    }
    switch (el.kind) {
      case "R":
      case "C":
      case "L": {
        const value = resolveValue(el.value, props)
        if (Number.isFinite(value) && value > 0)
          elements.push({ ...base, kind: el.kind, a: netOf(obj, el.a), b: netOf(obj, el.b), value, live: el.kind === "R" ? el.live : undefined, hidden: el.hidden, keys: [node(obj, el.a), node(obj, el.b)] })
        break
      }
      case "V": {
        const num = (v: Value | undefined) => (v === undefined ? 0 : resolveValue(v, props) || 0)
        const amplitude = Math.abs(num(el.amplitude))
        const frequency = num(el.frequency)
        elements.push({
          ...base,
          kind: "V",
          plus: netOf(obj, el.plus),
          minus: netOf(obj, el.minus),
          value: num(el.value),
          amplitude: frequency > 0 ? amplitude : 0,
          frequency: amplitude > 0 ? frequency : 0,
          phase: num(el.phase),
          shape: el.shape ?? "sine",
          duty: el.duty === undefined ? 0.5 : Math.min(0.99, Math.max(0.01, num(el.duty))),
          index: sources++,
          keys: [node(obj, el.plus), node(obj, el.minus)],
        })
        break
      }
      case "XFMR": {
        const ratio = resolveValue(el.ratio, props)
        if (Number.isFinite(ratio) && ratio > 0)
          elements.push({ ...base, kind: "XFMR", p1: netOf(obj, el.p1), p2: netOf(obj, el.p2), s1: netOf(obj, el.s1), s2: netOf(obj, el.s2), ratio, index: sources++, keys: [node(obj, el.p1), node(obj, el.p2), node(obj, el.s1), node(obj, el.s2)] })
        break
      }
      case "D": {
        const zener = el.zener !== undefined ? resolveValue(el.zener, props) : undefined
        const n = zener ? 1.5 : 1.8
        const vf = el.vf !== undefined ? resolveValue(el.vf, props) : 0.7
        const is = saturationCurrent(Number.isFinite(vf) && vf > 0 ? vf : 0.7, n)
        elements.push({ ...base, kind: "D", anode: netOf(obj, el.anode), cathode: netOf(obj, el.cathode), is, n, zener: zener && Number.isFinite(zener) ? zenerOffset(zener, is, n) : undefined, part: el.part, keys: [node(obj, el.anode), node(obj, el.cathode)] })
        break
      }
      case "Q": {
        const beta = el.beta !== undefined ? resolveValue(el.beta, props) : 200
        const rc = el.rc === undefined ? 0 : resolveValue(el.rc, props)
        const cPin = netOf(obj, el.c)
        let c = cPin
        let cKey = node(obj, el.c)
        // The collector resistance sits between the pin and an internal node the junction sees.
        // It follows the transistor in the list, so the first reading of the element is the transistor's.
        const withRc = Number.isFinite(rc) && rc > 0 && cPin !== GROUND
        if (withRc) {
          c = nodes++
          cKey = `${node(obj, el.c)}$rc`
        }
        elements.push({ ...base, kind: "Q", polarity: el.polarity === "npn" ? 1 : -1, b: netOf(obj, el.b), c, e: netOf(obj, el.e), beta: Number.isFinite(beta) && beta > 0 ? beta : 200, cPin, keys: [node(obj, el.b), cKey, node(obj, el.e)] })
        if (withRc) elements.push({ ...base, id: `${base.id}$rc`, kind: "R", a: cPin, b: c, value: rc, hidden: true, limits: undefined, keys: [node(obj, el.c), cKey] })
        break
      }
      case "M": {
        const vth = resolveValue(el.vth, props)
        const k = resolveValue(el.k, props)
        const lambda = el.lambda === undefined ? 0.01 : resolveValue(el.lambda, props)
        if (Number.isFinite(vth) && Number.isFinite(k) && k > 0)
          elements.push({ ...base, kind: "M", polarity: el.polarity === "nmos" ? 1 : -1, g: netOf(obj, el.g), d: netOf(obj, el.d), s: netOf(obj, el.s), vth: Math.abs(vth), k, lambda: Number.isFinite(lambda) ? Math.max(0, lambda) : 0.01, keys: [node(obj, el.g), node(obj, el.d), node(obj, el.s)] })
        break
      }
      case "SW": {
        const ron = el.ron === undefined ? SW_RON : resolveValue(el.ron, props)
        const strike = el.ideal ? Infinity : el.strike === undefined ? SW_STRIKE : resolveValue(el.strike, props)
        elements.push({ ...base, kind: "SW", a: netOf(obj, el.a), b: netOf(obj, el.b), part: el.part, closed: el.closed, ron: Number.isFinite(ron) && ron > 0 ? ron : SW_RON, strike: Number.isFinite(strike) && strike > 0 ? strike : Infinity, keys: [node(obj, el.a), node(obj, el.b)] })
        break
      }
      case "GPIO": {
        if (!active.has(uf.find(node(obj, el.node)))) break
        const keys: [string] | [string, string] = el.vddNode ? [node(obj, el.node), node(obj, el.vddNode)] : [node(obj, el.node)]
        elements.push({ ...base, kind: "GPIO", node: netOf(obj, el.node), nodeKey: el.node, vdd: el.vdd ?? 3.3, vddNet: el.vddNode ? netOf(obj, el.vddNode) : undefined, keys })
        break
      }
      case "REG": {
        const value = resolveValue(el.value, props)
        const dropout = el.dropout === undefined ? 0 : resolveValue(el.dropout, props)
        const imax = el.imax === undefined ? Infinity : resolveValue(el.imax, props)
        if (Number.isFinite(value) && value > 0)
          elements.push({ ...base, kind: "REG", in: netOf(obj, el.in), out: netOf(obj, el.out), gnd: netOf(obj, el.gnd), value, dropout: Number.isFinite(dropout) ? Math.max(0, dropout) : 0, imax: imax > 0 ? imax : Infinity, index: sources++, keys: [node(obj, el.in), node(obj, el.out)] })
        break
      }
    }
  }

  const pinNet = new Map<string, number>()
  for (const obj of doc.objects) {
    const def = getDef(obj.def)
    if (!def) continue
    for (const pin of def.pins) {
      const root = uf.find(node(obj, pin.id))
      if (root === groundRoot) pinNet.set(pinKey(obj.id, pin.id), GROUND)
      else if (index.has(root)) pinNet.set(pinKey(obj.id, pin.id), index.get(root)!)
    }
  }

  return { nodes, sources, elements, pinNet, groundKeys, contacts }
}
