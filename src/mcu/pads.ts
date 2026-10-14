/**
 * Pad names: "PA5" is port A, pin 5. A module of its own so the page can name pads without
 * importing the SoC model, which would also make the bundler place every module the debugger
 * shares with the core (the decoder, the DWARF reader) in the page's own chunk.
 */
export const PORT_NAMES = "ABCDEFGHIJK"

export type PadRef = { port: number; pin: number }

/** Analog-only pins with no port behind them (an AVR's ADC6/ADC7): "ADC6" is { port: 15, pin: 6 }. */
export const ANALOG_PORT = 15

/** "PA5" → { port: 0, pin: 5 }; "ADC6" → an analog-only pin. */
export function parsePad(name: string): PadRef | null {
  const a = /^ADC(\d{1,2})$/.exec(name)
  if (a) return Number(a[1]) < 16 ? { port: ANALOG_PORT, pin: Number(a[1]) } : null
  const m = /^P([A-K])(\d{1,2})$/.exec(name)
  if (!m) return null
  const pin = Number(m[2])
  if (pin > 15) return null
  return { port: PORT_NAMES.indexOf(m[1]), pin }
}
export function padName(p: PadRef) {
  if (p.port === ANALOG_PORT) return `ADC${p.pin}`
  return `P${PORT_NAMES[p.port]}${p.pin}`
}
