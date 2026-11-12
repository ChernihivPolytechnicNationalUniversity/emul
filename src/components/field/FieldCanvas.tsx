import * as React from "react"
import type { Rect, RoutedWire } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { paintField } from "./field-paint"
import type { WireMarks } from "./wire-marks"
import { useThemeName } from "./field-palette"
import type { WirePlate } from "./wire-plate"
import { deviceScale, MAX_CANVAS_PX, rasterBucket, type SymbolRaster } from "./symbol-raster"

type FieldCanvasProps = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  view: Rect
  grid: number
  scale: number
  colorOf: (wireId: string) => WireColorKey
  netOf?: (wireId: string) => string | undefined
  raster: SymbolRaster
  selectedObjects?: ReadonlySet<string>
  selectedWires?: ReadonlySet<string>
  plates?: readonly WirePlate[]
  marks?: WireMarks
  /** A search is on: these objects stay bright, the rest of the field dims. */
  lit?: ReadonlySet<string> | null
}

const NONE: ReadonlySet<string> = new Set()
const NO_PLATES: readonly WirePlate[] = []

export function FieldCanvas({ objects, routes, view, grid, scale, colorOf, netOf, raster, selectedObjects = NONE, selectedWires = NONE, plates = NO_PLATES, marks, lit = null }: FieldCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const bucket = rasterBucket(scale)
  const theme = useThemeName()

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || view.w <= 0) return
    const device = deviceScale()
    const pixels = bucket * device
    const width = Math.max(1, Math.round(view.w * pixels))
    const height = Math.max(1, Math.round(view.h * pixels))
    if (width > MAX_CANVAS_PX || height > MAX_CANVAS_PX) return
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return

    context.clearRect(0, 0, width, height)
    paintField(context, canvas, { objects, routes, view, grid, pixels, device, theme, colorOf, netOf, raster, selection: { objects: selectedObjects, wires: selectedWires, plates }, marks, lit })
  }, [objects, routes, view, grid, bucket, theme, colorOf, netOf, raster, selectedObjects, selectedWires, plates, marks, lit])

  if (view.w <= 0) return null
  return (
    <canvas
      ref={canvasRef}
      data-slot="field-canvas"
      className="pointer-events-none absolute"
      style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
    />
  )
}
