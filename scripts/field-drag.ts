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
  const dimmed = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-net]")].filter((e) => getComputedStyle(e).opacity !== "1").length)
  await page.mouse.click(toWire.x, toWire.y)
  await page.waitForTimeout(250)
  const notices = () => page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((e) => e.textContent ?? "").filter((t) => /joined|split apart|in series/.test(t)))
  expect("two nets joined by a drawn wire: no notice and no flash, nothing dimmed (the user, 2026-11-11)", [await notices(), await page.evaluate(() => document.querySelectorAll("[data-slot=wires] [data-flash]").length), await dimmed()], [[], 0, 0])
  await openDoc(page, "join-unlit", {
    objects: [resistorAt("R1", 10, 10), resistorAt("R4", 18, 16)],
    wires: [{ id: "a", a: cellPoint(14, 11), b: cellPoint(17, 11) }, { id: "b", a: cellPoint(22, 17), b: cellPoint(26, 17) }, { id: "c", a: cellPoint(10, 20), b: cellPoint(14, 20) }],
    parts: {},
  })
  const unlit = await fieldFrame(page)
  await dragBy(page, unlit.toScreen(cellPoint(20, 17)), unlit.toScreen(cellPoint(19, 11)), false)
  expect("R4 held with its pin on another net's open end: no wire dims before the drop (the user, 2026-11-11)", await dimmed(), 0)
  await page.mouse.up()
  await page.waitForTimeout(500)
  expect("and dropped there: no notice, no flash", [await notices(), await page.evaluate(() => document.querySelectorAll("[data-slot=wires] [data-flash]").length)], [[], 0])
  await openDoc(page, "stub-wire", { objects: [resistorAt("R1", 10, 10)], wires: [{ id: "stub", a: cellPoint(12, 13), b: cellPoint(13, 13) }], parts: {} })
  const stubFrame = await fieldFrame(page)
  const stubMiddle = stubFrame.toScreen(cellPoint(12.5, 13))
  await page.mouse.click(stubMiddle.x, stubMiddle.y)
  await page.waitForTimeout(300)
  expect("a one-cell wire with two open ends: a click on its middle selects it rather than starting a wire from an end (the user, 2026-11-11)", [(await countOf(page, "[data-slot=selection] [data-wire]")) > 0, await countOf(page, "[data-slot^=pending-wire]")], [true, 0])
  await page.keyboard.press("Delete")
  await page.waitForTimeout(400)
  expect("and Delete removes it", await countOf(page, "[data-slot=wires] [data-wire]"), 0)
  await openDoc(page, "plate-run", { objects: [resistorAt("R1", 10, 10)], wires: [{ id: "l1", a: cellPoint(14, 11), b: cellPoint(15, 11) }, { id: "l2", a: cellPoint(15, 11), b: cellPoint(15, 13) }], parts: {} })
  const plateFrame = await fieldFrame(page)
  const onUpright = plateFrame.toScreen(cellPoint(15, 12.3))
  await page.mouse.click(onUpright.x, onUpright.y)
  await page.waitForTimeout(300)
  const plate = await page.evaluate(() => ({
    plates: [...document.querySelectorAll("[data-slot=selection] [data-wire]")].map((e) => [e.hasAttribute("data-whole"), e.getAttribute("d")]),
    wire: document.querySelector("[data-slot=wires] [data-wire] path[data-base]")?.getAttribute("d") ?? null,
  }))
  expect("a click on one leg of an L selects the whole wire, and its plate is drawn along the wire's own rounded path (the user, 2026-11-11)", plate.plates.length > 0 && plate.plates.every(([whole, d]) => whole && d === plate.wire) ? "along the wire" : plate, "along the wire")
  await openDoc(page, "through-body", { objects: [resistorAt("R1", 10, 10), resistorAt("R2", 10, 14)], wires: [{ id: "across", a: cellPoint(12, 9), b: cellPoint(12, 13) }, { id: "under", a: cellPoint(9, 12), b: cellPoint(15, 12) }], parts: {} })
  const masking = await page.evaluate(() => {
    const casings = [...document.querySelectorAll("[data-slot=wires] [data-casing]")]
    const masked = casings.filter((e) => e.closest("[mask]")?.getAttribute("mask") === "url(#field-body-mask)")
    return { casings: casings.length, masked: masked.length, bodies: document.querySelectorAll("#field-body-mask polygon").length }
  })
  expect("a wire across R1's body cuts the wire it crosses but not R1: every gap is kept off both resistors' bodies (the user, 2026-11-11)", [masking.casings > 0, masking.masked === masking.casings, masking.bodies], [true, true, 2])
  await openDoc(page, "armed-double-click", { objects: [resistorAt("R1", 10, 10)], wires: [{ id: "w", a: cellPoint(9, 13), b: cellPoint(15, 13) }], parts: {} })
  const armedFrame = await fieldFrame(page)
  await page.addStyleTag({ content: "[data-sonner-toaster]{display:none!important}" })
  await page.getByRole("button", { name: "Resistor", exact: true }).click()
  await page.waitForTimeout(400)
  const onTheWire = armedFrame.toScreen(cellPoint(12, 13))
  await page.mouse.move(onTheWire.x, onTheWire.y, { steps: 6 })
  await page.waitForTimeout(300)
  await page.mouse.dblclick(onTheWire.x, onTheWire.y)
  await page.waitForTimeout(800)
  expect("a resistor in hand double-clicked onto a wire is placed once and leaves the hand; no wire is started (the user, 2026-11-11)", [await countOf(page, "[data-body]"), await countOf(page, "[data-slot=placement-hint]"), await countOf(page, "[data-slot^=pending-wire]")], [2, 0, 0])
  await page.keyboard.press("Escape")
  await open(page, "bridge")
  expect("a junction dot paints no white ring over the leads and wires that meet in it (the user, 2026-11-11: leads cut short at the diamond's corners)", await page.evaluate(() => [document.querySelectorAll("[data-junction]").length > 0, document.querySelectorAll("[data-junction] circle[fill='var(--background)']").length]), [true, 0])
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

