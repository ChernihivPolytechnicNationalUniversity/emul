import * as React from "react"

const KEY = "emul.palette.collapsed-groups"

const NONE: ReadonlySet<string> = new Set()

export function savedCollapsedGroups(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

export function saveCollapsedGroups(ids: ReadonlySet<string>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]))
    return true
  } catch {
    return false
  }
}

export function useGroupsOpen(query: string) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(savedCollapsedGroups)
  const [collapsedInSearch, setCollapsedInSearch] = React.useState<{ query: string; ids: ReadonlySet<string> }>({ query: "", ids: NONE })
  const shut = query ? (collapsedInSearch.query === query ? collapsedInSearch.ids : NONE) : collapsed

  const isOpen = (id: string) => !shut.has(id)
  const setOpen = (id: string, open: boolean) => {
    const next = new Set(shut)
    if (open) next.delete(id)
    else next.add(id)
    if (query) {
      setCollapsedInSearch({ query, ids: next })
      return
    }
    setCollapsed(next)
    saveCollapsedGroups(next)
  }
  return { isOpen, setOpen }
}
