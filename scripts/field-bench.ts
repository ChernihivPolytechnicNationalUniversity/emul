import { Buffer } from "node:buffer"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium, type Browser, type Page } from "playwright-core"
import { lab1Stand } from "@/schematic/examples"
import { GRID, objectPins, objectRect } from "@/schematic/geometry"
import { partKey, type PartState, type PlacedObject, type Schematic, type Wire } from "@/schematic/types"

/**
 * All three interactions run at the display's frame time once culling bounds what is on screen.
 * The 1200-object zoom is the one loose limit: the harness normalises every document to about
 * 50 % zoom, which is just above the threshold where labels stop being drawn, so that row alone
 * rasterises four thousand glyphs. Nobody reads a 1200-object schematic at 50 %.
 */
export const THRESHOLDS: Record<number, { dragP95: number; panP95: number; zoomP95: number }> = {
  30: { dragP95: 20, panP95: 20, zoomP95: 20 },
  120: { dragP95: 20, panP95: 20, zoomP95: 50 },
  480: { dragP95: 20, panP95: 20, zoomP95: 20 },
  1200: { dragP95: 50, panP95: 50, zoomP95: 150 },
  2010: { dragP95: 20, panP95: 20, zoomP95: 150 },
  5010: { dragP95: 20, panP95: 20, zoomP95: 200 },
}

const DEV_SERVER = "http://localhost:5173/"
const VIEWPORT = { width: 1600, height: 1000 }
const TILINGS = [1, 4, 16, 40, 67, 167]
const TILE_PITCH = { x: 100 * GRID, y: 80 * GRID }
const LOAD_TIMEOUT_MS = 120_000
const SETTLE_MS = 2500
const WORKING_ZOOM = 0.48
/** Well inside the band where the field is one canvas. */
const CANVAS_BAND_ZOOM = 0.14
/** The band only engages when enough is on screen to pay for the switch, so check it on a big one. */
const CANVAS_BAND_OBJECTS = 1200
const ZOOM_PRESSES = 24
const ZOOM_STEP_TIMEOUT_MS = 8000
const ZOOM_SETTLE_MS = 600
const DRAG_STEPS = 40
const ZOOM_STEPS = 40
const ZOOM_WHEEL_DELTA = 12
const STEP_PITCH = { x: 4, y: 2 }
const STEP_MS = 8
const IDLE_MS = 1500
const GRAB_MARGIN = { left: 120, right: 260, top: 120, bottom: 160 }

type FieldProbe = { frames: number[]; longTasks: number[]; previous: number; sample: FrameRequestCallback }
type Phase = { frames: number; median: number; p95: number; worst: number; longTasks: number; blocked: number; wall: number }
type FieldNodes = { total: number; path: number; circle: number; text: number }
type Measured = { objects: number; wires: number; pins: number; zoom: number; nodes: FieldNodes; mountMs: number; moved: boolean; drag: Phase; pan: Phase; wheelZoom: Phase; idle: Phase }

const buildRevision = (directory: string) => Number(directory.split("-")[1])

function chromiumExecutable() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright")
  const builds = existsSync(root) ? readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)) : []
  const newest = builds.sort((a, b) => buildRevision(a) - buildRevision(b)).at(-1)
  const executable = newest && join(root, newest, "chrome-linux64", "chrome")
  if (!executable || !existsSync(executable)) {
    console.log(`No Chromium build under ${root}.`)
    console.log("Install one with:\n\n  npx playwright install chromium\n")
    process.exit(1)
  }
  return executable
}

