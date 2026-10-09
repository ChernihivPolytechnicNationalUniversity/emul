import { describe, expect, it } from "vitest"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { BUZZER_PRESETS, transducer, type BuzzerPreset } from "@/sim/buzzer"
import type { Probe } from "@/sim/loop"
import { across, levelAt, lowSide, meanCurrentOf, N2N7000, sound, start } from "../lib/buzzer-bench"

describe("passive magnetic buzzer: CUI CEM-1203(42)", () => {
  it("reads its datasheet on its own test circuit: 3.5 Vo-p square at 2048 Hz, ½ duty, 95 dB(A) at 10 cm", () => {
    const s = levelAt("2048 Hz")
    expect.soft(s.level ?? 0, "level (dBA)").toBeNear(95, 1)
    expect.soft(s.tone ?? 0, "tone (Hz)").toBeNear(2048, 20)
    expect.soft(s.drive, "coil voltage (V)").toBeNear(3.5, 0.2)
    expect.soft(s.warnings, "nothing to say").toEqual([])
  })

  it("follows the datasheet's frequency curve: a main mode near 2.1 kHz and a second near 4.27 kHz", () => {
    const sweep = (from: number, to: number, step: number) => {
      let best = { hz: 0, db: -Infinity }
      for (let hz = from; hz <= to; hz += step) {
        const db = levelAt(`${hz} Hz`).unweighted ?? -Infinity
        if (db > best.db) best = { hz, db }
      }
      return best
    }
    const main = sweep(1900, 2300, 40)
    expect.soft(main.hz, "main peak (Hz)").toBeNear(2080, 60)
    expect.soft(main.db, "main peak, the datasheet's 94.8 dB (dB SPL)").toBeNear(94.8, 2)
    const second = sweep(3900, 4600, 70)
    expect.soft(second.hz, "second peak (Hz)").toBeNear(4270, 140)
    expect.soft(second.db, "second peak, the datasheet's 88.4 dB (dB SPL)").toBeNear(88.4, 3.5)
    expect.soft(levelAt("3 kHz").unweighted ?? 0, "between the peaks, 73 dB on the curve (dB SPL)").toBeNear(73, 4)
    expect.soft(levelAt("7 kHz").unweighted ?? 0, "above them, 70.7 dB on the curve (dB SPL)").toBeNear(70.7, 4)
  })

  it("sounds loud where a harmonic of the drive lands on the resonance: 2080 / 3 Hz beats its neighbours", () => {
    const third = levelAt("693 Hz").unweighted ?? 0
    expect.soft(third - (levelAt("600 Hz").unweighted ?? 0), "f1/3 over 600 Hz (dB)").toBeGreaterThan(3)
    expect.soft(third - (levelAt("800 Hz").unweighted ?? 0), "f1/3 over 800 Hz (dB)").toBeGreaterThan(3)
  })

  it("is quieter than rated under its operating range, in proportion to its current, and says so", () => {
    const bench = lowSide({ hz: "2048 Hz", supply: "1.5 V" })
    const snap = sound(start(bench.doc).run(0.2), bench.bz)
    expect.soft(snap.level ?? 0, "1.5 V: 20·log(1.5/3.5) under rated (dBA)").toBeNear(95 + 20 * Math.log10(1.5 / 3.5), 1)
    expect.soft(snap.warnings.join(" "), "warns").toContain("under its 3–5 V operating range")
  })

  it("on DC: a click, then silence, the coil heats, and 5 V burns it open in about two seconds", () => {
    const { doc, bz } = across("cem-1203-42", { kind: "dc", volts: 5 })
    const t = start(doc)
    let clicked = -Infinity
    let snap = t.run(0.05, (s) => (clicked = Math.max(clicked, sound(s, bz).level ?? -Infinity)))
    expect.soft(clicked, "the switch-on edge is heard (dBA)").toBeGreaterThan(60)
    snap = t.run(0.6)
    expect.soft(sound(snap, bz).level, "then nothing").toBeNull()
    expect.soft(sound(snap, bz).state, "state").toContain("DC")
    expect.soft(sound(snap, bz).warnings.join(" "), "warns").toContain("DC through a passive buzzer")
    expect.soft(snap.damage[bz.id], "not yet").toBeFalsy()
    snap = t.run(2)
    expect.soft(snap.damage[bz.id]?.reason ?? "", "0.6 W against the 0.3 W the coil takes at 5 V ½ duty").toContain("power")
    expect.soft(snap.damage[bz.id]?.fail ?? "?", "the coil opens").toBe("open")
  })

  it("3 V of DC only warms it", () => {
    const { doc, bz } = across("cem-1203-42", { kind: "dc", volts: 3 })
    expect.soft(start(doc).run(4).damage[bz.id], "0.21 W is within the coil's rating").toBeFalsy()
  })

  it("lets its coil's current go through a flyback diode; without one the kick is too short for the step, and the 2N7000 lives", () => {
    const drain = (bench: ReturnType<typeof lowSide>): Probe => ({ id: "drain", a: pinKey(bench.q.id, "D"), b: null })
    const clamped = lowSide({ hz: "2048 Hz", fet: N2N7000 })
    let snap = start(clamped.doc, [drain(clamped)]).run(0.1)
    expect.soft(snap.probes.drain.max, "clamped at the rail and a diode drop (V)").toBeLessThan(3.5 + 1.2)
    const bare = lowSide({ hz: "2048 Hz", fet: N2N7000, flyback: false })
    snap = start(bare.doc, [drain(bare)]).run(0.1)
    expect.soft(snap.probes.drain.max, "the drain kicks well past the rail, read as the 20 µs step's share of a 2 µs avalanche (V)").toBeGreaterThan(3.5 + 5)
    expect.soft(snap.damage[bare.q.id], "½·1.65 mH·(83 mA)² is 6 µJ a cycle: nothing to it").toBeFalsy()
    expect.soft(sound(snap, bare.bz).level ?? 0, "and the buzzer still sounds (dBA)").toBeGreaterThan(85)
  })
})