async function doubleClickChecks(page: Page) {
  console.log("\ndouble clicks: start a wire on bare field, end it as Enter does (the user, 2026-11-06)")
  await openDoc(page, "double-click", { objects: [resistorAt("F1", -6, -4), resistorAt("F2", 28, 16)], wires: [], parts: {} })
  const f = await fieldFrame(page)
  const at = (x: number, y: number) => f.toScreen(cellPoint(x, y))
  const openEnds = () => page.evaluate(() => [...document.querySelectorAll("[data-dangling]")].map((e) => e.getAttribute("data-dangling")).sort())
  const drawing = () => countOf(page, "[data-slot=pending-wire-route]")
  const start = await at(6, 6)
  await page.mouse.dblclick(start.x, start.y)
  const corner = await at(10, 6)
  await page.mouse.move(corner.x, corner.y, { steps: 6 })
  await page.waitForTimeout(200)
  expect("a double click on bare field starts a wire there, as W and a click did", await drawing(), 1)
  await page.mouse.click(corner.x, corner.y)
  const last = await at(10, 10)
  await page.mouse.move(last.x, last.y, { steps: 6 })
  await page.mouse.dblclick(last.x, last.y)
  await page.waitForTimeout(500)
  expect("a double click ends it at that point, as Enter ends it at the last clicked one", [await drawing(), await openEnds()], [0, [`${10 * GRID},${10 * GRID}`, `${6 * GRID},${6 * GRID}`].sort()])
  const single = await at(16, 6)
  await page.mouse.click(single.x, single.y)
  await page.mouse.move(single.x + 40, single.y, { steps: 4 })
  await page.waitForTimeout(200)
  expect("a single click on bare field starts nothing", await drawing(), 0)
  await page.waitForTimeout(600)
  const onWire = await at(8, 6)
  await page.mouse.dblclick(onWire.x, onWire.y)
  const branchTo = await at(8, 3)
  await page.mouse.move(branchTo.x, branchTo.y, { steps: 6 })
  await page.waitForTimeout(200)
  expect("a double click on a wire starts a branch from that point (the user, 2026-11-06)", await drawing(), 1)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)

  await openDoc(page, "crossing", { objects: [resistorAt("F1", -4, -3), resistorAt("F2", 11, 11)], wires: [{ id: "h", a: cellPoint(0, 5), b: cellPoint(10, 5) }, { id: "v", a: cellPoint(5, 0), b: cellPoint(5, 10) }], parts: {} })
  const g = await fieldFrame(page)
  const casings = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-casing]")].map((casing) => ({ gap: Number(casing.getAttribute("stroke-width")) - Number(document.querySelector(`[data-slot=wires] g[data-wire='${casing.getAttribute("data-wire")}'] > path`)?.getAttribute("stroke-width")), stroke: casing.getAttribute("stroke") })))
  expect("two wires crossing: each casing is 3 px wider than its wire on either side, so the crossing shows a gap one can see (design.md §8, «оставляем Gap железно»)", (await casings()).map((c) => c.gap), [6, 6])
  const bare = await g.toScreen(cellPoint(8, 2))
  await page.mouse.click(bare.x, bare.y)
  await page.keyboard.press("Control+a")
  await page.waitForTimeout(400)
  expect("selected, each wire keeps a 3 px casing, in the selection plate's own tint, so the gap stays and no white band shows inside the plate (the user's checks, 2026-11-06)", await casings(), [{ gap: 6, stroke: "var(--selection-tint)" }, { gap: 6, stroke: "var(--selection-tint)" }])
  await page.keyboard.press("Escape")
  await page.mouse.click(bare.x, bare.y)
  await page.waitForTimeout(700)
  const cross = await g.toScreen(cellPoint(5, 5))
  await page.mouse.dblclick(cross.x, cross.y)
  await page.waitForTimeout(500)
  expect("a double click on a crossing joins it, as J does: a dot there and nothing being drawn", [await countOf(page, `[data-junction='${5 * GRID},${5 * GRID}']`), await countOf(page, "[data-slot=pending-wire-route]")], [1, 0])
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

