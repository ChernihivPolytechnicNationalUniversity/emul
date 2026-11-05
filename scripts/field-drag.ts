import "./lib/all-parts"
import { Buffer } from "node:buffer"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, type Page } from "playwright-core"
import { examples, lab1Stand } from "@/schematic/examples"
import { bodyCentre, GRID, objectPins, objectRect, orientationOf, type Point, type Turn } from "@/schematic/geometry"
import { SCHEMATIC_VERSION, stamped } from "@/schematic/migrate"
import { rotateSelection } from "@/schematic/orient"
import { bodyBounds, contourOf } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"

const DEV_SERVER = process.env.EMUL_URL ?? "http://localhost:5173/"
const SHOTS = process.env.SHOTS
const LCD_BEZEL_CELLS = 38.6
const LIFT_CELLS = 60
const PAN_PX = 600
let failed = 0
let passed = 0
function expect(what: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? "✓" : "✗"} ${what}: ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`)
}

function chromiumExecutable() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")
  const builds = existsSync(root) ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)) : []
  const newest = builds.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])).at(-1)
  const executable = newest && join(root, newest, "chrome-linux64", "chrome")
  if (!executable || !existsSync(executable)) {
    console.log(`No Chromium build under ${root}. Install one with:\n\n  npx playwright install chromium\n`)
    process.exit(1)
  }
  return executable
}

const shoot = (page: Page, name: string) => (SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`) }) : Promise.resolve())

const LANDING_TIMEOUT_MS = 15_000
const pageTitle = (page: Page) => page.evaluate(() => document.title)

async function openDoc(page: Page, name: string, doc: Schematic) {
  await page.goto(DEV_SERVER, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-slot=dot-field-viewport]")
  const landing = Date.now() + LANDING_TIMEOUT_MS
  while ((await pageTitle(page)).startsWith("εmul") && Date.now() < landing) await page.waitForTimeout(100)
  await page.setInputFiles("input[type=file]", { name: `${name}.emul`, mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify({ format: "emul-project", version: 1, name, schematic: stamped(doc) })) })
  const opened = Date.now() + LANDING_TIMEOUT_MS
  while (!(await pageTitle(page)).startsWith(`${name} `) && Date.now() < opened) await page.waitForTimeout(100)
  if (!(await pageTitle(page)).startsWith(`${name} `)) throw new Error(`the field never showed ${name}: it shows “${await pageTitle(page)}”`)
  await page.waitForSelector("[data-slot=component]")
  await page.waitForTimeout(2000)
  return doc
}

const open = (page: Page, id: string) => openDoc(page, id, examples.find((e) => e.id === id)!.build(GRID))

const box = async (page: Page, id: string) => (await page.locator(`[data-body="${id}"] [data-slot=component]`).first().boundingBox())!

async function fieldFrame(page: Page) {
  const { left, top, x, y, scale } = await page.evaluate(() => {
    const viewport = document.querySelector("[data-slot=dot-field-viewport]")!.getBoundingClientRect()
    const view = new DOMMatrix(getComputedStyle(document.querySelector("[data-slot=dot-field-content]")!).transform)
    return { left: viewport.left, top: viewport.top, x: view.e, y: view.f, scale: view.a }
  })
  return {
    toScreen: (p: Point) => ({ x: left + x + p.x * scale, y: top + y + p.y * scale }),
    worldOf: (id: string) =>
      page.evaluate((objectId) => {
        const placed = document.querySelector<SVGSVGElement>(`[data-body="${CSS.escape(objectId)}"] [data-slot=component]`)!
        return { x: parseFloat(placed.style.left), y: parseFloat(placed.style.top) }
      }, id),
  }
}

async function dragBy(page: Page, from: Point, to: Point, release = true) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await page.waitForTimeout(150)
  if (!release) return
  await page.mouse.up()
  await page.waitForTimeout(800)
}

const crystal = (id: string, x: number, y: number, ref: string): PlacedObject => ({ id, def: "crystal", x: x * GRID, y: y * GRID, props: { ref } })
const crystalMiddle = (q: PlacedObject) => ({ x: q.x + 2 * GRID, y: q.y + GRID })
type ScreenBox = { x: number; y: number; width: number; height: number }
const overlapping = (a: ScreenBox, b: ScreenBox) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const drawn = (box: ScreenBox, defId: string): ScreenBox[] => {
  const def = getDef(defId)!
  const cell = box.width / def.width
  return (defId === "open746i-c" ? contourOf(def) : [bodyBounds(def)]).map((r) => ({ x: box.x + r.x * cell, y: box.y + r.y * cell, width: r.w * cell, height: r.h * cell }))
}
const onTheBoard = (crystalBox: ScreenBox, board: ScreenBox) => drawn(crystalBox, "crystal").some((body) => drawn(board, "open746i-c").some((piece) => overlapping(body, piece)))

const dots = (page: Page, id: string) =>
  page.evaluate((objectId) => {
    const group = document.querySelector(`[data-pins="${CSS.escape(objectId)}"]`)
    const markers = [...(group?.querySelectorAll(":scope > [data-pin] > [data-marker]") ?? [])].filter((m) => m.getAttribute("display") !== "none")
    const contact = markers.filter((m) => Number(m.getAttribute("r")) > 6)
    return { contact: contact.length, black: contact.filter((m) => m.getAttribute("class")?.includes("fill-foreground")).length, open: markers.length }
  }, id)

const blockedNow = (page: Page, id: string) => page.evaluate((objectId) => document.querySelector(`[data-body="${CSS.escape(objectId)}"]`)?.hasAttribute("data-blocked") ?? false, id)

const cellPoint = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const resistorAt = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const wiredPair = (): Schematic => ({
  objects: [resistorAt("R1", 10, 10), resistorAt("R2", 20, 10), resistorAt("R3", 14, 16, 90)],
  wires: [{ id: "w1", a: cellPoint(14, 11), b: cellPoint(20, 11) }],
  parts: {},
})
const countOf = (page: Page, selector: string) => page.evaluate((s) => document.querySelectorAll(s).length, selector)
const pieces = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("[data-slot=rubber-band] [data-piece]")].map((e) => e.getAttribute("data-piece")!.split(" ").map(Number)))
const orthogonal = (piece: number[]) => piece[0] === piece[2] || piece[1] === piece[3]

