import type { MemoryRegion } from "@/mcu/chip"
import type { ClockSource } from "@/mcu/periph/rcc"
import type { Icon } from "./icons"
import type { WireColorKey } from "./wire-colors"

/** Direction pointing outward from the component; wires leave the pin this way. */
export type Side = "left" | "right" | "top" | "bottom"

/** "node" is a bare wire node — a junction dot rather than a component terminal. */
export type PinKind = "power" | "gnd" | "digital" | "analog" | "node" | "nc"

/** A connection point. Coordinates are in grid cells relative to the component's top-left corner. */
export type PinDef = {
  id: string
  /** Short label drawn next to the pin (D13, A0, GND). */
  label: string
  x: number
  y: number
  side: Side
  /** Where the label sits relative to the pin. */
  labelAt: Side
  kind: PinKind
  /** Wire stub length in cells before routing starts (default 1). */
  stub?: number
  /** MCU pin name, e.g. PA5. */
  mcu?: string
  /** Board signal name, e.g. SPI_A_SCK. */
  signal?: string
  /** MCU function, e.g. SPI1_SCK. */
  fn?: string
  /** Physical connector and pin number. */
  connector?: string
  connectorPin?: number
  note?: string
}

/** `grip` paints nothing but catches the pointer: a handle to drag a symbol that has no body of its own. */
export type Fill = "board" | "zone" | "chip" | "connector" | "foreground" | "none" | "grip"

export type BodyShape =
  | { type: "rect"; x: number; y: number; w: number; h: number; rx?: number; fill?: Fill }
  | { type: "circle"; cx: number; cy: number; r: number; fill?: Fill }
  | {
      /** SVG path; coordinates in cells. Stroke is 2 world px, fill none unless set. */
      type: "path"
      d: string
      fill?: Fill
      muted?: boolean
    }
  | {
      type: "text"
      x: number
      y: number
      /** May reference object props: "{ref}", "{value}". */
      text: string
      /** Font size in cells (default 0.4). */
      size?: number
      anchor?: "start" | "middle" | "end"
      muted?: boolean
      /** Text drawn on a dark chip. */
      inverse?: boolean
      rotate?: number
    }

/** Interactive element on a component. State lives in the schematic, not in the definition. */
export type PartDef =
  | {
      type: "led"
      id: string
      label: string
      x: number
      y: number
      color: string
      /** "glow" draws only the halo (for schematic symbols); default draws an SMD package. */
      style?: "package" | "glow"
      /** Pin id on this component the LED is tied to, if it is exposed. */
      pin?: string
      mcu?: string
    }
  | {
      type: "button"
      id: string
      label: string
      x: number
      y: number
      /** Cap size in cells (default 1.6). */
      size?: number
      pin?: string
      mcu?: string
    }
  | {
      /** Toggle switch drawn as a lever between two contacts `span` cells apart. */
      type: "switch"
      id: string
      label: string
      x: number
      y: number
      span: number
      pin?: string
      mcu?: string
      /** Position the switch ships in (default off). */
      initial?: PartState
    }
  | {
      /** Logic level indicator/toggle: a box reading 1 or 0, clicked to flip `on`. */
      type: "logic"
      id: string
      label: string
      x: number
      y: number
    }
  | {
      /**
       * A display panel: a canvas of `width × height` pixels drawn over the cells at (x, y)
       * of size w × h, fed by the simulation; pressing it is a touch with coordinates.
       * `backlight` names an LED part whose level scales the picture.
       */
      type: "display"
      id: string
      label: string
      x: number
      y: number
      w: number
      h: number
      width: number
      height: number
      backlight?: string
    }
  | {
      /** A USB cable into a connector: plugged while `on`. Click to plug/unplug. */
      type: "usb"
      id: string
      label: string
      x: number
      y: number
      /** Cable comes from this side of the connector. */
      side: Side
      /** State before the user touches it (a board ships plugged in). */
      initial?: PartState
    }

// --- electrical model ---------------------------------------------------------

