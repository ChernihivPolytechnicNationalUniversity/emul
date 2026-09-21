import * as React from "react"
import { intersects, objectRect, type Rect } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { readFieldPalette, useThemeName } from "./field-palette"
import { deviceScale, MAX_CANVAS_PX, TextRaster, type Symbol } from "./symbol-raster"

type TextCanvasProps = {
  objects: readonly PlacedObject[]
  view: Rect
  grid: number
  scale: number
  raster: TextRaster
}

type Drawn = { surface: string; objects: readonly PlacedObject[] }

export function TextCanvas({ objects, view, grid, scale, raster }: TextCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const drawn = React.useRef<Drawn | null>(null)
  const theme = useThemeName()
  const [fonts, setFonts] = React.useState(() => typeof document === "undefined" || !document.fonts)
  React.useEffect(() => {
    if (fonts) return
    let live = true
    document.fonts.ready.then(() => {
      if (!live) return
      raster.forgetFonts()
      drawn.current = null
      setFonts(true)
    })
    return () => {
      live = false
    }
  }, [fonts, raster])

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || view.w <= 0) return
    const pixels = scale * deviceScale()
    const width = Math.max(1, Math.round(view.w * pixels))
    const height = Math.max(1, Math.round(view.h * pixels))
    if (width > MAX_CANVAS_PX || height > MAX_CANVAS_PX) return

    const context = canvas.getContext("2d")
    if (!context) return
    raster.setPalette(readFieldPalette(canvas, theme))

    const placed = (object: PlacedObject): (Rect & { sheet: Symbol; stretch: number }) | null => {
      const def = getDef(object.def)
      const sheet = def && raster.get(def, object.rotation ?? 0, grid, pixels)
      if (!sheet) return null
      const stretch = pixels / sheet.scale
      const rect = objectRect(object, grid)
      return {
        x: (rect.x - view.x) * pixels - sheet.originX * stretch,
        y: (rect.y - view.y) * pixels - sheet.originY * stretch,
        w: sheet.width * stretch,
        h: sheet.height * stretch,
        sheet,
        stretch,
      }
    }
    const blit = (object: PlacedObject) => {
      const at = placed(object)
      if (at) context.drawImage(at.sheet.image, at.x, at.y, at.w, at.h)
    }

    const surface = `${width}x${height}|${view.x},${view.y}|${pixels}|${theme}`
    const before = drawn.current
    const patch = before?.surface === surface ? changedArea(before.objects, objects, placed) : "everything"
    drawn.current = { surface, objects }

    if (patch === "nothing") return
    if (patch !== "everything") {
      context.save()
      context.beginPath()
      context.rect(patch.x, patch.y, patch.w, patch.h)
      context.clip()
      context.clearRect(patch.x, patch.y, patch.w, patch.h)
      for (const object of objects) {
        const at = placed(object)
        if (at && intersects(at, patch)) context.drawImage(at.sheet.image, at.x, at.y, at.w, at.h)
      }
      context.restore()
      return
    }

    canvas.width = width
    canvas.height = height
    context.clearRect(0, 0, width, height)
    for (const object of objects) blit(object)
  }, [objects, view, grid, scale, theme, fonts, raster])

  if (view.w <= 0) return null
  return (
    <canvas
      ref={canvasRef}
      data-slot="field-text"
      className="pointer-events-none absolute"
      style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
    />
  )
}

function changedArea(
  before: readonly PlacedObject[],
  after: readonly PlacedObject[],
  placed: (object: PlacedObject) => Rect | null,
): Rect | "nothing" | "everything" {
  if (before === after) return "nothing"
  const now = new Set(after.map((o) => o.id))
  const was = new Map(before.map((o) => [o.id, o]))
  const changed: PlacedObject[] = []
  for (const object of before) if (!now.has(object.id)) changed.push(object)
  for (const object of after) if (was.get(object.id) !== object) changed.push(object)
  if (changed.length === 0) return "nothing"
  if (changed.length > before.length / 4) return "everything"
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const object of changed) {
    const at = placed(object)
    if (!at) return "everything"
    minX = Math.min(minX, at.x)
    minY = Math.min(minY, at.y)
    maxX = Math.max(maxX, at.x + at.w)
    maxY = Math.max(maxY, at.y + at.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}
