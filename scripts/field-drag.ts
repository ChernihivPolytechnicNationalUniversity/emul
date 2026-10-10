import { Buffer } from "node:buffer"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, type Page } from "playwright-core"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, objectRect, type Point } from "@/schematic/geometry"
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

async function openDoc(page: Page, name: string, doc: Schematic) {
  await page.goto(DEV_SERVER, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-slot=dot-field-viewport]")
  await page.setInputFiles("input[type=file]", { name: `${name}.emul`, mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify({ format: "emul-project", version: 1, name, schematic: doc })) })
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
const overlapping = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

const dots = (page: Page, id: string) =>
  page.evaluate((objectId) => {
    const group = document.querySelector(`[data-pins="${CSS.escape(objectId)}"]`)
    const markers = [...(group?.querySelectorAll(":scope > [data-pin] > [data-marker]") ?? [])].filter((m) => m.getAttribute("display") !== "none")
    const contact = markers.filter((m) => Number(m.getAttribute("r")) > 6)
    return { contact: contact.length, black: contact.filter((m) => m.getAttribute("class")?.includes("fill-foreground")).length }
  }, id)

const blockedNow = (page: Page, id: string) => page.evaluate((objectId) => document.querySelector(`[data-body="${CSS.escape(objectId)}"]`)?.hasAttribute("data-blocked") ?? false, id)

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
  expect("…and the plate is red there (it is on the board, pins in no socket)", await blockedNow(page, lcd.id), true)
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
  await page.getByRole("button", { name: "Crystal", exact: true }).click()
  await page.waitForTimeout(1500)
  const added = (await page.evaluate(() => [...document.querySelectorAll("[data-body]")].map((e) => e.getAttribute("data-body")!))).filter((id) => !before.has(id))
  expect("one part was added", added.length, 1)
  const q = await box(page, added[0])
  const b = await box(page, board.id)
  const view = (await page.locator("[data-slot=dot-field-viewport]").boundingBox())!
  const overlaps = q.x < b.x + b.width && q.x + q.width > b.x && q.y < b.y + b.height && q.y + q.height > b.y
  expect("the crystal is not on the board", overlaps, false)
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
  expect("…it is off the board", overlapping(await box(page, q.id), await box(page, board.id)), false)
  expect("…and nothing of it is plugged in", (await dots(page, q.id)).contact, 0)
  expect("…nor sent home: the board's edge is nearer to the drop", Math.hypot(landed.x - q.x, landed.y - q.y) > GRID / 2, true)
}

async function freedSlotTakesTheDrop(page: Page) {
  console.log("\na crystal dropped half on a neighbour beside a freed slot")
  const pitch = { x: 5, y: 4 }
  const block: PlacedObject[] = []
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) if (row !== 1 || col !== 1) block.push(crystal(`q${row}${col}`, col * pitch.x, row * pitch.y, `ZQ${block.length + 1}`))
  const mover = crystal("mover", 40, 20, "ZQ9")
  await openDoc(page, "slot", { objects: [...block, mover], wires: [], parts: {} })
  const frame = await fieldFrame(page)
  const slot = { x: pitch.x * GRID, y: pitch.y * GRID }
  const drop = { x: slot.x + 2 * GRID, y: slot.y + GRID }
  await dragBy(page, frame.toScreen(crystalMiddle(mover)), frame.toScreen(crystalMiddle({ ...mover, ...drop })), false)
  expect("two cells right of the slot and one down it is on its neighbour: red", await blockedNow(page, mover.id), true)
  await page.mouse.up()
  await page.waitForTimeout(800)
  const landed = await frame.worldOf(mover.id)
  const cells = (p: Point) => ({ x: p.x / GRID, y: p.y / GRID })
  expect("released: not left where it was blocked", landed.x === drop.x && landed.y === drop.y, false)
  expect("…but in the freed slot, a cell below the drop, the nearest spot it fits", cells(landed), cells({ x: drop.x, y: drop.y + GRID }))
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
  await page.getByRole("button", { name: "Run" }).click()
  await page.waitForTimeout(1500)
  expect("the bench is running", await page.getByRole("button", { name: "Pause" }).count(), 1)
  const cursors: Record<string, string | null> = {
    "the empty field": await cursorOnTheEmptyField(page),
    "a pin": await cursorOnTheFirstVisible(page, "[data-slot=pins] [data-pin] circle"),
    "the touch panel": await cursorOnTheFirstVisible(page, "[data-slot=component] foreignObject"),
  }
  await page.keyboard.press("o")
  await page.waitForTimeout(800)
  cursors["the oscilloscope"] = await cursorOnTheFirstVisible(page, "[data-slot=scope] canvas")
  cursors["the palette's search box"] = await cursorOnTheFirstVisible(page, 'input[placeholder="Search…"]')
  await page.keyboard.press("o")
  await page.getByRole("button", { name: "New VHDL component" }).click()
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1000)
  cursors["the code editor"] = await cursorOnTheFirstVisible(page, ".monaco-editor .view-lines")
  for (const [where, cursor] of Object.entries(cursors))
    expect(`over ${where}, a cursor picture of our own, not the system one Windows draws by inverting`, cursor?.startsWith("url(") ? "ours" : cursor, "ours")
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
  await noPluggingIntoHeaders(page)
  await freedSlotTakesTheDrop(page)
  await addingLandsInView(page)
  await cursorsOverARunningBench(page)
} finally {
  await browser.close()
}
expect("no page errors", errors, [])
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