async function wiresFollowTheDrag(page: Page) {
  console.log("\nwires follow a dragged part, and Alt leaves them behind (design.md §6.3)")
  await openDoc(page, "drag-with-wires", wiredPair())
  const frame = await fieldFrame(page)
  await dragBy(page, frame.toScreen(cellPoint(22, 11)), frame.toScreen(cellPoint(22, 14)), false)
  const drawn = await pieces(page)
  expect("mid-drag the rubber band draws the wire, every piece horizontal or vertical", drawn.length > 0 && drawn.every(orthogonal), true)
  await page.mouse.up()
  await page.waitForTimeout(800)
  expect("dropped: R2 three cells lower", (await frame.worldOf("R2")).y, 13 * GRID)
  expect("dropped: the wire still reaches R2, no open end", await countOf(page, "[data-dangling]"), 0)
  await shoot(page, "drag-with-wires")
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  await page.keyboard.down("Alt")
  await dragBy(page, frame.toScreen(cellPoint(22, 14)), frame.toScreen(cellPoint(26, 14)))
  await page.keyboard.up("Alt")
  expect("Alt-dragged: R2 moved alone, the wire's end hangs where its pin was", await countOf(page, "[data-dangling]"), 1)
}

async function drawFromAWire(page: Page) {
  console.log("\na wire drawn from a wire with W, and the drawing keys (design.md §6.1)")
  await openDoc(page, "draw-from-wire", wiredPair())
  const frame = await fieldFrame(page)
  const onWire = frame.toScreen(cellPoint(15, 11))
  await page.mouse.move(onWire.x, onWire.y)
  await page.keyboard.press("w")
  await page.mouse.click(onWire.x, onWire.y)
  const pin = frame.toScreen(cellPoint(15, 16))
  await page.mouse.move(pin.x, pin.y, { steps: 8 })
  await page.mouse.click(pin.x, pin.y)
  await page.waitForTimeout(600)
  expect("W on a wire starts a branch: a dot where it starts", await page.evaluate(() => [...document.querySelectorAll("[data-junction]")].map((e) => e.getAttribute("data-junction"))), [`${15 * GRID},${11 * GRID}`])
  const lower = frame.toScreen(cellPoint(15, 20))
  await page.mouse.click(lower.x, lower.y)
  const corner = frame.toScreen(cellPoint(19, 18))
  await page.mouse.move(corner.x, corner.y, { steps: 6 })
  await page.mouse.click(corner.x, corner.y)
  const further = frame.toScreen(cellPoint(22, 16))
  await page.mouse.move(further.x, further.y, { steps: 6 })
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(200)
  expect("Backspace takes the corner back, and the wire is still being drawn", await countOf(page, "[data-slot=pending-wire-route] path"), 2)
  await page.keyboard.press("Enter")
  await page.waitForTimeout(600)
  expect("Enter finishes it where the pointer is, the end left hanging", await countOf(page, "[data-dangling]"), 1)
  const free = frame.toScreen(cellPoint(10, 11))
  await page.mouse.click(free.x, free.y)
  const away = frame.toScreen(cellPoint(12, 15))
  await page.mouse.move(away.x, away.y, { steps: 6 })
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  expect("Esc drops the wire being drawn: nothing added", [await countOf(page, "[data-slot=pending-wire-route]"), await countOf(page, "[data-dangling]")], [0, 1])
  await shoot(page, "draw-from-wire")
}

async function farDropAndWireCopy(page: Page) {
  console.log("\na far drop with nowhere clean near it, and copying a wire alone (review of phase 4)")
  const stand = lab1Stand.build(GRID)
  await openDoc(page, "far-drop", stand)
  const chip = stand.objects.find((o) => o.def === "stm32f746ig")!
  const frame = await fieldFrame(page)
  const before = await frame.worldOf(chip.id)
  const middle = { x: chip.x + objectRect(chip, GRID).w / 2, y: chip.y + objectRect(chip, GRID).h / 2 }
  await dragBy(page, frame.toScreen(middle), frame.toScreen({ x: middle.x + 13 * GRID, y: middle.y + 7 * GRID }))
  const after = await frame.worldOf(chip.id)
  expect("a chip dragged 13 cells with every wire blocked near the drop still moves", after.x !== before.x || after.y !== before.y, true)
  await openDoc(page, "copy-a-wire", wiredPair())
  const wired = await fieldFrame(page)
  const onWire = wired.toScreen(cellPoint(16, 11))
  await page.mouse.click(onWire.x, onWire.y)
  await page.keyboard.press("Control+c")
  await page.keyboard.press("Control+v")
  await page.waitForTimeout(700)
  expect("Ctrl+C and Ctrl+V on a selected segment alone paste it: two new open ends", await countOf(page, "[data-dangling]"), 2)
  const twoNets: Schematic = {
    objects: [resistorAt("R1", 10, 10), resistorAt("R2", 20, 10), resistorAt("R4", 10, 16), resistorAt("R5", 20, 16)],
    wires: [{ id: "a", a: cellPoint(14, 11), b: cellPoint(20, 11) }, { id: "b", a: cellPoint(14, 17), b: cellPoint(20, 17) }],
    parts: {},
  }
  await openDoc(page, "merge-flash", twoNets)
  const joining = await fieldFrame(page)
  const fromWire = joining.toScreen(cellPoint(17, 11))
  await page.mouse.move(fromWire.x, fromWire.y)
  await page.keyboard.press("w")
  await page.mouse.click(fromWire.x, fromWire.y)
  const toWire = joining.toScreen(cellPoint(17, 17))
  await page.mouse.move(toWire.x, toWire.y, { steps: 6 })
  await page.mouse.click(toWire.x, toWire.y)
  await page.waitForTimeout(250)
  expect("two nets joined by a drawn wire: the merged net flashes on the field", await page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-flash]")].map((e) => getComputedStyle(e).animationName)), ["wire-flash"])
  const shift = examples.find((e) => e.id === "nucleo-74hc595")!.build(GRID)
  await openDoc(page, "turn-refused", shift)
  const u2 = shift.objects.find((o) => o.props?.ref === "U2")!
  const chipFrame = await fieldFrame(page)
  const u2Middle = chipFrame.toScreen({ x: u2.x + objectRect(u2, GRID).w / 2, y: u2.y + objectRect(u2, GRID).h / 2 })
  await page.mouse.click(u2Middle.x, u2Middle.y)
  await page.keyboard.press("r")
  await page.waitForTimeout(900)
  expect("R on the 74HC595 turns it: no refusal", await page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].some((e) => e.textContent?.includes("Not done") || e.textContent?.includes("Not turned"))), false)
}

