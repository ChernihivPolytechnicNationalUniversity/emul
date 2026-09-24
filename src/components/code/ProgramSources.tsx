import * as React from "react"
import { ChevronRightIcon, FilePlusIcon, FileQuestionIcon, FolderUpIcon, LibraryIcon, LockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { SourceRef } from "@/debug/sources"
import { cn } from "@/lib/utils"

type Props = React.ComponentProps<"div"> & {
  /** The files the image was built from that are not the project's, as the debugger resolves them. */
  sources: SourceRef[]
  active: string | null
  tabOf: (ref: SourceRef) => string
  onOpen: (ref: SourceRef) => void
  onAdd: (files: File[]) => void
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1)

/**
 * Under the project's files, the program's other sources: files added for the debugger
 * (read-only), ST's library and the build service's startup code (from the site), and the
 * ones that are nowhere yet — the list says which, and takes them as files or a folder.
 */
export function ProgramSources({ sources, active, tabOf, onOpen, onAdd, className, ...props }: Props) {
  const [open, setOpen] = React.useState(true)
  const [missingOpen, setMissingOpen] = React.useState(true)
  const file = React.useRef<HTMLInputElement>(null)
  const folder = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "")
  }, [])
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ""
    if (files.length) onAdd(files)
  }
  const byName = (a: SourceRef, b: SourceRef) => nameOf(a.image).localeCompare(nameOf(b.image), "en")
  const present = sources.filter((s) => s.kind !== "missing").sort(byName)
  const missing = sources.filter((s) => s.kind === "missing").sort(byName)
  const row = (s: SourceRef) => {
    const tab = tabOf(s)
    const Icon = s.kind === "added" ? LockIcon : s.kind === "site" ? LibraryIcon : FileQuestionIcon
    return (
      <button
        key={s.image}
        type="button"
        title={`${s.image}${s.kind === "added" ? " — added, read-only" : s.kind === "site" ? " — ST's library, from the site" : " — no source here: open it to add it"}`}
        className={cn("flex h-5 w-full min-w-0 items-center gap-1.5 pr-2 pl-5 text-left text-xs hover:bg-accent/60", active === tab && "bg-accent", s.kind === "missing" && "text-muted-foreground")}
        onClick={() => onOpen(s)}
      >
        <Icon className={cn("size-3 shrink-0", s.kind === "site" ? "text-teal-600" : "text-muted-foreground")} />
        <span className="truncate">{nameOf(s.image)}</span>
      </button>
    )
  }
  return (
    <div data-slot="program-sources" className={cn("flex min-h-0 flex-col border-t", className)} {...props}>
      <div className="flex h-7 shrink-0 items-center gap-1 pr-1 pl-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase" onClick={() => setOpen((o) => !o)}>
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          Program sources
        </button>
        <input ref={file} type="file" multiple accept=".c,.h,.cpp,.hpp,.cc,.s,.S,.inc" className="hidden" onChange={take} />
        <input ref={folder} type="file" className="hidden" onChange={take} />
        <Button variant="ghost" size="icon-xs" aria-label="Add source files" title="Add the program's source files (read-only, for the debugger)" onClick={() => file.current?.click()}>
          <FilePlusIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Add a source folder" title="Add a folder of the program's sources (a CubeIDE project's Core/, Drivers/)" onClick={() => folder.current?.click()}>
          <FolderUpIcon />
        </Button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto pb-1">
          {present.map(row)}
          {missing.length > 0 && (
            <>
              <button type="button" className="flex h-5 w-full items-center gap-1 pl-2 text-left text-[0.6875rem] text-muted-foreground hover:bg-accent/60" onClick={() => setMissingOpen((o) => !o)}>
                <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", missingOpen && "rotate-90")} />
                not here · {missing.length}
              </button>
              {missingOpen && missing.map(row)}
            </>
          )}
          {!present.length && !missing.length && <div className="px-3 text-xs text-muted-foreground">Every source of the program is in the project.</div>}
        </div>
      )}
    </div>
  )
}
