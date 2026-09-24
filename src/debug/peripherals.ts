/**
 * The MCU's peripheral register map for the debugger's peripherals view: every block of the
 * device header (GPIOA at 0x40020000, a GPIO_TypeDef) with its registers' offsets and their
 * bit-fields, generated at site build time from ST's CMSIS device header (`pnpm peripherals`)
 * and served as `/peripherals/<chip>.json`.
 */

export type PeripheralRegister = { name: string; offset: number; size: number; access: "rw" | "r" | "w"; fields?: { name: string; pos: number; width: number }[] }
export type PeripheralMap = {
  chip: string
  /** Where the map came from: the device header's name and version. */
  source: string
  peripherals: { name: string; base: number; type: string; group: string }[]
  types: Record<string, { size: number; registers: PeripheralRegister[] }>
}

const cache = new Map<string, Promise<PeripheralMap | null>>()

/** The chip's map, fetched once; null where the site has none (a dev checkout without `pnpm peripherals`). */
export function loadPeripheralMap(chip: string): Promise<PeripheralMap | null> {
  let p = cache.get(chip)
  if (!p) {
    p = fetch(`/peripherals/${chip}.json`)
      .then((res) => (res.ok && (res.headers.get("content-type") ?? "").includes("json") ? (res.json() as Promise<PeripheralMap>) : null))
      .catch(() => null)
    cache.set(chip, p)
  }
  return p
}
