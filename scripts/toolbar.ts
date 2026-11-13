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

async function loadApp(page: Page) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(DEV_SERVER, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("[data-slot=dot-field-viewport]", { timeout: 20_000 })
      return
    } catch (e) {
      if (attempt === 3) throw e
      console.log(`  (the page did not load, attempt ${attempt}: ${(e as Error).message.split("\n")[0]})`)
    }
  }
}

async function openDoc(page: Page, name: string, doc: Schematic) {
  try {
    await openDocOnce(page, name, doc)
  } catch (e) {
    console.log(`  (the document did not open, once more: ${(e as Error).message.split("\n")[0]})`)
    await openDocOnce(page, name, doc)
  }
}

async function openDocOnce(page: Page, name: string, doc: Schematic) {
  await loadApp(page)
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
    { id: "h", a: cellPoint(22, 18), b: cellPoint(30, 18) },
    { id: "v", a: cellPoint(26, 15), b: cellPoint(26, 21) },
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
const wireMode = (page: Page) => page.evaluate(() => document.querySelector("[data-slot=field-toolbar] [data-wire-mode]")?.getAttribute("data-wire-mode") ?? null)
const hint = (page: Page) => page.evaluate(() => document.querySelector("[data-slot=tool-hint]")?.textContent ?? null)
const contentTransform = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector("[data-slot=dot-field-content]")!).transform)
const NEIGHBOURS = ["sim-controls", "probe-readout", "inspector", "wire-palette", "tool-hint", "placement-hint", "scale-bar", "zoom-controls", "field-toggle"]
const overlapsOfBar = (page: Page) =>
  page.evaluate((names) => {
    const bar = document.querySelector("[data-slot=field-toolbar]")!.getBoundingClientRect()
    const out: string[] = []
    for (const [n, e] of [...names.flatMap((n) => [...document.querySelectorAll(`[data-slot=${n}]`)].map((e) => [n, e] as const)), ...[...document.querySelectorAll("[aria-label='Hide the parts'],[aria-label='Show the parts']")].map((e) => ["palette-toggle", e] as const)]) {
      const r = e.getBoundingClientRect()
      if (r.width > 0 && r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top) out.push(n)
    }
    return out
  }, NEIGHBOURS)
const tooltipText = async (page: Page, selector: string) => {
  await page.hover(selector)
  await page.waitForTimeout(900)
  return page.evaluate(() => document.querySelector("[data-slot=tooltip-content]")?.textContent?.replace(/\s+/g, " ").trim() ?? null)
}

async function barOnTheLeft(page: Page) {
  console.log("\nthe bar: a column at the field's left edge under the parts toggle, five modes in three groups, icons only")
  await openDoc(page, "toolbar-bench", bench())
  const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
  const bar = (await rect(page, "[data-slot=field-toolbar]"))!
  expect("a vertical ARIA toolbar with a name", await page.evaluate(() => { const b = document.querySelector("[data-slot=field-toolbar]")!; return [b.getAttribute("role"), b.getAttribute("aria-orientation"), !!b.getAttribute("aria-label")] }), ["toolbar", "vertical", true])
  const toggle = (await rect(page, "[aria-label='Hide the parts']"))!
  const select = (await rect(page, toolButton("select")))!
  expect("its buttons stand in the parts toggle's column, the same 28 px wide (the user: aligned with the toggle)", [Math.round(select.x), Math.round(select.width)], [Math.round(toggle.x), Math.round(toggle.width)])
  expect("12 px under the toggle", Math.round(bar.y - (toggle.y + toggle.height)), 12)
  expect("taller than wide: a column", bar.height > bar.width, true)
  expect("the five modes top to bottom", await page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool]")].map((b) => b.getAttribute("data-tool"))), ["select", "hand", "wire", "part", "probe"])
  expect("three groups, two dividers", await countOf(page, "[data-slot=field-toolbar] [role=separator]"), 2)
  expect("Select is on at the start, nothing else", await pressedTools(page), ["select"])
  expect("icons only: no text on the bar", await page.evaluate(() => (document.querySelector("[data-slot=field-toolbar]") as HTMLElement).innerText.trim()), "")
  for (const id of ["select", "hand", "wire", "part", "probe"]) {
    const b = (await rect(page, toolButton(id)))!
    expect(`${id} is 28 px square (WCAG floor 24)`, [Math.round(b.width), Math.round(b.height)], [28, 28])
  }
  expect("each button names its key for assistive tech", await page.evaluate(() => [...document.querySelectorAll("[data-slot=field-toolbar] [data-tool]")].map((b) => b.getAttribute("aria-keyshortcuts"))), ["V", "H", "W", "A", "M"])
  expect("Hand's tooltip: its name and key", await tooltipText(page, toolButton("hand")), "HandH")
  expect("Wire's tooltip: its key and the double click", await tooltipText(page, toolButton("wire")), "WireWDouble-click the field or drag from a pin to start")
  expect("a document opened is fitted clear of the bar: no part under it", await page.evaluate(() => {
    const bar = document.querySelector("[data-slot=field-toolbar]")!.getBoundingClientRect()
    return [...document.querySelectorAll("[data-body] [data-slot=component]")].filter((e) => { const r = e.getBoundingClientRect(); return r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top }).length
  }), 0)
  expect("nothing else on the field overlaps it", await overlapsOfBar(page), [])
  await shoot(page, "toolbar-idle")
}