async function morningChecks(page: Page) {
  console.log("\nthe user's checks on the running app (2026-11-05 morning)")
  const frameParts: PlacedObject[] = [resistorAt("F1", -6, -4), resistorAt("F2", 28, 16)]
  await openDoc(page, "morning", { objects: frameParts, wires: [], parts: {} })
  const f = await fieldFrame(page)
  const at = (x: number, y: number) => f.toScreen(cellPoint(x, y))
  const openEnds = () => page.evaluate(() => [...document.querySelectorAll("[data-dangling]")].map((e) => e.getAttribute("data-dangling")))
  const pendingDrawn = () => countOf(page, "[data-slot=pending-wire-route]")
  let p = await at(5, 5)
  await page.mouse.move(p.x, p.y)
  await page.keyboard.press("w")
  p = await at(8, 9)
  await page.mouse.move(p.x, p.y, { steps: 6 })
  expect("W arms: no wire is drawn before the first click", await pendingDrawn(), 0)
  await page.mouse.click(p.x, p.y)
  const corner = await at(12, 9)
  await page.mouse.move(corner.x, corner.y, { steps: 6 })
  await page.mouse.click(corner.x, corner.y)
  const away = await at(16, 14)
  await page.mouse.move(away.x, away.y, { steps: 6 })
  await page.keyboard.press("Enter")
  await page.waitForTimeout(500)
  expect("Enter ends the wire at the last clicked point, not under the pointer", await openEnds(), [`${8 * GRID},${9 * GRID}`, `${12 * GRID},${9 * GRID}`])
  const end = await at(12, 9)
  await page.mouse.click(end.x + 3, end.y)
  const onward = await at(12, 12)
  await page.mouse.move(onward.x, onward.y, { steps: 6 })
  await page.waitForTimeout(300)
  expect("a click on the outer half of an open end's ring, past the wire, continues the wire", await pendingDrawn(), 1)
  expect("a click on an open end starts no error", await page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].some((e) => e.textContent?.includes("No wire to lay"))), false)
  await page.keyboard.press("Escape")
  const mid = await at(10, 9)
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.down()
  const lower = await at(10, 12)
  await page.mouse.move(lower.x, lower.y, { steps: 8 })
  const place = await at(10, 13)
  await page.mouse.move(place.x, place.y, { steps: 3 })
  await page.mouse.down()
  await page.mouse.up()
  const later = await at(20, 15)
  await page.mouse.move(later.x, later.y, { steps: 6 })
  expect("a press while a wire is still held (its release lost to another window) puts it down and starts no marquee", await page.evaluate(() => getComputedStyle(document.querySelector("[data-slot=dot-field-selection]")!).display), "none")
  await page.mouse.up()
  await page.keyboard.press("Escape")
  await openDoc(page, "turn-a-wire", { objects: frameParts, wires: [{ id: "w", a: cellPoint(2, 4), b: cellPoint(10, 4) }], parts: {} })
  const g = await fieldFrame(page)
  const onWire = g.toScreen(cellPoint(6, 4))
  await page.mouse.click(onWire.x, onWire.y)
  await page.keyboard.press("r")
  await page.waitForTimeout(600)
  expect("R on a selected wire turns it a quarter", await openEnds(), [`${6 * GRID},${0}`, `${6 * GRID},${8 * GRID}`])
  await openDoc(page, "held-free-wire", { objects: frameParts, wires: [{ id: "h", a: cellPoint(2, 4), b: cellPoint(9, 4) }, { id: "v", a: cellPoint(9, 4), b: cellPoint(9, 1) }], parts: {} })
  const k = await fieldFrame(page)
  const visibleRings = () => page.evaluate(() => [...document.querySelectorAll("[data-dangling]")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("data-dangling")))
  const bandRings = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=rubber-band] [data-band-dangling]")].map((e) => e.getAttribute("data-band-dangling")).sort())
  const grip = k.toScreen(cellPoint(5, 4))
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  const held = k.toScreen(cellPoint(8, 7))
  await page.mouse.move(held.x, held.y, { steps: 10 })
  await page.waitForTimeout(300)
  expect("a free wire held mid-drag leaves no open-end ring where its ends were (the user's picture 13)", await visibleRings(), [])
  expect("a free wire held mid-drag carries its open-end rings on the band", await bandRings(), [`${5 * GRID},${7 * GRID}`, `${12 * GRID},${4 * GRID}`])
  await page.mouse.up()
  await page.waitForTimeout(400)
  expect("released, the rings are the wire's own again, at its new ends", (await visibleRings()).sort(), [`${5 * GRID},${7 * GRID}`, `${12 * GRID},${4 * GRID}`])
  await openDoc(page, "alt-r", { objects: [...frameParts, resistorAt("R1", 0, 0), resistorAt("R2", 10, 0)], wires: [{ id: "w", a: cellPoint(4, 1), b: cellPoint(10, 1) }], parts: {} })
  const h = await fieldFrame(page)
  const r2 = h.toScreen(cellPoint(12, 1))
  await page.mouse.click(r2.x, r2.y)
  await page.keyboard.press("Alt+r")
  await page.keyboard.press("Alt+r")
  await page.waitForTimeout(600)
  expect("Alt+R turns the part alone: the wire stays where it was", await page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-wire] path[data-base]")].map((e) => e.getAttribute("d"))), [`M${4 * GRID} ${GRID} L${10 * GRID} ${GRID}`])
  await open(page, "nucleo-74hc595")
  const n = await fieldFrame(page)
  const onRow = n.toScreen(cellPoint(32, 17))
  const rowBelow = n.toScreen(cellPoint(32, 18))
  await page.mouse.move(onRow.x, onRow.y)
  await page.mouse.down()
  await page.mouse.move(rowBelow.x, rowBelow.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(500)
  const toasts = await page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((e) => e.textContent ?? ""))
  expect("a wire dragged where it would lie along another net's wire is refused in the words of a wire, not of a dropped part", toasts.some((t) => t.startsWith("Wire not moved")) && !toasts.some((t) => t.includes("Nowhere clean to put it")), true)
}

