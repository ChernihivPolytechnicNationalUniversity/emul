/**
 * Pad names: "PA5" is port A, pin 5. A module of its own so the page can name pads without
 * importing the SoC model, which would also make the bundler place every module the debugger
 * shares with the core (the decoder, the DWARF reader) in the page's own chunk.
 */
export const PORT_NAMES = "ABCDEFGHIJK"

export type PadRef = { port: number; pin: number }

/** "PA5" → { port: 0, pin: 5 }. */
export function parsePad(name: string): PadRef | null {
  const m = /^P([A-K])(\d{1,2})$/.exec(name)
  if (!m) return null
  const pin = Number(m[2])
  if (pin > 15) return null
  return { port: PORT_NAMES.indexOf(m[1]), pin }
}
export function padName(p: PadRef) {
  return `P${PORT_NAMES[p.port]}${p.pin}`
}
