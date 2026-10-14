/**
 * The "Arduino Nano dimmer" example as the palette builds it, running its own sketch
 * (firmware/arduino/examples/dimmer, built by `pnpm firmware-arduino` with the build service's
 * code): the pot's wiper on A0 sets D9's PWM duty, the LED follows, the USB serial reports both.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nanoDimmer } from "@/schematic/examples/nano-dimmer"
import { partKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { FIRMWARE } from "../lib/firmware"

const BUILD = join(FIRMWARE, "arduino", "build")

function bench() {
  const elf = join(BUILD, "dimmer.elf")
  if (!existsSync(elf)) throw new Error(`${elf} is missing — build the sketches with \`pnpm firmware-arduino\``)
  let doc: Schematic = nanoDimmer.build(GRID)
  const u = doc.objects.find((o) => o.def === "arduino-nano")!
  const pot = doc.objects.find((o) => o.def === "potentiometer")!
  const led = doc.objects.find((o) => o.def === "led")!
  const term = doc.objects.find((o) => o.def === "serial-terminal")!
  u.props = { ...u.props, firmware: "dimmer.elf", firmwareData: readFileSync(elf).toString("base64") }
  const loop = new SimLoop()
  const parts: Record<string, PartState> = { ...doc.parts }
  loop.setDoc(doc)
  loop.setParts(parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number, each?: () => void) => {
    const end = clock + seconds * 1000
    while (clock < end - 1e-9) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
      each?.()
    }
  }
  const turn = (pos: string) => {
    doc = { ...doc, objects: doc.objects.map((o) => (o.id === pot.id ? { ...o, props: { ...o.props, pos } } : o)) }
    loop.setDoc(doc)
  }
  const snap = () => loop.snapshot()!
  const text = () => snap().terminals[term.id].text
  /** The last whole report: the newest line may still be on the wire. */
  const report = () => {
    const m = [...text().matchAll(/A0 = (\d+) {2}duty = (\d+) %\r\n/g)].at(-1)
    return m ? { raw: Number(m[1]), duty: Number(m[2]) } : undefined
  }
  const level = () => snap().parts[partKey(led.id, "LED")]?.level ?? 0
  return { run, turn, snap, text, report, level, term }
}

describe("Arduino Nano dimmer (example)", () => {
  it("ships the sketch the test runs", () => {
    const built = join(BUILD, "dimmer.Dimmer.ino")
    if (!existsSync(built)) throw new Error(`${built} is missing — build the sketches with \`pnpm firmware-arduino\``)
    expect(readFileSync(built, "utf8")).toBe(readFileSync(join(FIRMWARE, "arduino", "examples", "dimmer", "Dimmer.ino"), "utf8"))
  })

  it("the pot sets the LED's duty and the serial reports it", () => {
    const b = bench()
    b.run(0.6)
    expect(b.text().startsWith("Dimmer: turn the pot\r\n")).toBe(true)
    // Half way: about 512 counts, a quarter of it as the duty, 49 %.
    const mid = b.report()!
    expect(Math.abs(mid.raw - 512)).toBeLessThan(8)
    expect(Math.abs(mid.duty - 49)).toBeLessThanOrEqual(1)
    const midLevel = b.level()

    // A quarter of the way from the 5 V end reads three quarters of full scale.
    b.turn("0.25")
    b.run(0.6)
    const high = b.report()!
    expect(Math.abs(high.raw - 767)).toBeLessThan(8)
    expect(Math.abs(high.duty - 74)).toBeLessThanOrEqual(1)
    expect(b.level()).toBeGreaterThan(midLevel)

    // At the ground end the LED goes dark.
    b.turn("1")
    b.run(0.6)
    expect(b.report()!.raw).toBeLessThan(5)
    expect(b.report()!.duty).toBe(0)
    expect(b.level()).toBeLessThan(0.02)
    expect(b.snap().terminals[b.term.id].framingErrors).toBe(0)
  })
})