async function phaseFiveChecks(page: Page) {
  console.log("\nthe field: bodies, splices, fields and the checker (phase 5, design.md §5, §6.8)")
  const diodeAt = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "diode", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
  await openDoc(page, "right-angle", { objects: [diodeAt("D5", 10, 10, 90), diodeAt("D6", 20, 20)], wires: [], parts: {} })
  let f = await fieldFrame(page)
  await dragBy(page, f.toScreen(cellPoint(22, 21)), f.toScreen(cellPoint(13, 10)), false)
  expect("held with its anode on D5's upper pin at a right angle, D6 is not drawn as blocked (findings 4.U12)", await blockedNow(page, "D6"), false)
  await page.mouse.up()
  await page.waitForTimeout(800)
  expect("dropped there, D6 stays where it was let go", await f.worldOf("D6"), { x: 11 * GRID, y: 9 * GRID })

  const spliceDoc = (): Schematic => ({
    objects: [resistorAt("R1", 10, 10), resistorAt("R2", 26, 10), resistorAt("R3", 16, 16)],
    wires: [{ id: "w1", a: cellPoint(14, 11), b: cellPoint(26, 11) }],
    parts: {},
  })
  const runs = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-slot=wires] [data-wire][data-points]")]
        .map((e) => (e.getAttribute("data-points") ?? "").split(" ").map((p) => p.split(",").map(Number)))
        .map((pts) => pts.flat())
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    )
  const along = (y: number, from: number, to: number) => [from * GRID, y * GRID, to * GRID, y * GRID]
  await openDoc(page, "splice", spliceDoc())
  f = await fieldFrame(page)
  await dragBy(page, f.toScreen(cellPoint(18, 17)), f.toScreen(cellPoint(18, 11)))
  expect("R3 dropped onto the R1–R2 wire lands there (findings 4.U8)", await f.worldOf("R3"), { x: 16 * GRID, y: 10 * GRID })
  expect("and the wire is cut under its body: exactly two halves, R1 to R3 and R3 to R2, no open end (design.md §5.3)", [await runs(), await countOf(page, "[data-dangling]")], [[along(11, 14, 16), along(11, 20, 26)], 0])
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  expect("one Undo takes back the drop and the cut together: R3 home, the wire whole (junctions.md principle 2)", [await f.worldOf("R3"), await runs()], [{ x: 16 * GRID, y: 16 * GRID }, [along(11, 14, 26)]])
  await page.keyboard.press("Control+Shift+z")
  await page.waitForTimeout(500)
  expect("one Redo puts both back", [await f.worldOf("R3"), await runs()], [{ x: 16 * GRID, y: 10 * GRID }, [along(11, 14, 16), along(11, 20, 26)]])
  await openDoc(page, "splice-alt", spliceDoc())
  f = await fieldFrame(page)
  await page.keyboard.down("Alt")
  await dragBy(page, f.toScreen(cellPoint(18, 17)), f.toScreen(cellPoint(18, 11)))
  await page.keyboard.up("Alt")
  const onTheRow = (await runs()).filter((r) => r.every((v, k) => k % 2 === 0 || v === 11 * GRID)).map((r) => [Math.min(...r.filter((_, k) => k % 2 === 0)), Math.max(...r.filter((_, k) => k % 2 === 0))]).sort((a, b) => a[0] - b[0])
  const covers = onTheRow.reduce((reach, [lo, hi]) => (lo <= reach ? Math.max(reach, hi) : reach), 14 * GRID) >= 26 * GRID && onTheRow[0]?.[0] === 14 * GRID
  expect("with Alt held R3 lands on the wire and the wire runs on from R1 to R2 under it, nothing cut (design.md §5.3: Alt suppresses)", [await f.worldOf("R3"), covers], [{ x: 16 * GRID, y: 10 * GRID }, true])

  await openDoc(page, "fields", { objects: [{ ...resistorAt("R1", 10, 10), props: { ref: "R1", value: "1 kΩ" } }], wires: [], parts: {} })
  f = await fieldFrame(page)
  const fieldBox = () => page.evaluate(() => document.querySelector("[data-field='R1:ref']")?.getBoundingClientRect().toJSON() ?? null)
  const before = await fieldBox()
  const body = await box(page, "R1")
  expect("R1's designator is a field of its own, drawn above the lying resistor (design.md §5.2)", !!before && before.y + before.height <= body.y + body.height / 2, true)
  if (!before) expect("a field dragged by hand follows the pointer and lands three cells right, the part stays", "no field to drag", "a field")
  else {
    const cell = (await f.toScreen(cellPoint(1, 0))).x - (await f.toScreen(cellPoint(0, 0))).x
    const grip = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
    const moved = (b: { x: number; y: number } | null) => (b ? [Math.round(((b.x - before.x) / cell) * 1000), Math.round(((b.y - before.y) / cell) * 1000)] : null)
    await dragBy(page, grip, { x: grip.x + 3 * cell, y: grip.y }, false)
    expect("held, the field follows the pointer three cells right and the part stays", [moved(await fieldBox()), await f.worldOf("R1")], [[3000, 0], { x: 10 * GRID, y: 10 * GRID }])
    await page.mouse.up()
    await page.waitForTimeout(500)
    expect("dropped, the field is three cells right, not a hair up or down, and the part has not moved", [moved(await fieldBox()), await f.worldOf("R1")], [[3000, 0], { x: 10 * GRID, y: 10 * GRID }])
    await page.keyboard.press("Control+z")
    await page.waitForTimeout(500)
    expect("one Undo puts the field back", moved(await fieldBox()), [0, 0])
  }

  await openDoc(page, "checker", {
    objects: [resistorAt("R1", 10, 10), resistorAt("R2", 10, 16)],
    wires: [
      { id: "w", a: cellPoint(14, 11), b: cellPoint(20, 11) },
      { id: "w2", a: cellPoint(10, 11), b: cellPoint(10, 17) },
      { id: "w3", a: cellPoint(14, 17), b: cellPoint(20, 17) },
    ],
    parts: {},
  })
  f = await fieldFrame(page)
  const toggle = page.locator("button[aria-label^='Show the field']")
  if (await toggle.count()) await toggle.first().click()
  await page.waitForTimeout(400)
  f = await fieldFrame(page)
  const findings = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=field-panel] [data-problem^='check:']")].map((e) => e.getAttribute("data-problem")!.split(":")[1]))
  const marks = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=check-marks] [data-finding='dangling-end']")].map((e) => e.getAttribute("data-at")).sort())
  expect("the checker lists both dangling ends among the field's problems (design.md §6.8: in the inspector; since main, the explorer's Problems)", (await findings()).filter((k) => k === "dangling-end").length, 2)
  expect("and marks both on the field, where they are", await marks(), [`${20 * GRID},${11 * GRID}`, `${20 * GRID},${17 * GRID}`])
  await page.mouse.click((await f.toScreen(cellPoint(15, 14))).x, (await f.toScreen(cellPoint(15, 14))).y)
  await page.keyboard.press("Shift+Digit1")
  await page.waitForTimeout(600)
  f = await fieldFrame(page)
  const free = await f.toScreen(cellPoint(20, 11))
  await page.mouse.move(free.x, free.y)
  await page.keyboard.press("q")
  await page.waitForTimeout(500)
  expect(
    "Q over one end puts one no-connect mark there; only that finding goes, in the panel and on the field (KiCad's no-connect flag, its key)",
    [await countOf(page, "[data-body] [data-slot=component][data-def='no-connect']"), (await findings()).filter((k) => k === "dangling-end").length, await marks()],
    [1, 1, [`${20 * GRID},${17 * GRID}`]],
  )
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  expect("one Undo takes the mark away and both findings are back", [await countOf(page, "[data-body] [data-slot=component][data-def='no-connect']"), await marks()], [0, [`${20 * GRID},${11 * GRID}`, `${20 * GRID},${17 * GRID}`]])
  const ringsAt = (at: string) =>
    page.evaluate((point) => [...document.querySelectorAll<SVGElement>(`[data-slot=check-marks] [data-at='${point}']`)].filter((e) => e.isConnected && getComputedStyle(e).display !== "none" && getComputedStyle(e.ownerSVGElement ?? e).display !== "none").length, at)
  const oldEnd = `${20 * GRID},${17 * GRID}`
  const onWire = await f.toScreen(cellPoint(17, 17))
  const below = await f.toScreen(cellPoint(17, 21))
  await page.mouse.move(onWire.x, onWire.y)
  await page.mouse.down()
  await page.mouse.move(below.x, below.y, { steps: 8 })
  await page.waitForTimeout(200)
  expect("held, a dragged wire leaves no checker ring where its open end was (the user's check of step 5, like 4.U5)", await ringsAt(oldEnd), 0)
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect("released, the ring is at the wire's new open end and not at the old one", [await ringsAt(oldEnd), await ringsAt(`${20 * GRID},${21 * GRID}`)], [0, 1])
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  const r1 = await f.toScreen(cellPoint(12, 11))
  await page.mouse.move(r1.x, r1.y)
  await page.mouse.down()
  await page.mouse.move(r1.x, r1.y + (await f.toScreen(cellPoint(0, 3))).y - (await f.toScreen(cellPoint(0, 0))).y, { steps: 8 })
  await page.waitForTimeout(200)
  expect("held, a dragged part leaves no checker ring behind either", await page.evaluate(() => [...document.querySelectorAll<SVGElement>("[data-slot=check-marks] circle")].filter((e) => getComputedStyle(e.ownerSVGElement ?? e).display !== "none" && getComputedStyle(e).display !== "none").length), 0)
  await page.mouse.up()
  await page.waitForTimeout(600)
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  const r2 = await f.toScreen(cellPoint(12, 17))
  await dragBy(page, r2, { x: r2.x, y: r2.y + (await f.toScreen(cellPoint(0, 3))).y - (await f.toScreen(cellPoint(0, 0))).y })
  expect("an ordinary edit goes through while findings stand: the checker never blocks", (await f.worldOf("R2")).y, 19 * GRID)
}

