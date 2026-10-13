import { open746ic } from "@/schematic/components/open746i-c"
import type { BodyShape, ComponentDef, PinDef, Side } from "@/schematic/types"

const WIDTH = 76
const HEIGHT = 56
const NAME_STEP = 0.19
const NAME_GAP = 0.45 + 0.35

type Run = { x: number; y: number; dir: "down" | "right"; side: Side; labelAt: Side; stub: number }

const shrouds = new Map<string, Extract<BodyShape, { type: "rect" }>>()

function shroud(connector: string, x0: number, y0: number, x1: number, y1: number) {
  const prev = shrouds.get(connector)
  if (!prev) {
    shrouds.set(connector, { type: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: 0.3, fill: "connector" })
    return
  }
  const nx = Math.min(prev.x, x0)
  const ny = Math.min(prev.y, y0)
  prev.w = Math.max(prev.x + prev.w, x1) - nx
  prev.h = Math.max(prev.y + prev.h, y1) - ny
  prev.x = nx
  prev.y = ny
}

const real = (connector: string, keep: (pin: number) => boolean = () => true) =>
  open746ic.pins.filter((p) => p.connector === connector && keep(p.connectorPin ?? 0)).sort((a, b) => (a.connectorPin ?? 0) - (b.connectorPin ?? 0))

const odd = (pin: number) => pin % 2 === 1
const even = (pin: number) => pin % 2 === 0

function run(connector: string, pins: PinDef[], at: Run): PinDef[] {
  const n = pins.length
  const beside = NAME_GAP + NAME_STEP * Math.max(...pins.map((p) => p.label.length))
  const above = NAME_GAP + 0.3
  shroud(
    connector,
    at.x - 0.5 - (at.labelAt === "left" ? beside : 0),
    at.y - 0.5 - (at.labelAt === "top" ? above : 0),
    at.x + (at.dir === "right" ? n - 0.5 : 0.5) + (at.labelAt === "right" ? beside : 0),
    at.y + (at.dir === "down" ? n - 0.5 : 0.5) + (at.labelAt === "bottom" ? above : 0),
  )
  return pins.map((p, i) => ({ ...p, x: at.x + (at.dir === "right" ? i : 0), y: at.y + (at.dir === "down" ? i : 0), side: at.side, labelAt: at.labelAt, stub: at.stub, printed: false }))
}

const left = (c: string, pins: PinDef[], y: number, inner = false) => run(c, pins, { x: inner ? 5 : 4, y, dir: "down", side: "left", labelAt: inner ? "right" : "left", stub: inner ? 3 : 2 })
const right = (c: string, pins: PinDef[], y: number, inner = false) => run(c, pins, { x: inner ? WIDTH - 5 : WIDTH - 4, y, dir: "down", side: "right", labelAt: inner ? "left" : "right", stub: inner ? 3 : 2 })
const top = (c: string, pins: PinDef[], x: number, inner = false) => run(c, pins, { x, y: inner ? 4 : 3, dir: "right", side: "top", labelAt: inner ? "bottom" : "top", stub: inner ? 3 : 2 })
const bottom = (c: string, pins: PinDef[], x: number, inner = false) => run(c, pins, { x, y: inner ? HEIGHT - 4 : HEIGHT - 3, dir: "right", side: "bottom", labelAt: inner ? "top" : "bottom", stub: inner ? 3 : 2 })

function strip(c: string, side: "left" | "right", y: number): PinDef[] {
  const [outer, inner] = side === "left" ? [10, 11] : [41, 40]
  const fromTop = (pins: PinDef[]) => (side === "left" ? pins : [...pins].reverse())
  return [
    ...run(c, fromTop(real(c, odd)), { x: outer, y, dir: "down", side, labelAt: side, stub: 2 }),
    ...run(c, fromTop(real(c, even)), { x: inner, y, dir: "down", side, labelAt: side === "left" ? "right" : "left", stub: 3 }),
  ]
}

const one = (id: string, at: Partial<PinDef>): PinDef => ({ ...open746ic.pins.find((p) => p.id === id)!, ...at, printed: false })

export function edgeHeaderBoard(): ComponentDef {
  shrouds.clear()
  const pins: PinDef[] = [
    one("5VDC", { x: 13, y: 3, side: "top", labelAt: "bottom" }),
    one("VCP-TX", { x: 46, y: 3, side: "top", labelAt: "bottom" }),
    one("VCP-RX", { x: 52, y: 3, side: "top", labelAt: "bottom" }),
    ...top("P6", real("P6"), 17),
    ...top("P3", real("P3"), 28),
    ...run("P5", real("P5", odd), { x: 55, y: 6, dir: "right", side: "top", labelAt: "top", stub: 2 }),
    ...run("P5", real("P5", even), { x: 55, y: 7, dir: "right", side: "top", labelAt: "bottom", stub: 3 }),
    ...left("P2", real("P2"), 6),
    ...left("P8", real("P8"), 16),
    ...left("P7", real("P7"), 23),
    ...left("P4", real("P4", odd), 30),
    ...left("P4", real("P4", even), 30, true),
    ...left("P13", real("P13", odd), 38),
    ...left("P13", real("P13", even), 38, true),
    ...right("P11", real("P11", odd), 18, true),
    ...right("P11", real("P11", even), 18),
    ...right("P1", real("P1", odd), 28, true),
    ...right("P1", real("P1", even), 28),
    ...right("P9", real("P9", odd), 37, true),
    ...right("P9", real("P9", even), 37),
    ...bottom("P12", real("P12", odd), 11),
    ...bottom("P12", real("P12", even), 11, true),
    ...bottom("P10", real("P10", odd), 23),
    ...bottom("P10", real("P10", even), 23, true),
    ...bottom("P15", real("P15", (pin) => pin <= 20), 35, true),
    ...bottom("P15", real("P15", (pin) => pin > 20), 35),
    ...run("CN2", real("CN2"), { x: 44, y: 18, dir: "down", side: "left", labelAt: "right", stub: 1 }),
    ...run("CN3", real("CN3"), { x: 44, y: 28, dir: "down", side: "left", labelAt: "right", stub: 1 }),
    ...run("CN1", real("CN1"), { x: 63, y: 14, dir: "down", side: "right", labelAt: "left", stub: 1 }),
    ...run("CN4", real("CN4"), { x: 63, y: 26, dir: "down", side: "right", labelAt: "left", stub: 1 }),
    ...run("CN5", real("CN5", odd), { x: 53, y: 36, dir: "right", side: "bottom", labelAt: "top", stub: 2 }),
    ...run("CN5", real("CN5", even), { x: 53, y: 37, dir: "right", side: "bottom", labelAt: "bottom", stub: 1 }),
    ...strip("P20", "left", 7),
    ...strip("P21", "left", 25),
    ...strip("P19", "right", 7),
    ...strip("P18", "right", 25),
  ]
  return {
    id: "edge-board",
    name: "Edge-header board",
    category: "Boards",
    icon: open746ic.icon,
    width: WIDTH,
    height: HEIGHT,
    body: [{ type: "rect", x: 0, y: 0, w: WIDTH, h: HEIGHT, rx: 3, fill: "board" }, ...shrouds.values()],
    pins,
    parts: [],
    pinsAreSockets: true,
  }
}
