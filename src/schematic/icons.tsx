import * as React from "react"

/**
 * Palette icons drawn as the schematic symbols themselves (IEC style, like the components on
 * the field), on the same 24 px box and stroke as the Lucide set so they sit in the sidebar
 * and menus unchanged.
 */
export type Icon = React.ComponentType<React.SVGProps<SVGSVGElement>>

const make = (name: string, children: React.ReactNode): Icon => {
  const C = (props: React.SVGProps<SVGSVGElement>) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  )
  C.displayName = name
  return C
}

const dot = (cx: number, cy: number, r = 1.6) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />

export const ResistorIcon = make("ResistorIcon", <path d="M2 12h4M18 12h4M6 8.5h12v7H6z" />)

export const PotentiometerIcon = make(
  "PotentiometerIcon",
  <>
    <path d="M2 14h4M18 14h4M6 10.5h12v7H6z M12 3v4" />
    <path d="M9.5 6.5 12 10l2.5-3.5z" fill="currentColor" />
  </>,
)

export const CapacitorIcon = make("CapacitorIcon", <path d="M2 12h8M14 12h8M10 5v14M14 5v14" />)

export const ElectrolyticCapacitorIcon = make(
  "ElectrolyticCapacitorIcon",
  <path d="M2 12h8M14 12h8M10 5v14M16.5 5.5a10 10 0 0 0 0 13M4 5.5h4M6 3.5v4" />,
)

export const InductorIcon = make(
  "InductorIcon",
  <path d="M1 14h2a2.25 2.25 0 0 1 4.5 0a2.25 2.25 0 0 1 4.5 0a2.25 2.25 0 0 1 4.5 0a2.25 2.25 0 0 1 4.5 0h2" />,
)

export const DiodeIcon = make(
  "DiodeIcon",
  <>
    <path d="M2 12h5M17 12h5M17 5.5v13" />
    <path d="M7 6v12l9-6z" fill="currentColor" />
  </>,
)

export const ZenerDiodeIcon = make(
  "ZenerDiodeIcon",
  <>
    <path d="M2 12h5M17 12h5M20 5.5h-3v13h-3" />
    <path d="M7 6v12l9-6z" fill="currentColor" />
  </>,
)

export const LedIcon = make(
  "LedIcon",
  <>
    <path d="M2 14h5M17 14h5M17 7.5v13" />
    <path d="M7 8v12l9-6z" fill="currentColor" />
    <path d="M11.5 6.5l3-3.5M12.8 3h1.7v1.9M15.5 6.5l3-3.5M16.8 3h1.7v1.9" strokeWidth={1.5} />
  </>,
)

export const NpnIcon = make(
  "NpnIcon",
  <>
    <path d="M2 12h7M9 5v14M9 9l8-5V2M9 15l8 5v2" />
    <path d="M17.5 20.3l-5-.3 2-3.5z" fill="currentColor" stroke="none" />
  </>,
)

export const PnpIcon = make(
  "PnpIcon",
  <>
    <path d="M2 12h7M9 5v14M9 9l8-5V2M9 15l8 5v2" />
    <path d="M9.2 15.1l1.9 3.4 1.9-3z" fill="currentColor" stroke="none" />
  </>,
)

export const NmosIcon = make(
  "NmosIcon",
  <>
    <path d="M2 12h6M8 7v10M11 5v4M11 10v4M11 15v4M17 2v5h-6M17 22v-5h-6M11 12h6" />
    <path d="M11.5 12l3-1.7v3.4z" fill="currentColor" stroke="none" />
  </>,
)

export const PmosIcon = make(
  "PmosIcon",
  <>
    <path d="M2 12h6M8 7v10M11 5v4M11 10v4M11 15v4M17 2v5h-6M17 22v-5h-6M11 12h6" />
    <path d="M16.5 12l-3-1.7v3.4z" fill="currentColor" stroke="none" />
  </>,
)

export const PulseSourceIcon = make(
  "PulseSourceIcon",
  <>
    <path d="M2 12h2M20 12h2" />
    <circle cx={12} cy={12} r={8} />
    <path d="M7.5 14.5h2v-5h5v5h2" />
  </>,
)

export const PushbuttonIcon = make(
  "PushbuttonIcon",
  <>
    <path d="M2 16h5M17 16h5M6 10h12M12 10V6M9 6h6" />
    {dot(7, 16)}
    {dot(17, 16)}
  </>,
)

export const SwitchIcon = make(
  "SwitchIcon",
  <>
    <path d="M2 16h5M17 16h5M7 16l9-7" />
    {dot(7, 16)}
    {dot(17, 16)}
  </>,
)

