import * as React from "react"
import type { Rect, RoutedWire } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { paintField } from "./field-paint"
import { useThemeName } from "./field-palette"
import { deviceScale, MAX_CANVAS_PX, rasterBucket, type SymbolRaster } from "./symbol-raster"

type FieldCanvasProps = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  view: Rect
  grid: number
  scale: number
  colorOf: (wireId: string) => WireColorKey
  raster: SymbolRaster
}

export function FieldCanvas({ objects, routes, view, grid, scale, colorOf, raster }: FieldCanvasProps) {
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
    paintField(context, canvas, { objects, routes, view, grid, pixels, device, theme, colorOf, raster })
  }, [objects, routes, view, grid, bucket, theme, colorOf, raster])

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
