import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { pinKey } from "@/schematic/types"
import { across, lowSide, meanCurrentOf, sound, start } from "../lib/buzzer-bench"

type Level = { typ: number; min: number; weighted: boolean }

type MagneticSheet = {
  model: string
  sheet: string
  resonance?: { hz: number; tolerance: number }
  ohms: number
  ohmsTolerance: number
  volts: { rated: number; min: number; max: number }
  ratedHz: number
  level: Level
  maxMeanMilliamps: number
  curve: [number, number][]
  curveRms: number
}

const MAGNETIC: MagneticSheet[] = [
  {
    model: "cem-1203-42",
    sheet: "CUI CEM-1203(42), 2006-08-11 and Same Sky rev 1.05",
    ohms: 42,
    ohmsTolerance: 6.3,
    volts: { rated: 3.5, min: 3, max: 5 },
    ratedHz: 2048,
    level: { typ: 95, min: 85, weighted: true },
    maxMeanMilliamps: 35,
    curve: [[424, 81.1], [718, 87.5], [1056, 77.9], [1390, 78.6], [2000, 88.1], [2048, 94.0], [2100, 94.2], [2200, 90.6], [2500, 77.5], [3000, 73.0], [3600, 77.4], [4000, 82.0], [4270, 87.8], [5000, 74.1], [7000, 70.7]],
    curveRms: 3,
  },
  {
    model: "at-1224-twt-5v-2",
    sheet: "PUI Audio AT-1224-TWT-5V-2-R rev C, 2024-10-15",
    resonance: { hz: 2400, tolerance: 500 },
    ohms: 47,
    ohmsTolerance: 7,
    volts: { rated: 5, min: 3, max: 7 },
    ratedHz: 2400,
    level: { typ: 95.3, min: 87, weighted: false },
    maxMeanMilliamps: 40,
    curve: [[500, 79.7], [833, 87.5], [1000, 74.7], [1500, 81.8], [2000, 76.1], [2200, 87.7], [2353, 95.8], [2400, 95.3], [2500, 93.4], [2700, 85.8], [3000, 81.7], [3500, 80.2], [4000, 86.9], [4462, 90.5], [5000, 82.5], [7000, 74.2]],
    curveRms: 3,
  },
  {
    model: "cmt-0904-83t",
    sheet: "CUI CMT-0904-83T rev 1.03, 2024-09-11",
    ohms: 15,
    ohmsTolerance: 2,
    volts: { rated: 3, min: 2, max: 5 },
    ratedHz: 2730,
    level: { typ: 89.1, min: 83, weighted: false },
    maxMeanMilliamps: 90,
    curve: [[700, 80.3], [1067, 86.7], [1300, 77.4], [2000, 79.7], [2400, 78.2], [2730, 89.1], [2850, 92.9], [3010, 94.2], [3200, 91.9], [3500, 88.4], [4000, 84.6], [4500, 82.4], [5000, 83.9], [5685, 88.0], [6500, 78.7], [8000, 75.7]],
    curveRms: 3,
  },
]

const levelOf = (s: ReturnType<typeof sound>, weighted: boolean) => (weighted ? s.level : s.unweighted) ?? -Infinity
const unit = (weighted: boolean) => (weighted ? "dB(A)" : "dB")