describe("active magnetic buzzer: TMB12A05", () => {
  const meanCurrent = (doc: Schematic, wireId: string, seconds: number) => {
    const t = start(doc)
    t.run(0.05)
    let sum = 0
    let n = 0
    const snap = t.run(seconds, (s) => {
      sum += Math.abs(s.wireCurrent[wireId] ?? 0)
      n++
    })
    return { snap, amps: sum / n }
  }

  it("on 5 V DC reads the mean of Huaneng's ten-sample test report: 96.6 dB, 23.0 mA, 2407 Hz", () => {
    const { doc, bz, feed } = across("tmb12a05", { kind: "dc", volts: 5 })
    const { snap, amps } = meanCurrent(doc, feed.id, 0.2)
    expect.soft(sound(snap, bz).unweighted ?? 0, "sound pressure at 10 cm (dB)").toBeNear(96.6, 0.3)
    expect.soft(sound(snap, bz).tone ?? 0, "tone (Hz)").toBeNear(2407, 1)
    expect.soft(amps * 1e3, "mean supply current (mA)").toBeNear(23.04, 0.3)
  })

  it("stays silent below the voltage its oscillator starts at, and reversed", () => {
    for (const volts of [2, -5]) {
      const { doc, bz, feed } = across("tmb12a05", { kind: "dc", volts })
      const { snap, amps } = meanCurrent(doc, feed.id, 0.2)
      const s = sound(snap, bz)
      expect.soft(s.level, `${volts} V: silent`).toBeNull()
      expect.soft(amps * 1e3, `${volts} V: next to no current (mA)`).toBeLessThan(0.1)
      expect.soft(s.warnings.join(" "), `${volts} V: says why`).toMatch(volts < 0 ? /Reversed/ : /below the 2.4 V its oscillator needs/)
    }
  })

  it("reversed, conducts only past its transistor's emitter–base breakdown: 5 V for 5 s leaves it whole, 12 V from a stiff supply kills it in seconds", () => {
    const five = across("tmb12a05", { kind: "dc", volts: -5 })
    const { snap, amps } = meanCurrent(five.doc, five.feed.id, 5)
    expect.soft(amps * 1e3, "−5 V: next to no current (mA)").toBeLessThan(0.1)
    expect.soft(sound(snap, five.bz).level, "−5 V: silent").toBeNull()
    expect.soft(snap.damage[five.bz.id], "−5 V: unharmed").toBeFalsy()
    const twelve = across("tmb12a05", { kind: "dc", volts: -12 })
    const t = start(twelve.doc)
    let snap12 = t.run(0.3)
    expect.soft(Math.abs(snap12.wireCurrent[twelve.feed.id] ?? 0) * 1e3, "−12 V: (12 − 7.7 V) through the 100 Ω path (mA)").toBeNear(42, 5)
    expect.soft(sound(snap12, twelve.bz).warnings.join(" "), "says why it heats").toMatch(/breaks down and conducts about 4\d mA, more than it takes for long/)
    expect.soft(snap12.damage[twelve.bz.id], "not at once").toBeFalsy()
    snap12 = t.run(3)
    expect.soft(snap12.damage[twelve.bz.id]?.reason ?? "", "−12 V: dead within a few seconds").toContain("power")
  })

  it("gets louder and draws more along Huaneng's 2023 dB–V and mA–V curves, and 12 V cooks it", () => {
    const at = (volts: number) => {
      const { doc, bz, feed } = across("tmb12a05", { kind: "dc", volts })
      const { snap, amps } = meanCurrent(doc, feed.id, 0.2)
      return { db: sound(snap, bz).unweighted ?? 0, ma: amps * 1e3 }
    }
    const scale = 23.04 / 22.67
    for (const [volts, db, ma] of [[3, 86.7, 13.03], [4, 88.83, 17.79], [7, 92.21, 30.15]]) {
      const got = at(volts)
      expect.soft(got.db, `${volts} V: the curve's shape on the report's 96.6 dB (dB)`).toBeNear(96.6 + db - 90.34, 0.3)
      expect.soft(got.ma, `${volts} V: the curve's current (mA)`).toBeNear(ma * scale, 0.4)
    }
    const { doc, bz } = across("tmb12a05", { kind: "dc", volts: 12 })
    const snap = start(doc).run(4)
    expect.soft(snap.damage[bz.id]?.reason ?? "", "dead past its rating").toContain("power")
  })

  it("only gates its own tone when its supply is switched like tone(): the pitch does not follow", () => {
    const bench = lowSide({ model: "tmb12a05", supply: "5 V", hz: "440 Hz", flyback: false })
    const snap = start(bench.doc).run(0.3)
    const s = sound(snap, bench.bz)
    expect.soft(s.warnings.join(" "), "warns").toContain("cannot play another pitch")
    expect.soft(s.heard?.tone ?? s.tone ?? 0, "what it sounds is still its own tone (Hz)").toBeNear(2407, 5)
  })
})

