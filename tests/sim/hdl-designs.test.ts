import { describe, expect, it } from "vitest"
import type { HdlNetlist } from "emul-shared/hdl"
import { hdlDef } from "@/schematic/hdl"
import { setLibrary } from "@/schematic/registry"
import type { HdlModule } from "@/schematic/types"
import { HdlPart } from "@/sim/hdl"
import cpu from "./hdl/cpu.json"
import uart from "./hdl/uart.json"
import mult from "./hdl/mult.json"
import ripple from "./hdl/ripple.json"
import fsm from "./hdl/fsm.json"
import od from "./hdl/od.json"
import latch from "./hdl/latch.json"
import intbus from "./hdl/intbus.json"
import konst from "./hdl/const.json"
import initreg from "./hdl/initreg.json"
import generics from "./hdl/generics.json"
import intport from "./hdl/intport.json"
import escaped from "./hdl/escaped.json"
import hello from "./hdl/hello.json"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

function part(name: string, netlist: unknown) {
  const m: HdlModule = { id: `hdl:${name}`, name, files: [], netlist: netlist as HdlNetlist, built: name }
  setLibrary([m])
  return new HdlPart("U1", m.id, m.netlist!, m.built)
}

class Bench {
  t = 0
  constructor(readonly p: HdlPart) {}
  set(pin: string, level: boolean) {
    this.p.input(pin, level, (this.t += 1e-6))
  }
  bus(name: string, width: number, value: number) {
    for (let i = 0; i < width; i++) this.set(`${name}[${i}]`, ((value >>> i) & 1) === 1)
  }
  word(name: string, width: number) {
    let v = 0
    for (let i = 0; i < width; i++) if (this.p.drive(`${name}[${i}]`)) v += 2 ** i
    return v
  }
  pulse(clk = "clk") {
    this.set(clk, true)
    this.set(clk, false)
  }
}

