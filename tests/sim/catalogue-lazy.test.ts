import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import { catalogueSource } from "../../scripts/lib/catalogue"
import { PART_FILES } from "@/schematic/parts"

/** A registry as a fresh page has it: no part file loaded yet. */
async function freshRegistry() {
  vi.resetModules()
  return import("@/schematic/registry")
}

describe("the catalogue manifest", () => {
  it("is current: run `pnpm catalogue` after changing a part or an example", async () => {
    expect(readFileSync("src/schematic/catalogue.gen.ts", "utf8"), "src/schematic/catalogue.gen.ts is stale: run pnpm catalogue").toBe(await catalogueSource())
  })

  it("lists every file of parts, and every file it lists exports its parts as `defs`", async () => {
    const files = readdirSync("src/schematic/components").filter((f) => f.endsWith(".ts"))
    const withDefs = files.filter((f) => /^export const defs\b/m.test(readFileSync(`src/schematic/components/${f}`, "utf8"))).map((f) => f.replace(/\.ts$/, ""))
    expect(Object.keys(PART_FILES).sort(), "add the file to PART_FILES in src/schematic/parts.ts").toEqual(withDefs.sort())
    for (const [file, load] of Object.entries(PART_FILES)) expect.soft((await load()).defs.length, file).toBeGreaterThan(0)
  })
})

describe("parts load on demand", () => {
  it("a fresh page knows every part by its manifest, and has loaded none", async () => {
    const r = await freshRegistry()
    expect(r.getMeta("resistor")?.name).toBe("Resistor")
    expect(r.getMeta("open746i-c")?.width).toBeGreaterThan(0)
    expect(r.getDef("resistor")).toBeUndefined()
    expect(r.loadedFiles()).toEqual([])
  })

  it("loads only the file a part lives in", async () => {
    const r = await freshRegistry()
    await r.ensureDefs(["nucleo-f429zi"])
    expect(r.getDef("nucleo-f429zi")?.pins.length).toBeGreaterThan(0)
    expect(r.loadedFiles()).toEqual(["nucleo-f429zi"])
    expect(r.getDef("open746i-c")).toBeUndefined()
  })

  it("does not wait when everything asked for is already here", async () => {
    const r = await freshRegistry()
    await r.ensureDefs(["resistor"])
    expect(r.ensureDefs(["resistor", "capacitor"])).toBeNull()
  })

  it("asks once for a file, however many ask at the same time", async () => {
    const r = await freshRegistry()
    const a = r.ensureDefs(["resistor"])
    const b = r.ensureDefs(["capacitor"])
    await Promise.all([a, b])
    expect(r.loadedFiles()).toEqual(["basic"])
  })

  it("passes over ids it does not know: HDL modules, a file from a newer version", async () => {
    const r = await freshRegistry()
    expect(r.ensureDefs(["hdl:abc", "no-such-part"])).toBeNull()
  })

  it("loads every id a saved project may hold", async () => {
    const r = await freshRegistry()
    const saved: string[] = JSON.parse(readFileSync("tests/data/catalogue-ids.json", "utf8"))
    await r.ensureDefs(saved)
    for (const id of saved) expect.soft(r.getDef(id), id).toBeDefined()
  })

  it("a part's manifest entry is what its definition says", async () => {
    const r = await freshRegistry()
    await r.loadAllDefs()
    for (const meta of r.catalogue) {
      const def = r.getDef(meta.id)!
      expect.soft({ name: def.name, category: def.category, width: def.width, height: def.height, icon: def.icon, chip: def.chip }, meta.id).toEqual({
        name: meta.name,
        category: meta.category,
        width: meta.width,
        height: meta.height,
        icon: meta.icon,
        chip: meta.chip,
      })
    }
  })

  it("lists all parts only once all are loaded", async () => {
    const r = await freshRegistry()
    expect(() => r.allDefs()).toThrow(/loadAllDefs/)
    await r.loadAllDefs()
    expect(r.allDefs().map((d) => d.id)).toEqual(r.catalogue.map((m) => m.id))
  })
})

describe("examples on a fresh page", () => {
  it("build, and the bench they build has every part once its ids are loaded", async () => {
    const r = await freshRegistry()
    const { examples } = await import("@/schematic/examples")
    const { GRID } = await import("@/schematic/geometry")
    for (const example of examples) {
      const doc = await r.withDefs(() => example.build(GRID))
      await r.ensureDefs(r.defIds(doc))
      const missing = doc.objects.filter((o) => !r.getDef(o.def) && !r.getMeta(o.def)).map((o) => o.def)
      expect.soft(missing, example.id).toEqual([])
      expect.soft(doc.objects.filter((o) => r.getMeta(o.def) && !r.getDef(o.def)).map((o) => o.def), example.id).toEqual([])
    }
  })

  it("name their board's chip without building", async () => {
    const r = await freshRegistry()
    const { examples } = await import("@/schematic/examples")
    const { GRID } = await import("@/schematic/geometry")
    const { EXAMPLE_BOARDS } = await import("@/schematic/catalogue.gen")
    for (const example of examples) {
      const ref = example.projects?.[0]?.ref
      const doc = await r.withDefs(() => example.build(GRID))
      const board = ref ? (doc.objects.find((o) => o.props?.ref === ref)?.def ?? null) : null
      expect.soft(EXAMPLE_BOARDS[example.id] ?? null, example.id).toBe(board)
    }
  })
})
