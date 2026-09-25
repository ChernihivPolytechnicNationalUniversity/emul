import { CELL_PINS, portPins, type CellType, type HdlNetlist, type PortDirection } from "emul-shared/hdl"
import { hdlModule } from "@/schematic/registry"
import type { DigitalEdge, DigitalPart } from "./digital"

const Op = {
  BUF: 0,
  NOT: 1,
  AND: 2,
  NAND: 3,
  OR: 4,
  NOR: 5,
  XOR: 6,
  XNOR: 7,
  ANDNOT: 8,
  ORNOT: 9,
  MUX: 10,
  NMUX: 11,
  AOI3: 12,
  OAI3: 13,
  AOI4: 14,
  OAI4: 15,
  TBUF: 16,
  DFF: 17,
  DFFSR: 18,
  DLATCH: 19,
  DLATCHSR: 20,
} as const

type Op = (typeof Op)[keyof typeof Op]

const OPS: Record<CellType, Op> = {
  $_BUF_: Op.BUF,
  $_NOT_: Op.NOT,
  $_AND_: Op.AND,
  $_NAND_: Op.NAND,
  $_OR_: Op.OR,
  $_NOR_: Op.NOR,
  $_XOR_: Op.XOR,
  $_XNOR_: Op.XNOR,
  $_ANDNOT_: Op.ANDNOT,
  $_ORNOT_: Op.ORNOT,
  $_MUX_: Op.MUX,
  $_NMUX_: Op.NMUX,
  $_AOI3_: Op.AOI3,
  $_OAI3_: Op.OAI3,
  $_AOI4_: Op.AOI4,
  $_OAI4_: Op.OAI4,
  $_TBUF_: Op.TBUF,
  $_DFF_P_: Op.DFF,
  $_DFFSR_PPP_: Op.DFFSR,
  $_DLATCH_P_: Op.DLATCH,
  $_DLATCHSR_PPP_: Op.DLATCHSR,
}

const sequential = (op: number) => op >= Op.DFF

export type HdlSnapshot = { oscillating: boolean; cells: number; floating: string[] }

type PinInfo = { pin: string; bit: number; dir: PortDirection; tri: readonly number[] | null }