async function zoomAcrossPinDetail(page: Page) {
  const pinsDrawn = () => page.evaluate(() => document.querySelectorAll("[data-slot=pins] [data-pin]").length > 0)
  await page.keyboard.down("Control")
  let notches = 0
  while ((await pinsDrawn()) && notches < 12) {
    await page.mouse.wheel(0, 100)
    await page.waitForTimeout(400)
    notches++
  }
  const hidden = !(await pinsDrawn())
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(250)
  }
  await page.keyboard.up("Control")
  await page.waitForTimeout(900)
  expect(`mid-drag, ${notches} wheel notches out hid the pins and as many back drew them again`, hidden && (await pinsDrawn()), true)
}

async function contactsFollowTheDrag(page: Page) {
  console.log("\ncontact dots follow a drag")
  const doc = await open(page, "open746-lcd")
  const lcd = doc.objects.find((o) => o.def === "lcd7-f")!
  const board = doc.objects.find((o) => o.def === "open746i-c")!
  const docked = await box(page, lcd.id)
  const cell = docked.width / getDef("lcd7-f")!.width
  const grab = { x: docked.x + docked.width / 2, y: docked.y + LCD_BEZEL_CELLS * cell }
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-body]")?.getAttribute("data-body"), grab)
  expect("the grab point is on the LCD", hit, lcd.id)
  const before = { lcd: await dots(page, lcd.id), board: await dots(page, board.id) }
  console.log(`  docked: LCD ${before.lcd.contact} dots, board ${before.board.contact} dots, ${cell.toFixed(2)} px a cell`)
  expect("docked, the LCD shows a contact dot on every FFC pin", before.lcd.contact >= 40, true)

  const to = async (cx: number, cy: number) => {
    await page.mouse.move(grab.x + cx * cell, grab.y + cy * cell, { steps: 6 })
    await page.waitForTimeout(150)
  }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await to(0, 3)
  await shoot(page, "lcd-lifted")
  expect("3 cells down, before release: no LCD dot is left", (await dots(page, lcd.id)).contact, 0)
  expect("…nor on P15", (await dots(page, board.id)).contact, before.board.contact - before.lcd.contact)
  await to(0, 2)
  expect("2 cells down, its FFC tail over the board's: the plate is red (on the board, pins in no socket)", await blockedNow(page, lcd.id), true)
  await to(0, 3)
  await zoomAcrossPinDetail(page)
  await to(0, 4)
  expect("zoomed out past the pin dots and back mid-drag, a cell further: still no P15 dot", (await dots(page, board.id)).contact, before.board.contact - before.lcd.contact)
  expect("…and the redrawn LCD pins travel with it", await page.evaluate((id) => document.querySelector(`[data-pins="${CSS.escape(id)}"]`)?.getAttribute("transform"), lcd.id), `translate(0 ${4 * GRID})`)
  await to(0, 1)
  expect("1 cell down: the top row sits on P15's bottom row", (await dots(page, lcd.id)).contact, before.lcd.contact / 2)
  await to(0, 0)
  expect("back on P15 mid-drag: every dot is back", await dots(page, lcd.id), before.lcd)
  expect("…on the board too", await dots(page, board.id), before.board)
  await to(0, LIFT_CELLS)
  await page.mouse.up()
  await page.waitForTimeout(800)
  expect(`released ${LIFT_CELLS} cells down: the committed picture agrees, no LCD dot`, (await dots(page, lcd.id)).contact, 0)
  expect("…and no P15 dot", (await dots(page, board.id)).contact, before.board.contact - before.lcd.contact)

  await page.mouse.move(800, 500)
  await page.mouse.wheel(0, PAN_PX)
  await page.waitForTimeout(500)
  const away = await box(page, lcd.id)
  const regrab = { x: away.x + away.width / 2, y: away.y + LCD_BEZEL_CELLS * cell }
  expect(`the LCD moved ${LIFT_CELLS} cells`, Math.round((away.y + PAN_PX - docked.y) / cell), LIFT_CELLS)
  await page.mouse.move(regrab.x, regrab.y)
  await page.mouse.down()
  await page.mouse.move(regrab.x, regrab.y - LIFT_CELLS * cell, { steps: 12 })
  await page.waitForTimeout(150)
  await shoot(page, "lcd-redocked")
  expect("dragged back onto P15, before release: the dots are black already", await dots(page, lcd.id), before.lcd)
  expect("…on both sides", await dots(page, board.id), before.board)
  await page.mouse.up()
  await page.waitForTimeout(800)
  expect("released: the committed picture is the same", { lcd: await dots(page, lcd.id), board: await dots(page, board.id) }, before)
}

