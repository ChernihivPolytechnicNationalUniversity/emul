/**
 * Bourns MF-MSMF resettable fuses (PTC), the rows of the series data sheet's electrical
 * characteristics: Vmax, Imax, Ihold, Itrip, Rmin and R1max, the maximum time to trip at a
 * current, the tripped dissipation. The engine's resettable-fuse model (`ptcModel`) heats it
 * with I² toward a trip between Ihold and Itrip, timed by that row's time to trip.
 */
import { PolyfuseIcon } from "../icons"
import type { BodyShape, ComponentDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

type Row = { vmax: number; imax: number; hold: number; trip: number; rmin: number; r1max: number; at: number; within: number; pd: number }

export const MF_MSMF: Record<string, Row> = {
  "MF-MSMF010": { vmax: 60, imax: 40, hold: 0.1, trip: 0.3, rmin: 0.7, r1max: 15, at: 0.5, within: 1.5, pd: 0.8 },
  "MF-MSMF014": { vmax: 60, imax: 40, hold: 0.14, trip: 0.34, rmin: 0.4, r1max: 6.5, at: 1.5, within: 0.15, pd: 0.8 },
  "MF-MSMF020": { vmax: 30, imax: 80, hold: 0.2, trip: 0.4, rmin: 0.4, r1max: 6, at: 6, within: 0.06, pd: 0.8 },
  "MF-MSMF030": { vmax: 30, imax: 10, hold: 0.3, trip: 0.6, rmin: 0.3, r1max: 3, at: 8, within: 0.1, pd: 0.8 },
  "MF-MSMF035/33X": { vmax: 33, imax: 40, hold: 0.35, trip: 0.7, rmin: 0.25, r1max: 1.7, at: 8, within: 0.15, pd: 0.8 },
  "MF-MSMF050": { vmax: 15, imax: 100, hold: 0.5, trip: 1.0, rmin: 0.15, r1max: 1.0, at: 8, within: 0.15, pd: 0.8 },
}

const row = (p: Record<string, string>) => MF_MSMF[p.model] ?? MF_MSMF["MF-MSMF050"]

const body: BodyShape[] = [
  { type: "path", d: "M0 1 H1 M3 1 H4 M1 0.6 H3 V1.4 H1 Z M0.8 1.8 L1.2 1.6 H2.6 L3.2 0.2" },
  { type: "text", x: 2, y: 0.28, text: "{ref}", size: 0.35 },
  { type: "text", x: 2, y: 2.15, text: "{model}", size: 0.28, muted: true },
]

export const polyfuse: ComponentDef = {
  id: "polyfuse",
  name: "Resettable fuse (PTC)",
  keywords: ["fuse", "PTC", "polyfuse", "PolySwitch", "resettable", "MF-MSMF", "Bourns"],
  description:
    "Bourns MF-MSMF polyfuse, 1812 SMD (Arduino's USB fuse is the MF-MSMF050): conducts below Ihold, trips somewhere up to Itrip — sooner the harder it is pushed — and, tripped, lets through only what keeps 0.8 W in it. Take the power away and it cools and resets.",
  category: "power",
  icon: PolyfuseIcon,
  prefix: "F",
  defaults: { model: "MF-MSMF050" },
  fields: [
    {
      key: "model",
      label: "Part",
      type: "select",
      options: Object.entries(MF_MSMF).map(([id, r]) => ({ value: id, label: `${id} · hold ${r.hold} A, trip ${r.trip} A, ${r.vmax} V` })),
    },
  ],
  width: 4,
  height: 2,
  parts: [],
  pins: [
    { id: "1", label: "", x: 0, y: 1, side: "left", labelAt: "top", kind: "power" },
    { id: "2", label: "", x: 4, y: 1, side: "right", labelAt: "top", kind: "power" },
  ],
  body,
  model: [
    {
      kind: "R",
      a: "1",
      b: "2",
      value: (p) => row(p).rmin,
      ptc: { hold: (p) => row(p).hold, trip: (p) => row(p).trip, at: (p) => row(p).at, within: (p) => row(p).within, pd: (p) => row(p).pd },
      limits: { voltage: (p) => row(p).vmax, current: (p) => row(p).imax, fail: "open" },
    },
  ],
  info: {
    Source: "Bourns MF-MSMF series data sheet, electrical characteristics at 23 °C",
    Model:
      "heat is the running average of (I / Itrip′)², Itrip′ midway between Ihold and Itrip; it trips at 1, timed so the listed current trips it in exactly the listed maximum time; tripped, its resistance keeps the tripped dissipation in it; unpowered, it cools with the same time constant and resets at Ihold's heat",
    Reset: "cools with the heating's time constant (≈17 s for the MF-MSMF050) and resets at Ihold's heat: assumed, to be checked (the data sheet gives no reset time)",
    "Not modelled":
      "the spread between Rmin and R1max (it starts at Rmin and returns to it after a trip), the resistance's rise as it warms below a trip, the ambient temperature's effect on Ihold",
  },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [polyfuse]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "polyfuse": {
    maker: "Bourns",
    docs: [DOCS["bourns-mf-msmf"]],
    specs: [
      { label: "Vmax / Imax (MF-MSMF050)", value: "15 V / 100 A", cite: { page: 1, at: "Electrical Characteristics" } },
      { label: "Ihold / Itrip (MF-MSMF050)", value: "0.50 A / 1.00 A at 23 °C", cite: { page: 1, at: "Electrical Characteristics" } },
      { label: "Resistance (MF-MSMF050)", value: "0.15 Ω min, 1.0 Ω R1max", cite: { page: 1, at: "Electrical Characteristics" } },
      { label: "Time to trip (MF-MSMF050)", value: "0.15 s max at 8 A", cite: { page: 1, at: "Electrical Characteristics" } },
      { label: "Tripped dissipation", value: "0.8 W typical", cite: { page: 1, at: "Electrical Characteristics" } },
      { label: "Operating temperature", value: "−40 to +85 °C", cite: { page: 3, at: "Environmental Characteristics" } },
    ],
    modelled: [
      { what: "Six ratings from the table: MF-MSMF010, 014, 020, 030, 035/33X and 050", cite: { page: 1, at: "Electrical Characteristics" } },
      { what: "Starts at Rmin (0.15 Ω for the MF-MSMF050)", cite: { page: 1, at: "Electrical Characteristics" }, test: "tests/sim/polyfuse.test.ts" },
      { what: "Heats with I² and trips: the listed current trips it within the listed maximum time (8 A in 0.15 s)", cite: { page: 1, at: "Electrical Characteristics" }, test: "tests/sim/polyfuse.test.ts" },
      { what: "Holds Ihold without tripping and trips at Itrip, slowly", cite: { page: 3, at: "Test Procedures and Requirements, Hold Current" }, test: "tests/sim/polyfuse.test.ts" },
      { what: "Tripped, its resistance keeps 0.8 W in it", cite: { page: 1, at: "Electrical Characteristics" }, test: "tests/sim/polyfuse.test.ts" },
      { what: "Stays tripped while powered and resets once unpowered and cool; the reset time is assumed (the sheet gives none)", test: "tests/sim/polyfuse.test.ts" },
      { what: "Tripping across more than Vmax destroys it", cite: { page: 1, at: "Electrical Characteristics" }, test: "tests/sim/polyfuse.test.ts" },
    ],
    notModelled: [
      { what: "The spread between Rmin and R1max (it starts at Rmin and returns to it after a trip)", cite: { page: 1, at: "Electrical Characteristics" } },
      { what: "The resistance's rise as it warms below a trip" },
      { what: "The ambient temperature's effect on Ihold", cite: { page: 9, at: "Thermal Derating Table" } },
      { what: "The typical time-to-trip curves: one point, the table's maximum time, sets the timing", cite: { page: 7, at: "Typical Time to Trip at 23 °C" } },
      { what: "The series' other ratings (MF-MSMF075 and up, the /33X, /60X variants)", cite: { page: 1, at: "Electrical Characteristics" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
