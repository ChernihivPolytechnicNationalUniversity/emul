import * as React from "react"

const KEY = "emul.inspector.sections"

function saved(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, boolean] => typeof e[1] === "boolean"))
  } catch {
    return {}
  }
}

/**
 * Which inspector sections are open ("panel" is the whole inspector), shared by every part and
 * kept across reloads. A section nobody has touched takes the default it is given.
 */
export function useSectionsOpen() {
  const [chosen, setChosen] = React.useState<Readonly<Record<string, boolean>>>(saved)
  const isOpen = (id: string, byDefault = true) => chosen[id] ?? byDefault
  const setOpen = (id: string, open: boolean) => {
    setChosen((prev) => {
      const next = { ...prev, [id]: open }
      try {
        localStorage.setItem(KEY, JSON.stringify(next))
      } catch {
        // Private window or blocked storage: the sections still open and close for this visit.
      }
      return next
    })
  }
  return { isOpen, setOpen }
}

export type SectionsOpen = ReturnType<typeof useSectionsOpen>