async function bridgeBuiltByHand(page: Page) {
  console.log("\na diode bridge built by hand: four diodes turned with R and Shift+R, dragged corner to corner")
  const diode = (n: number): PlacedObject => ({ id: `d${n}`, def: "diode", x: 0, y: (n - 1) * 3 * GRID, props: { ref: `D${n}`, value: "1N4007", vrev: "1000 V" } })
  let doc: Schematic = { objects: [1, 2, 3, 4].map(diode), wires: [], parts: {} }
  const corner: PlacedObject = { id: "g", def: "ground", x: 12 * GRID, y: 10 * GRID }
  await openDoc(page, "bridge-by-hand", { ...doc, objects: [...doc.objects, corner], version: SCHEMATIC_VERSION } as Schematic)
  const frame = await fieldFrame(page)
  const middle = (o: PlacedObject) => {
    const c = bodyCentre(getDef(o.def)!, orientationOf(o))
    return frame.toScreen({ x: o.x + c.x * GRID, y: o.y + c.y * GRID })
  }
  const plan: [string, Turn, number, number, number][] = [["d1", -1, 1, 5, 1], ["d2", -1, 3, 8, 1], ["d3", -1, 3, 5, 4], ["d4", -1, 1, 8, 4]]
  const reachable = (p: Point) => p.x > 270 && p.x < 1150 && p.y > 40 && p.y < 950
  for (const [id, turn, presses, tx, ty] of plan) {
    const before = doc.objects.find((o) => o.id === id)!
    expect(`${id} starts where the pointer can reach it, clear of the inspector`, reachable(middle(before)), true)
    await page.mouse.click(middle(before).x, middle(before).y)
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(turn > 0 ? "r" : "Shift+R")
      doc = rotateSelection(doc, new Set([id]), turn, GRID)
      await page.waitForTimeout(150)
    }
    const turned = doc.objects.find((o) => o.id === id)!
    const target = { ...turned, x: tx * GRID, y: ty * GRID }
    expect(`${id} goes where the pointer can reach`, reachable(middle(target)), true)
    await dragBy(page, middle(turned), middle(target))
    doc = { ...doc, objects: doc.objects.map((o) => (o.id === id ? target : o)) }
  }
  await page.mouse.click(300, 900)
  await page.waitForTimeout(500)
  await shoot(page, "bridge-by-hand")
  const placed = await page.evaluate(() =>
    [...document.querySelectorAll("[data-body]")].map((e) => {
      const svg = e.querySelector<SVGSVGElement>("[data-slot=component]")!
      return { id: e.getAttribute("data-body"), transform: svg.style.transform }
    }),
  )
  expect("each diode turned by R and Shift+R stands on its diagonal", placed.filter((p) => p.id?.startsWith("d")).map((p) => p.transform), ["rotate(315deg)", "rotate(225deg)", "rotate(225deg)", "rotate(315deg)"])
  for (const id of ["d1", "d2", "d3", "d4"]) {
    const marks = await dots(page, id)
    expect(`${id}: both pins meet a neighbour's: no open-pin marker left, and no dot where only two ends meet (design.md §3.2–3.3)`, { open: marks.open, contact: marks.contact }, { open: 0, contact: 0 })
  }
}