describe.each(MAGNETIC)("passive magnetic $model, line by line against $sheet", (d) => {
  it(`coil resistance ${d.ohms} ± ${d.ohmsTolerance} Ω, read with 1 V DC across it`, () => {
    const { doc, feed } = across(d.model, { kind: "dc", volts: 1 })
    const { amps } = meanCurrentOf(doc, feed.id)
    expect.soft(1 / amps - 0.1, "resistance (Ω)").toBeNear(d.ohms, d.ohms * 0.005)
  })

  it(`rated drive ${d.volts.rated} Vo-p, ${d.ratedHz} Hz, ½ duty, on the sheet's test circuit: typical ${d.level.typ} ${unit(d.level.weighted)}, never under the ${d.level.min} minimum, ${d.maxMeanMilliamps} mA mean at most`, () => {
    const bench = lowSide({ model: d.model, supply: `${d.volts.rated} V`, hz: `${d.ratedHz} Hz` })
    const { snap, amps } = meanCurrentOf(bench.doc, bench.source.id)
    const s = sound(snap, bench.bz)
    expect.soft(levelOf(s, d.level.weighted), `sound pressure at 10 cm (${unit(d.level.weighted)})`).toBeNear(d.level.typ, 0.5)
    expect.soft(levelOf(s, d.level.weighted), "above the guaranteed minimum").toBeGreaterThanOrEqual(d.level.min)
    expect.soft(s.tone ?? 0, "tone (Hz)").toBeNear(d.ratedHz, 10)
    expect.soft(amps * 1e3, "mean supply current (mA)").toBeLessThanOrEqual(d.maxMeanMilliamps * 1.03)
    expect.soft(amps * 1e3, "…at the maximum, the inductance being back-solved from it (mA)").toBeGreaterThanOrEqual(d.maxMeanMilliamps * 0.97)
    expect.soft(s.warnings, "nothing to warn about").toEqual([])
  })

  it(`operating range ${d.volts.min}–${d.volts.max} Vo-p: silent about it inside, warns under and over`, () => {
    const warnings = (volts: number) => {
      const bench = lowSide({ model: d.model, supply: `${volts} V`, hz: `${d.ratedHz} Hz` })
      return sound(start(bench.doc).run(0.15), bench.bz).warnings.join(" ")
    }
    expect.soft(warnings(d.volts.min), `at ${d.volts.min} V`).toBe("")
    expect.soft(warnings(d.volts.max), `at ${d.volts.max} V`).toBe("")
    expect.soft(warnings(d.volts.min * 0.85), `at ${d.volts.min * 0.85} V`).toContain("under its")
    expect.soft(warnings(d.volts.max * 1.15), `at ${d.volts.max * 1.15} V`).toContain(`over its ${d.volts.max} V maximum`)
  })

  it("DC: a click and silence with a warning; at the top of its range the coil overheats and opens, at the bottom it only warms", () => {
    const hot = across(d.model, { kind: "dc", volts: d.volts.max })
    const t = start(hot.doc)
    let snap = t.run(0.8)
    expect.soft(sound(snap, hot.bz).level, "silent on DC").toBeNull()
    expect.soft(sound(snap, hot.bz).warnings.join(" "), "says why").toContain("DC through a passive buzzer")
    snap = t.run(4)
    expect.soft(snap.damage[hot.bz.id]?.fail ?? "", `${d.volts.max} V DC: the coil opens`).toBe("open")
    const warm = across(d.model, { kind: "dc", volts: d.volts.min })
    expect.soft(start(warm.doc).run(4.8).damage[warm.bz.id], `${d.volts.min} V DC: whole`).toBeFalsy()
  })

  it(`frequency response swept at its rated drive follows the published curve within ${d.curveRms} dB rms`, () => {
    const errors = d.curve.map(([hz, db]) => {
      const bench = lowSide({ model: d.model, supply: `${d.volts.rated} V`, hz: `${hz} Hz` })
      return (sound(start(bench.doc).run(0.15), bench.bz).unweighted ?? 0) - db
    })
    const rms = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length)
    expect.soft(rms, `rms against the curve (dB); point by point ${errors.map((e) => e.toFixed(1)).join(", ")}`).toBeLessThanOrEqual(d.curveRms)
    const loudest = d.curve.reduce((best, p) => (p[1] > best[1] ? p : best))
    const k = d.curve.indexOf(loudest)
    expect.soft(errors[k], `at the curve's peak, ${loudest[0]} Hz (dB)`).toBeNear(0, 3)
    if (d.resonance) {
      const modelled = d.curve.map(([hz], i) => [hz, d.curve[i][1] + errors[i]] as const).reduce((best, p) => (p[1] > best[1] ? p : best))
      expect.soft(modelled[0], `loudest at ${modelled[0]} Hz, inside the resonance ${d.resonance.hz} ± ${d.resonance.tolerance} Hz`).toBeNear(d.resonance.hz, d.resonance.tolerance)
    }
  })
})

type PiezoSheet = {
  model: string
  sheet: string
  nanofarads: number
  measuredAt: number
  rated: { high: number; low: number; hz: number }
  level: Level
  maxVolts: number
}