export const BatteryIcon = make(
  "BatteryIcon",
  <path d="M2 12h6M16 12h6M8 5v14M11 9v6M13 5v14M16 9v6M3 5h3M4.5 3.5v3" />,
)

export const DcSourceIcon = make(
  "DcSourceIcon",
  <>
    <path d="M2 12h2M20 12h2" />
    <circle cx={12} cy={12} r={8} />
    <path d="M8 9.5h3M9.5 8v3M13 14.5h3" />
  </>,
)

export const AcSourceIcon = make(
  "AcSourceIcon",
  <>
    <path d="M2 12h2M20 12h2" />
    <circle cx={12} cy={12} r={8} />
    <path d="M8 12c1-3 3-3 4 0s3 3 4 0" />
  </>,
)

export const TransformerIcon = make(
  "TransformerIcon",
  <path d="M7 2v2.5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5a2.5 2.5 0 0 1 0 5V22M17 2v2.5a2.5 2.5 0 0 0 0 5a2.5 2.5 0 0 0 0 5a2.5 2.5 0 0 0 0 5V22M11.25 4v16M12.75 4v16" />,
)

export const JunctionIcon = make(
  "JunctionIcon",
  <>
    <path d="M2 12h20M12 12v10" />
    {dot(12, 12, 2.5)}
  </>,
)

export const GroundIcon = make("GroundIcon", <path d="M12 3v9M4 12h16M7 16h10M10 20h4" />)

export const SupplyIcon = make("SupplyIcon", <path d="M12 21V8M6 8h12M9 5h6" />)

export const LogicStateIcon = make(
  "LogicStateIcon",
  <>
    <rect x="3" y="6" width="12" height="12" rx="1.5" />
    <path d="M15 12h6M8.5 9.5v5M7.2 10.6l1.3-1.1" />
  </>,
)

export const VoltmeterIcon = make(
  "VoltmeterIcon",
  <>
    <path d="M2 12h3M19 12h3" />
    <circle cx={12} cy={12} r={7} />
    <path d="M9.5 8.5l2.5 7 2.5-7" />
  </>,
)

export const AmmeterIcon = make(
  "AmmeterIcon",
  <>
    <path d="M2 12h3M19 12h3" />
    <circle cx={12} cy={12} r={7} />
    <path d="M9.5 15.5l2.5-7 2.5 7M10.3 13h3.4" />
  </>,
)

export const TerminalIcon = make(
  "TerminalIcon",
  <>
    <rect x={3} y={5} width={18} height={14} rx={1.5} />
    <path d="M7 9l3 3-3 3M12 15h5" />
  </>,
)

export const DisplayIcon = make(
  "DisplayIcon",
  <>
    <rect x={3} y={4} width={18} height={13} rx={1.5} />
    <path d="M7 20h10M8 8h4" />
  </>,
)

export const CrystalIcon = make(
  "CrystalIcon",
  <>
    <path d="M2 12h5M17 12h5M7 8v8M17 8v8" />
    <rect x={9.5} y={7} width={5} height={10} rx={0.5} />
  </>,
)

export const OscillatorIcon = make(
  "OscillatorIcon",
  <>
    <rect x={3} y={6} width={14} height={12} rx={1} />
    <path d="M17 12h5M6 14h2v-4h2v4h2v-4h2" />
  </>,
)

export const ChipIcon = make(
  "ChipIcon",
  <>
    <rect x={7} y={7} width={10} height={10} rx={1} />
    <path d="M9 7V4M12 7V4M15 7V4M9 20v-3M12 20v-3M15 20v-3M7 9H4M7 12H4M7 15H4M20 9h-3M20 12h-3M20 15h-3" />
  </>,
)

export const HdlIcon = make(
  "HdlIcon",
  <>
    <rect x={6} y={5} width={12} height={14} rx={1} />
    <path d="M6 9H3M6 15H3M21 9h-3M21 15h-3M10.5 10 9 12l1.5 2M13.5 10l1.5 2-1.5 2" />
  </>,
)

export const MemoryIcon = make(
  "MemoryIcon",
  <>
    <rect x={5} y={7} width={14} height={10} rx={1} />
    <path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3M8 10v4M12 10v4M16 10v4" />
  </>,
)

export const BoardIcon = make(
  "BoardIcon",
  <>
    <rect x={4} y={3} width={16} height={18} rx={1.5} />
    <rect x={9} y={8} width={6} height={6} />
    <path d="M6.5 6v1M6.5 9v1M6.5 12v1M6.5 15v1M17.5 6v1M17.5 9v1M17.5 12v1M17.5 15v1" />
  </>,
)