async function selectionBesideItself(page: Page) {
  console.log("\nthe bar never moves; the selection's actions sit beside the selection")
  await openDoc(page, "toolbar-still", bench())
  const before = await rect(page, "[data-slot=field-toolbar]")
  const frame = await fieldFrame(page)
  const r1 = frame.toScreen(cellPoint(12, 10.5))
  await page.mouse.click(r1.x, r1.y)
  await page.waitForTimeout(300)
  expect("a part selected: the bar is where it was", await rect(page, "[data-slot=field-toolbar]"), before)
  expect("the inspector's actions name their keys", await page.evaluate(() => [...document.querySelectorAll("[data-slot=inspector] [data-action]")].map((b) => b.getAttribute("aria-keyshortcuts"))), ["Shift+R", "R", "X", "Y", "Del"])
  const turnedBefore = await page.evaluate(() => document.querySelector('[data-body="R1"] [data-slot=component]')?.getAttribute("style"))
  await page.click("[data-slot=inspector] [data-action='Rotate clockwise']")
  await page.waitForTimeout(400)
  expect("the inspector's Rotate turns the part", (await page.evaluate(() => document.querySelector('[data-body="R1"] [data-slot=component]')?.getAttribute("style"))) !== turnedBefore, true)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(200)
  const wire = (await fieldFrame(page)).toScreen(cellPoint(24, 18))
  await page.mouse.click(wire.x, wire.y)
  await page.waitForTimeout(300)
  expect("a wire selected: its palette offers Re-route and Delete with their keys", await page.evaluate(() => [...document.querySelectorAll("[data-slot=wire-palette] [data-action]")].map((b) => [b.getAttribute("data-action"), b.querySelector("kbd")?.textContent])), [["reroute", "T"], ["delete", "Del"]])
  const palette = (await rect(page, "[data-slot=wire-palette]"))!
  const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
  expect("the wire palette sits where the inspector does: 48 px down, 12 px from the right", [Math.round(palette.y - stage.y), Math.round(stage.x + stage.width - palette.x - palette.width)], [48, 12])
  expect("and covers neither the bar nor the field's toggle", await page.evaluate(() => {
    const p = document.querySelector("[data-slot=wire-palette]")!.getBoundingClientRect()
    return [...document.querySelectorAll("[data-slot=field-toolbar], [data-slot=field-toggle]")].filter((e) => { const r = e.getBoundingClientRect(); return r.left < p.right && r.right > p.left && r.top < p.bottom && r.bottom > p.top }).length
  }), 0)
  await page.keyboard.press("Escape")
}