const PIEZO: PiezoSheet[] = [
  {
    model: "pkm13epyh4000-a0",
    sheet: "Murata PKM13EPYH4000-A0 data sheet, 2022-03-19",
    nanofarads: 5.5,
    measuredAt: 1000,
    rated: { high: 1.5, low: -1.5, hz: 4000 },
    level: { typ: 78, min: 70, weighted: false },
    maxVolts: 15,
  },
  {
    model: "pkm17epp-2002-b0",
    sheet: "Murata catalogue P37E, 2012-02-01, and its response curve",
    nanofarads: 34,
    measuredAt: 120,
    rated: { high: 3, low: 0, hz: 2000 },
    level: { typ: 82, min: 70, weighted: false },
    maxVolts: 25,
  },
]

describe.each(PIEZO)("passive piezo $model, line by line against $sheet", (d) => {
  it(`capacitance ${d.nanofarads} nF ± 30 %, measured at ${d.measuredAt} Hz as the sheet does`, () => {
    const { doc, place, wire } = builder(GRID)
    const src = place("ac-source", 0, 0, { value: "1 V", freq: `${d.measuredAt} Hz`, rint: "0.01 Ω" })
    const sense = place("resistor", 6, -4, { value: "100 Ω" })
    const bz = place(`buzzer-${d.model}`, 14, 0)
    const gnd = place("ground", 0, 8)
    wire(src, "+", sense, "1")
    wire(sense, "2", bz, "1")
    wire(bz, "2", gnd, "GND")
    wire(src, "-", gnd, "GND")
    const t = start(doc, [{ id: "sense", a: pinKey(sense.id, "1"), b: pinKey(sense.id, "2") }])
    t.run(0.1)
    t.loop.setProbes([{ id: "sense", a: pinKey(sense.id, "1"), b: pinKey(sense.id, "2") }])
    const amps = t.run(10 / d.measuredAt + 0.02).probes.sense.rms / 100
    const ohms = Math.sqrt(Math.max(0, (1 / amps) ** 2 - 100 ** 2))
    expect.soft(1e9 / (2 * Math.PI * d.measuredAt * ohms), "capacitance at the pins (nF)").toBeNear(d.nanofarads, d.nanofarads * 0.02)
  })

  it(`rated drive ${d.rated.low}…${d.rated.high} V square at ${d.rated.hz} Hz: typical ${d.level.typ} dB, never under the ${d.level.min} minimum`, () => {
    const { doc, bz } = across(d.model, { kind: "square", volts: d.rated.high, low: d.rated.low, hz: `${d.rated.hz} Hz`, rint: "25 Ω" })
    const s = sound(start(doc).run(0.15), bz)
    expect.soft(s.unweighted ?? 0, "sound pressure at 10 cm (dB)").toBeNear(d.level.typ, 0.3)
    expect.soft(s.unweighted ?? 0, "above the guaranteed minimum").toBeGreaterThanOrEqual(d.level.min)
    expect.soft(s.warnings, "nothing to warn about").toEqual([])
  })

  it(`maximum input ${d.maxVolts} Vo-p: a square up to it plays without harm or warning, over it warns, and the ceramic depolarises only at twice it`, () => {
    const square = (amplitude: number) => {
      const swing = d.rated.low < 0 ? { volts: amplitude, low: -amplitude } : { volts: amplitude, low: 0 }
      const bench = across(d.model, { kind: "square", ...swing, hz: `${d.rated.hz} Hz`, rint: "25 Ω" })
      const snap = start(bench.doc).run(0.3)
      return { damaged: snap.damage[bench.bz.id], warnings: sound(snap, bench.bz).warnings.join(" ") }
    }
    const at = square(d.maxVolts)
    expect.soft(at.damaged, "whole at its maximum").toBeFalsy()
    expect.soft(at.warnings, "no warning at its maximum").toBe("")
    const over = square(d.maxVolts * 1.15)
    expect.soft(over.damaged, "whole a little over it").toBeFalsy()
    expect.soft(over.warnings, "warns a little over it").toContain(`over its ${d.maxVolts} V maximum`)
    const past = across(d.model, { kind: "dc", volts: d.maxVolts * 2.1 })
    expect.soft(start(past.doc).run(0.05).damage[past.bz.id]?.reason ?? "", "broken at twice its rating").toContain("voltage")
  })

  it("on the sheet's own transistor drive, a resistor across it lets it discharge every cycle and sound; without one it hardly sounds", () => {
    const drive = (withResistor: boolean) => {
      const { doc, place, wire } = builder(GRID)
      const rail = place("supply", 12, -8, { value: "+V", voltage: "5 V", imax: "1 A" })
      const bz = place(`buzzer-${d.model}`, 10, -2)
      const q = place("npn", 12, 8, { value: "2N2222", beta: "150", rc: "0.5 Ω", icmax: "600 mA", vcemax: "40 V", pmax: "500 mW" })
      const base = place("resistor", 4, 9, { value: "1 kΩ" })
      const gen = place("pulse-source", -4, 8, { high: "5 V", low: "0 V", freq: `${d.rated.hz} Hz` })
      const gnd = place("ground", 15, 16)
      wire(rail, "V", bz, "1")
      wire(bz, "2", q, "C")
      wire(q, "E", gnd, "GND")
      wire(gen, "+", base, "1")
      wire(base, "2", q, "B")
      wire(gen, "-", gnd, "GND")
      if (withResistor) {
        const r = place("resistor", 18, -2, { value: "1 kΩ" }, 90)
        wire(r, "1", rail, "V")
        wire(r, "2", q, "C")
      }
      return sound(start(doc).run(0.2), bz).unweighted ?? -Infinity
    }
    const square = across(d.model, { kind: "square", volts: 5, hz: `${d.rated.hz} Hz`, rint: "25 Ω" })
    const direct = sound(start(square.doc).run(0.2), square.bz).unweighted ?? 0
    expect.soft(drive(true), "with 1 kΩ across it, as loud as a 5 Vp-p square straight on it (dB)").toBeNear(direct, 1.5)
    expect.soft(direct - drive(false), "without it, far quieter (dB)").toBeGreaterThan(15)
  })

  it("DC across it: no sound and a warning about the bias", () => {
    const { doc, bz } = across(d.model, { kind: "dc", volts: 3 })
    const s = sound(start(doc).run(0.8), bz)
    expect.soft(s.level, "silent").toBeNull()
    expect.soft(s.warnings.join(" "), "warns").toContain("DC across a piezo")
  })
})