describe("passive magnetic buzzers on their datasheets' own test circuit: a low-side switch with a diode across the coil", () => {
  it.each([
    ["CEM-1203(42)", "cem-1203-42", "3.5 V", "2048 Hz", { db: 95, weighted: true, ma: 35 }],
    ["AT-1224-TWT-5V-2-R", "at-1224-twt-5v-2", "5 V", "2400 Hz", { db: 95.3, weighted: false, ma: 40 }],
    ["CMT-0904-83T", "cmt-0904-83t", "3 V", "2730 Hz", { db: 89.1, weighted: false, ma: 90 }],
  ] as const)("%s reads its rated sound pressure and draws its rated mean current", (_, model, supply, hz, want) => {
    const bench = lowSide({ model, supply, hz })
    const { snap, amps } = meanCurrentOf(bench.doc, bench.source.id)
    const s = sound(snap, bench.bz)
    expect.soft((want.weighted ? s.level : s.unweighted) ?? 0, `sound pressure at 10 cm (${want.weighted ? "dB(A)" : "dB"})`).toBeNear(want.db, 0.5)
    expect.soft(amps * 1e3, "mean supply current (mA)").toBeNear(want.ma, want.ma * 0.03)
  })
})

describe("active magnetic buzzer: CUI CMI-9650C-030, against its datasheet's curves", () => {
  it.each([
    [2, 81.04, 14.98],
    [3, 85.25, 18.3],
    [4, 89.45, 22.88],
    [4.5, 91.56, 25.42],
  ])("on %s V reads %s dB(A) and draws %s mA", (volts, dba, ma) => {
    const { doc, bz, feed } = across("cmi-9650c-030", { kind: "dc", volts })
    const { snap, amps } = meanCurrentOf(doc, feed.id)
    expect.soft(sound(snap, bz).level ?? 0, "sound pressure at 10 cm (dB(A))").toBeNear(dba, 0.3)
    expect.soft(amps * 1e3, "current (mA)").toBeNear(ma, 0.3)
  })
})

describe("active magnetic buzzer: TDK SDC1610M5-01, against its catalogue's curves", () => {
  const curve = { 4: { dba: 89.31, hz: 2468, ma: 15.85 }, 5: { dba: 90.22, hz: 2426, ma: 19.53 }, 6: { dba: 91.07, hz: 2383, ma: 22.42 }, 7: { dba: 91.84, hz: 2340, ma: 24.55 } }

  it.each(Object.entries(curve))("at %s V reads TDK's sound pressure, tone and current", (volts, want) => {
    const { doc, bz, feed } = across("sdc1610m5-01", { kind: "dc", volts: Number(volts) })
    const t = start(doc)
    t.run(0.05)
    let sum = 0
    let n = 0
    const snap = t.run(0.2, (s) => {
      sum += Math.abs(s.wireCurrent[feed.id] ?? 0)
      n++
    })
    const s = sound(snap, bz)
    expect.soft(s.level ?? 0, "sound pressure at 10 cm (dB(A))").toBeNear(want.dba, 0.3)
    expect.soft(s.tone ?? 0, "oscillation frequency (Hz)").toBeNear(want.hz, 3)
    expect.soft((sum / n) * 1e3, "average current (mA)").toBeNear(want.ma, 0.3)
  })
})

