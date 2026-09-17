import * as React from "react"
import { toast } from "sonner"
import { DotField, type DotFieldHandle, type FieldState } from "@/components/field/DotField"
import { MenuBar } from "@/components/menu/MenuBar"
import { GRID } from "@/schematic/geometry"
import { ComponentsSidebar } from "@/components/palette/ComponentsSidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Example } from "@/schematic/examples"
import type { Schematic } from "@/schematic/types"

/** Height of the menu bar; the sidebar is fixed, so it has to be told to start below it. */
const MENU_H = 28

const emptyState: FieldState = {
  hasSelection: false,
  hasObjects: false,
  isEmpty: true,
  canUndo: false,
  canRedo: false,
  canPaste: false,
  running: false,
  started: false,
  speed: 1,
  probing: false,
  scope: false,
  logic: false,
  code: false,
}

/** A schematic is plain JSON, but a file picked off disk is not to be trusted with that. */
function isSchematic(doc: unknown): doc is Schematic {
  const d = doc as Schematic
  return !!d && Array.isArray(d.objects) && Array.isArray(d.wires)
}

export default function App() {
  const field = React.useRef<DotFieldHandle>(null)
  const [state, setState] = React.useState<FieldState>(emptyState)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const fileInput = React.useRef<HTMLInputElement>(null)

  const save = React.useCallback(() => {
    const doc = field.current?.doc()
    if (!doc) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }))
    const a = document.createElement("a")
    a.href = url
    a.download = "schematic.json"
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  const open = React.useCallback(() => fileInput.current?.click(), [])

  /**
   * An example with code hands each board its sources and opens the editor on it: the program
   * is the student's to read and compile, no image comes ready-made.
   */
  const loadExample = async (example: Example) => {
    const doc = example.build(GRID)
    for (const p of example.projects ?? []) {
      const board = doc.objects.find((o) => o.props?.ref === p.ref)
      if (!board) continue
      try {
        board.project = await p.load()
      } catch (e) {
        toast.error("Could not load the example's code", { description: `${p.ref}: ${(e as Error).message}` })
      }
    }
    field.current?.load(doc)
    if (example.projects?.length) field.current?.openCode(example.projects[0]!.ref)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset first: picking the same file twice in a row has to fire the change again.
    e.target.value = ""
    if (!file) return
    try {
      const doc: unknown = JSON.parse(await file.text())
      if (!isSchematic(doc)) throw new Error("not a schematic")
      field.current?.load(doc)
    } catch {
      toast.error("Could not open that file", { description: `${file.name} is not a schematic.` })
    }
  }

  // ⌘S and ⌘O belong to the browser until we take them.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key !== "s" && key !== "o") return
      e.preventDefault()
      if (key === "s") save()
      else open()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [save, open])

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <MenuBar
          field={field}
          state={state}
          sidebarOpen={sidebarOpen}
          onSidebarToggle={() => setSidebarOpen((v) => !v)}
          onOpenFile={open}
          onSaveFile={save}
          onExample={(example) => void loadExample(example)}
          style={{ height: MENU_H }}
        />
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} style={{ minHeight: 0, flex: 1 }}>
          <ComponentsSidebar
            onPick={(item) => field.current?.addAtCenter(item.id)}
            style={{ top: MENU_H, height: `calc(100svh - ${MENU_H}px)` }}
          />
          <SidebarInset className="relative min-h-0 flex-1 overflow-hidden">
            <SidebarTrigger className="absolute top-3 left-3 z-10" />
            <DotField ref={field} onStateChange={setState} />
          </SidebarInset>
        </SidebarProvider>
      </div>
      <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
      <Toaster position="bottom-center" richColors />
    </TooltipProvider>
  )
}
