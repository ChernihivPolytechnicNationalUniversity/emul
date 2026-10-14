/**
 * The "Nucleo 4×4 keypad" example co-simulated: unmodified HAL firmware scans the membrane
 * keypad (open-drain rows driven low one at a time, columns on the internal pull-ups), debounces
 * over two 5 ms scans and prints each new key on USART3 into the serial terminal. Then the
 * matrix's own physics: three keys at a rectangle's corners ghost the fourth.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoKeypad } from "@/schematic/examples/keypad"
import { partKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { spawnNodeCore } from "../../scripts/lib/core-threads"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

const LEGENDS = "123A456B789C*0#D"
/** Key part id ("K23") for a legend ("6"). */
const keyOf = (legend: string) => {
  const i = LEGENDS.indexOf(legend)
  return `K${Math.floor(i / 4) + 1}${(i % 4) + 1}`
}

function bench() {
  const doc: Schematic = nucleoKeypad.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const kp = doc.objects.find((o) => o.def === "keypad-4x4")!
  const term = doc.objects.find((o) => o.def === "serial-terminal")!
  u.props = { ...u.props, firmware: "nucleo-keypad.elf", firmwareData: exampleBase64("nucleo-keypad.elf") }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (ms: number) => {
    const end = clock + ms
    while (clock < end) {
      clock = Math.min(end, clock + 10)
      loop.advance(clock)
    }
  }
  /** Holds exactly these keys (by legend), releasing every other. */
  const hold = (...legends: string[]) => {
    const parts = { ...doc.parts }
    for (const l of legends) parts[partKey(kp.id, keyOf(l))] = { pressed: true }
    loop.setParts(parts)
  }
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const word = (name: string) => core().bus.read32(core().firmware.symbols.find((x) => x.name === name)!.value)
  const text = () => loop.snapshot()!.terminals[term.id]?.text ?? ""
  return { loop, run, hold, word, text }
}

describe("Nucleo 4×4 keypad", () => {
  it("prints 1, 5, #, D as they are pressed one at a time", () => {
    const b = bench()
    b.run(50)
    expect(b.word("scans"), "the scan loop runs").toBeGreaterThan(3)
    expect(b.word("keyCount"), "nothing printed with no key down").toBe(0)
    expect(b.text()).toBe("")
    const typed: string[] = []
    for (const key of ["1", "5", "#", "D"]) {
      b.hold(key)
      b.run(60)
      typed.push(key)
      expect(b.word("lastKey"), `last key after pressing ${key}`).toBe(key.charCodeAt(0))
      expect(b.word("keysDown"), `settled map while ${key} is held`).toBe(1 << LEGENDS.indexOf(key))
      b.hold()
      b.run(60)
      expect(b.word("keysDown"), `settled map after releasing ${key}`).toBe(0)
      expect(b.text(), `terminal after ${key}`).toBe(typed.join(""))
    }
    expect(b.word("keyCount")).toBe(4)
    expect(b.word("errors"), "no HAL errors").toBe(0)
    const term = Object.values(b.loop.snapshot()!.terminals)[0]!
    expect.soft(term.framingErrors, "115200 8N1 on both sides").toBe(0)
  })

  it("holding a key prints it once, not on every scan", () => {
    const b = bench()
    b.run(20)
    b.hold("7")
    b.run(300)
    expect(b.text()).toBe("7")
    expect(b.word("keyCount")).toBe(1)
  })

  it("ghosts 5 when 1, 2 and 4 are held (no diodes in the matrix)", () => {
    const b = bench()
    b.run(20)
    b.hold("1")
    b.run(60)
    b.hold("1", "2")
    b.run(60)
    expect(b.text(), "two keys in one row read cleanly").toBe("12")
    b.hold("1", "2", "4")
    b.run(60)
    // Row 2 low → key 4 → column 1 → key 1 → row 1 (released, high-Z) → key 2 → column 2: the
    // firmware sees 5 as well, exactly as on the real keypad.
    expect(b.text()).toBe("1245")
    const ghost = 1 << LEGENDS.indexOf("5")
    expect(b.word("keysDown") & ghost, "5 in the settled map").toBe(ghost)
    expect(b.word("lastKey")).toBe("5".charCodeAt(0))
    b.hold()
    b.run(60)
    expect(b.word("keysDown")).toBe(0)
  })

  it("with the core in a worker, the first press prints only its key (a key couples two pads; the core must not move mid-press)", async () => {
    const doc: Schematic = nucleoKeypad.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    const kp = doc.objects.find((o) => o.def === "keypad-4x4")!
    const term = doc.objects.find((o) => o.def === "serial-terminal")!
    u.props = { ...u.props, firmware: "nucleo-keypad.elf", firmwareData: exampleBase64("nucleo-keypad.elf") }
    const loop = new SimLoop()
    loop.spawnCore = () => spawnNodeCore()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    while (loop.booting) await new Promise((r) => setTimeout(r, 10))
    let clock = 0
    const run = (ms: number) => {
      const end = clock + ms
      while (clock < end) {
        clock = Math.min(end, clock + 16.7)
        loop.advance(clock)
      }
    }
    run(200)
    loop.setParts({ ...doc.parts, [partKey(kp.id, keyOf("1"))]: { pressed: true } })
    run(80)
    loop.setParts({ ...doc.parts })
    run(60)
    expect(loop.snapshot()!.terminals[term.id]?.text).toBe("1")
  })
})
