import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { examples } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { readProjectFile } from "@/project/project-store"
import type { Schematic } from "@/schematic/types"
import { inventory, pinPartition, type Partition } from "./pin-partition"
import { SCHEMATIC_CASES } from "./schematic-cases"

const ROOT = join(import.meta.dirname, "..", "..")
const DATA = join(ROOT, "tests", "data")
export const PARTITIONS = join(DATA, "pin-partition")

export type PartitionDocument = { name: string; source: string; doc: Schematic }

export function emulFiles(): string[] {
  return readdirSync(DATA, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".emul"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
}

export async function partitionDocuments(): Promise<PartitionDocument[]> {
  const out: PartitionDocument[] = examples.map((e) => ({ name: e.id, source: `example ${e.id}`, doc: e.build(GRID) }))
  for (const c of SCHEMATIC_CASES) out.push({ name: `case--${c.name}`, source: `tests/lib/schematic-cases.ts ${c.name}`, doc: c.build() })
  for (const file of emulFiles()) {
    const path = relative(DATA, file).split(sep).join("/")
    const read = await readProjectFile(new Blob([readFileSync(file)]))
    if (!read) throw new Error(`${path} does not read as a project`)
    out.push({ name: path.replaceAll("/", "--"), source: `tests/data/${path}`, doc: read.doc })
  }
  return out
}

export type PartitionFixture = { source: string; objects: string[]; nets: Partition }

export const fixturePath = (name: string) => join(PARTITIONS, `${name}.json`)

export function readFixture(name: string): PartitionFixture | null {
  const path = fixturePath(name)
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PartitionFixture) : null
}

const lines = (items: readonly unknown[]) => (items.length ? `\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ` : "")

export function fixtureText(document: PartitionDocument): string {
  const objects = inventory(document.doc.objects)
  const nets = pinPartition(document.doc, GRID)
  return `{\n  "source": ${JSON.stringify(document.source)},\n  "objects": [${lines(objects)}],\n  "nets": [${lines(nets)}]\n}\n`
}

export function writeFixture(document: PartitionDocument) {
  writeFileSync(fixturePath(document.name), fixtureText(document))
}
