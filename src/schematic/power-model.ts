import type { Element, NodeRef, ProtChip } from "./types"

export function tp4056(at: { vcc: NodeRef; bat: NodeRef; gnd: NodeRef; prog: NodeRef; chrg?: NodeRef; stdby?: NodeRef; ce?: NodeRef; temp?: NodeRef }): Element[] {
  return [{ kind: "CHG", in: at.vcc, bat: at.bat, gnd: at.gnd, prog: at.prog, chrg: at.chrg, stdby: at.stdby, ce: at.ce, temp: at.temp, value: 4.2, limits: { voltage: 8, fail: "short", fatal: false } }]
}

export function protector(chip: ProtChip, at: { vdd: NodeRef; vss: NodeRef; cs: NodeRef; od: NodeRef; oc: NodeRef }, vddMax?: number): Element[] {
  return [
    { kind: "PROT", vdd: at.vdd, vss: at.vss, cs: at.cs, od: at.od, oc: at.oc, chip },
    { kind: "R", a: at.vdd, b: at.vss, value: 1.2e6, hidden: true, limits: vddMax ? { voltage: vddMax, fail: "open" } : undefined },
  ]
}

export function dualNmos(at: { s1: NodeRef; g1: NodeRef; s2: NodeRef; g2: NodeRef; d: NodeRef }, k = 6, current = 6): Element[] {
  const limits = { voltage: 20, current, power: 1, fail: "short", fatal: false } as const
  const fet = (g: NodeRef, s: NodeRef): Element[] => [
    { kind: "M", polarity: "nmos", g, d: at.d, s, vth: 0.7, k, limits },
    { kind: "D", anode: s, cathode: at.d, vf: 0.6, limits: { current, fail: "short", fatal: false } },
  ]
  return [...fet(at.g1, at.s1), ...fet(at.g2, at.s2)]
}

export function dw01a(at: { vdd: NodeRef; vss: NodeRef; cs: NodeRef; od: NodeRef; oc: NodeRef }): Element[] {
  return protector("dw01a", at, 10)
}

export function fs8205a(at: { s1: NodeRef; g1: NodeRef; s2: NodeRef; g2: NodeRef; d: NodeRef }): Element[] {
  return dualNmos(at)
}

export function dw03(at: { vdd: NodeRef; gnd: NodeRef; vm: NodeRef }, rated = false): Element[] {
  return [
    ...protector("dw03", { vdd: at.vdd, vss: at.gnd, cs: at.vm, od: "$dw03od", oc: "$dw03oc" }, rated ? 6 : undefined),
    ...dualNmos({ s1: at.gnd, g1: "$dw03od", s2: at.vm, g2: "$dw03oc", d: "$dw03d" }, 8.3, 5),
  ]
}

export function mt3608(at: { power: NodeRef; out?: NodeRef; gnd: NodeRef; fb: NodeRef; vin?: NodeRef; en?: NodeRef }): Element[] {
  return [{ kind: "BOOST", in: at.power, out: at.out, gnd: at.gnd, fb: at.fb, vcc: at.vin, en: at.en, vref: 0.6, eff: 0.9, ilim: 2, uvlo: 2, iq: 1e-3, limits: { voltage: 28, fail: "open", fatal: false } }]
}
