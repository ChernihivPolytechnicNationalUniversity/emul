import * as React from "react"
import { CopyIcon, DownloadIcon, EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { Projects } from "@/hooks/use-projects"
import type { ProjectMeta, Thumb } from "@/project/project-store"
import { cn } from "@/lib/utils"

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Infinity],
]

function ago(at: number): string {
  let v = (at - Date.now()) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(v) < size) return unit === "second" ? "just now" : rtf.format(Math.round(v), unit)
    v /= size
  }
  return ""
}

function Preview({ thumb }: { thumb?: Thumb }) {
  if (!thumb) return <div className="h-12 w-16 shrink-0 rounded-sm border border-dashed" />
  const pad = 4
  const rects: React.ReactNode[] = []
  for (let i = 0; i < thumb.rects.length; i += 4)
    rects.push(<rect key={i} x={thumb.rects[i]} y={thumb.rects[i + 1]} width={thumb.rects[i + 2]} height={thumb.rects[i + 3]} rx={0.8} />)
  const lines: React.ReactNode[] = []
  for (let i = 0; i < thumb.lines.length; i += 4)
    lines.push(<line key={i} x1={thumb.lines[i]} y1={thumb.lines[i + 1]} x2={thumb.lines[i + 2]} y2={thumb.lines[i + 3]} />)
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${thumb.w + 2 * pad} ${thumb.h + 2 * pad}`}
      className="h-12 w-16 shrink-0 rounded-sm border bg-background text-muted-foreground"
      preserveAspectRatio="xMidYMid meet"
    >
      <g fill="currentColor" fillOpacity={0.12} stroke="currentColor" strokeWidth={0.6}>
        {rects}
      </g>
      <g stroke="currentColor" strokeWidth={0.5} strokeOpacity={0.7}>
        {lines}
      </g>
    </svg>
  )
}

function Row({
  project,
  active,
  projects,
  onDownload,
  onPicked,
}: {
  project: ProjectMeta
  active: boolean
  projects: Projects
  onDownload: (id: string) => void
  onPicked: () => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(project.name)

  const commit = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== project.name) void projects.rename(project.id, name)
    else setName(project.name)
  }

  return (
    <li
      className={cn("group flex items-center gap-3 rounded-md p-1.5 hover:bg-muted", active && "bg-muted")}
      onClick={() => {
        if (editing) return
        void projects.open(project.id)
        onPicked()
      }}
    >
      <Preview thumb={project.thumb} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={name}
            className="h-6 px-1.5 text-sm"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              if (e.key === "Escape") {
                setName(project.name)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div className="truncate text-sm font-medium">{project.name}</div>
        )}
        <div className="text-xs text-muted-foreground">
          {active ? "Open · " : ""}
          {ago(project.at)}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 aria-expanded:opacity-100" />}
          onClick={(e) => e.stopPropagation()}
          aria-label="Project actions"
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={() => {
              setName(project.name)
              setEditing(true)
            }}
          >
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void projects.duplicate(project.id)}>
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDownload(project.id)}>
            <DownloadIcon />
            Save to file
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void projects.remove(project.id)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

export function ProjectsSheet({
  open,
  onOpenChange,
  projects,
  onNew,
  onDownload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Projects
  onNew: () => void
  onDownload: (id: string) => void
}) {
  const list = projects.current && !projects.list.some((p) => p.id === projects.current!.id) ? [projects.current, ...projects.list] : projects.list
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="gap-2">
        <SheetHeader className="pb-0">
          <SheetTitle>Projects</SheetTitle>
          <SheetDescription>Kept in this browser. Save to file for a copy that survives clearing it.</SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              onNew()
              onOpenChange(false)
            }}
          >
            <PlusIcon />
            New project
          </Button>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4">
          {list.map((p) => (
            <Row
              key={p.id}
              project={p}
              active={p.id === projects.current?.id}
              projects={projects}
              onDownload={onDownload}
              onPicked={() => onOpenChange(false)}
            />
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  )
}
