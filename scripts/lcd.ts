/**
 * The 7" LCD on the Open746I-C through the whole chain: Waveshare's display demo brings the
 * SDRAM up over the FMC, clears the panel with the DMA2D and writes text into the framebuffer
 * that the LTDC scans out to the panel docked on P15; the backlight draws from 5 V once the
 * firmware raises BL. Then the GT911 touch test: reset and id over bit-banged I²C, a press
 * on the glass reported to the firmware and drawn back as crosshairs.
 *
 *   pnpm lcd
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GRID } from "@/schematic/geometry"
import { cubeDemo, lcdDemo, touchDemo } from "@/schematic/examples"
import { partKey, pinKey } from "@/schematic/types"
import type { Gt911Snapshot } from "@/sim/digital"
import { SimLoop, type Snapshot } from "@/sim/loop"

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : String(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(48)} ${fmt(got).padStart(12)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

const firmware = (name: string) => readFileSync(join(import.meta.dirname, "..", "public", "firmware", name)).toString("base64")

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
  u.props = { ...u.props, firmware: elf, firmwareData: firmware(elf) }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  let frame: Uint8ClampedArray | null = null
  let snap: Snapshot | null = null
  loop.advance(clock)
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
  return { doc, u, lcd, loop, run, frame: () => frame, snap: () => snap! }
}

const wall0 = performance.now()
console.log("Display demo: SDRAM, DMA2D clear, text through the LTDC")
{
  const s = session(lcdDemo, "open746-lcd.elf")
  let snap = s.run(0.3)
  const st = snap.mcus[s.u.id]
  expect("core running", st.running ? "yes" : `no: ${st.halted}`, "yes")
  expect("SYSCLK from the 8 MHz crystal", st.sysclk, 200e6)
  expect("nothing unmodelled but the DMA FIFO", st.unmodelled.map((x) => x.block).join(", "), "DMA2 FIFO mode")
  const d = snap.displays[s.lcd.id]
  expect("panel locked", d.status, "ok")
  const f = s.frame()!
  const top = colours(f, 1024, 600)
  expect("background red", top[0][0], "255,0,0")
  expect("red covers most of the panel", top[0][1] > 600000 ? "yes" : `no: ${top[0][1]}`, "yes")
  expect("text in blue", top[1]?.[0] ?? "none", "0,0,255")
  expect("blue pixels of the four lines", top[1]?.[1] ?? 0, 4986, 200)
  const textRow = colours(f, 1024, 600, { x: 0, y: 24, w: 500, h: 24 })
  expect("line 1 has text", textRow.some(([c]) => c === "0,0,255") ? "yes" : "no", "yes")
  const blank = colours(f, 1024, 600, { x: 0, y: 300, w: 1024, h: 300 })
  expect("lower half is plain red", blank.length, 1)
  expect("backlight on (DISP from the board's 3.3 V)", snap.parts[partKey(s.lcd.id, "BL")]?.level ?? 0, 1, 0.05)
  expect("LCD 3V3 pin", snap.pinVoltage[pinKey(s.lcd.id, "4")], 3.3, 0.05)
  expect("LCD 3.3 V draw: logic + backlight (A)", Math.abs(snap.pinCurrent[pinKey(s.lcd.id, "4")]), 0.35, 0.04)
  // Nothing changed since: the worker sends no new frame.
  snap = s.run(0.1)
  expect("unchanged picture is not resent", snap.displays[s.lcd.id].frame === null ? "not sent" : "sent", "not sent")

  console.log("\nUnplugging the USB kills the picture, RESET restarts the demo")
  s.loop.setParts({ [partKey(s.u.id, "USB")]: { on: false } })
  snap = s.run(0.1)
  expect("panel without power: dark, not 'no signal'", snap.displays[s.lcd.id].status, "off")
  expect("backlight off", snap.parts[partKey(s.lcd.id, "BL")]?.level ?? 0, 0)
  s.loop.setParts({ [partKey(s.u.id, "USB")]: { on: true } })
  snap = s.run(0.4)
  expect("picture back after the reboot", snap.displays[s.lcd.id].status, "ok")
  expect("red again", colours(s.frame()!, 1024, 600)[0][0], "255,0,0")
}

console.log("\nTouch test: GT911 reset and id, a press drawn as crosshairs")
{
  const s = session(touchDemo, "open746-touch.elf")
  const term = s.doc.objects.find((o) => o.def === "serial-terminal")!
  let snap = s.run(2.2)
  const st = snap.mcus[s.u.id]
  expect("core running", st.running ? "yes" : `no: ${st.halted}`, "yes")
  const gt = snap.digital[s.lcd.id] as Gt911Snapshot
  expect("GT911 address after the reset sequence", `0x${gt.address.toString(16)}`, "0x5d")
  const text = snap.terminals[term.id]?.text ?? ""
  expect("id read over I²C, printed on USART1", /TouchPad_ID:9,1,1/.test(text) ? "yes" : `no: ${JSON.stringify(text.slice(0, 80))}`, "yes")
  expect("firmware version printed", /FirmwareVersion:1060/.test(text) ? "yes" : "no", "yes")
  expect("panel locked", snap.displays[s.lcd.id].status, "ok")
  expect("white after the clear", colours(s.frame()!, 1024, 600)[0][0], "255,255,255")

  s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: true, x: 500, y: 300 } })
  snap = s.run(0.3)
  const reads = (snap.digital[s.lcd.id] as Gt911Snapshot).reads
  expect("reports at ~100 Hz while the finger is down", reads >= 25 && reads <= 35 ? "yes" : `no: ${reads} in 0.3 s`, "yes")
  const f = s.frame()!
  const col = colours(f, 1024, 600, { x: 500, y: 0, w: 1, h: 600 })
  const row = colours(f, 1024, 600, { x: 0, y: 300, w: 1024, h: 1 })
  expect("vertical line at x = 500", col[0][1] >= 590 && col[0][0] !== "255,255,255" ? "yes" : `no: ${JSON.stringify(col.slice(0, 2))}`, "yes")
  expect("horizontal line at y = 300", row[0][1] >= 1000 && row[0][0] !== "255,255,255" ? "yes" : `no: ${JSON.stringify(row.slice(0, 2))}`, "yes")
  const elsewhere = colours(f, 1024, 600, { x: 100, y: 100, w: 300, h: 150 })
  expect("rest of the panel still white", elsewhere[0][0], "255,255,255")
  s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: false } })
  snap = s.run(0.2)
  expect("no touch reported after release", (snap.digital[s.lcd.id] as Gt911Snapshot).touches.length, 0)
  expect("release report (zero points) taken by the firmware", (snap.digital[s.lcd.id] as Gt911Snapshot).ready ? "pending" : "cleared", "cleared")
  expect("crosshairs erased", colours(s.frame()!, 1024, 600, { x: 500, y: 0, w: 1, h: 600 })[0][0], "255,255,255")
  // A second press: the zero-length read of the release report must not have hung the bus.
  s.loop.setParts({ [partKey(s.lcd.id, "PANEL")]: { pressed: true, x: 200, y: 100 } })
  snap = s.run(0.3)
  const col2 = colours(s.frame()!, 1024, 600, { x: 200, y: 0, w: 1, h: 600 })
  expect("second press drawn at x = 200", col2[0][1] >= 590 && col2[0][0] !== "255,255,255" ? "yes" : `no: ${JSON.stringify(col2.slice(0, 2))}`, "yes")
}

console.log("\nCube demo: our C++ renderer into double-buffered SDRAM framebuffers")
{
  const s = session(cubeDemo, "open746-cube.elf")
  let snap = s.run(0.5)
  const st = snap.mcus[s.u.id]
  expect("core running", st.running ? "yes" : `no: ${st.halted}`, "yes")
  expect("panel locked", snap.displays[s.lcd.id].status, "ok")
  const f1 = s.frame()!
  const top = colours(f1, 1024, 600)
  expect("background is the dark blue-black", top[0][0], "8,8,16")
  expect("cube covers 10–40 % of the panel", top[0][1] < 553000 && top[0][1] > 370000 ? "yes" : `no: ${top[0][1]} background pixels`, "yes")
  expect("hundreds of texture colours (RGB565, shaded)", top.length > 300 ? "yes" : `no: ${top.length}`, "yes")
  snap = s.run(0.5)
  const f2 = s.frame()!
  let differ = 0
  for (let i = 0; i < f1.length; i += 4) if (f1[i] !== f2[i] || f1[i + 1] !== f2[i + 1] || f1[i + 2] !== f2[i + 2]) differ++
  expect("the cube has turned (pixels changed)", differ > 20000 ? "yes" : `no: ${differ}`, "yes")
}

const wall = (performance.now() - wall0) / 1000
console.log(`\n${wall.toFixed(1)} s wall`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
