import "./lib/all-parts"
import { Buffer } from "node:buffer"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { GRID, type Point } from "@/schematic/geometry"
import { stamped } from "@/schematic/migrate"
import type { PlacedObject, Schematic } from "@/schematic/types"

const DEV_SERVER = process.env.EMUL_URL ?? "http://localhost:5173/"
const SHOTS = process.env.SHOTS
let failed = 0
let passed = 0
function expect(what: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(`${ok ? "✓" : "✗"} ${what}: ${JSON.stringify(got)}${ok ? "" : `  (want ${JSON.stringify(want)})`}`)
}
const expectAtLeast = (what: string, got: number, floor: number) => expect(`${what} (≥ ${floor})`, got >= floor ? "ok" : got, "ok")

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
const pageTitle = (page: Page) => page.evaluate(() => document.title)

async function openDoc(page: Page, name: string, doc: Schematic) {
  await page.goto(DEV_SERVER, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-slot=dot-field-viewport]")
  const landing = Date.now() + 15_000
  while ((await pageTitle(page)).startsWith("εmul") && Date.now() < landing) await page.waitForTimeout(100)
  await page.setInputFiles("input[type=file]", { name: `${name}.emul`, mimeType: "application/octet-stream", buffer: Buffer.from(JSON.stringify({ format: "emul-project", version: 1, name, schematic: stamped(doc) })) })
  const opened = Date.now() + 15_000
  while (!(await pageTitle(page)).startsWith(`${name} `) && Date.now() < opened) await page.waitForTimeout(100)
  if (!(await pageTitle(page)).startsWith(`${name} `)) throw new Error(`the field never showed ${name}`)
  await page.waitForSelector("[data-slot=component]")
  await page.waitForTimeout(1500)
}

async function fieldFrame(page: Page) {
  const { left, top, x, y, scale } = await page.evaluate(() => {
    const viewport = document.querySelector("[data-slot=dot-field-viewport]")!.getBoundingClientRect()
    const view = new DOMMatrix(getComputedStyle(document.querySelector("[data-slot=dot-field-content]")!).transform)
    return { left: viewport.left, top: viewport.top, x: view.e, y: view.f, scale: view.a }
  })
  return { toScreen: (p: Point) => ({ x: left + x + p.x * scale, y: top + y + p.y * scale }) }
}

const cellPoint = (x: number, y: number): Point => ({ x: x * GRID, y: y * GRID })
const resistorAt = (id: string, x: number, y: number, rotation?: 90): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id }, ...(rotation && { rotation }) })
const bench = (): Schematic => ({
  objects: [resistorAt("R1", 10, 10), resistorAt("R2", 20, 10), resistorAt("R3", 14, 16, 90), resistorAt("R4", 10, 22), resistorAt("R5", 20, 22)],
  wires: [
    { id: "h", a: cellPoint(14, 26), b: cellPoint(22, 26) },
    { id: "v", a: cellPoint(18, 24), b: cellPoint(18, 30) },
  ],
  parts: {},
})

const countOf = (page: Page, selector: string) => page.evaluate((s) => document.querySelectorAll(s).length, selector)
const rect = (page: Page, selector: string) => page.evaluate((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect()
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
}, selector)
const pressedTools = (page: Page) => page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool][aria-pressed=true]")].map((b) => b.getAttribute("data-tool")))
const toolButton = (id: string) => `[data-slot=field-toolbar] [data-tool="${id}"]`
const tag = (page: Page) => page.evaluate(() => document.querySelector("[data-slot=line-mode]")?.textContent ?? null)
const drawing = (page: Page) => countOf(page, "[data-slot=pending-wire-route]")
const wires = (page: Page) => countOf(page, "[data-slot=wires] g[data-wire]")
const checkedMode = (page: Page) => page.evaluate(() => document.querySelector("[data-slot=tool-strip] [role=radiogroup] [role=radio][aria-checked=true]")?.getAttribute("data-mode") ?? null)
const strip = (page: Page) => page.evaluate(() => document.querySelector("[data-slot=tool-strip]")?.textContent ?? null)
const contentTransform = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector("[data-slot=dot-field-content]")!).transform)

