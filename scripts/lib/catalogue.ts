import type { CatalogueEntry, ComponentDef } from "@/schematic/types"
import { PART_FILES } from "@/schematic/parts"
import * as ICONS from "@/schematic/icons"

export const CATALOGUE_PATH = "src/schematic/catalogue.gen.ts"

const iconName = new Map<unknown, string>(Object.entries(ICONS).map(([name, icon]) => [icon, name]))

function entryOf(def: ComponentDef, file: string): CatalogueEntry {
  const icon = iconName.get(def.icon)
  if (!icon) throw new Error(`${def.id}: its icon is not one of src/schematic/icons.tsx`)
  const { id, name, description, category, keywords, width, height, prefix, chip, board } = def
  return { id, name, description, category, keywords, icon, width, height, prefix, chip, board, file }
}

/** The text of catalogue.gen.ts as the parts' files and the examples have it now. */
export async function catalogueSource(): Promise<string> {
  const entries: CatalogueEntry[] = []
  for (const [file, load] of Object.entries(PART_FILES)) for (const def of (await load()).defs) entries.push(entryOf(def, file))

  // Examples are built here once, so the Examples menu knows each one's board without building them all.
  const { loadAllDefs } = await import("@/schematic/registry")
  await loadAllDefs()
  const { examples } = await import("@/schematic/examples")
  const { GRID } = await import("@/schematic/geometry")
  const boards: [string, string][] = []
  for (const example of examples) {
    const ref = example.projects?.[0]?.ref
    const board = ref && example.build(GRID).objects.find((o) => o.props?.ref === ref)?.def
    if (board) boards.push([example.id, board])
  }

  return [
    "// Written by `pnpm catalogue` (scripts/catalogue.ts) from the parts' files and the examples: do not edit by hand.",
    'import type { CatalogueEntry } from "./types"',
    "",
    "/** Every part in palette order: what a page knows of it before its file loads. */",
    "export const CATALOGUE: CatalogueEntry[] = [",
    ...entries.map((e) => `  ${JSON.stringify(e)},`),
    "]",
    "",
    "/** The board each example hands its first project to, by example id. */",
    "export const EXAMPLE_BOARDS: Record<string, string> = {",
    ...boards.map(([example, board]) => `  ${JSON.stringify(example)}: ${JSON.stringify(board)},`),
    "}",
    "",
  ].join("\n")
}
