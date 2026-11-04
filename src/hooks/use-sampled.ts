import * as React from "react"

/** A value that changes many times a second, sampled every `ms`: lists and badges that read rather than flicker. */
export function useSampled<T>(value: T, ms: number): T {
  const [sampled, setSampled] = React.useState(value)
  const latest = React.useRef(value)
  React.useEffect(() => {
    latest.current = value
  }, [value])
  React.useEffect(() => {
    const id = setInterval(() => setSampled((s) => (Object.is(s, latest.current) ? s : latest.current)), ms)
    return () => clearInterval(id)
  }, [ms])
  return sampled
}