async function wireToolAndItsAngles(page: Page) {
  console.log("\nthe Wire tool: stays on; its three angles beside it while it is on (Excalidraw's arrow types, model §5.2 C)")
  await openDoc(page, "toolbar-wire", bench())
  const frame = await fieldFrame(page)
  expect("the Wire button shows the current angle: right angles", await wireMode(page), "90")
  expect("no angles on view while Wire is off", await countOf(page, "[data-slot=wire-angles]"), 0)
  await page.click(toolButton("wire"))
  await page.waitForTimeout(200)
  expect("Wire on: the three angles beside it, in Shift+Space's order, right angles checked", await page.evaluate(() => [...document.querySelectorAll("[data-slot=wire-angles] [role=radio]")].map((i) => [i.getAttribute("data-mode"), i.getAttribute("aria-checked")])), [["90", "true"], ["45", "false"], ["any", "false"]])
  const angles = (await rect(page, "[data-slot=wire-angles]"))!
  const bar = (await rect(page, "[data-slot=field-toolbar]"))!
  const wireButton = (await rect(page, toolButton("wire")))!
  expect("to the right of the bar, level with Wire", [angles.x >= bar.x + bar.width, Math.abs(angles.y + angles.height / 2 - (wireButton.y + wireButton.height / 2)) <= 1], [true, true])
  expect("each angle as large as a tool button", Math.round((await rect(page, "[data-slot=wire-angles] [role=radio]"))!.height), 28)
  const tail = (await rect(page, "[data-slot=wire-angles-tail]"))!
  expect("a tail points from the angles back to Wire (the user, 2026-11-13)", [tail.x < angles.x, Math.abs(tail.y + tail.height / 2 - (wireButton.y + wireButton.height / 2)) <= 1], [true, true])
  await page.click("[data-slot=wire-angles] [data-mode='45']")
  await page.waitForTimeout(200)
  expect("one click on 45° sets it, the tool stays on", [await wireMode(page), await pressedTools(page)], ["45", ["wire"]])
  const pin = frame.toScreen(cellPoint(14, 11))
  await page.mouse.move(pin.x, pin.y)
  await page.waitForTimeout(150)
  expect("the tag beside the pointer agrees", await tag(page), "45°")
  expect("a hint names the keys inside a wire", ((await hint(page)) ?? "").includes("Backspace"), true)
  const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
  const hintBox = (await rect(page, "[data-slot=tool-hint]"))!
  expect("the hint sits at the top centre of the field", [Math.round(hintBox.y - stage.y), Math.abs(hintBox.x + hintBox.width / 2 - (stage.x + stage.width / 2)) <= 1], [12, true])
  await page.keyboard.press("Shift+Space")
  await page.waitForTimeout(150)
  expect("Shift+Space checks the next angle", [await wireMode(page), await page.evaluate(() => document.querySelector("[data-slot=wire-angles] [aria-checked=true]")?.getAttribute("data-mode"))], ["any", "any"])
  await page.keyboard.press("Shift+Space")
  await page.waitForTimeout(150)
  expect("and wraps back to right angles", await wireMode(page), "90")

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
  expect("the second Esc goes back to Select; the hint and the angles go", [await pressedTools(page), await hint(page), await countOf(page, "[data-slot=wire-angles]")], [["select"], null, 0])
  await shoot(page, "toolbar-wire")
}