async function devServerIsUp() {
  try {
    await fetch(DEV_SERVER, { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

function tiled(base: Schematic, tiles: number): Schematic {
  const objects: PlacedObject[] = []
  const wires: Wire[] = []
  const parts: Record<string, PartState> = {}
  const columns = Math.ceil(Math.sqrt(tiles))
  for (let tile = 0; tile < tiles; tile++) {
    const dx = (tile % columns) * TILE_PITCH.x
    const dy = Math.floor(tile / columns) * TILE_PITCH.y
    const renamed = new Map(base.objects.map((object) => [object.id, `${object.id}-${tile}`]))
    for (const object of base.objects) objects.push({ ...object, id: renamed.get(object.id)!, x: object.x + dx, y: object.y + dy })
    for (const wire of base.wires)
      wires.push({
        ...wire,
        id: `${wire.id}-${tile}`,
        from: { ...wire.from, object: renamed.get(wire.from.object)! },
        to: { ...wire.to, object: renamed.get(wire.to.object)! },
        points: wire.points?.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      })
    for (const [key, state] of Object.entries(base.parts)) {
      const [object, part] = key.split(":")
      const renamedObject = renamed.get(object)
      if (renamedObject) parts[partKey(renamedObject, part)] = state
    }
  }
  return { objects, wires, parts }
}

const pinCount = (doc: Schematic) => doc.objects.reduce((sum, object) => sum + objectPins(object, GRID).length, 0)

/**
 * What the field is showing, whichever way it is drawing it. A document large enough to open
 * zoomed into the canvas band has no component elements at all, so counting those alone would
 * wait forever.
 */
const drawnSignature = (page: Page) =>
  page.evaluate(() => {
    const components = document.querySelectorAll("[data-slot=component]").length
    const canvas = document.querySelector("[data-slot=field-canvas]") as HTMLCanvasElement | null
    return components > 0 ? `dom:${components}` : canvas ? `canvas:${canvas.width}x${canvas.height}` : "none"
  })

/**
 * Culling means the field never holds the whole document, so readiness is "the picture stopped
 * changing" rather than "every object is in the DOM".
 */
async function waitUntilDrawn(page: Page) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  let previous = ""
  while (Date.now() < deadline) {
    const drawn = await drawnSignature(page)
    if (drawn !== "none" && drawn === previous) return
    previous = drawn
    await page.waitForTimeout(300)
  }
  throw new Error("the field never settled")
}

async function openField(browser: Browser, doc: Schematic) {
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto(DEV_SERVER, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("[data-slot=dot-field-viewport]")
  const started = Date.now()
  await page.setInputFiles("input[type=file]", {
    name: `stress-${doc.objects.length}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  })
  await waitUntilDrawn(page)
  const mountMs = Date.now() - started
  await page.waitForSelector("[data-slot=zoom-controls]")
  await page.waitForTimeout(SETTLE_MS)
  return { page, mountMs }
}

const readZoom = (page: Page) =>
  page.evaluate(() => {
    const badge = document.querySelector("[data-slot=zoom-controls]")?.textContent?.match(/(\d+)%/)
    return badge ? Number(badge[1]) / 100 : null
  })

async function zoomInFrom(page: Page, shown: number) {
  await page.keyboard.press("Control+Equal")
  const readoutCatchesUp = page.waitForFunction(
    (previous) => {
      const badge = document.querySelector("[data-slot=zoom-controls]")?.textContent?.match(/(\d+)%/)
      return badge ? Number(badge[1]) / 100 !== previous : false
    },
    shown,
    { timeout: ZOOM_STEP_TIMEOUT_MS },
  )
  return readoutCatchesUp.then(
    () => true,
    () => false,
  )
}

async function normaliseZoom(page: Page) {
  for (let press = 0; press < ZOOM_PRESSES; press++) {
    const shown = (await readZoom(page)) ?? 1
    if (shown >= WORKING_ZOOM) break
    if (!(await zoomInFrom(page, shown))) break
  }
  await page.waitForTimeout(ZOOM_SETTLE_MS)
  return (await readZoom(page)) ?? 0
}

const fieldNodes = (page: Page): Promise<FieldNodes> =>
  page.evaluate(() => ({
    total: document.querySelectorAll("[data-slot=dot-field-content] *").length,
    path: document.querySelectorAll("[data-slot=dot-field-content] path").length,
    circle: document.querySelectorAll("[data-slot=dot-field-content] circle").length,
    text: document.querySelectorAll("[data-slot=dot-field-content] text").length,
  }))

const componentOrigins = (page: Page) =>
  page.evaluate(() => {
    let sum = 0
    for (const element of document.querySelectorAll("[data-slot=component]")) {
      const box = element.getBoundingClientRect()
      sum += box.x + box.y
    }
    return sum
  })

const largestComponentInView = (page: Page) =>
  page.evaluate((margin) => {
    let best: { x: number; y: number; width: number } | null = null
    for (const element of document.querySelectorAll("[data-slot=component]")) {
      const box = element.getBoundingClientRect()
      const x = box.x + box.width / 2
      const y = box.y + box.height / 2
      const inView = x >= margin.left && x <= innerWidth - margin.right && y >= margin.top && y <= innerHeight - margin.bottom
      if (!inView) continue
      if (!best || box.width > best.width) best = { x, y, width: box.width }
    }
    return best
  }, GRAB_MARGIN)

async function instrument(page: Page) {
  await page.evaluate(() => {
    const probe = { frames: [], longTasks: [], previous: performance.now() } as unknown as FieldProbe
    const host = window as unknown as { __fieldBench: FieldProbe }
    host.__fieldBench = probe
    probe.sample = (now) => {
      probe.frames.push(now - probe.previous)
      probe.previous = now
      requestAnimationFrame(probe.sample)
    }
    requestAnimationFrame(probe.sample)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.longTasks.push(entry.duration)
    }).observe({ entryTypes: ["longtask"] })
  })
}

const percentile = (sorted: number[], fraction: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0

function summarise(frames: number[], longTasks: number[], wall: number): Phase {
  const sorted = [...frames].sort((a, b) => a - b)
  return {
    frames: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    worst: sorted.at(-1) ?? 0,
    longTasks: longTasks.length,
    blocked: longTasks.reduce((sum, duration) => sum + duration, 0),
    wall,
  }
}

async function measure(page: Page, run: () => Promise<void>): Promise<Phase> {
  await page.evaluate(() => {
    const probe = (window as unknown as { __fieldBench: FieldProbe }).__fieldBench
    probe.frames.length = 0
    probe.longTasks.length = 0
  })
  const started = Date.now()
  await run()
  const wall = Date.now() - started
  const taken = await page.evaluate(() => {
    const probe = (window as unknown as { __fieldBench: FieldProbe }).__fieldBench
    return { frames: probe.frames.slice(1), longTasks: probe.longTasks.slice() }
  })
  return summarise(taken.frames, taken.longTasks, wall)
}

async function sweep(page: Page, origin: { x: number; y: number }) {
  await page.mouse.move(origin.x, origin.y)
  await page.mouse.down()
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await page.mouse.move(origin.x + step * STEP_PITCH.x, origin.y + step * STEP_PITCH.y)
    await page.waitForTimeout(STEP_MS)
  }
  await page.mouse.up()
}

async function panWithSpaceHeld(page: Page) {
  await page.keyboard.down(" ")
  await sweep(page, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 })
  await page.keyboard.up(" ")
}

async function pinchZoom(page: Page) {
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  await page.keyboard.down("Control")
  for (let step = 0; step < ZOOM_STEPS; step++) {
    await page.mouse.wheel(0, step < ZOOM_STEPS / 2 ? -ZOOM_WHEEL_DELTA : ZOOM_WHEEL_DELTA)
    await page.waitForTimeout(STEP_MS)
  }
  await page.keyboard.up("Control")
}

const ms = (value: number) => `${value.toFixed(1)} ms`
const blocked = (phase: Phase) => `${phase.blocked.toFixed(0)}/${phase.wall} ms (${Math.round((phase.blocked / Math.max(1, phase.wall)) * 100)}%)`

const phaseLine = (name: string, phase: Phase) =>
  `  ${name.padEnd(5)} frames ${String(phase.frames).padStart(4)}` +
  `  median ${ms(phase.median).padStart(9)}` +
  `  p95 ${ms(phase.p95).padStart(9)}` +
  `  worst ${ms(phase.worst).padStart(9)}` +
  `  long ${String(phase.longTasks).padStart(3)}` +
  `  blocked ${blocked(phase)}`

function table(header: string[], rows: string[][]) {
  const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column].length)))
  const line = (cells: string[]) => "  " + cells.map((cell, column) => cell.padStart(widths[column])).join("   ")
  console.log(line(header))
  console.log(line(widths.map((width) => "─".repeat(width))))
  for (const row of rows) console.log(line(row))
}

type FieldShape = Record<string, { x: number; y: number }[]>

const fieldShape = (page: Page): Promise<FieldShape> =>
  page.evaluate(() => {
    const out: Record<string, { x: number; y: number }[]> = {}
    for (const symbol of document.querySelectorAll<SVGElement>("[data-body] svg")) {
      const host = symbol.closest<HTMLElement>("[data-body]")!
      out[`object ${host.dataset.body}`] = [{ x: parseFloat(symbol.style.left), y: parseFloat(symbol.style.top) }]
    }
    for (const group of document.querySelectorAll<SVGGElement>("[data-slot=wires] g[data-wire]")) {
      const body = group.querySelector("path")!
      const length = body.getTotalLength()
      const along: { x: number; y: number }[] = []
      for (let i = 0; i <= 16; i++) {
        const at = body.getPointAtLength((length * i) / 16)
        along.push({ x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 })
      }
      out[`wire ${group.dataset.wire}`] = along
    }
    return out
  })

/** What moved differently from the objects: everything should travel by the same offset. */
function drifted(from: FieldShape, to: FieldShape) {
  const shared = Object.keys(from).filter((key) => key in to)
  const anObject = shared.find((key) => key.startsWith("object "))
  const dx = anObject ? to[anObject][0].x - from[anObject][0].x : 0
  const dy = anObject ? to[anObject][0].y - from[anObject][0].y : 0
  const off = shared.filter((key) => {
    const a = from[key]
    const b = to[key]
    if (a.length !== b.length) return true
    return a.some((point, i) => Math.abs(b[i].x - point.x - dx) > 0.6 || Math.abs(b[i].y - point.y - dy) > 0.6)
  })
  return { dx, dy, off, of: shared.length }
}

async function dragEverything(page: Page) {
  await page.keyboard.press("Control+a")
  await page.waitForTimeout(250)
  const grab = await largestComponentInView(page)
  if (!grab) throw new Error("no component sits inside the viewport")
  await sweep(page, grab)
  await page.waitForTimeout(500)
}

/**
 * Selecting the whole schematic and moving it must translate it, twice running. The first pass
 * of the drag rewrite left the bend-point cache from one drag in place for the next, so every
 * bent wire crept away from its own pins on the second move and only the first was undoable.
 */
async function checkRepeatedDrag(page: Page) {
  const before = await fieldShape(page)
  await dragEverything(page)
  const afterOne = await fieldShape(page)
  await dragEverything(page)
  const afterTwo = await fieldShape(page)

  for (const [label, move] of [
    ["the first drag of everything translates it", drifted(before, afterOne)],
    ["the second drag of everything translates it", drifted(afterOne, afterTwo)],
  ] as const) {
    check(label, move.off.length === 0, move.off.length === 0 ? `by (${move.dx}, ${move.dy})` : `${move.off.length} of ${move.of} moved differently, e.g. ${move.off[0]}`)
  }

  await page.keyboard.press("Control+z")
  await page.waitForTimeout(500)
  const undone = await fieldShape(page)
  const back = drifted(afterOne, undone)
  check("one undo takes the second drag back", back.off.length === 0 && back.dx === 0 && back.dy === 0, back.off.length === 0 && !back.dx && !back.dy ? "restored" : "the document did not come back")
}

const fieldCounts = (page: Page) =>
  page.evaluate(() => ({
    canvases: document.querySelectorAll("[data-slot=field-canvas]").length,
    components: document.querySelectorAll("[data-slot=component]").length,
    wirePaths: document.querySelectorAll("[data-slot=wires] path").length,
    pinNodes: document.querySelectorAll("[data-slot=pins] *").length,
    nodes: document.querySelectorAll("[data-slot=dot-field-content] *").length,
  }))

async function zoomTo(page: Page, want: number) {
  for (let step = 0; step < ZOOM_PRESSES * 2; step++) {
    const shown = (await readZoom(page)) ?? 1
    if (Math.abs(Math.log(shown / want)) < 0.1) break
    await page.keyboard.press(shown < want ? "Control+Equal" : "Control+Minus")
    const caughtUp = await page
      .waitForFunction(
        (previous) => {
          const badge = document.querySelector("[data-slot=zoom-controls]")?.textContent?.match(/(\d+)%/)
          return badge ? Number(badge[1]) / 100 !== previous : false
        },
        shown,
        { timeout: ZOOM_STEP_TIMEOUT_MS },
      )
      .then(() => true, () => false)
    if (!caughtUp) break
  }
  await page.waitForTimeout(ZOOM_SETTLE_MS * 2)
  return (await readZoom(page)) ?? 0
}

/**
 * Below the zoom where a pin can be aimed at, the field is one canvas and the DOM holds only
 * overlays. What has to keep working there: the picture, selecting and moving a symbol by
 * geometry rather than by `elementFromPoint`, and coming back to the DOM on the way up.
 */
/** A screen point over some object, worked out from the document — the canvas has no elements. */
async function pointOverObject(page: Page, doc: Schematic) {
  const placed = doc.objects.map((object) => {
    const rect = objectRect(object, GRID)
    return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  })
  return page.evaluate(
    ([centres, margin]) => {
      const content = document.querySelector("[data-slot=dot-field-content]") as HTMLElement | null
      const field = document.querySelector("[data-slot=dot-field-viewport]")?.getBoundingClientRect()
      if (!content || !field) return null
      const m = new DOMMatrix(getComputedStyle(content).transform)
      // Against the field's own box, not the window: the sidebar owns the first 256 px.
      for (const centre of centres) {
        const x = field.left + m.e + centre.x * m.a
        const y = field.top + m.f + centre.y * m.d
        const inside =
          x > field.left + margin.left &&
          x < field.right - margin.right &&
          y > field.top + margin.top &&
          y < field.bottom - margin.bottom
        if (inside) return { x, y }
      }
      return null
    },
    [placed, GRAB_MARGIN] as const,
  )
}

async function checkCanvasBand(page: Page, doc: Schematic) {
  const at = await zoomTo(page, CANVAS_BAND_ZOOM)
  const band = await fieldCounts(page)
  check(`the canvas band is reached`, at <= CANVAS_BAND_ZOOM * 1.25, `zoomed to ${Math.round(at * 100)}%`)
  check("the band draws the field on a canvas", band.canvases >= 1, `${band.canvases} canvas`)
  check(
    "the band leaves no component, wire or pin nodes",
    band.components === 0 && band.wirePaths === 0 && band.pinNodes === 0,
    `${band.nodes} nodes in the field`,
  )

  const before = await page.evaluate(() => (document.querySelector("[data-slot=field-canvas]") as HTMLCanvasElement | null)?.toDataURL().length ?? 0)
  const grab = await pointOverObject(page, doc)
  if (!grab) {
    check("a symbol is in view to drag in the band", false, "nothing in reach")
    await zoomTo(page, WORKING_ZOOM + 0.05)
    return
  }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  let carried = ""
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(grab.x + step * 10, grab.y + step * 5)
    await page.waitForTimeout(25)
    if (step === 6) carried = await page.evaluate(() => (document.querySelector("[data-slot=field-drag-layer]") as HTMLElement | null)?.style.transform ?? "")
  }
  await page.mouse.up()
  await page.waitForTimeout(700)
  const cleared = await page.evaluate(() => (document.querySelector("[data-slot=field-drag-layer]") as HTMLElement | null)?.style.transform ?? "")
  const after = await page.evaluate(() => (document.querySelector("[data-slot=field-canvas]") as HTMLCanvasElement | null)?.toDataURL().length ?? 0)
  check("a drag in the band moves the drag layer", /translate\(/.test(carried), carried || "(nothing)")
  check("the drag layer is cleared on release", cleared === "" || cleared === "none", cleared || "(empty)")
  check("the committed move repaints the static canvas", after !== before, `${before} → ${after} bytes`)

  await zoomTo(page, WORKING_ZOOM + 0.05)
  const back = await fieldCounts(page)
  check("leaving the band brings the DOM layers back", back.canvases === 0 && back.components > 0, `${back.components} components, ${back.canvases} canvas`)
}

type ExtraChecks = { repeatedDrag?: boolean; canvasBand?: boolean }

async function measureDocument(browser: Browser, doc: Schematic, extra: ExtraChecks): Promise<Measured> {
  const pins = pinCount(doc)
  console.log(`\n${doc.objects.length} objects / ${doc.wires.length} wires / ${pins} pins`)
  const { page, mountMs } = await openField(browser, doc)
  try {
    const zoom = await normaliseZoom(page)
    const nodes = await fieldNodes(page)
    console.log(`  loaded in ${mountMs} ms, zoom ${Math.round(zoom * 100)}%, ${nodes.total} nodes in the field (path ${nodes.path}, circle ${nodes.circle}, text ${nodes.text})`)

    if (extra.canvasBand) await checkCanvasBand(page, doc)
    if (extra.repeatedDrag) await checkRepeatedDrag(page)
    if (extra.canvasBand || extra.repeatedDrag) {
      await page.keyboard.press("Escape")
      await page.waitForTimeout(300)
    }

    const target = await largestComponentInView(page)
    if (!target) throw new Error(`no component sits inside the viewport at ${Math.round(zoom * 100)}% zoom`)

    await instrument(page)
    const settled = await componentOrigins(page)
    const drag = await measure(page, () => sweep(page, target))
    const moved = Math.abs((await componentOrigins(page)) - settled) > 1
    console.log(phaseLine("drag", drag))
    const pan = await measure(page, () => panWithSpaceHeld(page))
    console.log(phaseLine("pan", pan))
    const wheelZoom = await measure(page, () => pinchZoom(page))
    console.log(phaseLine("zoom", wheelZoom))
    const idle = await measure(page, () => page.waitForTimeout(IDLE_MS))
    console.log(phaseLine("idle", idle))

    return { objects: doc.objects.length, wires: doc.wires.length, pins, zoom, nodes, mountMs, moved, drag, pan, wheelZoom, idle }
  } finally {
    await page.close()
  }
}

function report(results: Measured[]) {
  console.log("\nThe documents and what they put in the DOM")
  table(
    ["objects", "wires", "pins", "loaded", "zoom", "nodes", "path", "circle", "text", "per object"],
    results.map((r) => [
      String(r.objects),
      String(r.wires),
      String(r.pins),
      `${(r.mountMs / 1000).toFixed(1)} s`,
      `${Math.round(r.zoom * 100)}%`,
      String(r.nodes.total),
      String(r.nodes.path),
      String(r.nodes.circle),
      String(r.nodes.text),
      (r.nodes.total / r.objects).toFixed(1),
    ]),
  )

  console.log("\nWhat a frame costs while the pointer is down")
  table(
    ["objects", "drag p95", "drag worst", "drag blocked", "pan p95", "pan blocked", "zoom p95", "zoom blocked", "idle p95"],
    results.map((r) => [
      String(r.objects),
      ms(r.drag.p95),
      ms(r.drag.worst),
      blocked(r.drag),
      ms(r.pan.p95),
      blocked(r.pan),
      ms(r.wheelZoom.p95),
      blocked(r.wheelZoom),
      ms(r.idle.p95),
    ]),
  )
}

let failed = 0
let total = 0
const check = (what: string, ok: boolean, detail: string) => {
  total++
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(46)} ${detail}`)
}
const atMost = (what: string, got: number, limit: number) =>
  check(what, got <= limit, `${ms(got).padStart(12)}   at most ${ms(limit)}`)

const wall0 = performance.now()
const base = lab1Stand.build(GRID)
const requested = process.argv.slice(2).map(Number).filter(Number.isFinite)
const documents = TILINGS.map((tiles) => tiled(base, tiles)).filter(
  (doc) => requested.length === 0 || requested.includes(doc.objects.length),
)

if (!documents.length) {
  console.log(`No document of that size. Sizes are ${TILINGS.map((tiles) => tiles * base.objects.length).join(", ")}.`)
  process.exit(1)
}

if (!(await devServerIsUp())) {
  console.log(`Nothing is answering on ${DEV_SERVER}.`)
  console.log("Start the dev server in another terminal and run this again:\n\n  CHOKIDAR_USEPOLLING=true pnpm dev\n")
  process.exit(1)
}

const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
})

const results: Measured[] = []
for (const doc of documents) {
  try {
    results.push(
      await measureDocument(browser, doc, {
        repeatedDrag: doc === documents[0],
        canvasBand: doc === documents[documents.length - 1] && doc.objects.length >= CANVAS_BAND_OBJECTS,
      }),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error)
    check(`${doc.objects.length} objects: measured`, false, `${reason}\n    the page must not reload mid-run — do not edit src/ while benchmarking`)
  }
}

await browser.close()
report(results)

console.log("")
for (const result of results) {
  const limit = THRESHOLDS[result.objects]
  if (!limit) continue
  const zoom = `${Math.round(result.zoom * 100)}%`
  check(`${result.objects} objects: the view was normalised`, result.zoom >= WORKING_ZOOM, `zoomed to ${zoom}, wanted ${Math.round(WORKING_ZOOM * 100)}% or more`)
  check(`${result.objects} objects: the drag moved a component`, result.moved, result.moved ? "moved" : "nothing was grabbed")
  atMost(`${result.objects} objects: drag p95`, result.drag.p95, limit.dragP95)
  atMost(`${result.objects} objects: pan p95`, result.pan.p95, limit.panP95)
  atMost(`${result.objects} objects: zoom p95`, result.wheelZoom.p95, limit.zoomP95)
}

console.log(`\n${total - failed}/${total} checks passed in ${Math.round(performance.now() - wall0)} ms`)
process.exit(failed ? 1 : 0)
