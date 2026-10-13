import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { AMBIENT, COMMON_CATHODE_LEAD, deratedCurrent, intensityVsAmbient, L154A4SURKQBDZGW, luminousIntensity, PART_NUMBER, RATED_TEST_CURRENT, rgbLedGlow, type RgbDie } from "@/schematic/components/rgb-led"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import cie from "../data/kingbright-l154a4surkqbdzgw/cie1931-locus.json"
import curves from "../data/kingbright-l154a4surkqbdzgw/curves.json"
import sheet from "../data/kingbright-l154a4surkqbdzgw/datasheet.json"

type DieId = RgbDie["id"]
type Axis = { slope: number }
type Cartesian = { grid: { x: Axis; y: Axis }; lineWidthPt: number; lineWidth: { x: number; y: number }; points: number[][]; dashed: number[][] }
type Line = (typeof sheet.lines)[number] & Record<string, unknown>

const DIES = L154A4SURKQBDZGW
const die = (id: DieId) => DIES.find((d) => d.id === id)!
const line = (id: string) => sheet.lines.find((l) => l.id === id) as Line
const perDie = <T,>(id: string, key: string) => (line(id) as Record<string, unknown>)[key] as Record<DieId, T>
const curve = (id: DieId, name: "forwardVoltage" | "luminousIntensityVsCurrent" | "derating" | "luminousIntensityVsTemperature") => curves.dies[id][name] as Cartesian
const ptPerX = (c: Cartesian) => 1 / c.grid.x.slope
const ptPerY = (c: Cartesian) => 1 / c.grid.y.slope

const VF_TOLERANCE = (line("characteristics-note-2") as { volts: number }).volts
const WAVELENGTH_TOLERANCE = (line("characteristics-note-1") as { nm: number }).nm
const INTENSITY_SPREAD = (line("selection-note-2") as { relative: number }).relative

function settle(doc: Schematic, ms: number): Snapshot {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  while (clock < ms) {
    clock = Math.min(ms, clock + 10)
    loop.advance(clock)
  }
  const snap = loop.snapshot()!
  loop.dispose()
  return snap
}

const reading = (snap: Snapshot, led: PlacedObject, id: DieId) => snap.readings.find((r) => r.object === led.id && r.element === DIES.findIndex((d) => d.id === id))!
const lit = (snap: Snapshot, led: PlacedObject, id: DieId) => snap.parts[partKey(led.id, id)]?.on ?? false
const fmt = (v: number) => v.toPrecision(7)

function driven(id: DieId, volts: number, ohms: number, props: Record<string, string> = {}) {
  const { doc, place, wire } = builder(GRID)
  const source = place("dc-source", 0, 0, { value: `${fmt(volts)} V`, rint: `${fmt(ohms)} Ω`, imax: "10 A" })
  const led = place("rgb-led", 10, 0, props)
  const gnd = place("ground", 4, 10)
  wire(source, "+", led, id)
  wire(led, "K", gnd, "GND")
  wire(source, "-", gnd, "GND")
  return { doc, led }
}

function reversed(id: DieId, volts: number) {
  const { doc, place, wire } = builder(GRID)
  const source = place("dc-source", 0, 0, { value: `${fmt(volts)} V`, rint: "1 kΩ" })
  const led = place("rgb-led", 10, 0)
  const gnd = place("ground", 4, 10)
  wire(source, "+", led, "K")
  wire(led, id, gnd, "GND")
  wire(source, "-", gnd, "GND")
  return { doc, led }
}

function at(id: DieId, amps: number, guessVolts: number, ms: number, props: Record<string, string> = {}) {
  const ohms = 10_000
  const { doc, led } = driven(id, guessVolts + amps * ohms, ohms, props)
  const snap = settle(doc, ms)
  return { snap, led, r: reading(snap, led, id) }
}