const hookedWire = (): Schematic => ({
  objects: [resistorAt("R1", 10, 10)],
  wires: [{ id: "level", a: cellPoint(14, 11), b: cellPoint(20, 11) }, { id: "down", a: cellPoint(20, 11), b: cellPoint(20, 15) }],
  parts: {},
})

async function zoomTo(page: Page, outSteps: number) {
  await page.keyboard.press("Control+0")
  await page.waitForTimeout(500)
  for (let k = 0; k < outSteps; k++) await page.keyboard.press("Control+Minus")
  await page.waitForTimeout(900)
}

async function openEndCue(page: Page) {
  console.log("\nan open end shows that a press there continues the wire, and the rest of the wire that a press moves it (the user, 2026-11-11)")
  await openDoc(page, "open-end-cue", hookedWire())
  const end = `${20 * GRID},${15 * GRID}`
  const cue = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=open-end-cue] [data-continues]")].map((e) => e.getAttribute("data-continues")))
  const cueSize = () => page.evaluate(() => {
    const ring = document.querySelector("[data-slot=open-end-cue] circle[data-continues]")
    return ring ? Math.round(ring.getBoundingClientRect().width) : 0
  })
  const cursorAt = (p: Point) => page.evaluate(({ x, y }) => {
    const cursor = getComputedStyle(document.elementFromPoint(x, y)!).cursor
    return cursor.startsWith("url(") ? "precise" : cursor
  }, p)
  const hover = async (p: Point) => {
    await page.mouse.move(p.x, p.y, { steps: 4 })
    await page.waitForTimeout(150)
  }
  for (const [zoom, outSteps, near, far] of [["100 %", 0, 4, 40], ["33 %", 6, 5, 12], ["300 %", -6, 8, 60]] as const) {
    if (outSteps >= 0) await zoomTo(page, outSteps)
    else {
      await zoomTo(page, 0)
      for (let k = 0; k < -outSteps; k++) await page.keyboard.press("Control+Equal")
      await page.waitForTimeout(900)
    }
    const f = await fieldFrame(page)
    const tip = f.toScreen(cellPoint(20, 15))
    const beside = { x: tip.x + near * 0.6, y: tip.y - near * 0.8 }
    await hover(beside)
    expect(`${zoom}: ${near} px from the open end the end is marked: a press there continues the wire`, await cue(), [end])
    expect(`${zoom}: and the cursor there is the cross a pin shows, the one that starts a wire`, await cursorAt(beside), "precise")
    if (zoom === "33 %") expect(`${zoom}: the mark is at least 14 px across, as wide as the press reaches`, (await cueSize()) >= 14, true)
    const onWire = { x: tip.x, y: tip.y - far }
    await hover(onWire)
    expect(`${zoom}: ${far} px up the wire nothing is marked`, await cue(), [])
    expect(`${zoom}: and the cursor says a press moves the wire`, await cursorAt(onWire), "move")
  }
  await zoomTo(page, 6)
  const f = await fieldFrame(page)
  const tip = f.toScreen(cellPoint(20, 15))
  await hover({ x: tip.x + 3, y: tip.y - 4 })
  await page.mouse.down()
  await page.mouse.move(tip.x + 40, tip.y + 30, { steps: 8 })
  await page.waitForTimeout(200)
  expect("33 %: a press where the end is marked starts drawing from it, and the mark gives way to the wire being drawn", [await countOf(page, "[data-slot=pending-wire-route]"), await cue()], [1, []])
  await page.mouse.up()
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  const up = { x: tip.x, y: tip.y - 12 }
  await hover(up)
  await page.mouse.down()
  await page.mouse.move(up.x + f.toScreen(cellPoint(23, 15)).x - tip.x, up.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect("33 %: a press where nothing is marked moves the wire: no wire drawn, the open end three cells right", [await countOf(page, "[data-slot^=pending-wire]"), await page.evaluate(() => [...document.querySelectorAll("[data-dangling]")].map((e) => e.getAttribute("data-dangling")))], [0, [`${23 * GRID},${15 * GRID}`]])
}