/** A pin id, or an internal node named "$name" that is not exposed as a pin. */
export type NodeRef = string

/** Numeric value, an SI string ("4.7 kΩ", "{value}"), or a function of the object's props. */
export type Value = number | string | ((props: Record<string, string>) => number)

/**
 * Absolute maximum ratings. Exceeding `voltage` breaks the element at once; exceeding
 * `current` or `power` heats it and breaks it after a short overload. `fail` says what is
 * left: an open circuit (default) or a short between the element's terminals.
 */
/**
 * Ratings a solved element is checked against. `voltage` is the magnitude across it (reverse
 * only for a diode); `reverse` a separate reverse-polarity limit for parts that mind the sign
 * (an electrolytic). `fail` is what the broken element becomes. A failure is `fatal` (the
 * default) when it takes the whole component with it — one die, one winding — and not when
 * the rest of the part keeps working on its own (the other half of a potentiometer).
 */
export type Limits = { power?: Value; current?: Value; voltage?: Value; reverse?: Value; fail?: "open" | "short"; fatal?: boolean }

export type Element =
  /** `live` names a pin-reader key the simulation loop answers with the resistance to use right now (an MCU's supply load by power mode). */
  | { kind: "R"; a: NodeRef; b: NodeRef; value: Value; live?: string; limits?: Limits; hidden?: boolean; supply?: boolean }
  | { kind: "C"; a: NodeRef; b: NodeRef; value: Value; limits?: Limits; hidden?: boolean }
  | { kind: "L"; a: NodeRef; b: NodeRef; value: Value; limits?: Limits; hidden?: boolean }
  /**
   * Ideal voltage source, plus relative to minus. `value` is the DC level; with `amplitude`
   * and `frequency` a sine of that peak rides on it: v(t) = value + amplitude·sin(2πft + phase).
   */
  | {
      kind: "V"
      plus: NodeRef
      minus: NodeRef
      value: Value
      amplitude?: Value
      frequency?: Value
      /** Radians. */
      phase?: Value
      /** "pulse" is a square wave from `value` to `value + amplitude`, high for `duty` of each period. */
      shape?: "sine" | "pulse"
      /** 0..1; default 0.5. */
      duty?: Value
      limits?: Limits
    }
  /**
   * Electrochemical cell(s): open-circuit voltage from the chemistry's discharge curve at the
   * state of charge, which the solver integrates from the current; internal resistance
   * (default from the chemistry and capacity) that climbs towards empty; Peukert rate loss,
   * self-discharge, overcharge and deep-discharge failure; diffusion (the voltage rests back
   * up after a load), self-heating with the chemistry's vent temperature, ambient `temp` in °C
   * (capacity and resistance follow it), wear from `cycles` and `years`, and a capacity
   * `spread` in per cent between the cells of a pack (the weakest empties first). `chemistry`
   * is a `Chemistry.id` (may reference a prop), `capacity` in Ah, `soc` the starting state of
   * charge in per cent.
   */
  | {
      kind: "BAT"
      plus: NodeRef
      minus: NodeRef
      chemistry: string
      cells: Value
      capacity: Value
      soc: Value
      rint?: Value
      temp?: Value
      cycles?: Value
      years?: Value
      spread?: Value
      limits?: Limits
    }
  /** Ideal transformer: V(s1, s2) = ratio · V(p1, p2), no losses or magnetising current. */
  | { kind: "XFMR"; p1: NodeRef; p2: NodeRef; s1: NodeRef; s2: NodeRef; ratio: Value; limits?: Limits }
  /** Shockley diode. `vf` is the forward drop at 10 mA; `zener` the reverse breakdown voltage. */
  | { kind: "D"; anode: NodeRef; cathode: NodeRef; vf?: Value; zener?: Value; part?: string; limits?: Limits }
  /**
   * `limits.voltage` is Vce max, `current` Ic max, `power` total dissipation. `rc` is the ohmic
   * collector resistance in series with the junction model, which sets Vce(sat) above the
   * few tens of millivolts an ideal Ebers–Moll transistor saturates at.
   */
  | { kind: "Q"; polarity: "npn" | "pnp"; b: NodeRef; c: NodeRef; e: NodeRef; beta?: Value; rc?: Value; limits?: Limits }
  /**
   * Enhancement MOSFET, Shichman–Hodges: `vth` is the threshold magnitude, `k` the
   * transconductance parameter in A/V², `lambda` channel-length modulation in 1/V.
   * `limits.voltage` is Vds max, `current` Id max, `power` total dissipation.
   */
  | { kind: "M"; polarity: "nmos" | "pmos"; g: NodeRef; d: NodeRef; s: NodeRef; vth: Value; k: Value; lambda?: Value; limits?: Limits }
  /**
   * Switch driven by a part: closed while the part is `on`, `pressed`, or (`off`) not on, through
   * `ron` of contact resistance. Open, the gap arcs over when the voltage across it reaches
   * `strike` volts (an inductive load let go), unless it is `ideal` (an instrument's switch).
   */
  | { kind: "SW"; a: NodeRef; b: NodeRef; part: string; closed: "on" | "pressed" | "off"; ron?: Value; strike?: Value; ideal?: boolean; limits?: Limits }
  | { kind: "GND"; node: NodeRef }
  /**
   * MCU pad: driven by the emulated MCU's GPIO block; high-impedance without firmware.
   * `limits.voltage` is the pad's absolute maximum against ground, `current` the per-pin limit.
   */
  | {
      kind: "GPIO"
      node: NodeRef
      /** Supply the driver and pulls switch to: a rail node (follows the real supply), else a fixed voltage. */
      vddNode?: NodeRef
      vdd?: number
      limits?: Limits
    }
  /**
   * Ideal linear regulator: holds `out` at `value` above `gnd` while `in` is at least `dropout`
   * higher, follows `in − dropout` below that, folds back to `imax` into an overload, and
   * blocks when something else holds `out` higher. Draws no quiescent current.
   */
  | { kind: "REG"; in: NodeRef; out: NodeRef; gnd: NodeRef; value: Value; dropout?: Value; imax?: Value; limits?: Limits }
  /** Nodes that are the same conductor inside the component (a ground rail). */
  | { kind: "SHORT"; nodes: NodeRef[] }