function interpolate(points: number[][], x: number): number {
  for (let k = 1; k < points.length; k++) {
    const [x0, y0] = points[k - 1]
    const [x1, y1] = points[k]
    if (x >= x0 && x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return x < points[0][0] ? points[0][1] : points[points.length - 1][1]
}

function distanceToChord(knot: number[], a: number[], b: number[], sx: number, sy: number): number {
  const [kx, ky] = [knot[0] * sx, knot[1] * sy]
  const [ax, ay] = [a[0] * sx, a[1] * sy]
  const [bx, by] = [b[0] * sx, b[1] * sy]
  const length = Math.hypot(bx - ax, by - ay)
  if (length < 0.01) return Math.min(Math.hypot(kx - ax, ky - ay), Math.hypot(kx - bx, ky - by))
  return Math.abs((bx - ax) * (ay - ky) - (ax - kx) * (by - ay)) / length
}

function distanceToCurve(fn: (x: number) => number, point: number[], c: Cartesian, from: number, to: number): number {
  let best = Infinity
  for (let k = 0; k <= 4000; k++) {
    const x = from + ((to - from) * k) / 4000
    best = Math.min(best, Math.hypot((x - point[0]) * ptPerX(c), (fn(x) - point[1]) * ptPerY(c)))
  }
  return best
}

describe(`RGB LED (${sheet.part}, ${sheet.spec} rev. ${sheet.revision}), line by line`, () => {
  describe("page 1: the part, its dies and its leads", () => {
    it("is the part the datasheet names, a 5 mm full-colour lamp with a common cathode", () => {
      const def = getDef("rgb-led")!
      expect(PART_NUMBER).toBe(sheet.part)
      expect(line("part-number").printed).toContain(PART_NUMBER)
      expect(def.body.some((shape) => shape.type === "text" && shape.text === PART_NUMBER), "the symbol prints the part number").toBe(true)
      expect(def.fields?.map((f) => f.key), "one part, so there is no part to pick or type in").toEqual(["temp"])
      expect(def.name).toMatch(/common cathode/)
      expect(line("title").printed).toMatch(/\(5mm\) FULL COLOR LED LAMP/)
      expect(def.description).toMatch(/5 mm full-colour lamp/)
      expect(line("colours").dies).toEqual(["R", "B", "G"])
      expect(getDef("rgb-led-ca"), "no common-anode Kingbright part shares these dies").toBeUndefined()
    })

    it.each(["R", "B", "G"] as const)("die %s is the material the description names", (id) => {
      const l = line(`material-${id}`) as Line & { material: string }
      expect(die(id).material).toBe(l.material)
    })

    it("has the leads in the datasheet's order: 1 red anode, 2 common cathode, 3 blue anode, 4 green anode", () => {
      const def = getDef("rgb-led")!
      const symbol = line("pinout-symbol") as Line & { commonLead: number; anodes: Record<DieId, number> }
      expect(def.pins.map((p) => p.connectorPin)).toEqual((line("pinout-end-view") as Line & { leads: number[] }).leads)
      expect(def.pins.map((p) => [p.connectorPin, p.id])).toEqual([
        [1, "R"],
        [2, "K"],
        [3, "B"],
        [4, "G"],
      ])
      expect(COMMON_CATHODE_LEAD).toBe(symbol.commonLead)
      expect((line("pinout-cathode-label") as Line & { lead: number }).lead).toBe(COMMON_CATHODE_LEAD)
      for (const d of DIES) expect(d.lead, d.id).toBe(symbol.anodes[d.id])
      expect(def.pins.find((p) => p.id === "K")?.kind).toBe("gnd")
    })

    it.each(["R", "B", "G"] as const)("lead %s forward into lead 2 lights that die and no other; backwards, nothing lights", (id) => {
      const forward = driven(id, 5, 1000)
      const on = settle(forward.doc, 20)
      for (const other of DIES) expect.soft(lit(on, forward.led, other.id), `${other.id} lit`).toBe(other.id === id)
      const back = reversed(id, 3)
      const off = settle(back.doc, 20)
      for (const other of DIES) expect.soft(lit(off, back.led, other.id), `${other.id} lit backwards`).toBe(false)
      expect.soft(off.damage[back.led.id], "3 V backwards is inside the 5 V rating").toBeFalsy()
    })
  })

  describe("page 2: selection guide", () => {
    it.each(["R", "B", "G"] as const)("die %s at 20 mA: the CIE127-2007-traceable typical intensity, never under the minimum", (id) => {
      const l = line(`selection-${id}`) as Line & { mcdTraceable: { min: number; typ: number }; mcd: { min: number; typ: number } }
      const vf = perDie<number>("forward-voltage", "typ")[id]
      const { snap, led, r } = at(id, RATED_TEST_CURRENT, vf, 20)
      const amps = snap.parts[partKey(led.id, id)]?.amps ?? 0
      expect.soft(Math.abs(r.current) * 1e3, "current (mA)").toBeNear(20, 0.2)
      expect.soft(amps, "the snapshot carries the die's current, as the eye averages it").toBeNearRel(Math.abs(r.current), 1e-3)
      const mcd = luminousIntensity(die(id), RATED_TEST_CURRENT)
      expect.soft(mcd, "typical (mcd)").toBe(l.mcdTraceable.typ)
      expect.soft(mcd, "minimum (mcd)").toBeGreaterThanOrEqual(l.mcdTraceable.min)
      expect.soft(luminousIntensity(die(id), amps) / mcd, "at the current it really runs").toBeNear(amps / RATED_TEST_CURRENT, 1e-9)
      if (l.mcd.typ === l.mcdTraceable.typ) expect.soft(mcd, "the older row agrees").toBeNear(l.mcd.typ, l.mcd.typ * INTENSITY_SPREAD)
      else expect.soft(l.mcd.typ / l.mcdTraceable.typ, "the older, untraceable row is another scale").toBeGreaterThan(1 + INTENSITY_SPREAD)
    })

    it("viewing angle 2θ½ = 60°: the drawn spatial distribution halves at ±30° for every die (not simulated: εmul draws no beam)", () => {
      const degrees = (line("selection-viewing-angle") as Line & { degrees: number }).degrees
      for (const id of ["R", "B", "G"] as const) {
        const sd = curves.dies[id].spatialDistribution
        const half: number[] = []
        for (let k = 1; k < sd.points.length; k++) {
          const [a0, r0] = sd.points[k - 1]
          const [a1, r1] = sd.points[k]
          if ((r0 - 0.5) * (r1 - 0.5) < 0) half.push(a0 + ((0.5 - r0) * (a1 - a0)) / (r1 - r0))
        }
        const lineDegrees = (sd.lineWidthRelative * 180) / Math.PI
        expect.soft(half.length, `${id} crossings`).toBe(2)
        expect.soft(half[1] - half[0], `${id} 2θ½`).toBeNear(degrees, 2 * lineDegrees)
      }
    })
  })

  describe("page 2: electrical and optical characteristics at 25 °C", () => {
    it.each(["R", "B", "G"] as const)("die %s: VF at 20 mA within the sheet's ±0.1 V of typical, under the maximum", (id) => {
      const typ = perDie<number>("forward-voltage", "typ")[id]
      const max = perDie<number>("forward-voltage", "max")[id]
      const { snap, led, r } = at(id, RATED_TEST_CURRENT, typ, 20)
      expect.soft(Math.abs(r.current) * 1e3, "current (mA)").toBeNear(20, 0.2)
      expect.soft(r.voltage, "VF, pin to pin").toBeNear(typ, VF_TOLERANCE)
      expect.soft(r.voltage, "VF max").toBeLessThan(max)
      expect.soft(snap.damage[led.id], "intact").toBeFalsy()
    })

    it.each(["R", "B", "G"] as const)("die %s: IR at VR = 5 V under the maximum, intact and dark", (id) => {
      const { volts, max } = line("reverse-current") as Line & { volts: number; max: Record<DieId, number> }
      const { doc, led } = reversed(id, volts)
      const snap = settle(doc, 20)
      const r = reading(snap, led, id)
      expect.soft(r.voltage, "reverse voltage").toBeNear(-volts, 1e-3)
      expect.soft(-r.current, "reverse current (A)").toBeGreaterThanOrEqual(0)
      expect.soft(-r.current, "reverse current (A)").toBeLessThanOrEqual(max[id])
      expect.soft(snap.damage[led.id], "intact").toBeFalsy()
      expect.soft(lit(snap, led, id), "dark").toBe(false)
    })

    it.each(["R", "B", "G"] as const)("die %s: the glow's chromaticity is the CIE 1931 spectral locus at its dominant wavelength", (id) => {
      const nm = perDie<number>("dominant-wavelength", "nm")[id]
      const xy = cie.xy as Record<string, number[]>
      expect(die(id).dominantNm).toBe(nm)
      expect(die(id).chromaticity).toEqual(xy[String(nm)])
      expect(xy[String(nm - WAVELENGTH_TOLERANCE)], "the locus 1 nm either side is on file").toBeDefined()
      expect(xy[String(nm + WAVELENGTH_TOLERANCE)]).toBeDefined()
    })

    it("the drawn spectra peak where the table says; their widths are as drawn (not simulated: the glow is the dominant wavelength)", () => {
      const peaks = perDie<number>("peak-wavelength", "nm")
      const widths = perDie<number>("half-width", "nm")
      const nmPerLine = curves.spectrum.lineWidth.x
      const drawnWidth: Record<DieId, number> = { R: 0, G: 0, B: 0 }
      for (const id of ["R", "B", "G"] as const) {
        const pts = curves.spectrum.curves[id]
        const peak = pts.reduce((a, b) => (b[1] > a[1] ? b : a))
        expect.soft(peak[0], `${id} peak (nm)`).toBeNear(peaks[id], WAVELENGTH_TOLERANCE + nmPerLine)
        const half: number[] = []
        for (let k = 1; k < pts.length; k++) {
          const [x0, y0] = pts[k - 1]
          const [x1, y1] = pts[k]
          if ((y0 - peak[1] / 2) * (y1 - peak[1] / 2) < 0) half.push(x0 + ((peak[1] / 2 - y0) * (x1 - x0)) / (y1 - y0))
        }
        drawnWidth[id] = half[half.length - 1] - half[0]
      }
      expect.soft(drawnWidth.G, "green as tabled").toBeNear(widths.G, 2 * nmPerLine)
      expect.soft(drawnWidth.R, "red is drawn narrower than the 28 nm in the table").toBeNear(25.1, 2 * nmPerLine)
      expect.soft(drawnWidth.B, "blue is drawn narrower than the 25 nm in the table").toBeNear(22.3, 2 * nmPerLine)
    })

    it.each(["R", "B", "G"] as const)("die %s: the capacitance at 0 V is the charge a 3 V reverse step pulls, over 3 V", (id) => {
      const farads = perDie<number>("capacitance", "farads")[id]
      const { doc, place, wire } = builder(GRID)
      const step = place("pulse-source", 0, 0, { high: "3 V", low: "0 V", freq: "1 Hz", duty: "50", delay: "10 ms", rint: "100 kΩ", imax: "1 A" })
      const led = place("rgb-led", 10, 0)
      const gnd = place("ground", 4, 10)
      const feed = wire(step, "+", led, "K")
      wire(led, id, gnd, "GND")
      wire(step, "-", gnd, "GND")
      const loop = new SimLoop()
      loop.setDoc(doc)
      loop.setRunning(true)
      loop.advance(0)
      loop.advance(9)
      loop.snapshot()
      loop.advance(19)
      const charging = loop.snapshot()!
      loop.advance(29)
      const leaking = loop.snapshot()!
      loop.dispose()
      const windowSeconds = 0.01
      const reverseBiasedSeconds = 0.009
      const charge = charging.wireCurrent[feed.id] * windowSeconds - leaking.wireCurrent[feed.id] * reverseBiasedSeconds
      const across = charging.pinVoltage[pinKey(led.id, "K")] - charging.pinVoltage[pinKey(led.id, id)]
      expect.soft(across, "the step reached the die").toBeNear(3, 0.01)
      expect.soft(Math.abs(charge) / across, "C (F)").toBeNear(farads, farads * 0.02)
    })
  })

  describe("page 2: absolute maximum ratings at 25 °C", () => {
    it.each(["R", "B", "G"] as const)("die %s: at the DC rating it dissipates under its power rating, so the current rating is the one that binds", (id) => {
      const watts = perDie<number>("power-dissipation", "watts")[id]
      const amps = perDie<number>("dc-forward-current", "amps")[id]
      const vf = perDie<number>("forward-voltage", "typ")[id]
      const { snap, led, r } = at(id, amps * 0.99, vf + 0.1, 20)
      expect.soft(r.limits?.power, "power rating (W)").toBeNear(watts, 1e-12)
      expect.soft(r.power, "dissipation at the DC rating (W)").toBeLessThan(watts)
      expect.soft(r.load, "load: the current's").toBeNear((amps * 0.99) / amps, 0.01)
      expect.soft(snap.damage[led.id], "intact").toBeFalsy()
    })

    it.each(["R", "B", "G"] as const)("die %s: 3 per cent under the DC forward current runs for 2 s, 10 per cent over burns it open alone", (id) => {
      const amps = perDie<number>("dc-forward-current", "amps")[id]
      const vf = perDie<number>("forward-voltage", "typ")[id]
      const under = at(id, amps * 0.97, vf, 2000)
      expect.soft(under.snap.damage[under.led.id], "intact under").toBeFalsy()
      expect.soft(lit(under.snap, under.led, id), "lit").toBe(true)
      const over = at(id, amps * 1.1, vf + 0.1, 500)
      const damage = over.snap.damage[over.led.id]
      expect.soft(damage?.element, "this die").toBe(DIES.findIndex((d) => d.id === id))
      expect.soft(damage?.reason ?? "", "by its current").toMatch(/^current /)
      expect.soft(damage?.fail, "open").toBe("open")
      expect.soft(damage?.fatal, "the other dies live on").toBeFalsy()
    })

    it.each(["R", "B", "G"] as const)("die %s: the peak current in 0.1 ms pulses at 1/10 duty is ridden out; 5 per cent past it burns at once; held, it burns", (id) => {
      const { amps, duty, pulse } = line("peak-forward-current") as Line & { amps: Record<DieId, number>; duty: number; pulse: number }
      const peak = amps[id]
      const probe = at(id, peak, 1, 1)
      expect.soft(probe.snap.damage[probe.led.id], "a millisecond at the peak is nothing").toBeFalsy()
      const volts = probe.r.voltage
      const pulsed = (current: number) => {
        const ohms = 100
        const { doc, place, wire } = builder(GRID)
        const source = place("pulse-source", 0, 0, { high: `${fmt(volts + current * ohms)} V`, low: "0 V", freq: `${1 / (pulse / duty)} Hz`, width: `${pulse} s`, rint: `${ohms} Ω`, imax: "5 A" })
        const led = place("rgb-led", 10, 0)
        const gnd = place("ground", 4, 10)
        wire(source, "+", led, id)
        wire(led, "K", gnd, "GND")
        wire(source, "-", gnd, "GND")
        let top = 0
        const loop = new SimLoop()
        loop.setDoc(doc)
        loop.setRunning(true)
        loop.advance(0)
        for (let tick = 1; tick <= 400; tick++) {
          loop.advance(tick < 100 ? tick * 0.02 : 2 + (tick - 100))
          const snap = loop.snapshot()!
          top = Math.max(top, Math.abs(reading(snap, led, id)?.current ?? 0))
          if (snap.damage[led.id]) break
        }
        const snap = loop.snapshot()!
        loop.dispose()
        return { snap, led, top }
      }
      const rated = pulsed(peak * 0.98)
      expect.soft(rated.top / peak, "pulses reach the peak").toBeGreaterThan(0.95)
      expect.soft(rated.snap.damage[rated.led.id], "ridden out for 0.3 s").toBeFalsy()
      const over = pulsed(peak * 1.05)
      expect.soft(over.snap.damage[over.led.id]?.reason ?? "", "past the peak rating").toMatch(new RegExp(`^surge current [\\d.]+ mA exceeds the ${peak * 1000}(\\.0+)? mA rating`))
      expect.soft(over.snap.time, "at the first pulse").toBeLessThan(0.002)
      const held = at(id, peak * 0.98, volts, 200)
      expect.soft(held.snap.damage[held.led.id]?.reason ?? "", "held, the heat builds").toMatch(/^(current|power) /)
    })

    it.each(["R", "B", "G"] as const)("die %s: 4.9 V reversed is ridden out; 5.2 V is past the 5 V rating and burns it open alone", (id) => {
      const volts = (line("reverse-voltage") as Line & { volts: number }).volts
      expect(die(id).ratings.reverseVolts).toBe(volts)
      const under = reversed(id, volts - 0.1)
      const kept = settle(under.doc, 50)
      expect.soft(kept.damage[under.led.id], "intact").toBeFalsy()
      const over = reversed(id, volts + 0.2)
      const gone = settle(over.doc, 50)
      const damage = gone.damage[over.led.id]
      expect.soft(damage?.element, "this die").toBe(DIES.findIndex((d) => d.id === id))
      expect.soft(damage?.reason ?? "", "reverse voltage").toMatch(/^voltage 5\.\d+ V exceeds the 5(\.0+)? V rating/)
      expect.soft(damage?.fatal, "the others live on").toBeFalsy()
    })

    it("operating and storage temperature −40…+85 °C: the ambient field spans exactly that", () => {
      const range = line("temperature-range") as Line & { min: number; max: number }
      const field = getDef("rgb-led")!.fields!.find((f) => f.key === "temp")
      expect(field).toMatchObject({ type: "range", min: range.min, max: range.max })
      expect([AMBIENT.min, AMBIENT.max]).toEqual([range.min, range.max])
      expect(getDef("rgb-led")!.defaults?.temp).toBe(String(AMBIENT.reference))
    })
  })

  describe("pages 3–5: the curves, at every digitised point", () => {
    describe.each(["R", "B", "G"] as const)("die %s", (id) => {
      const iv = curve(id, "forwardVoltage")

      it("forward current vs forward voltage: held at each solid point's voltage and pushed its current, the die settles within one printed line width of it", () => {
        const sx = ptPerX(iv)
        const sy = ptPerY(iv)
        let worst = 0
        for (const p of iv.points) {
          const amps = Math.max(0, p[1]) / 1000
          const heldRun = driven(id, p[0], 1e-3)
          const held = reading(settle(heldRun.doc, 2), heldRun.led, id)
          const pushedRun = driven(id, p[0] + amps * 1e4, 1e4)
          const pushed = reading(settle(pushedRun.doc, 2), pushedRun.led, id)
          const d = distanceToChord(p, [held.voltage, held.current * 1000], [pushed.voltage, pushed.current * 1000], sx, sy)
          worst = Math.max(worst, d)
          expect.soft(d, `${p[0]} V, ${p[1]} mA: ${held.voltage.toFixed(4)} V gives ${(held.current * 1000).toFixed(3)} mA, ${(pushed.current * 1000).toFixed(3)} mA needs ${pushed.voltage.toFixed(4)} V (pt)`).toBeLessThanOrEqual(iv.lineWidthPt)
        }
        expect(worst).toBeLessThanOrEqual(iv.lineWidthPt)
      })

      it("forward current vs forward voltage, the dashed continuation past the DC rating: within the sheet's ±0.1 V", () => {
        const dashed = [iv.points[iv.points.length - 1], ...iv.dashed].map(([v, mA]) => [mA, v])
        for (const p of iv.dashed) {
          if (p[1] <= iv.points[iv.points.length - 1][1]) continue
          const { r, snap, led } = at(id, p[1] / 1000, p[0], 2)
          const want = interpolate(dashed, r.current * 1000)
          expect.soft(r.voltage - want, `${p[1]} mA (V)`).toBeNear(0, VF_TOLERANCE)
          expect.soft(snap.damage[led.id], "two milliseconds past the rating is survived").toBeFalsy()
        }
      })

      it("luminous intensity vs forward current: within one printed line width of every point", () => {
        const c = curve(id, "luminousIntensityVsCurrent")
        const rel = (mA: number) => luminousIntensity(die(id), mA / 1000) / die(id).millicandelaAt20mA
        for (const p of c.points) expect.soft(distanceToCurve(rel, p, c, Math.max(0, p[0] - 3), p[0] + 3), `${p[0]} mA (pt)`).toBeLessThanOrEqual(c.lineWidthPt)
        expect(rel(20)).toBe(1)
      })

      it("luminous intensity vs ambient temperature: within one printed line width of every point", () => {
        const c = curve(id, "luminousIntensityVsTemperature")
        const rel = (t: number) => intensityVsAmbient(die(id), t)
        for (const p of c.points) expect.soft(distanceToCurve(rel, p, c, p[0] - 5, p[0] + 5), `${p[0]} °C (pt)`).toBeLessThanOrEqual(c.lineWidthPt)
        expect(rel(25)).toBe(1)
      })

      it("forward current derating: within one printed line width of every point, and the drop to nothing at the 85 °C end of the range", () => {
        const c = curve(id, "derating")
        const mA = (t: number) => deratedCurrent(die(id), Math.min(AMBIENT.max, t)) * 1000
        const [drop, ...rest] = c.points.filter((p) => p[0] > 80).sort((a, b) => a[1] - b[1])
        for (const p of c.points) {
          if (p === drop) continue
          expect.soft(distanceToCurve(mA, p, c, Math.max(-40, p[0] - 5), Math.min(AMBIENT.max, p[0] + 5)), `${p[0]} °C, ${p[1]} mA (pt)`).toBeLessThanOrEqual(c.lineWidthPt)
        }
        expect.soft(rest.length, "the curve's last knee before the drop").toBe(1)
        expect.soft(drop[0], "the drop sits at the top of the range (°C)").toBeNear(AMBIENT.max, c.lineWidth.x)
        expect.soft(drop[1], "down to the axis (mA)").toBeLessThanOrEqual(c.lineWidth.y)
      })

      it.each([50, 85])("derated at %i °C on the field: 3 per cent under runs for 2 s, 10 per cent over burns it", (celsius) => {
        const amps = deratedCurrent(die(id), celsius)
        const vf = perDie<number>("forward-voltage", "typ")[id]
        const props = { temp: String(celsius) }
        const under = at(id, amps * 0.97, vf - 0.2, 2000, props)
        expect.soft(under.snap.damage[under.led.id], "intact").toBeFalsy()
        const over = at(id, amps * 1.1, vf - 0.2, 1000, props)
        expect.soft(over.snap.damage[over.led.id]?.reason ?? "", "burnt by its current").toMatch(/^current /)
      })
    })
  })

  describe("the package's glow: the light of the three dies, added", () => {
    const light = (mA: number) => ({ level: Math.min(1, mA / 8), amps: mA / 1000 })
    const at20 = light(20)
    it.each([
      ["red alone", [at20, undefined, undefined], "rgb(255 0 0)"],
      ["green alone", [undefined, at20, undefined], "rgb(0 255 0)"],
      ["blue alone", [undefined, undefined, at20], "rgb(0 0 255)"],
      ["red and green at 20 mA each: the green's 1300 mcd swamps the red's 200, still green", [at20, at20, undefined], "rgb(0 255 0)"],
      ["red at 20 mA and green at 2 mA: orange", [at20, light(2), undefined], "rgb(255 97 0)"],
      ["green and blue: a sky blue", [undefined, at20, at20], "rgb(0 155 255)"],
      ["red and blue: violet, the blue's radiance leading", [at20, undefined, at20], "rgb(110 0 255)"],
      ["all three at 20 mA: not white but a sky blue, the blue die's radiance winning", [at20, at20, at20], "rgb(0 152 255)"],
      ["red 20 mA, green 7.23 mA, blue 2.37 mA: the D65 white of this part (28, 67 and 5 per cent of the luminance)", [at20, light(7.23), light(2.37)], "rgb(255 255 255)"],
    ] as const)("%s", (_, lights, color) => {
      expect(rgbLedGlow(lights)?.color).toBe(color)
    })

    it("follows the dies' intensity-vs-current curve: half the current is half the light, the hue unchanged", () => {
      expect(rgbLedGlow([light(4), undefined, undefined])).toEqual({ color: "rgb(255 0 0)", level: 0.5 })
      expect(rgbLedGlow([at20, light(2), undefined])?.color, "the red's share follows the currents, not the 8 mA the eye calls full").not.toBe(rgbLedGlow([at20, light(20), undefined])?.color)
    })

    it("follows the ambient: at 85 °C the red keeps 45 per cent of its light, the blue 90, and violet turns bluer and dimmer", () => {
      expect(intensityVsAmbient(die("R"), AMBIENT.max)).toBeNear(0.45, 0.025)
      expect(intensityVsAmbient(die("B"), AMBIENT.max)).toBeNear(0.9, 0.025)
      const warm = rgbLedGlow([at20, undefined, at20], AMBIENT.reference)!
      const hot = rgbLedGlow([at20, undefined, at20], AMBIENT.max)!
      const [r25, , b25] = warm.color.match(/\d+/g)!.map(Number)
      const [r85, , b85] = hot.color.match(/\d+/g)!.map(Number)
      expect([b25, b85]).toEqual([255, 255])
      expect(r85).toBeLessThan(r25)
      expect(hot.level).toBeNear(intensityVsAmbient(die("B"), AMBIENT.max), 1e-9)
    })

    it("is dark with every die dark", () => {
      expect(rgbLedGlow([undefined, undefined, undefined])).toBeNull()
      expect(rgbLedGlow([{ level: 0, amps: 0 }, { level: 0, amps: 0 }, { level: 0, amps: 0 }])).toBeNull()
    })

    it("on the field, red through 150 Ω and green through 680 Ω from 5 V glow orange, blue dark", () => {
      const { doc, place, wire } = builder(GRID)
      const supply = place("dc-source", 0, 0, { value: "5 V" })
      const rr = place("resistor", 8, 0, { value: "150 Ω" })
      const rg = place("resistor", 8, 4, { value: "680 Ω" })
      const led = place("rgb-led", 16, 0)
      const gnd = place("ground", 4, 10)
      wire(supply, "-", gnd, "GND")
      wire(supply, "+", rr, "1")
      wire(supply, "+", rg, "1")
      wire(rr, "2", led, "R")
      wire(rg, "2", led, "G")
      wire(led, "K", gnd, "GND")
      const snap = settle(doc, 200)
      const lights = DIES.map((d) => snap.parts[partKey(led.id, d.id)])
      expect(lights[2]?.level ?? 0, "blue dark").toBe(0)
      const [r, g, b] = rgbLedGlow(lights)!.color.match(/\d+/g)!.map(Number)
      expect([r, g > 60 && g < 200, b]).toEqual([255, true, 0])
    })
  })

  describe("every line of the sheet is accounted for", () => {
    const AGAINST_THE_MODEL = new Set([
      "title", "part-number", "colours", "material-R", "material-B", "material-G",
      "pinout-cathode-label", "pinout-end-view", "pinout-symbol",
      "selection-R", "selection-B", "selection-G", "selection-note-2", "selection-note-traceable",
      "dominant-wavelength", "capacitance", "forward-voltage", "reverse-current", "characteristics-note-1", "characteristics-note-2",
      "power-dissipation", "dc-forward-current", "peak-forward-current", "reverse-voltage", "temperature-range", "ratings-note-1",
      ...["R", "B", "G"].flatMap((id) => ["forward-voltage", "intensity-current", "derating", "intensity-temperature"].map((c) => `curve-${c}-${id}`)),
    ])
    const AGAINST_THE_TABLE = new Set(["selection-viewing-angle", "selection-note-1", "peak-wavelength", "half-width", "curve-spectrum", "curve-spatial-R", "curve-spatial-B", "curve-spatial-G"])
    const NOT_SIMULATED: Record<string, string> = {
      "esd-attention": "εmul has no electrostatic discharge",
      "characteristics-note-3": "a statement of calibration; the wavelengths themselves are checked above",
      "esd-damage": "εmul has no electrostatic discharge; surges are the peak-current rating, checked above",
      "esd-wrist-band": "handling advice",
      "esd-grounding": "handling advice",
      "feature-uniform": "a marketing claim with no number",
      "feature-low-power": "a marketing claim with no number",
      "feature-long-life": "εmul does not age an LED",
      "feature-rohs": "material compliance",
      "dimension-lens": "a schematic symbol has no body",
      "dimension-flange": "a schematic symbol has no body",
      "dimension-body": "a schematic symbol has no body",
      "dimension-lead-length": "a schematic symbol has no body",
      "dimension-flange-thickness": "a schematic symbol has no body",
      "dimension-flange-protrusion": "a schematic symbol has no body",
      "dimension-lead-kink": "a schematic symbol has no body",
      "dimension-lead-section": "a schematic symbol has no body",
      "dimension-lead-pitch": "a schematic symbol has no body; the lead order is checked above",
      "dimension-short-leads": "a schematic symbol has no body; lead 2 as the cathode is checked above",
      "dimension-lead-3": "a schematic symbol has no body",
      "package-note-1": "units of the drawing",
      "package-note-2": "tolerance of the drawing",
      "package-note-3": "how the drawing is measured",
      "package-note-4": "a disclaimer",
      "compliance-marks": "material compliance",
      "selection-lens": "the lens is drawn as the glow; a diffused lens is what makes one mixed colour",
      "lead-solder-2mm": "εmul has no soldering",
      "lead-solder-5mm": "εmul has no soldering",
      "ratings-note-2": "εmul has no soldering",
      "ratings-note-3": "εmul has no soldering",
      "packing-bag": "packing",
      "packing-box-5": "packing",
      "packing-box-9": "packing",
      "packing-label": "packing",
      "precaution-1": "assembly advice",
      "precaution-2": "assembly advice",
      "precaution-3": "assembly advice",
      "precaution-4": "assembly advice",
      "precaution-5": "assembly advice",
      "precaution-6": "assembly advice",
      "precaution-7": "assembly advice",
      "precaution-8": "assembly advice",
      "precaution-9": "εmul has no soldering",
      "precaution-10": "εmul has no soldering",
      "wave-profile": "εmul has no soldering",
      "wave-note-1": "εmul has no soldering",
      "wave-note-2": "εmul has no soldering",
      "wave-note-3": "εmul has no soldering",
      "wave-note-4": "εmul has no soldering",
      "wave-note-5": "εmul has no soldering",
      "wave-note-6": "εmul has no soldering",
      "application-notes": "a reference",
    }

    it("each line is checked against the model, checked against the table it belongs with, or listed with the reason it is not simulated", () => {
      const ids = sheet.lines.map((l) => l.id)
      expect(new Set(ids).size, "no line twice").toBe(ids.length)
      const groups = [AGAINST_THE_MODEL, AGAINST_THE_TABLE, new Set(Object.keys(NOT_SIMULATED))]
      expect(ids.filter((id) => groups.filter((g) => g.has(id)).length !== 1), "each line in exactly one group").toEqual([])
      expect(groups.flatMap((g) => [...g]).filter((id) => !ids.includes(id)), "no stale ids").toEqual([])
      expect(groups.map((g) => g.size), "model, table, not simulated").toEqual([38, 8, 52])
    })

    it("the digitised curves come from the sheet on file", () => {
      expect(curves.sha256).toBe(sheet.sha256)
      const points = (["R", "B", "G"] as const).reduce((n, id) => {
        const d = curves.dies[id]
        return n + d.forwardVoltage.points.length + d.forwardVoltage.dashed.length + d.luminousIntensityVsCurrent.points.length + d.derating.points.length + d.luminousIntensityVsTemperature.points.length
      }, 0)
      expect(points).toBeGreaterThan(150)
    })
  })
})