describe("piezo sounders", () => {
  it("PKM13EPYH4000-A0 straight on a 3 Vp-p square at 4 kHz reads its datasheet's typical 78 dB", () => {
    const { doc, bz } = across("pkm13epyh4000-a0", { kind: "square", volts: 3, hz: "4 kHz", rint: "25 Ω" })
    const s = sound(start(doc).run(0.15), bz)
    expect.soft(s.unweighted ?? 0, "sound pressure at 10 cm, unweighted as Murata measures it (dB)").toBeNear(78, 0.3)
    expect.soft(s.tone ?? 0, "tone (Hz)").toBeNear(4000, 30)
  })

  it("PKM13EPYH4000-A0 on a 3 Vp-p square swept 1–10 kHz follows Murata's 2022 response curve, the bumps where its 3rd harmonic lands on the resonances included", () => {
    const level = (hz: number) => {
      const bench = across("pkm13epyh4000-a0", { kind: "square", volts: 3, hz: `${hz} Hz`, rint: "25 Ω" })
      return sound(start(bench.doc).run(0.12), bench.bz).unweighted ?? 0
    }
    const curve: [number, number, number][] = [
      [1300, 67.9, 2.5],
      [1600, 68.1, 1.5],
      [2500, 56.0, 1.5],
      [3800, 69.7, 1.5],
      [4400, 74.0, 1.5],
      [4900, 77.6, 1.5],
      [6000, 69.1, 1.5],
      [6850, 69.7, 1.5],
      [8600, 71.1, 1.5],
      [9500, 64.6, 1.5],
    ]
    const base = level(4000)
    for (const [hz, db, tol] of curve) expect.soft(level(hz) - base, `${hz} Hz against 4 kHz, the fit's own residual within ${tol} dB (dB)`).toBeNear(db - 77.14, tol)
  })

  it.each([
    ["PKM17EPP-2002-B0", "pkm17epp-2002-b0", 2000, { 2023: 80.31, 2746: 86.28, 6101: 79.64 }],
  ] as const)("%s on a 1 Vrms sine sweep peaks where Murata's response curve does, by as much", (_, model, reference, peaks) => {
    const level = (hz: number) => {
      const bench = across(model, { kind: "sine", rms: 1, hz })
      return sound(start(bench.doc).run(0.12), bench.bz).unweighted ?? 0
    }
    const base = level(reference)
    const curveAt = { 4000: 79.67, 2000: 79.95 }[reference]
    for (const [hz, db] of Object.entries(peaks)) expect.soft(level(Number(hz)) - base, `${hz} Hz against ${reference} Hz (dB)`).toBeNear(db - curveAt, 0.5)
  })

  it("loses 3 dB of fundamental at 25 % duty and the same at 75 %", () => {
    const at = (duty: string) => {
      const { doc, bz } = across("pkm13epyh4000-a0", { kind: "square", volts: 3, hz: "4 kHz", duty, rint: "25 Ω" })
      return sound(start(doc).run(0.15), bz).level ?? 0
    }
    const half = at("50")
    expect.soft(at("25") - half, "25 % (dB)").toBeNear(-3, 1)
    expect.soft(at("75") - half, "75 % (dB)").toBeNear(-3, 1)
  })

  it("is silent on DC and warns about the bias", () => {
    const { doc, bz } = across("pkm13epyh4000-a0", { kind: "dc", volts: 3 })
    const snap = start(doc).run(0.8)
    expect.soft(sound(snap, bz).level, "silent").toBeNull()
    expect.soft(sound(snap, bz).warnings.join(" "), "warns").toContain("DC across a piezo")
  })

  it.each([
    [5, 89.48, 4.26],
    [8, 93.72, 7.33],
    [12, 98.15, 12.44],
    [15, 100.65, 17.5],
  ])("PKB24SPCH3601-B0 on %s V reads Murata's curves: %s dB, %s mA, at its 3.6 kHz", (volts, db, ma) => {
    const { doc, bz, feed } = across("pkb24spch3601-b0", { kind: "dc", volts })
    const { snap, amps } = meanCurrentOf(doc, feed.id)
    const s = sound(snap, bz)
    expect.soft(s.unweighted ?? 0, "sound pressure at 10 cm (dB)").toBeNear(db, 0.3)
    expect.soft(amps * 1e3, "consumption current (mA)").toBeNear(ma, 0.3)
    expect.soft(s.tone ?? 0, "tone (Hz)").toBeNear(3600, 1)
  })
})