async function barSitsTopCentre(page: Page) {
  console.log("\nthe bar: top centre of the field, six modes in three groups (model §6.1–6.2)")
  await openDoc(page, "toolbar-bench", bench())
  const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
  const bar = await rect(page, "[data-slot=field-toolbar]")
  expect("a toolbar is on the field", !!bar, true)
  if (!bar) return
  expect("it is an ARIA toolbar with a name", await page.evaluate(() => { const b = document.querySelector("[data-slot=field-toolbar]")!; return [b.getAttribute("role"), !!b.getAttribute("aria-label")] }), ["toolbar", true])
  expect("centred on the field within a pixel", Math.abs(bar.x + bar.width / 2 - (stage.x + stage.width / 2)) <= 1, true)
  expect("12 px below the field's top edge", Math.round(bar.y - stage.y), 12)
  expect("the six modes in order", await page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool]")].map((b) => b.getAttribute("data-tool"))), ["select", "hand", "wire", "join", "part", "probe"])
  expect("three groups, two dividers", await countOf(page, "[data-slot=field-toolbar] [role=separator]"), 2)
  expect("Select is on at the start, nothing else", await pressedTools(page), ["select"])
  for (const id of ["select", "hand", "wire", "join", "part", "probe"]) {
    const b = (await rect(page, toolButton(id)))!
    expectAtLeast(`${id} is 36 px tall`, Math.round(b.height), 36)
  }
  expect("each button prints its key", await page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool] kbd")].map((k) => k.textContent)), ["V", "H", "W", "J", "A", "M"])
  expect("each button names its mode at this width (≥ lg)", await page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool] [data-slot=tool-name]")].map((n) => (n as HTMLElement).offsetWidth > 0)), [true, true, true, true, true, true])
  await page.hover(toolButton("wire"))
  await page.waitForTimeout(900)
  expect("hovering Wire shows its name and key", await page.evaluate(() => document.querySelector("[data-slot=tooltip-content]")?.textContent?.replace(/\s+/g, " ").trim() ?? null), "Wire — W")
  await shoot(page, "toolbar-idle")
}

async function barNeverMoves(page: Page) {
  console.log("\nthe bar never moves with the selection (constraint 2)")
  await openDoc(page, "toolbar-still", bench())
  const before = await rect(page, "[data-slot=field-toolbar]")
  const frame = await fieldFrame(page)
  const r1 = frame.toScreen(cellPoint(12, 10.5))
  await page.mouse.click(r1.x, r1.y)
  await page.waitForTimeout(300)
  expect("a part selected: the bar is where it was", await rect(page, "[data-slot=field-toolbar]"), before)
  expect("and the strip offers the selection's actions with their keys", await page.evaluate(() => [...document.querySelectorAll("[data-slot=tool-strip] [data-action]")].map((b) => [b.getAttribute("data-action"), b.querySelector("kbd")?.textContent])), [["rotate", "R"], ["flip-horizontal", "X"], ["flip-vertical", "Y"], ["delete", "Del"]])
  const turnedBefore = await page.evaluate(() => document.querySelector('[data-body="R1"] [data-slot=component]')?.getAttribute("style"))
  await page.click("[data-slot=tool-strip] [data-action=rotate]")
  await page.waitForTimeout(400)
  expect("Rotate on the strip turns the part", (await page.evaluate(() => document.querySelector('[data-body="R1"] [data-slot=component]')?.getAttribute("style"))) !== turnedBefore, true)
  const strip = (await rect(page, "[data-slot=tool-strip]"))!
  const bar = (await rect(page, "[data-slot=field-toolbar]"))!
  expect("the strip sits 8 px under the bar", Math.round(strip.y - (bar.y + bar.height)), 8)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
  expect("nothing selected, no strip", await countOf(page, "[data-slot=tool-strip]"), 0)
  const frame2 = await fieldFrame(page)
  const wire = frame2.toScreen(cellPoint(16, 26))
  await page.mouse.click(wire.x, wire.y)
  await page.waitForTimeout(300)
  expect("a wire selected: Re-route joins the strip with T", await page.evaluate(() => document.querySelector("[data-slot=tool-strip] [data-action=reroute] kbd")?.textContent ?? null), "T")
  await page.keyboard.press("Escape")
}