export class HdlPart implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[]
  readonly out: DigitalEdge[] = []
  readonly built: string | undefined
  private readonly defId: string
  private readonly netlist: HdlNetlist
  private readonly ops: Uint8Array
  private readonly conn: Int32Array
  private readonly start: Int32Array
  private readonly fanStart: Int32Array
  private readonly fan: Int32Array
  private readonly v: Uint8Array
  private readonly clock: Uint8Array
  private readonly queue: Int32Array
  private readonly queued: Uint8Array
  private readonly seqDirty: Uint8Array
  private readonly seqList: Int32Array
  private readonly external: Uint8Array
  private readonly info = new Map<string, PinInfo>()
  private readonly listen: PinInfo[] = []
  private readonly drivers: PinInfo[] = []
  private readonly heard = new Map<string, boolean>()
  private readonly bus = new Map<number, number[]>()
  private combOnly = false
  private readonly driven = new Map<string, boolean | null>()
  private head = 0
  private tail = 0
  private seqCount = 0
  private oscillating = false

  constructor(object: string, defId: string, netlist: HdlNetlist, built?: string) {
    this.object = object
    this.defId = defId
    this.netlist = netlist
    this.built = built
    const cells = netlist.cells
    const n = cells.length
    this.ops = new Uint8Array(n)
    this.start = new Int32Array(n + 1)
    let total = 0
    for (let c = 0; c < n; c++) {
      this.start[c] = total
      total += cells[c]!.length - 1
    }
    this.start[n] = total
    this.conn = new Int32Array(total)
    const readers = new Int32Array(netlist.nets)
    for (let c = 0; c < n; c++) {
      const [type, ...nets] = cells[c]!
      this.ops[c] = OPS[type]
      this.conn.set(nets, this.start[c]!)
      const inputs = CELL_PINS[type].length - 1
      for (let k = 0; k < inputs; k++) readers[nets[k]!]!++
    }
    this.fanStart = new Int32Array(netlist.nets + 1)
    for (let i = 0; i < netlist.nets; i++) this.fanStart[i + 1] = this.fanStart[i]! + readers[i]!
    this.fan = new Int32Array(this.fanStart[netlist.nets]!)
    const fill = this.fanStart.slice(0, netlist.nets)
    for (let c = 0; c < n; c++) {
      const s = this.start[c]!
      const inputs = this.start[c + 1]! - s - 1
      for (let k = 0; k < inputs; k++) this.fan[fill[this.conn[s + k]!]!++] = c
    }
    this.v = new Uint8Array(netlist.nets)
    this.clock = new Uint8Array(n)
    this.queue = new Int32Array(n + 1)
    this.queued = new Uint8Array(n)
    this.seqDirty = new Uint8Array(n)
    this.seqList = new Int32Array(n)
    this.external = new Uint8Array(netlist.nets)

    for (let c = 0; c < n; c++) {
      if (this.ops[c] !== Op.TBUF) continue
      const out = this.conn[this.start[c]! + 2]!
      const list = this.bus.get(out)
      if (list) list.push(c)
      else this.bus.set(out, [c])
    }
    for (const port of netlist.ports) if (port.dir !== "output") for (const bit of port.bits) this.external[bit] = 1
    const pins: string[] = []
    for (const port of netlist.ports)
      for (const { pin, bit } of portPins(port)) {
        const tri = port.dir === "inout" || (port.dir === "output" && !this.external[bit]) ? (this.bus.get(bit) ?? null) : null
        const p: PinInfo = { pin, bit, dir: port.dir, tri }
        this.info.set(pin, p)
        pins.push(pin)
        if (port.dir !== "output") this.listen.push(p)
        if (port.dir !== "input") this.drivers.push(p)
      }
    this.pins = pins
    this.powerOn()
    this.emit(0)
  }

  drive(pin: string): boolean | null {
    const p = this.info.get(pin)
    if (!p || p.dir === "input") return null
    return this.level(p)
  }

  input(pin: string, level: boolean, time: number): void {
    const p = this.info.get(pin)
    if (!p || p.dir === "output") return
    this.heard.set(pin, level)
    const value = level ? 1 : 0
    if (p.bit < 2 || this.v[p.bit] === value) return
    this.v[p.bit] = value
    this.touch(p.bit)
    this.settle()
    this.emit(time)
  }

  prime(levels: Map<string, boolean>, time: number): void {
    for (const [pin, level] of levels) if (this.info.get(pin)?.dir !== "output") this.heard.set(pin, level)
    this.powerOn()
    this.emit(time)
  }

  reset(): void {
    this.powerOn()
    this.emit(0)
  }

  configure(): void {}

  outdated(): boolean {
    return hdlModule(this.defId)?.built !== this.built
  }

  snapshot(): HdlSnapshot {
    return { oscillating: this.oscillating, cells: this.netlist.cells.length, floating: this.listen.filter((p) => p.dir === "input" && !this.heard.has(p.pin)).map((p) => p.pin) }
  }

  private powerOn() {
    this.v.fill(0)
    this.v[1] = 1
    for (const net of this.netlist.init) this.v[net] = 1
    for (const p of this.listen) if (p.bit >= 2) this.v[p.bit] = this.heard.get(p.pin) ? 1 : 0
    this.oscillating = false
    this.head = this.tail = 0
    this.queued.fill(0)
    this.combOnly = true
    for (let c = 0; c < this.ops.length; c++) this.enqueue(c)
    this.settle()
    this.combOnly = false
    for (let c = 0; c < this.ops.length; c++) {
      const op = this.ops[c]!
      if (op === Op.DFF || op === Op.DFFSR) this.clock[c] = this.v[this.conn[this.start[c]!]!]!
    }
    for (let c = 0; c < this.ops.length; c++) this.enqueue(c)
    this.settle()
  }

  private resolve(drivers: readonly number[]): number {
    let level = -1
    for (const c of drivers) {
      const s = this.start[c]!
      if (!this.v[this.conn[s + 1]!]) continue
      const a = this.v[this.conn[s]!]!
      level = level < 0 ? a : level & a
    }
    return level
  }

  private level(p: PinInfo): boolean | null {
    if (p.tri) {
      const level = this.resolve(p.tri)
      return level < 0 ? null : level === 1
    }
    return this.v[p.bit] === 1
  }

  private emit(time: number) {
    for (const p of this.drivers) {
      const level = this.level(p)
      if (this.driven.get(p.pin) === level) continue
      this.driven.set(p.pin, level)
      this.out.push({ pin: p.pin, level, time })
    }
  }

  private enqueue(c: number) {
    if (this.queued[c]) return
    this.queued[c] = 1
    this.queue[this.tail] = c
    this.tail = this.tail === this.queue.length - 1 ? 0 : this.tail + 1
  }

  private touch(net: number) {
    for (let i = this.fanStart[net]!, end = this.fanStart[net + 1]!; i < end; i++) this.enqueue(this.fan[i]!)
  }

  private set(net: number, value: number) {
    if (net < 2 || this.v[net] === value) return
    this.v[net] = value
    this.touch(net)
  }

  private settle() {
    const v = this.v
    const conn = this.conn
    let budget = 64 * (this.ops.length + 16)
    for (;;) {
      while (this.head !== this.tail) {
        const c = this.queue[this.head]!
        this.head = this.head === this.queue.length - 1 ? 0 : this.head + 1
        this.queued[c] = 0
        const op = this.ops[c]!
        if (sequential(op)) {
          if (this.combOnly) continue
          if (!this.seqDirty[c]) {
            this.seqDirty[c] = 1
            this.seqList[this.seqCount++] = c
          }
          continue
        }
        if (--budget < 0) {
          this.oscillating = true
          this.head = this.tail = 0
          this.queued.fill(0)
          return
        }
        const s = this.start[c]!
        const a = v[conn[s]!]!
        let y: number
        switch (op) {
          case Op.BUF:
            this.set(conn[s + 1]!, a)
            continue
          case Op.NOT:
            this.set(conn[s + 1]!, a ^ 1)
            continue
          case Op.TBUF: {
            const out = conn[s + 2]!
            if (this.external[out]) continue
            const level = this.resolve(this.bus.get(out)!)
            if (level >= 0) this.set(out, level)
            continue
          }
          case Op.AND:
            y = a & v[conn[s + 1]!]!
            break
          case Op.NAND:
            y = (a & v[conn[s + 1]!]!) ^ 1
            break
          case Op.OR:
            y = a | v[conn[s + 1]!]!
            break
          case Op.NOR:
            y = (a | v[conn[s + 1]!]!) ^ 1
            break
          case Op.XOR:
            y = a ^ v[conn[s + 1]!]!
            break
          case Op.XNOR:
            y = a ^ v[conn[s + 1]!]! ^ 1
            break
          case Op.ANDNOT:
            y = a & (v[conn[s + 1]!]! ^ 1)
            break
          case Op.ORNOT:
            y = a | (v[conn[s + 1]!]! ^ 1)
            break
          case Op.MUX:
            y = v[conn[s + 2]!] ? v[conn[s + 1]!]! : a
            break
          case Op.NMUX:
            y = (v[conn[s + 2]!] ? v[conn[s + 1]!]! : a) ^ 1
            break
          case Op.AOI3:
            y = ((a & v[conn[s + 1]!]!) | v[conn[s + 2]!]!) ^ 1
            break
          case Op.OAI3:
            y = ((a | v[conn[s + 1]!]!) & v[conn[s + 2]!]!) ^ 1
            break
          case Op.AOI4:
            y = ((a & v[conn[s + 1]!]!) | (v[conn[s + 2]!]! & v[conn[s + 3]!]!)) ^ 1
            break
          default:
            y = ((a | v[conn[s + 1]!]!) & (v[conn[s + 2]!]! | v[conn[s + 3]!]!)) ^ 1
            break
        }
        this.set(conn[this.start[c + 1]! - 1]!, y)
      }
      if (this.seqCount === 0) return
      const count = this.seqCount
      budget -= count
      const next = new Uint8Array(count)
      for (let i = 0; i < count; i++) {
        const c = this.seqList[i]!
        this.seqDirty[c] = 0
        const s = this.start[c]!
        const q = v[conn[this.start[c + 1]! - 1]!]!
        switch (this.ops[c]) {
          case Op.DFF: {
            const clk = v[conn[s]!]!
            next[i] = clk && !this.clock[c] ? v[conn[s + 1]!]! : q
            this.clock[c] = clk
            break
          }
          case Op.DFFSR: {
            const clk = v[conn[s]!]!
            const edge = clk && !this.clock[c]
            this.clock[c] = clk
            next[i] = v[conn[s + 2]!] ? 0 : v[conn[s + 1]!] ? 1 : edge ? v[conn[s + 3]!]! : q
            break
          }
          case Op.DLATCH:
            next[i] = v[conn[s]!] ? v[conn[s + 1]!]! : q
            break
          default:
            next[i] = v[conn[s + 2]!] ? 0 : v[conn[s + 1]!] ? 1 : v[conn[s]!] ? v[conn[s + 3]!]! : q
            break
        }
      }
      this.seqCount = 0
      for (let i = 0; i < count; i++) {
        const c = this.seqList[i]!
        this.set(conn[this.start[c + 1]! - 1]!, next[i]!)
      }
    }
  }
}