describe("the transducer's filters", () => {
  const fitted = (spec: BuzzerPreset, hz: number) => {
    const mode = (at: number, q: number) => {
      const x = hz / at
      return (x * x) / Math.hypot(1 - x * x, x / q)
    }
    const modes = [{ relativeFrequency: 1, q: spec.q, relativeLevel: 1 }, ...(spec.modes ?? [])]
    const cavity = spec.cavity ? mode(spec.frequency * spec.cavity.relativeFrequency, spec.cavity.q) : 1
    return cavity * Math.sqrt(modes.reduce((sum, m) => sum + (m.relativeLevel * mode(spec.frequency * m.relativeFrequency, m.q)) ** 2, 0))
  }

  it.each(BUZZER_PRESETS.map((p) => [p.name, p] as const))("%s: realise the fitted response, modes summed in power, as one causal filter", (_, spec) => {
    const sections = transducer(spec)
    const digital = (hz: number) => sections.reduce((gain, s) => gain * s.magnitudeAt(hz), 1)
    const db = (hz: number) => 20 * Math.log10(digital(hz) / fitted(spec, hz))
    const reference = db(spec.frequency)
    for (const hz of [300, 700, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000, 8000, 10000, 12000])
      expect.soft(db(hz) - reference, `${hz} Hz against the fit (dB)`).toBeNear(0, 0.1)
  })
})

describe("the sound the loop hands to the speaker", () => {
  it("is the buzzer's pressure at 10 cm, one sample per 20 µs step, with its pitch", () => {
    const { doc, bz } = across("tmb12a05", { kind: "dc", volts: 5 })
    const t = start(doc)
    t.loop.setAudio(true)
    const before = t.run(0.05).time
    t.loop.drainAudio()
    const snap = t.run(0.1)
    const chunk = t.loop.drainAudio()!
    expect.soft(chunk.samples.length, "one sample per step simulated").toBeNear((snap.time - before) / 20e-6, 1)
    expect.soft(chunk.pitch ?? 0, "pitch (Hz)").toBeNear(2407, 1)
    let sum = 0
    for (const p of chunk.samples) sum += p * p
    const db = 20 * Math.log10(Math.sqrt(sum / chunk.samples.length) / 20e-6)
    expect.soft(db, "the samples' level matches the unweighted readout (dB SPL)").toBeNear(sound(snap, bz).unweighted ?? 0, 0.5)
  })

  it("plays the datasheet's curve as the readout shows it, with no dip between the two modes", () => {
    const heard = (hz: string) => {
      const bench = lowSide({ hz })
      const t = start(bench.doc)
      t.loop.setAudio(true)
      t.run(0.1)
      t.loop.drainAudio()
      const snap = t.run(0.1)
      const samples = t.loop.drainAudio()!.samples
      let sum = 0
      for (const p of samples) sum += p * p
      return { db: 20 * Math.log10(Math.sqrt(sum / samples.length) / 20e-6), readout: sound(snap, bench.bz).unweighted ?? 0 }
    }
    for (const [hz, curve] of [["3 kHz", 73], ["3.6 kHz", 77], ["4 kHz", 82], ["4.27 kHz", 87.8]] as const) {
      const { db, readout } = heard(hz)
      expect.soft(db, `${hz}: heard against the curve's ${curve} dB (dB SPL)`).toBeNear(curve, 4)
      expect.soft(db, `${hz}: heard against the readout (dB SPL)`).toBeNear(readout, 0.5)
    }
  })

  it("hands over nothing while audio is off", () => {
    const { doc } = across("tmb12a05", { kind: "dc", volts: 5 })
    const t = start(doc)
    t.run(0.05)
    expect.soft(t.loop.drainAudio(), "no samples").toBeNull()
  })
})

describe("the part on the field", () => {
  it("lights its sound arcs only while it sounds", () => {
    const { doc, bz } = across("tmb12a05", { kind: "dc", volts: 5 })
    const snap = start(doc).run(0.1)
    expect.soft(snap.parts[partKey(bz.id, "SOUND")]?.on, "on while beeping").toBe(true)
    const quiet = across("tmb12a05", { kind: "dc", volts: 2 })
    expect.soft(start(quiet.doc).run(0.1).parts[partKey(quiet.bz.id, "SOUND")]?.on, "dark when silent").toBe(false)
  })
})