async function wireToolAndItsModes(page: Page) {
  console.log("\nthe Wire tool: stays on, its three modes on the strip (model §5.2, §5.3)")
  await openDoc(page, "toolbar-wire", bench())
  const frame = await fieldFrame(page)
  await page.click(toolButton("wire"))
  await page.waitForTimeout(200)
  expect("clicking Wire turns it on", await pressedTools(page), ["wire"])
  expect("the strip shows the three modes, 90° checked", await checkedMode(page), "90")
  expect("the strip names Shift+Space", ((await strip(page)) ?? "").includes("Shift+Space"), true)
  expect("three radios, in Shift+Space's order", await page.evaluate(() => [...document.querySelectorAll("[data-slot=tool-strip] [role=radio]")].map((r) => r.getAttribute("data-mode"))), ["90", "45", "any"])
  await page.click("[data-slot=tool-strip] [role=radio][data-mode='45']")
  await page.waitForTimeout(150)
  expect("clicking 45° checks it", await checkedMode(page), "45")
  const pin = frame.toScreen(cellPoint(14, 11))
  await page.mouse.move(pin.x, pin.y)
  await page.waitForTimeout(150)
  expect("the tag beside the pointer agrees", await tag(page), "45°")
  await page.keyboard.press("Shift+Space")
  await page.waitForTimeout(150)
  expect("Shift+Space checks the next mode on the strip", await checkedMode(page), "any")
  await page.keyboard.press("Shift+Space")
  await page.waitForTimeout(150)
  expect("and wraps back to 90°", await checkedMode(page), "90")

  const before = await wires(page)
  const draw = async (from: Point, to: Point) => {
    const a = frame.toScreen(from)
    const b = frame.toScreen(to)
    await page.mouse.move(a.x, a.y)
    await page.mouse.click(a.x, a.y)
    await page.mouse.move(b.x, b.y, { steps: 8 })
    await page.mouse.click(b.x, b.y)
    await page.waitForTimeout(400)
  }
  await draw(cellPoint(14, 11), cellPoint(20, 11))
  expect("a first wire laid", await wires(page), before + 1)
  expect("the tool is still on after it", await pressedTools(page), ["wire"])
  await draw(cellPoint(14, 23), cellPoint(20, 23))
  expect("a second wire without pressing W again", await wires(page), before + 2)
  const mid = frame.toScreen(cellPoint(30, 14))
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.click(mid.x, mid.y)
  await page.mouse.move(mid.x + 80, mid.y, { steps: 4 })
  expect("set up: a wire under way", await drawing(page), 1)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(150)
  expect("the first Esc drops the wire under way and keeps the tool", [await drawing(page), await pressedTools(page)], [0, ["wire"]])
  await page.keyboard.press("Escape")
  await page.waitForTimeout(150)
  expect("the second Esc goes back to Select", await pressedTools(page), ["select"])
  await shoot(page, "toolbar-wire")
}

async function keysSelectTheModes(page: Page) {
  console.log("\na key does what its button does (rehearsal, model §5.3)")
  await openDoc(page, "toolbar-keys", bench())
  const frame = await fieldFrame(page)
  const bare = frame.toScreen(cellPoint(34, 6))
  await page.mouse.move(bare.x, bare.y)
  for (const [key, tool] of [["w", "wire"], ["j", "join"], ["h", "hand"], ["m", "probe"], ["v", "select"]] as const) {
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
    expect(`${key.toUpperCase()} turns on ${tool}`, await pressedTools(page), [tool])
  }
  await page.keyboard.press("a")
  await page.waitForTimeout(300)
  expect("A opens Quick Insert, and Add part shows pressed while it is open", [await countOf(page, "[data-slot=quick-insert-search]"), await pressedTools(page)], [1, ["part"]])
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
  await page.click(toolButton("part"))
  await page.waitForTimeout(300)
  expect("the Add part button opens Quick Insert too", await countOf(page, "[data-slot=quick-insert-search]"), 1)
  await page.keyboard.press("Escape")
}