type ActiveSheet = {
  model: string
  sheet: string
  volts: { rated: number; min: number; max: number }
  level: Level
  milliamps: { typ: number; max: number | null }
  tone: { typ: number; low: number; high: number }
}

const ACTIVE: ActiveSheet[] = [
  {
    model: "tmb12a05",
    sheet: "Huaneng TMB12A05 specification and test report, 2023-11-07",
    volts: { rated: 5, min: 3, max: 7 },
    level: { typ: 96.6, min: 95, weighted: false },
    milliamps: { typ: 23.04, max: 30 },
    tone: { typ: 2407, low: 2100, high: 2700 },
  },
  {
    model: "sdc1610m5-01",
    sheet: "TDK SDC series catalogue, 2024-11-29",
    volts: { rated: 5, min: 4, max: 8 },
    level: { typ: 90.2, min: 85, weighted: true },
    milliamps: { typ: 19.53, max: 30 },
    tone: { typ: 2426, low: 1920, high: 2880 },
  },
  {
    model: "cmi-9650c-030",
    sheet: "CUI CMI-9650C-030, 2024-09-11 (its own current curve reads 18.3 mA where its table says 15 mA max)",
    volts: { rated: 3, min: 2, max: 5 },
    level: { typ: 85.25, min: 78, weighted: true },
    milliamps: { typ: 18.3, max: null },
    tone: { typ: 2850, low: 2700, high: 3000 },
  },
  {
    model: "pkb24spch3601-b0",
    sheet: "Murata catalogue P37E, 2012-02-01",
    volts: { rated: 12, min: 3, max: 15 },
    level: { typ: 98.15, min: 90, weighted: false },
    milliamps: { typ: 12.44, max: 16 },
    tone: { typ: 3600, low: 3100, high: 4100 },
  },
]