async function addingLandsInView(page: Page) {
  console.log("\na part added over a big board")
  const doc = await open(page, "lab1-running-light")
  const board = doc.objects.find((o) => o.def === "open746i-c")!
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Control+Equal")
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1200)
  const zoom = await page.evaluate(() => document.querySelector("[data-slot=zoom-controls]")?.textContent?.match(/(\d+)%/)?.[1])
  console.log(`  zoom ${zoom}%`)
  const before = new Set(await page.evaluate(() => [...document.querySelectorAll("[data-body]")].map((e) => e.getAttribute("data-body")!)))
  // Groups past the first start folded: unfold the crystal's before clicking it.
  const crystal = page.getByRole("button", { name: "Crystal", exact: true })
  if (!(await crystal.isVisible())) await page.getByRole("button", { name: /^ICs & timing/ }).click()
  // A click arms the part for the pointer; Enter on the focused row is what adds it in view.
  await crystal.focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(1500)
  const added = (await page.evaluate(() => [...document.querySelectorAll("[data-body]")].map((e) => e.getAttribute("data-body")!))).filter((id) => !before.has(id))
  expect("one part was added", added.length, 1)
  const q = await box(page, added[0])
  const b = await box(page, board.id)
  const view = (await page.locator("[data-slot=dot-field-viewport]").boundingBox())!
  expect("the crystal is not on the board, its outline or its P15 tab", onTheBoard(q, b), false)
  const inside = q.x >= view.x && q.y >= view.y && q.x + q.width <= view.x + view.width && q.y + q.height <= view.y + view.height
  expect("…and the view came round to it: it is on screen", inside, true)
  expect("…selected", await page.evaluate((id) => !!document.querySelector(`[data-slot=selection] [data-plate="${CSS.escape(id)}"]`), added[0]), true)
  await shoot(page, "crystal-added")
}

async function noPluggingIntoHeaders(page: Page) {
  console.log("\na crystal dropped with its leads on a board's header pins")
  const base = examples.find((e) => e.id === "lab1-running-light")!.build(GRID)
  const board = base.objects.find((o) => o.def === "open746i-c")!
  const frameOfBoard = objectRect(board, GRID)
  const pins = objectPins(board, GRID)
  const [left] = pins.flatMap((a) => pins.filter((b) => b.point.y === a.point.y && b.point.x - a.point.x === 4 * GRID).map((b) => [a, b] as const)).filter(([a]) => a.point.y - frameOfBoard.y >= 4 * GRID && frameOfBoard.y + frameOfBoard.h - a.point.y >= 4 * GRID && a.point.x - frameOfBoard.x >= 4 * GRID && frameOfBoard.x + frameOfBoard.w - a.point.x >= 8 * GRID)[0]!
  const q = crystal("plug", 90, 10, "ZQ1")
  await openDoc(page, "plug", { ...base, objects: [...base.objects, q] })
  const frame = await fieldFrame(page)
  const target = { x: left.point.x, y: left.point.y - GRID }
  const grab = frame.toScreen(crystalMiddle(q))
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-body]")?.getAttribute("data-body"), grab)
  expect("the grab point is on the crystal", hit, q.id)
  await dragBy(page, grab, frame.toScreen(crystalMiddle({ ...q, ...target })), false)
  expect(`over ${left.key.split(":")[1]} and the pin four cells on, the plate is red`, await blockedNow(page, q.id), true)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const landed = await frame.worldOf(q.id)
  console.log(`  aimed at (${target.x / GRID}, ${target.y / GRID}) cells, landed at (${landed.x / GRID}, ${landed.y / GRID})`)
  expect("released: it did not stay on the header", Math.hypot(landed.x - target.x, landed.y - target.y) > GRID / 2, true)
  expect("…it is off the board, its outline and its P15 tab", onTheBoard(await box(page, q.id), await box(page, board.id)), false)
  expect("…and nothing of it is plugged in", (await dots(page, q.id)).contact, 0)
  expect("…nor sent home: the board's edge is nearer to the drop", Math.hypot(landed.x - q.x, landed.y - q.y) > GRID / 2, true)
}

async function freedSlotTakesTheDrop(page: Page) {
  console.log("\na crystal dropped half on a neighbour beside a freed slot")
  const pitch = { x: 5, y: 2 }
  const block: PlacedObject[] = []
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) if (row !== 1 || col !== 1) block.push(crystal(`q${row}${col}`, col * pitch.x, row * pitch.y, `ZQ${block.length + 1}`))
  const mover = crystal("mover", 40, 20, "ZQ9")
  await openDoc(page, "slot", { objects: [...block, mover], wires: [], parts: {} })
  const frame = await fieldFrame(page)
  const slot = { x: pitch.x * GRID, y: pitch.y * GRID }
  const drop = { x: slot.x + 2 * GRID, y: slot.y }
  await dragBy(page, frame.toScreen(crystalMiddle(mover)), frame.toScreen(crystalMiddle({ ...mover, ...drop })), false)
  expect("two cells right of the slot its lead lies along its neighbour's: red", await blockedNow(page, mover.id), true)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const landed = await frame.worldOf(mover.id)
  const cells = (p: Point) => ({ x: p.x / GRID, y: p.y / GRID })
  expect("released: not left where it was blocked", landed.x === drop.x && landed.y === drop.y, false)
  expect("…but a cell below the drop, the nearest spot it fits, nearer home of the two (design.md §5.1: bodies and leads only)", cells(landed), cells({ x: drop.x, y: drop.y + GRID }))
  await shoot(page, "freed-slot")
}

