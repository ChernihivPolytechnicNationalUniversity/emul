/**
 * The digital parts a board carries next to its MCU (an accelerometer on SPI, a codec on I²C), as
 * the one DigitalPart the loop keeps per placed object: pins, edges, ticks and snapshots of every
 * chip, each on its own pins of the board's model.
 */
import type { PartState } from "@/schematic/types"
import type { DigitalEdge, DigitalPart } from "./digital-part"

/** A chip whose supply the board switches: dead (drives nothing, hears nothing) below `min` volts on `node`, reset when it comes up. */
export type SwitchedSupply = { node: string; min: number }

export class OnboardParts implements DigitalPart {
  readonly object: string
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  readonly senses: readonly string[]
  readonly chips: Record<string, DigitalPart>
  private readonly edges: DigitalEdge[] = []
  private readonly byPin = new Map<string, DigitalPart[]>()
  private readonly supplies: Map<DigitalPart, SwitchedSupply>
  private readonly dead = new Set<DigitalPart>()

  constructor(object: string, chips: Record<string, DigitalPart>, supplies: Record<string, SwitchedSupply> = {}) {
    this.object = object
    this.chips = chips
    for (const chip of Object.values(chips)) for (const pin of chip.pins) this.byPin.set(pin, [...(this.byPin.get(pin) ?? []), chip])
    this.pins = [...this.byPin.keys()]
    this.outputs = [...new Set(Object.values(chips).flatMap((c) => [...(c.outputs ?? c.pins)]))]
    this.supplies = new Map(Object.entries(supplies).map(([name, supply]) => [chips[name], supply]))
    for (const chip of this.supplies.keys()) this.dead.add(chip)
    this.senses = [...new Set([...this.supplies.values()].map((s) => s.node))]
  }

  /** Whether a chip has power: always, unless its supply is switched and off. */
  powered(name: string) {
    return !this.dead.has(this.chips[name])
  }

  sense(volts: (pin: string) => number, time: number) {
    for (const [chip, supply] of this.supplies) {
      const on = volts(supply.node) >= supply.min
      if (on && this.dead.has(chip)) {
        this.dead.delete(chip)
        chip.reset()
      } else if (!on && !this.dead.has(chip)) {
        this.dead.add(chip)
        // Everything it was driving lets go as the rail falls.
        for (const pin of chip.pins) if (chip.drive(pin) !== null) this.edges.push({ pin, level: null, time })
      }
    }
  }

  /** Every chip's pending edges, merged in time order; the loop drains this array in place. */
  get out(): DigitalEdge[] {
    let moved = false
    for (const chip of Object.values(this.chips))
      if (chip.out.length) {
        const edges = chip.out.splice(0, chip.out.length)
        if (!this.dead.has(chip)) this.edges.push(...edges)
        moved = true
      }
    if (moved) this.edges.sort((a, b) => a.time - b.time)
    return this.edges
  }

  drive(pin: string): boolean | null {
    for (const chip of this.byPin.get(pin) ?? []) {
      if (this.dead.has(chip)) continue
      const level = chip.drive(pin)
      if (level !== null) return level
    }
    return null
  }

  input(pin: string, level: boolean, time: number) {
    for (const chip of this.byPin.get(pin) ?? []) if (!this.dead.has(chip)) chip.input(pin, level, time)
  }

  reset() {
    for (const chip of Object.values(this.chips)) chip.reset()
  }

  configure(props: Record<string, string>) {
    for (const chip of Object.values(this.chips)) chip.configure(props)
  }

  interact(part: string, state: PartState, time: number) {
    for (const chip of Object.values(this.chips)) chip.interact?.(part, state, time)
  }

  prime(levels: Map<string, boolean>, time: number) {
    for (const chip of Object.values(this.chips)) {
      if (!chip.prime) continue
      const own = new Map([...levels].filter(([pin]) => chip.pins.includes(pin)))
      chip.prime(own, time)
    }
  }

  tick(time: number) {
    let changed = false
    for (const chip of Object.values(this.chips)) if (!this.dead.has(chip) && chip.tick?.(time)) changed = true
    return changed
  }

  quietUntil() {
    let until = Infinity
    for (const chip of Object.values(this.chips)) {
      if (!chip.tick || this.dead.has(chip)) continue
      until = Math.min(until, chip.quietUntil ? chip.quietUntil() : -Infinity)
    }
    return until
  }

  snapshot() {
    return Object.fromEntries(Object.entries(this.chips).map(([name, chip]) => [name, { powered: !this.dead.has(chip), ...(chip.snapshot() as object) }]))
  }
}