async function shorteningFromAnOpenEnd(page: Page) {
  console.log("\na press on an open end drawn back along the wire shortens it, as Zip retracts a path (the user, 2026-11-11)")
  const rings = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-dangling]")].filter((e) => getComputedStyle(e).display !== "none").map((e) => e.getAttribute("data-dangling")))
  const bandRings = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=rubber-band] [data-band-dangling]")].map((e) => e.getAttribute("data-band-dangling")))
  const bandPieces = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-slot=rubber-band] [data-piece]")]
        .map((e) => {
          const [ax, ay, bx, by] = e.getAttribute("data-piece")!.split(" ").map(Number)
          return ax < bx || (ax === bx && ay <= by) ? `${ax} ${ay} ${bx} ${by}` : `${bx} ${by} ${ax} ${ay}`
        })
        .sort(),
    )
  const wirePoints = () => page.evaluate(() => [...document.querySelectorAll("[data-slot=wires] [data-wire][data-points]")].map((e) => e.getAttribute("data-points")))
  const key = (x: number, y: number) => `${x * GRID},${y * GRID}`
  const pointsOf = (...cells: [number, number][]) => cells.map(([x, y]) => key(x, y)).join(" ")
  await openDoc(page, "shorten", hookedWire())
  await zoomTo(page, 0)
  let f = await fieldFrame(page)
  const via = async (...cells: [number, number][]) => {
    for (const [x, y] of cells) {
      const p = f.toScreen(cellPoint(x, y))
      await page.mouse.move(p.x, p.y, { steps: 6 })
    }
    await page.waitForTimeout(200)
  }
  const press = async (x: number, y: number) => {
    const p = f.toScreen(cellPoint(x, y))
    await page.mouse.move(p.x, p.y)
    await page.waitForTimeout(100)
    await page.mouse.down()
  }
  await press(20, 15)
  await via([20, 13])
  expect("held two cells back up the wire: the wire ends there, its open end with it", [await bandRings(), await rings()], [[key(20, 13)], []])
  expect("and the wire shown is the shorter one", await bandPieces(), [`${14 * GRID} ${11 * GRID} ${20 * GRID} ${11 * GRID}`, `${20 * GRID} ${11 * GRID} ${20 * GRID} ${13 * GRID}`].sort())
  await via([20, 11], [17, 11])
  expect("on round the bend, three cells along: the bend is gone, the end follows the pointer", [await bandRings(), await bandPieces()], [[key(17, 11)], [`${14 * GRID} ${11 * GRID} ${17 * GRID} ${11 * GRID}`]])
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect("released: the wire is that much shorter, nothing left being drawn", [await rings(), await wirePoints(), await countOf(page, "[data-slot^=pending-wire]")], [[key(17, 11)], [pointsOf([14, 11], [17, 11])], 0])
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  expect("one undo gives the whole wire back", await rings(), [key(20, 15)])
  f = await fieldFrame(page)
  await press(20, 15)
  await via([20, 13], [22, 13], [23, 13])
  expect("back two cells and off to the right: the wire is cut back and drawn on from the cut", [await bandRings(), await page.evaluate(() => document.querySelector("[data-slot=pending-wire-route] path[stroke-dasharray]")?.getAttribute("d") ?? null)], [[key(20, 13)], `M${20 * GRID} ${13 * GRID} L${23 * GRID} ${13 * GRID}`])
  await page.mouse.up()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(600)
  expect("finished: the stub below the cut is gone and the wire turns off at it", [await rings(), await wirePoints()], [[key(23, 13)], [pointsOf([14, 11], [20, 11], [20, 13], [23, 13])]])
  await openDoc(page, "shorten-to-nothing", hookedWire())
  await zoomTo(page, 0)
  f = await fieldFrame(page)
  await press(20, 15)
  await via([20, 13], [20, 11], [17, 11], [14, 11])
  expect("held all the way back on R1's pin: no wire left on the field, and no ring left hanging where the end was", [await bandPieces(), await bandRings(), await rings()], [[], [], []])
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect("released there: the wire is gone", await countOf(page, "[data-slot=wires] [data-wire]"), 0)
  await openDoc(page, "shorten-and-back", hookedWire())
  await zoomTo(page, 0)
  f = await fieldFrame(page)
  await press(20, 15)
  await via([20, 12], [20, 15])
  expect("drawn back and forward again to the end: the wire is whole again", [await bandRings(), await rings()], [[], [key(20, 15)]])
  await page.mouse.up()
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  expect("and released and dropped there, nothing changed", await wirePoints(), [pointsOf([14, 11], [20, 11], [20, 15])])
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
  if (!before) expect("a field dragged by hand follows the pointer freely, off the cells, the part stays", "no field to drag", "a field")
  else {
    const cell = (await f.toScreen(cellPoint(1, 0))).x - (await f.toScreen(cellPoint(0, 0))).x
    const grip = { x: before.x + before.width / 2, y: before.y + before.height / 2 }
    const moved = (b: { x: number; y: number } | null) => (b ? [Math.round(((b.x - before.x) / cell) * 100), Math.round(((b.y - before.y) / cell) * 100)] : null)
    await dragBy(page, grip, { x: grip.x + 1.37 * cell, y: grip.y + 0.41 * cell }, false)
    expect("held, the field follows the pointer exactly, 1.37 cells right and 0.41 down, no invisible cells (the user, 2026-11-11), and the part stays", [moved(await fieldBox()), await f.worldOf("R1")], [[137, 41], { x: 10 * GRID, y: 10 * GRID }])
    await page.mouse.up()
    await page.waitForTimeout(500)
    expect("dropped, the field stays exactly where the pointer left it and the part has not moved", [moved(await fieldBox()), await f.worldOf("R1")], [[137, 41], { x: 10 * GRID, y: 10 * GRID }])
    await page.keyboard.press("Control+z")
    await page.waitForTimeout(500)
    expect("one Undo puts the field back", moved(await fieldBox()), [0, 0])
  }

  await page.keyboard.press("Escape")
  const cellPx = (await f.toScreen(cellPoint(1, 0))).x - (await f.toScreen(cellPoint(0, 0))).x
  const resistorBox = await box(page, "R1")
  const marqueeFrom = { x: resistorBox.x - 0.63 * cellPx, y: resistorBox.y + resistorBox.height + 0.29 * cellPx }
  const marqueeTo = { x: marqueeFrom.x + 1.44 * cellPx, y: marqueeFrom.y + 0.67 * cellPx }
  await dragBy(page, marqueeFrom, marqueeTo, false)
  const marqueeBox = await page.evaluate(() => document.querySelector("[data-slot=dot-field-selection]")?.getBoundingClientRect().toJSON() ?? null)
  const offBy = marqueeBox ? Math.max(Math.abs(marqueeBox.x - marqueeFrom.x), Math.abs(marqueeBox.y - marqueeFrom.y), Math.abs(marqueeBox.x + marqueeBox.width - marqueeTo.x), Math.abs(marqueeBox.y + marqueeBox.height - marqueeTo.y)) : Infinity
  expect("the selection box runs exactly from where the press was to the pointer, off the cells, within a pixel (the user, 2026-11-11)", offBy <= 1 ? "within a pixel" : { offBy, marqueeBox, marqueeFrom, marqueeTo }, "within a pixel")
  await page.mouse.up()
  await page.waitForTimeout(300)

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
  const rings = () => page.evaluate(() => document.querySelectorAll("[data-slot=check-marks], [data-finding]").length)
  expect("the checker lists both dangling ends among the field's problems (design.md §6.8: the explorer's Problems)", (await findings()).filter((k) => k === "dangling-end").length, 2)
  expect("and draws nothing on the field: no ring, no mark (the user, 2026-11-06)", await rings(), 0)
  const free = await f.toScreen(cellPoint(20, 11))
  await page.mouse.move(free.x, free.y)
  await page.keyboard.press("q")
  await page.waitForTimeout(500)
  expect("Q over an open end puts nothing there: there is no no-connect mark (the user, 2026-11-06)", [await countOf(page, "[data-body] [data-slot=component]"), (await findings()).filter((k) => k === "dangling-end").length], [2, 2])
  const onWire = await f.toScreen(cellPoint(17, 17))
  const below = await f.toScreen(cellPoint(17, 21))
  await page.mouse.move(onWire.x, onWire.y)
  await page.mouse.down()
  await page.mouse.move(below.x, below.y, { steps: 8 })
  await page.waitForTimeout(200)
  expect("held, a dragged wire shows no checker ring anywhere", await rings(), 0)
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect("released, still none", await rings(), 0)
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
const errors: string[] = []
const sections = [contactsFollowTheDrag, wiresFollowTheDrag, drawFromAWire, farDropAndWireCopy, morningChecks, doubleClickChecks, openEndCue, shorteningFromAnOpenEnd, phaseFiveChecks, bridgeBuiltByHand, noPluggingIntoHeaders, freedSlotTakesTheDrop, addingLandsInView, typeBPlugTakesTheClick, cursorsOverARunningBench]
try {
  for (const section of sections) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    page.on("pageerror", (e) => errors.push(String(e)))
    await section(page)
    await page.close()
  }
} finally {
  await browser.close()
}
expect("no page errors", errors, [])
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