/** An editable per-instance property shown in the inspector. */
export type PropField =
  | { key: string; label: string; type: "text"; placeholder?: string }
  /** A number with an SI prefix in a fixed unit, stored as "4.7 kΩ". `placeholder` is shown when empty (a value the model derives). */
  | { key: string; label: string; type: "quantity"; unit: string; placeholder?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[] }
  | { key: string; label: string; type: "range"; min: number; max: number; step: number; /** Shown after the value. */ unit?: string }

export type ComponentDef = {
  id: string
  name: string
  description?: string
  /** Palette group. */
  category: string
  icon: Icon
  /** Size in grid cells. */
  width: number
  height: number
  /** Reference designator prefix (R, C, D, U). Objects get "{prefix}{n}" as props.ref. */
  prefix?: string
  /** Default props (value, color…); overridable per placed object. */
  defaults?: Record<string, string>
  /** Extra "{key}" substitutions for the body text computed from the props (a label that combines several). */
  derive?: (props: Record<string, string>) => Record<string, string>
  /** Editable props. `ref` is added automatically for components with a prefix. */
  fields?: PropField[]
  body: BodyShape[]
  pins: PinDef[]
  parts: PartDef[]
  /** Electrical model; components without one are drawn but do not conduct. */
  model?: Element[]
  /** Inspector hides internal elements that carry no current: boards have dozens of them. */
  hideIdle?: boolean
  /** Emulated MCU on this component: a chip profile id from `src/mcu/chip.ts`. */
  chip?: string
  /** Pin whose voltage powers the on-board MCU; the core holds in reset while it is low. */
  mcuPower?: string
  /** Pin that is the MCU's NRST; the core holds in reset while it is low. */
  mcuReset?: string
  /** Pin whose level at reset selects the boot memory (BOOT0); absent: always boots from flash. */
  mcuBoot0?: string
  /**
   * Clock sources a board carries for its MCU (null: the pins are free). A bare chip omits this
   * and gets its HSE/LSE from crystals or oscillators wired to its OSC pins on the field.
   */
  mcuClocks?: { hse: ClockSource | null; lse: ClockSource | null }
  /**
   * Memory a board hangs on the MCU's external bus (an SDRAM on the FMC): mapped into the
   * core's address space, reachable once the firmware has set the controller up.
   */
  mcuMemory?: MemoryRegion[]
  /** A live meter readout drawn on the component (a voltmeter, ammeter): what to show and where. */
  meter?: MeterSpec
  /** An RGB panel fed by an MCU's LCD controller: which pins carry which signal, and what it accepts. */
  panel?: PanelSpec
  /** Free-form reference data shown in the inspector later. */
  info?: Record<string, string>
}