const cursorOnTheFirstVisible = (page: Page, selector: string) =>
  page.evaluate((s) => {
    for (const target of document.querySelectorAll(s)) {
      const r = target.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (hit && target.contains(hit)) return getComputedStyle(hit).cursor
    }
    return null
  }, selector)

const cursorOnTheEmptyField = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.querySelector("[data-slot=dot-field-viewport]")!
    const r = viewport.getBoundingClientRect()
    for (let y = r.top + 20; y < r.bottom; y += 17)
      for (let x = r.left + 20; x < r.right; x += 17) if (document.elementFromPoint(x, y) === viewport) return getComputedStyle(viewport).cursor
    return null
  })

async function cursorsOverARunningBench(page: Page) {
  console.log("\nthe crosshair and the text cursor over a running bench")
  await open(page, "open746-touch")
  await page.getByRole("button", { name: "Run", exact: true }).click()
  await page.waitForTimeout(1500)
  expect("the bench is running", await page.getByRole("button", { name: "Pause", exact: true }).count(), 1)
  const cursors: Record<string, string | null> = {
    "the empty field": await cursorOnTheEmptyField(page),
    "a pin": await cursorOnTheFirstVisible(page, "[data-slot=pins] [data-pin] circle"),
    "the touch panel": await cursorOnTheFirstVisible(page, "[data-slot=component] foreignObject"),
  }
  await page.keyboard.press("o")
  await page.waitForTimeout(800)
  cursors["the oscilloscope"] = await cursorOnTheFirstVisible(page, "[data-slot=scope] canvas")
  cursors["the palette's search box"] = await cursorOnTheFirstVisible(page, 'input[placeholder="Search parts…"]')
  await page.keyboard.press("o")
  // The palette's one way in to HDL is a menu: VHDL or Verilog, new or imported.
  await page.getByRole("button", { name: /^New HDL component/ }).first().click()
  await page.getByRole("menuitem", { name: "New VHDL component" }).click()
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1000)
  cursors["the code editor"] = await cursorOnTheFirstVisible(page, ".monaco-editor .view-lines")
  for (const [where, cursor] of Object.entries(cursors))
    expect(`over ${where}, a cursor picture of our own, not the system one Windows draws by inverting`, cursor?.startsWith("url(") ? "ours" : cursor, "ours")
}

async function typeBPlugTakesTheClick(page: Page) {
  for (const rotation of [0, 90] as const) {
    console.log(`\nthe STM32-H405's USB-B plug, board turned ${rotation}°: a click on the overmold or the cable unplugs it, one on the receptacle plugs it back`)
    const base = examples.find((e) => e.id === "h405-blink")!.build(GRID)
    await openDoc(page, `h405-usb-${rotation}`, { ...base, objects: base.objects.map((o) => (o.def === "olimex-stm32-h405" ? { ...o, rotation } : o)) })
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press("Control+Minus")
      await page.waitForTimeout(300)
    }
    const usb = page.locator("[data-slot=component] g.cursor-pointer").filter({ has: page.locator("title", { hasText: /^USB: click to/ }) }).first()
    const state = async () => ((await usb.locator("title").textContent()) ?? "").replace(/^USB: click to /, "")
    const centre = async (selector: string, along = 0.5) => {
      const b = (await usb.locator(selector).first().boundingBox())!
      return { x: b.x + b.width * (rotation ? 0.5 : along), y: b.y + b.height * (rotation ? along : 0.5) }
    }
    const onThePlug = (p: Point) => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest("g.cursor-pointer title, g.cursor-pointer")?.querySelector("title")?.textContent?.startsWith("USB"), p)
    expect("plugged in at first", await state(), "unplug")
    const overmold = await centre("rect.fill-foreground")
    const cable = await centre("line.stroke-foreground", 0.2)
    const face = await centre("rect.fill-secondary")
    expect("the overmold and the cable are in the field, not under a panel", [await onThePlug(overmold), await onThePlug(cable)], [true, true])
    await page.mouse.click(overmold.x, overmold.y)
    expect("a click on the overmold unplugs it", await state(), "plug in")
    await page.mouse.click(face.x, face.y)
    expect("a click on the receptacle's face plugs it back", await state(), "unplug")
    await page.mouse.click(cable.x, cable.y)
    expect("a click on the cable, well away from the board, unplugs it", await state(), "plug in")
  }
}

try {
  await fetch(DEV_SERVER, { signal: AbortSignal.timeout(3000) })
} catch {
  console.log(`No dev server at ${DEV_SERVER}. Start one with:\n\n  CHOKIDAR_USEPOLLING=true pnpm dev\n`)
  process.exit(1)
}
const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors: string[] = []
page.on("pageerror", (e) => errors.push(String(e)))
try {
  await contactsFollowTheDrag(page)
  await wiresFollowTheDrag(page)
  await drawFromAWire(page)
  await farDropAndWireCopy(page)
  await morningChecks(page)
  await phaseFiveChecks(page)
  await bridgeBuiltByHand(page)
  await noPluggingIntoHeaders(page)
  await freedSlotTakesTheDrop(page)
  await addingLandsInView(page)
  await typeBPlugTakesTheClick(page)
  await cursorsOverARunningBench(page)
} finally {
  await browser.close()
}
expect("no page errors", errors, [])
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
