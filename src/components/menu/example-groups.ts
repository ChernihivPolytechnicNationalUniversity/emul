import type { Target } from "emul-shared/source"
import { buildTarget } from "@/project/board-build"
import { prebuilt } from "@/project/prebuilt"
import { examples, showcase, type Example } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"

export type ExampleItem = { example: Example; /** Every board comes programmed: it opens running. */ ready: boolean }
export type ExampleGroup = { title: string; items: ExampleItem[] }

/** The menu's sections, by the chip the example's firmware is for, in this order; circuits without code last. */
const SECTIONS: { title: string; targets: readonly (Target | null)[] }[] = [
  { title: "STM32 · Nucleo-F429ZI", targets: ["stm32f429zi"] },
  { title: "STM32 · F746 stand", targets: ["stm32f746ig"] },
  { title: "STM32 · F4-Discovery", targets: ["stm32f407vg"] },
  { title: "STM32 · F405 boards", targets: ["stm32f405rg"] },
  { title: "Arduino · Nano", targets: ["atmega328p"] },
  { title: "Circuits", targets: [null] },
]

/** The chip of the first board an example hands code to, read off the bench it builds. */
function targetOf(example: Example): Target | null {
  const ref = example.projects?.[0]?.ref
  if (!ref) return null
  const board = example.build(GRID).objects.find((o) => o.props?.ref === ref)
  return buildTarget(board && getDef(board.def)) ?? null
}

const item = (example: Example): ExampleItem => ({
  example,
  ready: !!example.projects?.length && example.projects.every((p) => !!prebuilt[example.id]?.[p.ref]),
})

let groups: ExampleGroup[] | null = null

/** The Examples menu: the showcase on its own first, then a section per board. Built once, when first opened. */
export function exampleGroups(): ExampleGroup[] {
  if (groups) return groups
  const rest = examples.filter((e) => e !== showcase).map((e) => ({ e, target: targetOf(e) }))
  groups = [
    { title: "Start here", items: [item(showcase)] },
    ...SECTIONS.map((s) => ({ title: s.title, items: rest.filter((r) => s.targets.includes(r.target)).map((r) => item(r.e)) })),
  ]
  // A chip with no section of its own (a PIC, a new target) still gets listed.
  const listed = new Set(groups.flatMap((g) => g.items.map((i) => i.example)))
  const other = rest.filter((r) => !listed.has(r.e)).map((r) => item(r.e))
  if (other.length) groups.splice(groups.length - 1, 0, { title: "Other boards", items: other })
  groups = groups.filter((g) => g.items.length)
  return groups
}
