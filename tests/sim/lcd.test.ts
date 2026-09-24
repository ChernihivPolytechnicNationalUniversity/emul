/**
 * The 7" LCD on the Open746I-C through the whole chain: Waveshare's display demo brings the
 * SDRAM up over the FMC, clears the panel with the DMA2D and writes text into the framebuffer
 * that the LTDC scans out to the panel docked on P15; the backlight draws from 5 V once the
 * firmware raises BL. Then the GT911 touch test: reset and id over bit-banged I²C, a press
 * on the glass reported to the firmware and drawn back as crosshairs.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { cubeDemo, lcdDemo, touchDemo } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import type { Gt911Snapshot } from "@/sim/digital"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

/** Colour histogram of a frame: the most common RGB triples and the count of each. */
function colours(frame: Uint8ClampedArray, width: number, height: number, region?: { x: number; y: number; w: number; h: number }) {
  const hist = new Map<string, number>()
  const r = region ?? { x: 0, y: 0, w: width, h: height }
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * width + x) * 4
      const k = `${frame[i]},${frame[i + 1]},${frame[i + 2]}`
      hist.set(k, (hist.get(k) ?? 0) + 1)
    }
  return [...hist.entries()].sort((a, b) => b[1] - a[1])
}

function session(build: typeof lcdDemo, elf: string) {
  const doc = build.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
  u.props = { ...u.props, firmware: elf, firmwareData: exampleBase64(elf) }
  const loop = new SimLoop()
  let clock = 0
  let frame: Uint8ClampedArray | null = null
  let snap: Snapshot | null = null
  const start = () => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    loop.advance(clock)
  }
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
      snap = loop.snapshot()!
      const d = snap.displays[lcd.id]
      if (d?.frame) frame = new Uint8ClampedArray(d.frame)
    }
    return snap!
  }
  return { doc, u, lcd, loop, start, run, frame: () => frame! }
}

const expectCrosshairLine = (hist: [string, number][], min: number) => {
  expect(hist[0][1]).toBeGreaterThanOrEqual(min)
  expect(hist[0][0]).not.toBe("255,255,255")
}

describe("display demo: SDRAM, DMA2D clear, text through the LTDC", () => {
  const s = session(lcdDemo, "open746-lcd.elf")
  let snap: Snapshot
  beforeAll(() => {
    s.start()
    snap = s.run(0.3)
  })

  it("runs the core at 200 MHz from the 8 MHz crystal", () => {
    const st = snap.mcus[s.u.id]
    expect(st.halted, "halted").toBeFalsy()
    expect(st.running, "core running").toBe(true)
    expect(st.sysclk, "SYSCLK").toBe(200e6)
  })

  it("touches nothing unmodelled but the DMA FIFO", () => {
    expect(snap.mcus[s.u.id].unmodelled.map((x) => x.block).join(", ")).toBe("DMA2 FIFO mode")
  })

  it("locks the panel", () => expect(snap.displays[s.lcd.id].status).toBe("ok"))

  it("draws blue text on a red background", () => {
    const top = colours(s.frame(), 1024, 600)
    expect.soft(top[0][0], "background").toBe("255,0,0")
    expect.soft(top[0][1], "red pixels").toBeGreaterThan(600000)
    expect.soft(top[1]?.[0] ?? "none", "text colour").toBe("0,0,255")
    expect.soft(top[1]?.[1] ?? 0, "blue pixels of the four lines").toBeNear(4986, 200)
  })

  it("puts text on line 1 and leaves the lower half plain red", () => {
    expect.soft(colours(s.frame(), 1024, 600, { x: 0, y: 24, w: 500, h: 24 }).some(([c]) => c === "0,0,255"), "line 1 has text").toBe(true)
    expect.soft(colours(s.frame(), 1024, 600, { x: 0, y: 300, w: 1024, h: 300 }).length, "colours in the lower half").toBe(1)
  })

  it("powers the backlight and logic from the board's 3.3 V", () => {
    expect.soft(snap.parts[partKey(s.lcd.id, "BL")]?.level ?? 0, "backlight").toBeNear(1, 0.05)
    expect.soft(snap.pinVoltage[pinKey(s.lcd.id, "4")], "LCD 3V3 pin").toBeNear(3.3, 0.05)
    expect.soft(Math.abs(snap.pinCurrent[pinKey(s.lcd.id, "4")]), "LCD 3.3 V draw (A)").toBeNear(0.35, 0.04)
  })

  // Nothing changed since: the worker sends no new frame.
  it("does not resend an unchanged picture", () => {
    expect(s.run(0.1).displays[s.lcd.id].frame).toBeNull()
  })

  describe("unplugging the module's USB (the supply)", () => {
    it("kills the picture: dark, not 'no signal'", () => {
      s.loop.setParts({ [partKey(s.u.id, "MUSB")]: { on: false } })
      const snap = s.run(0.1)
      expect.soft(snap.displays[s.lcd.id].status, "panel").toBe("off")
      expect.soft(snap.parts[partKey(s.lcd.id, "BL")]?.level ?? 0, "backlight").toBe(0)
    })

    it("restarts the demo when plugged back", () => {
      s.loop.setParts({ [partKey(s.u.id, "MUSB")]: { on: true } })
      const snap = s.run(0.4)
      expect.soft(snap.displays[s.lcd.id].status, "panel").toBe("ok")
      expect.soft(colours(s.frame(), 1024, 600)[0][0], "background").toBe("255,0,0")
    })
  })
})

