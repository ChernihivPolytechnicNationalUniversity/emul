import { cn } from "@/lib/utils"
import { wireColorVar, wireFlowVar, WIRE_COLORS, WIRE_COLOR_SHORTCUT, type WireColorKey } from "@/schematic/wire-colors"

type WirePaletteProps = Omit<React.ComponentProps<"div">, "onSelect"> & {
  active: ReadonlySet<WireColorKey>
  overridden: boolean
  onPick: (color: WireColorKey | undefined, segmentOnly?: boolean) => void
}

export function WirePalette({ active, overridden, onPick, className, ...props }: WirePaletteProps) {
  return (
    <div
      data-slot="wire-palette"
      className={cn("w-max rounded-lg border bg-card/95 p-1.5 shadow-md backdrop-blur-sm", className)}
      {...props}
    >
      <div className="grid grid-cols-7 gap-1">
        {WIRE_COLORS.map((key) => (
          <button
            key={key}
            type="button"
            title={`${key} · ${WIRE_COLOR_SHORTCUT[key]}`}
            aria-label={key}
            aria-pressed={active.has(key)}
            onClick={(e) => onPick(key, e.shiftKey)}
            className={cn(
              "size-7 rounded-md font-mono text-[0.6875rem] leading-none transition-[box-shadow] outline-none",
              active.has(key) ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : "hover:ring-2 hover:ring-border hover:ring-offset-1 hover:ring-offset-card",
            )}
            style={{ background: wireColorVar(key), color: wireFlowVar(key) }}
          >
            {WIRE_COLOR_SHORTCUT[key]}
          </button>
        ))}
        <button
          type="button"
          title="Automatic"
          aria-label="Automatic colour"
          aria-pressed={!overridden}
          onClick={() => onPick(undefined)}
          className={cn(
            "size-7 rounded-md border border-dashed border-muted-foreground/50 font-mono text-[0.6875rem] leading-none text-muted-foreground transition-[box-shadow] outline-none",
            !overridden ? "ring-2 ring-primary ring-offset-1 ring-offset-card" : "hover:ring-2 hover:ring-border hover:ring-offset-1 hover:ring-offset-card",
          )}
        >
          A
        </button>
      </div>
    </div>
  )
}