async function handAndJoin(page: Page) {
  console.log("\nHand pans with a plain drag; Join joins a crossing on a click")
  await openDoc(page, "toolbar-hand", bench())
  const frame = await fieldFrame(page)
  await page.click(toolButton("hand"))
  const bare = frame.toScreen(cellPoint(34, 6))
  const before = await contentTransform(page)
  await page.mouse.move(bare.x, bare.y)
  await page.mouse.down()
  await page.mouse.move(bare.x + 120, bare.y + 60, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect("a drag with Hand pans the field", (await contentTransform(page)) !== before, true)
  expect("and draws no selection box", await page.evaluate(() => (document.querySelector("[data-slot=dot-field-selection]") as HTMLElement | null)?.style.display ?? "none"), "none")
  expect("the strip says how to pan", ((await strip(page)) ?? "").length > 10, true)

  await openDoc(page, "toolbar-join", bench())
  const f2 = await fieldFrame(page)
  await page.click(toolButton("join"))
  const dotsBefore = await countOf(page, "[data-junction]")
  const crossing = f2.toScreen(cellPoint(18, 26))
  await page.mouse.click(crossing.x, crossing.y)
  await page.waitForTimeout(400)
  expect("a click on a crossing with Join joins it: a dot appears", await countOf(page, "[data-junction]"), dotsBefore + 1)
  expect("Join stays on", await pressedTools(page), ["join"])
}

async function instrumentsAndShortcuts(page: Page) {
  console.log("\nProbe on the bar, the instruments on the simulation controls, the shortcut list on ?")
  await openDoc(page, "toolbar-instruments", bench())
  expect("the simulation controls no longer carry the probe", await countOf(page, "[data-slot=sim-controls] [data-action=probe]"), 0)
  await page.click(toolButton("probe"))
  await page.waitForTimeout(200)
  expect("Probe on the bar turns the probe on", await pressedTools(page), ["probe"])
  await page.keyboard.press("Escape")
  expect("the oscilloscope and the analyser have buttons with their keys", await page.evaluate(() => ["scope", "logic"].map((a) => document.querySelector(`[data-slot=sim-controls] [data-action=${a}] kbd`)?.textContent ?? null)), ["O", "L"])
  await page.click("[data-slot=sim-controls] [data-action=scope]")
  await page.waitForTimeout(400)
  expect("the oscilloscope button opens the oscilloscope", await countOf(page, "[data-slot=scope]"), 1)
  const frame = await fieldFrame(page)
  const bare = frame.toScreen(cellPoint(34, 6))
  await page.mouse.click(bare.x, bare.y)
  await page.keyboard.press("Shift+Slash")
  await page.waitForTimeout(300)
  expect("? opens the keyboard shortcuts", await countOf(page, "[data-slot=shortcuts-dialog]"), 1)
  const text = await page.evaluate(() => document.querySelector("[data-slot=shortcuts-dialog]")?.textContent ?? "")
  expect("it lists the wire modes' key and the tools' keys", ["Shift+Space", "Wire", "Join", "Hand", "Re-route"].every((w) => text.includes(w)), true)
  await page.keyboard.press("Escape")
  await page.click("[data-slot=menubar] >> text=Help")
  await page.waitForTimeout(200)
  expect("Help lists the keyboard shortcuts", await page.locator("[role=menuitem]", { hasText: "Keyboard shortcuts" }).count(), 1)
  await page.keyboard.press("Escape")
}

async function narrowAndTouch(browser: Browser) {
  console.log("\nnarrow windows and a coarse pointer (model §5.4, §5.7)")
  const narrow = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  await openDoc(narrow, "toolbar-narrow", bench())
  const stage = (await rect(narrow, "[data-slot=dot-field-stage]"))!
  const bar = (await rect(narrow, "[data-slot=field-toolbar]"))!
  expect("below lg the names fold away, the keys stay", await narrow.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool]")].map((b) => [(b.querySelector("[data-slot=tool-name]") as HTMLElement | null)?.offsetWidth ?? 0, b.querySelector("kbd")?.textContent])), [[0, "V"], [0, "H"], [0, "W"], [0, "J"], [0, "A"], [0, "M"]])
  expect("the bar fits inside the field", bar.x >= stage.x && bar.x + bar.width <= stage.x + stage.width, true)
  const others = await narrow.evaluate(() => [...document.querySelectorAll("[data-slot=dot-field-stage] > *:not([data-slot=field-toolbar])")].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })))
  const over = (a: typeof bar, b: typeof bar) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  expect("and covers no other control on the field", others.filter((o) => o.width < stage.width && over(o, bar)).length, 0)
  await narrow.close()

  const touch = await browser.newPage({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true })
  await openDoc(touch, "toolbar-touch", bench())
  for (const id of ["select", "wire", "probe"]) expectAtLeast(`${id} under a coarse pointer is 44 px`, Math.round((await rect(touch, toolButton(id)))!.height), 44)
  expect("no key letters where there is no keyboard", await countOf(touch, "[data-slot=field-toolbar] kbd:not([hidden])") === 0 || (await touch.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] kbd")].every((k) => (k as HTMLElement).offsetWidth === 0))), true)
  await touch.close()
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const errors: string[] = []
const sections = [barSitsTopCentre, barNeverMoves, wireToolAndItsModes, keysSelectTheModes, handAndJoin, instrumentsAndShortcuts]
for (const section of sections) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  page.on("pageerror", (e) => errors.push(`${section.name}: ${e.message}`))
  try {
    await section(page)
  } catch (e) {
    failed++
    console.log(`✗ ${section.name} threw: ${(e as Error).message.split("\n")[0]}`)
  }
  await page.close()
}
try {
  await narrowAndTouch(browser)
} catch (e) {
  failed++
  console.log(`✗ narrowAndTouch threw: ${(e as Error).message.split("\n")[0]}`)
}
await browser.close()
expect("no page errors", errors, [])
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
