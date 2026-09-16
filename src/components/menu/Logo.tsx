import { cn } from "@/lib/utils"

// ε glyph (DejaVu Math TeX Gyre, U+1D700) as outlines; source of truth is public/mark.svg.
const EPSILON = "M55.4 -49.3 53.6 -39.7 48.1 -38.5Q48.4 -42.8 45.2 -45.1Q42.1 -47.3 37.6 -47.3Q33 -47.3 29.1 -44.9Q25.2 -42.5 24.6 -39.1Q23.9 -34.8 27.4 -32.3Q31.1 -29.8 37.5 -29.8H39.9L38.9 -24.7H34.4Q28 -24.7 23 -21.5Q18.1 -18.4 17 -13Q16.2 -8.9 19.8 -5.9Q23.3 -2.9 28.8 -2.7Q34.4 -2.7 39.1 -5.3Q43.7 -7.8 45.1 -12.9L50.2 -11.7L48.2 -1.6Q42.3 0.3 37.3 1Q31.9 1.9 28.1 1.9Q18.4 1.9 12.6 -2Q6.8 -5.8 8.2 -13.1Q9.7 -20.9 15.1 -24.6Q17.8 -26.5 25.4 -27.4L18.5 -31.3Q14.9 -33.4 16.1 -39.6Q17.3 -45.9 22.8 -49.2Q28.3 -52.5 37.8 -52.4Q40.7 -52.4 45.3 -51.7Q50 -50.8 55.4 -49.3Z"

/** Wordmark: math ε + "mul". Inherits text color and font size. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline font-semibold tracking-tight select-none", className)} aria-label="emul">
      <svg viewBox="5.9 -54.4 51.5 58.3" className="h-[0.66em] mr-px w-auto" fill="currentColor" aria-hidden="true">
        <path d={EPSILON} />
      </svg>
      <span aria-hidden="true">mul</span>
    </span>
  )
}