describe("designs synthesised by the service", () => {
  it("runs an 8-bit accumulator CPU from its ROM: Fibonacci on the output port, then halt", () => {
    const b = new Bench(part("cpu", cpu))
    b.set("clk", false)
    b.set("rst", true)
    b.pulse()
    b.set("rst", false)
    const seen: number[] = []
    for (let i = 0; i < 400 && !b.p.drive("halted"); i++) {
      b.pulse()
      if (b.p.drive("out_strobe")) seen.push(b.word("out_port", 8))
    }
    expect(seen).toEqual([1, 2, 3, 5, 8, 13, 21, 34, 55, 89])
    expect(b.p.drive("halted")).toBe(true)
  })

  it("sends bytes through a UART and receives them back on a loopback wire", () => {
    const b = new Bench(part("uart", uart))
    b.set("clk", false)
    b.set("send", false)
    b.set("rx", true)
    const got: number[] = []
    for (const byte of [0x55, 0xa3, 0x00, 0xff, 0x0f]) {
      b.bus("tx_data", 8, byte)
      b.set("send", true)
      b.pulse()
      b.set("send", false)
      for (let i = 0; i < 80; i++) {
        b.pulse()
        b.set("rx", b.p.drive("tx")!)
        if (b.p.drive("rx_valid")) got.push(b.word("rx_data", 8))
      }
      expect(b.p.drive("tx_busy")).toBe(false)
    }
    expect(got).toEqual([0x55, 0xa3, 0x00, 0xff, 0x0f])
  })

  it("multiplies 16-bit numbers combinationally", () => {
    const b = new Bench(part("mult", mult))
    let seed = 12345
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) & 0xffff
    const started = performance.now()
    for (let i = 0; i < 200; i++) {
      const x = next()
      const y = next()
      b.bus("a", 16, x)
      b.bus("b", 16, y)
      expect(b.word("p", 32)).toBe(x * y)
    }
    b.bus("a", 16, 0xffff)
    b.bus("b", 16, 0xffff)
    expect(b.word("p", 32)).toBe(0xffff * 0xffff)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it("ripples a counter through flip-flops clocked by each other's outputs", () => {
    const b = new Bench(part("ripple", ripple))
    b.set("clk", true)
    for (let n = 1; n <= 20; n++) {
      b.set("clk", false)
      b.set("clk", true)
      expect(b.word("q", 4)).toBe(n % 16)
    }
  })

  it("walks a traffic light through its states, and the walk button cuts green short", () => {
    const b = new Bench(part("traffic", fsm))
    const light = () => (b.p.drive("red") ? "R" : "") + (b.p.drive("yellow") ? "Y" : "") + (b.p.drive("green") ? "G" : "")
    b.set("clk", false)
    b.set("walk", false)
    b.set("rst", true)
    b.set("rst", false)
    const seq: string[] = []
    for (let i = 0; i < 12; i++) {
      seq.push(light())
      b.pulse()
    }
    expect(seq.join("")).toBe("RRRRGGGGGYYR")
    while (light() !== "G") b.pulse()
    b.set("walk", true)
    b.pulse()
    expect(light()).toBe("Y")
  })

  it("pulls an open-drain line low or lets go of it, and reads whoever else drives it", () => {
    const b = new Bench(part("od", od))
    b.set("pull_low", true)
    expect(b.p.drive("sda")).toBe(false)
    b.set("sda", false)
    expect(b.p.drive("seen")).toBe(false)
    b.set("pull_low", false)
    expect(b.p.drive("sda")).toBeNull()
    b.set("sda", true)
    expect(b.p.drive("seen")).toBe(true)
    b.set("sda", false)
    expect(b.p.drive("seen")).toBe(false)
  })

  it("keeps a latch transparent while enabled and holding otherwise", () => {
    const b = new Bench(part("latch", latch))
    b.set("en", true)
    b.set("d", true)
    expect(b.p.drive("q")).toBe(true)
    b.set("d", false)
    expect(b.p.drive("q")).toBe(false)
    b.set("d", true)
    b.set("en", false)
    b.set("d", false)
    expect(b.p.drive("q")).toBe(true)
  })

  it("selects between two tri-state drivers on an internal bus", () => {
    const b = new Bench(part("intbus", intbus))
    b.bus("a", 4, 0b1010)
    b.bus("b", 4, 0b0110)
    b.bus("sel", 2, 0b01)
    expect(b.word("y", 4)).toBe(0b1010)
    b.bus("sel", 2, 0b10)
    expect(b.word("y", 4)).toBe(0b0110)
  })

  it("drives constant outputs and passes an input straight through", () => {
    const b = new Bench(part("const", konst))
    expect(b.p.drive("one")).toBe(true)
    expect(b.p.drive("zero")).toBe(false)
    b.set("a", false)
    expect(b.p.drive("same")).toBe(false)
    b.set("a", true)
    expect(b.p.drive("same")).toBe(true)
  })

  it("reads a memory filled by an initial block", () => {
    const b = new Bench(part("initreg", initreg))
    b.set("clk", false)
    const seen = []
    for (let i = 0; i < 5; i++) {
      seen.push(b.word("q", 8))
      b.pulse()
    }
    expect(seen).toEqual([0x11, 0x22, 0x33, 0x44, 0x11])
  })

  it("builds with the generics it was given, a vector constant among them", () => {
    const b = new Bench(part("generics", generics))
    b.bus("a", 3, 0b101)
    expect(b.word("y", 3)).toBe(0b010)
    expect(b.word("k", 4)).toBe(0b0110)
  })

  it("turns integer ports into bit vectors", () => {
    const b = new Bench(part("intport", intport))
    for (const n of [0, 5, 15]) {
      b.bus("n", 4, n)
      expect(b.word("m", 4)).toBe(15 - n)
    }
  })

  it("keeps escaped Verilog names as pins", () => {
    const def = hdlDef({ id: "hdl:esc", name: "esc", files: [], netlist: escaped as HdlNetlist, built: "x" })!
    expect(def.pins.map((p) => p.id)).toEqual(expect.arrayContaining(["a+b", "clk", "out$[0]", "out$[3]", "VCC", "GND"]))
  })
})

describe("hdl symbols and files", () => {
  const netlist = (ports: { name: string; dir: "input" | "output" }[]): HdlNetlist => ({
    top: "t",
    language: "verilog",
    nets: 2 + ports.length,
    ports: ports.map((p, i) => ({ ...p, bits: [2 + i], offset: 0, upto: false })),
    cells: [],
    init: [],
  })

  it("moves its supply pins out of the way of ports named VCC and GND", () => {
    const def = hdlDef({ id: "hdl:pw", name: "pw", files: [], netlist: netlist([{ name: "VCC", dir: "input" }, { name: "gnd", dir: "input" }, { name: "y", dir: "output" }]), built: "x" })!
    const ids = def.pins.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(expect.arrayContaining(["VCC", "gnd", "y", "VDD", "VSS"]))
    expect(def.model!.some((e) => e.kind === "GPIO" && e.vddNode === "VDD")).toBe(true)
  })

  it("never names a pin like an internal node", () => {
    const def = hdlDef({ id: "hdl:d", name: "d", files: [], netlist: netlist([{ name: "$x", dir: "input" }]), built: "x" })!
    expect(def.pins.every((p) => !p.id.startsWith("$"))).toBe(true)
  })

  it("gives an imported file a name the service accepts", async () => {
    const { safeName } = await import("@/components/hdl/files")
    expect(safeName("Лаба 1 — лічильник.VHD")).toBe("Laba_1_lichylnyk.vhd")
    expect(safeName("мій модуль.v")).toBe("mii_modul.v")
    expect(safeName("___.vhd")).toBe("source.vhd")
  })
})

describe("a Verilog UART on the bench", () => {
  it("sends Hello to the serial terminal, clocked by a pulse source", () => {
    const m: HdlModule = { id: "hdl:hello", name: "hello", files: [], netlist: hello as HdlNetlist, built: "hello" }
    const { doc, place, wire } = builder(GRID)
    doc.library = [m]
    setLibrary(doc.library)
    const vcc = place("supply", 10, 0, { value: "+3.3V", voltage: "3.3 V" })
    const u = place(m.id, 8, 4)
    wire(vcc, "V", u, "VCC")
    wire(u, "GND", place("ground", 10, 14), "GND")
    const clk = place("pulse-source", 0, 4, { high: "3.3 V", low: "0 V", freq: "4.8 kHz", duty: "50" })
    wire(clk, "+", u, "clk")
    wire(clk, "-", place("ground", 0, 10), "GND")
    const en = place("logic-state", 0, 12, { vdd: "3.3 V" })
    wire(en, "OUT", u, "en")
    const term = place("serial-terminal", 20, 4, { baud: "1200" })
    wire(u, "tx", term, "RX")

    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts({ [partKey(en.id, "S")]: { on: true } })
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    while (clock < 400) loop.advance((clock += 30))
    const text = loop.snapshot()!.terminals[term.id]!.text
    expect(text.startsWith("Hello\r\nHello\r\nHello")).toBe(true)
    expect(loop.snapshot()!.terminals[term.id]!.framingErrors).toBe(0)
  })
})

describe("choosing the top unit", () => {
  it("passes over a testbench and a unit instantiated by another", async () => {
    const { guessTop } = await import("emul-shared/hdl")
    const vhdl = [
      { path: "cpu.vhd", content: "entity alu is port (a : in bit; y : out bit); end;\nentity cpu is port (clk : in bit); end;\narchitecture rtl of cpu is begin u: entity work.alu port map (a => clk, y => open); end;" },
      { path: "tb.vhd", content: "entity tb is end;\narchitecture sim of tb is begin end;" },
    ]
    expect(guessTop(vhdl)).toBe("cpu")
    const verilog = [
      { path: "top.v", content: "module top(input a, output y); inv u(.a(a), .y(y)); endmodule\nmodule inv(input a, output y); assign y = ~a; endmodule" },
      { path: "tb.v", content: "module tb; reg a; wire y; top dut(.a(a), .y(y)); endmodule" },
    ]
    expect(guessTop(verilog)).toBe("top")
  })
})

describe("a Verilog UART receiving from the serial terminal", () => {
  it("decodes the bytes the terminal sends", () => {
    const m: HdlModule = { id: "hdl:uart", name: "uart", files: [], netlist: uart as HdlNetlist, built: "uart" }
    const { doc, place, wire } = builder(GRID)
    doc.library = [m]
    setLibrary(doc.library)
    const vcc = place("supply", 10, 0, { value: "+3.3V", voltage: "3.3 V" })
    const u = place(m.id, 8, 4)
    wire(vcc, "V", u, "VCC")
    wire(u, "GND", place("ground", 10, 20), "GND")
    const clk = place("pulse-source", 0, 4, { high: "3.3 V", low: "0 V", freq: "4.8 kHz", duty: "50" })
    wire(clk, "+", u, "clk")
    wire(clk, "-", place("ground", 0, 10), "GND")
    const term = place("serial-terminal", 24, 4, { baud: "1200" })
    wire(term, "TX", u, "rx")
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setProbes([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `b${i}`, a: `${u.id}:rx_data[${i}]`, b: null })))
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    const run = (s: number) => {
      const end = clock + s * 1000
      while (clock < end) loop.advance((clock = Math.min(end, clock + 30)))
    }
    const byte = () => [0, 1, 2, 3, 4, 5, 6, 7].reduce((n, i) => n | ((loop.snapshot()!.probes[`b${i}`]?.v ?? 0) > 1.6 ? 1 << i : 0), 0)
    run(0.02)
    const got: number[] = []
    for (const ch of "Ok?") {
      loop.sendSerial(term.id, ch)
      run(0.015)
      got.push(byte())
    }
    expect(String.fromCharCode(...got)).toBe("Ok?")
  })
})