/** LTDC output lines a parallel RGB panel takes. */
export type PanelSignal = `R${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}` | `G${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}` | `B${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}` | "CLK" | "HS" | "VS" | "DE"

export type PanelSpec = {
  /** The display part that shows the picture. */
  part: string
  width: number
  height: number
  /** Pin id → the signal the panel expects on it. */
  signals: Record<string, PanelSignal>
  /** Pixel clock the panel locks to, Hz. */
  pixelHz: [number, number]
  /** The logic supply pin: below ~2.7 V the panel is dark and mute. */
  power?: string
}

/**
 * A live value drawn on a meter component from one of its model elements' operating point:
 * the voltage across it, the current through it, or its power. RMS is shown in an AC circuit.
 */
export type MeterSpec = {
  read: "voltage" | "current" | "power"
  /** Model element index to read (default 0). */
  element?: number
  /** Unit for the SI formatter ("V", "A", "W"). */
  unit: string
  /** Where to draw the value, in grid cells. */
  x: number
  y: number
  /** Font size in cells (default 0.4). */
  size?: number
}

// --- schematic state ---------------------------------------------------------

export type PinRef = { object: string; pin: string }

/** Clockwise rotation in degrees, in 45° steps so components can sit on a diagonal. */
export type Rotation = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315

export type PlacedObject = {
  id: string
  /** ComponentDef id. */
  def: string
  /** Top-left corner of the (rotated) bounding box in world px, snapped to the grid. */
  x: number
  y: number
  /** Clockwise rotation in degrees. */
  rotation?: Rotation
  /** ref, value and other per-instance props. */
  props?: Record<string, string>
}

export type Point = { x: number; y: number }

export type Wire = {
  id: string
  from: PinRef
  to: PinRef
  /** User-placed bend points in world px (snapped); the router connects them orthogonally. */
  points?: Point[]
  color?: WireColorKey
}

/** `x`/`y`: where a panel was pressed, in its own pixels. */
export type PartState = { on?: boolean; pressed?: boolean; x?: number; y?: number }

/** A component destroyed by the simulation. Lives in the simulation, not the document. */
/** One broken model element: what it became and why. */
export type DamageEntry = { reason: string; /** What the broken element became. */ fail: "open" | "short"; /** Model element index. */ element: number }
/**
 * What is broken on a component: the first failure, whether it killed the whole part
 * (`fatal`), and any further elements that broke on their own afterwards.
 */
export type Damage = DamageEntry & { fatal: boolean; also?: DamageEntry[] }

export type Schematic = {
  objects: PlacedObject[]
  wires: Wire[]
  /** Keyed by partKey(objectId, partId). */
  parts: Record<string, PartState>
}

export const partKey = (object: string, part: string) => `${object}:${part}`
export const pinKey = (object: string, pin: string) => `${object}:${pin}`

export const emptySchematic = (): Schematic => ({ objects: [], wires: [], parts: {} })
