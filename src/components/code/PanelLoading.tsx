import { cn } from "@/lib/utils"
import { Skeleton as Base } from "@/components/ui/skeleton"
import { EmulLoader } from "@/components/ui/emul-loader"

/** The panel's bars, a shade darker than the stock skeleton so they show on the white panel. */
const Skeleton = ({ className, ...props }: React.ComponentProps<typeof Base>) => <Base className={cn("bg-foreground/10", className)} {...props} />

/** Line widths of the placeholder code, so it reads as a file and not as bars. */
const LINES = [62, 48, 0, 34, 40, 0, 70, 56, 58, 0, 44, 66, 30, 52, 0, 38, 60, 24]

/**
 * What a code panel shows while its chunk (Monaco and the editor) downloads: the panel's own
 * outline, an explorer and a file of pulsing lines, and the εmul loop saying what is coming.
 */
export function PanelLoading({ className, explorer = true, label = "Loading the editor…" }: { className?: string; explorer?: boolean; label?: string }) {
  return (
    <div className={cn("relative flex min-h-0 shrink-0 border-l bg-background md:max-xl:absolute md:max-xl:inset-y-0 md:max-xl:right-0 md:max-xl:z-30 md:max-xl:max-w-full max-md:fixed max-md:inset-x-0 max-md:top-10 max-md:bottom-0 max-md:z-40 max-md:w-auto max-md:border-l-0", className)} role="status" aria-live="polite">
      {explorer && (
        <div className="flex w-50 max-md:hidden shrink-0 flex-col gap-2 border-r p-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
          <Skeleton className="h-4 w-24" />
          <div className="flex-1" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="flex flex-col gap-2 p-4">
          {LINES.map((w, i) => (w ? <Skeleton key={i} className="h-3" style={{ width: `${w}%`, animationDelay: `${i * 60}ms` }} /> : <div key={i} className="h-3" />))}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-1 rounded-xl border bg-background px-6 pt-3 pb-4 text-sm text-muted-foreground shadow-md">
          <EmulLoader className="size-20" />
          {label}
        </div>
      </div>
    </div>
  )
}