describe.each(ACTIVE)("active $model, line by line against $sheet", (d) => {
  const on = (volts: number) => {
    const { doc, bz, feed } = across(d.model, { kind: "dc", volts })
    const { snap, amps } = meanCurrentOf(doc, feed.id)
    return { s: sound(snap, bz), amps }
  }
  const lasts = (volts: number, seconds: number) => {
    const { doc, bz } = across(d.model, { kind: "dc", volts })
    return !start(doc).run(seconds).damage[bz.id]
  }

  it(`rated ${d.volts.rated} V DC: typical ${d.level.typ} ${unit(d.level.weighted)} (minimum ${d.level.min}), ${d.milliamps.typ} mA${d.milliamps.max ? ` (at most ${d.milliamps.max})` : ""}, ${d.tone.typ} Hz inside ${d.tone.low}–${d.tone.high} Hz`, () => {
    const { s, amps } = on(d.volts.rated)
    expect.soft(levelOf(s, d.level.weighted), `sound pressure at 10 cm (${unit(d.level.weighted)})`).toBeNear(d.level.typ, 0.3)
    expect.soft(levelOf(s, d.level.weighted), "above the guaranteed minimum").toBeGreaterThanOrEqual(d.level.min)
    expect.soft(amps * 1e3, "current (mA)").toBeNear(d.milliamps.typ, 0.3)
    if (d.milliamps.max !== null) expect.soft(amps * 1e3, "within the maximum (mA)").toBeLessThanOrEqual(d.milliamps.max)
    expect.soft(s.tone ?? 0, "tone (Hz)").toBeNear(d.tone.typ, 2)
    expect.soft(s.tone ?? 0, "inside the tolerance (Hz)").toBeGreaterThanOrEqual(d.tone.low)
    expect.soft(s.tone ?? 0, "inside the tolerance (Hz)").toBeLessThanOrEqual(d.tone.high)
    expect.soft(s.warnings, "nothing to warn about").toEqual([])
  })

  it(`operating range ${d.volts.min}–${d.volts.max} V: sounds and keeps quiet about it inside, warns just under and over, and lasts at the top`, () => {
    const bottom = on(d.volts.min)
    expect.soft(bottom.s.sounding, `sounds at ${d.volts.min} V`).toBe(true)
    expect.soft(bottom.s.warnings, `no warning at ${d.volts.min} V`).toEqual([])
    const top = on(d.volts.max)
    expect.soft(top.s.sounding, `sounds at ${d.volts.max} V`).toBe(true)
    expect.soft(top.s.warnings, `no warning at ${d.volts.max} V`).toEqual([])
    expect.soft(lasts(d.volts.max, 10), `whole after 10 s at ${d.volts.max} V`).toBe(true)
    const under = on(d.volts.min * 0.9)
    expect.soft(under.s.sounding, `still sounds at ${d.volts.min * 0.9} V`).toBe(true)
    expect.soft(under.s.warnings.join(" "), `warns at ${d.volts.min * 0.9} V`).toContain("under its")
    expect.soft(on(d.volts.max * 1.1).s.warnings.join(" "), `warns at ${d.volts.max * 1.1} V`).toContain(`over its ${d.volts.max} V maximum`)
  })

  it("polarity: + on pin 1; reversed at its rated voltage it is silent and says so", () => {
    const { s } = on(-d.volts.rated)
    expect.soft(s.sounding, "silent").toBe(false)
    expect.soft(s.warnings.join(" "), "warns").toMatch(/Reversed/)
  })
})

describe("active TMB12A05 against Huaneng's 2017 specification", () => {
  it("response time: at full sound within 50 ms of its 5 V being applied", () => {
    const { doc, bz } = across("tmb12a05", { kind: "dc", volts: 5 })
    let reached = Infinity
    start(doc).run(0.1, (snap) => {
      const s = sound(snap, bz)
      if (reached === Infinity && (s.unweighted ?? -Infinity) >= 96.6 - 1) reached = snap.time
    })
    expect.soft(reached * 1e3, "time to within 1 dB of its level (ms)").toBeLessThanOrEqual(50)
  })
})