async function keysSelectTheModes(page: Page) {
  console.log("\na key does what its button does (rehearsal, model §5.3)")
  await openDoc(page, "toolbar-keys", bench())
  const frame = await fieldFrame(page)
  const bare = frame.toScreen(cellPoint(34, 6))
  await page.mouse.move(bare.x, bare.y)
  for (const [key, tool] of [["w", "wire"], ["h", "hand"], ["m", "probe"], ["v", "select"]] as const) {
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

async function handTool(page: Page) {
  console.log("\nHand pans with a plain drag")
  await openDoc(page, "toolbar-hand", bench())
  await page.click(toolButton("hand"))
  const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
  const bare = { x: stage.x + stage.width / 2, y: stage.y + stage.height - 160 }
  const before = await contentTransform(page)
  await page.mouse.move(bare.x, bare.y)
  await page.mouse.down()
  await page.mouse.move(bare.x + 120, bare.y + 60, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect("a drag with Hand pans the field", (await contentTransform(page)) !== before, true)
  expect("and draws no selection box", await page.evaluate(() => (document.querySelector("[data-slot=dot-field-selection]") as HTMLElement | null)?.style.display ?? "none"), "none")
  expect("the hint says how to pan", ((await hint(page)) ?? "").includes("Drag to pan"), true)
  const frame = await fieldFrame(page)
  const r1 = frame.toScreen(cellPoint(12, 10.5))
  expect("over a part the cursor stays the hand: nothing on the field is under it", await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y)!; return [e.getAttribute("data-slot"), getComputedStyle(e).cursor] }, [r1.x, r1.y]), ["hand-overlay", "grab"])
  const partBefore = await page.evaluate(() => (document.querySelector('[data-body="R1"] [data-slot=component]') as HTMLElement).style.cssText)
  const viewBefore = await contentTransform(page)
  await page.mouse.move(r1.x, r1.y)
  await page.mouse.down()
  await page.mouse.move(r1.x + 37, r1.y + 23, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  expect("a drag that starts on a part pans the view and leaves the part where it was", [await page.evaluate(() => (document.querySelector('[data-body="R1"] [data-slot=component]') as HTMLElement).style.cssText), (await contentTransform(page)) !== viewBefore], [partBefore, true])
  const shift = await page.evaluate(([a, b]) => { const m = new DOMMatrix(a), n = new DOMMatrix(b); return [Math.round(n.e - m.e), Math.round(n.f - m.f)] }, [viewBefore, await contentTransform(page)])
  expect("the view follows the pointer exactly, both axes at once: 37 px right, 23 px down", shift, [37, 23])
  expect("no hover readout while panning over parts", await countOf(page, "[data-slot=field-readout]"), 0)
}

async function joinHere(page: Page) {
  console.log("\nJoin is off the bar (model §5.1): J joins the crossing under the pointer, as the right-click menu does")
  await openDoc(page, "toolbar-join", bench())
  const frame = await fieldFrame(page)
  const crossing = frame.toScreen(cellPoint(26, 18))
  const dotsBefore = await countOf(page, "[data-junction]")
  await page.mouse.move(crossing.x, crossing.y)
  await page.keyboard.press("j")
  await page.waitForTimeout(400)
  expect("J over a crossing joins it: a dot appears", await countOf(page, "[data-junction]"), dotsBefore + 1)
  expect("and the bar stays on Select", await pressedTools(page), ["select"])
  await page.keyboard.press("Control+z")
  await page.waitForTimeout(400)
  expect("set up: undone", await countOf(page, "[data-junction]"), dotsBefore)
  await page.mouse.click(crossing.x, crossing.y, { button: "right" })
  await page.waitForTimeout(300)
  expect("the right-click menu offers Join wires here with its key", await page.evaluate(() => document.querySelector("[data-action=join-here]")?.textContent?.replace(/\s+/g, " ").trim() ?? null), "Join wires hereJ")
  await page.click("[data-action=join-here]")
  await page.waitForTimeout(400)
  expect("and joins the crossing it was opened on", await countOf(page, "[data-junction]"), dotsBefore + 1)
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
  expect("it lists the wire angles' key and the tools' keys", ["Shift+Space", "Wire", "Join", "Hand", "Re-route"].every((w) => text.includes(w)), true)
  await page.keyboard.press("Escape")
  await page.click("[data-slot=menubar] >> text=Help")
  await page.waitForTimeout(200)
  expect("Help lists the keyboard shortcuts", await page.locator("[role=menuitem]", { hasText: "Keyboard shortcuts" }).count(), 1)
  await page.keyboard.press("Escape")
}

async function dockedInTheFoldedPalette(page: Page) {
  console.log("\nthe palette folded: the tools move into its column, above search and the groups (the user, 2026-11-13)")
  await openDoc(page, "toolbar-docked", bench())
  await page.click("[aria-label='Hide the parts']")
  await page.waitForTimeout(600)
  expect("the bar is in the folded palette and not on the field", [await countOf(page, "[data-slot=palette-rail] [data-slot=field-toolbar]"), await countOf(page, "[data-slot=dot-field-stage] [data-slot=field-toolbar]")], [1, 0])
  expect("first in the column, before search", await page.evaluate(() => { const rail = document.querySelector("[data-slot=palette-rail]")!; const bar = rail.querySelector("[data-slot=field-toolbar]")!.getBoundingClientRect(); const search = rail.querySelector("[aria-label='Search parts']")!.getBoundingClientRect(); return bar.bottom < search.top }), true)
  const rail = (await rect(page, "[data-slot=palette-rail]"))!
  const select = (await rect(page, toolButton("select")))!
  expect("its buttons the column's 32 px, centred in it", [Math.round(select.width), Math.abs(select.x + select.width / 2 - (rail.x + rail.width / 2)) <= 1], [32, true])
  await page.click(toolButton("wire"))
  await page.waitForTimeout(300)
  const angles = (await rect(page, "[data-slot=wire-angles]"))!
  expect("Wire on: its angles out over the field, right of the column, and nothing covers them", [angles.x >= rail.x + rail.width, await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-slot=wire-angles]"), [angles.x + angles.width / 2, angles.y + angles.height / 2])], [true, true])
  await page.keyboard.press("Escape")
  await page.click("[aria-label='Show the parts']")
  await page.waitForTimeout(600)
  expect("unfolded: the bar is back on the field", [await countOf(page, "[data-slot=palette-rail]"), await countOf(page, "[data-slot=dot-field-stage] [data-slot=field-toolbar]")], [0, 1])
}

async function noConflicts(browser: Browser) {
  console.log("\nno conflicts at the field's left edge on any screen: idle, probing, wiring, a part selected (the user, 2026-11-13)")
  for (const [width, height, touch] of [[1600, 900, false], [1366, 768, false], [1000, 700, false], [740, 360, true], [390, 844, true]] as const) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: touch, isMobile: touch })
    await openDoc(page, "toolbar-sizes", bench())
    const name = `${width}×${height}${touch ? " touch" : ""}`
    expect(`${name}, idle: nothing overlaps the bar`, await overlapsOfBar(page), [])
    const stage = (await rect(page, "[data-slot=dot-field-stage]"))!
    const bar = (await rect(page, "[data-slot=field-toolbar]"))!
    expect(`${name}: the bar ends above the simulation controls`, bar.y + bar.height <= (await rect(page, "[data-slot=sim-controls]"))!.y - 8, true)
    expect(`${name}: the bar inside the field`, bar.y + bar.height <= stage.y + stage.height && bar.x + bar.width <= stage.x + stage.width, true)
    if (touch) expectAtLeast(`${name}: buttons 44 px under a coarse pointer`, Math.round((await rect(page, toolButton("select")))!.height), 44)
    await page.click(toolButton("probe"))
    const frame = await fieldFrame(page)
    for (const c of [cellPoint(10, 11), cellPoint(14, 11)]) {
      const at = frame.toScreen(c)
      await page.mouse.click(at.x, at.y)
    }
    await page.waitForTimeout(500)
    expect(`${name}, probing with both tips down: nothing overlaps the bar`, await overlapsOfBar(page), [])
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")
    await page.click(toolButton("select"))
    const r1 = frame.toScreen(cellPoint(12, 10.5))
    await page.mouse.click(r1.x, r1.y)
    await page.waitForTimeout(400)
    expect(`${name}, a part selected: the inspector clear of the bar`, await overlapsOfBar(page), [])
    await shoot(page, `toolbar-${width}x${height}`)
    await page.close()
  }
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() })
const errors: string[] = []
const sections = [barOnTheLeft, selectionBesideItself, wireToolAndItsAngles, keysSelectTheModes, handTool, joinHere, instrumentsAndShortcuts, dockedInTheFoldedPalette]
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
  await noConflicts(browser)
} catch (e) {
  failed++
  console.log(`✗ noConflicts threw: ${(e as Error).message.split("\n")[0]}`)
}
await browser.close()
expect("no page errors", errors, [])
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