describe("touch test: GT911 reset and id, a press drawn as crosshairs", () => {
  const s = session(touchDemo, "open746-touch.elf")
  const term = s.doc.objects.find((o) => o.def === "serial-terminal")!
  const gt = (snap: Snapshot) => snap.digital[s.lcd.id] as Gt911Snapshot
  let snap: Snapshot
  beforeAll(() => {
    s.start()
    snap = s.run(2.2)
  })

  it("runs the core", () => {
    expect(snap.mcus[s.u.id].halted).toBeFalsy()
    expect(snap.mcus[s.u.id].running).toBe(true)
  })

  it("puts the GT911 at 0x5d after the reset sequence", () => expect(`0x${gt(snap).address.toString(16)}`).toBe("0x5d"))

  it("reads the id over I²C and prints it on USART1", () => {
    const text = snap.terminals[term.id]?.text ?? ""
    expect.soft(text).toMatch(/TouchPad_ID:9,1,1/)
    expect.soft(text).toMatch(/FirmwareVersion:1060/)
  })

  it("clears the locked panel to white", () => {
    expect(snap.displays[s.lcd.id].status).toBe("ok")
    expect(colours(s.frame(), 1024, 600)[0][0]).toBe("255,255,255")
  })

  describe("a press at (500, 300)", () => {
    let pressed: Snapshot
    beforeAll(() => {
      s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: true, x: 500, y: 300 } })
      pressed = s.run(0.3)
    })

    it("is reported at ~100 Hz while the finger is down", () => {
      expect(gt(pressed).reads).toBeGreaterThanOrEqual(25)
      expect(gt(pressed).reads).toBeLessThanOrEqual(35)
    })

    it("is drawn as crosshairs and nothing else", () => {
      expectCrosshairLine(colours(s.frame(), 1024, 600, { x: 500, y: 0, w: 1, h: 600 }), 590)
      expectCrosshairLine(colours(s.frame(), 1024, 600, { x: 0, y: 300, w: 1024, h: 1 }), 1000)
      expect(colours(s.frame(), 1024, 600, { x: 100, y: 100, w: 300, h: 150 })[0][0], "rest of the panel").toBe("255,255,255")
    })
  })

  it("reports the release and erases the crosshairs", () => {
    s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: false } })
    const snap = s.run(0.2)
    expect.soft(gt(snap).touches.length, "touches after release").toBe(0)
    expect.soft(gt(snap).ready, "release report (zero points) taken by the firmware").toBeFalsy()
    expect.soft(colours(s.frame(), 1024, 600, { x: 500, y: 0, w: 1, h: 600 })[0][0], "crosshairs erased").toBe("255,255,255")
  })

  // A second press: the zero-length read of the release report must not have hung the bus.
  it("draws a second press at x = 200", () => {
    s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: true, x: 200, y: 100 } })
    s.run(0.3)
    expectCrosshairLine(colours(s.frame(), 1024, 600, { x: 200, y: 0, w: 1, h: 600 }), 590)
  })
})

describe("cube demo: our C++ renderer into double-buffered SDRAM framebuffers", () => {
  const s = session(cubeDemo, "open746-cube.elf")
  let snap: Snapshot
  let f1: Uint8ClampedArray
  beforeAll(() => {
    s.start()
    snap = s.run(0.5)
    f1 = s.frame()
  })

  it("runs the core and locks the panel", () => {
    expect(snap.mcus[s.u.id].halted).toBeFalsy()
    expect(snap.mcus[s.u.id].running).toBe(true)
    expect(snap.displays[s.lcd.id].status).toBe("ok")
  })

  it("draws a shaded, textured cube over 10–40 % of a dark blue-black panel", () => {
    const top = colours(f1, 1024, 600)
    expect.soft(top[0][0], "background").toBe("8,8,16")
    expect.soft(top[0][1], "background pixels").toBeLessThan(553000)
    expect.soft(top[0][1], "background pixels").toBeGreaterThan(370000)
    expect.soft(top.length, "texture colours (RGB565, shaded)").toBeGreaterThan(300)
  })

  it("turns the cube", () => {
    s.run(0.5)
    const f2 = s.frame()
    let differ = 0
    for (let i = 0; i < f1.length; i += 4) if (f1[i] !== f2[i] || f1[i + 1] !== f2[i + 1] || f1[i + 2] !== f2[i + 2]) differ++
    expect(differ).toBeGreaterThan(20000)
  })
})
