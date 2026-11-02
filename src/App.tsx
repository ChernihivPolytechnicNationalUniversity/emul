import * as React from "react"
import { toast } from "sonner"
import { DotField, type DotFieldHandle, type FieldState } from "@/components/field/DotField"
import { DEFAULT_TEXT_SCALE } from "@/components/field/text-scale"
import { MenuBar } from "@/components/menu/MenuBar"
import { GRID } from "@/schematic/geometry"
import { ComponentsSidebar } from "@/components/palette/ComponentsSidebar"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { exampleBySlug, showcase, type Example } from "@/schematic/examples"
import { exampleBench, programExample } from "@/project/prebuilt"
import type { Schematic } from "@/schematic/types"
import { HDL_ACCEPT, readHdlFiles } from "@/components/hdl/files"
import { useEvent } from "@/hooks/use-event"
import { useIsMobile } from "@/hooks/use-mobile"
import { announceUpgrade, useProjects } from "@/hooks/use-projects"
import { fileName, nameFromFile, projectFile, readProjectFile, shareLink } from "@/project/project-store"
import { cubeBench, importNotes, readCubeProject, unsupportedChip, type ProjectEntry } from "@/project/cubemx"
import { dropEntries, filesEntries, isProjectDrop, isZip, pickFolder } from "@/project/entries"
import { downloadBlob } from "@/lib/download"
import { Button } from "@/components/ui/button"
import { ProjectsSheet } from "@/components/projects/ProjectsSheet"
import { hostedRoom, roomFromPath, useLive } from "@/collab/use-live"
import { LiveCursors } from "@/components/share/LiveCursors"
import { ShareDialog } from "@/components/share/ShareDialog"

/** Height of the menu bar; the sidebar is fixed, so it has to be told to start below it. */
const MENU_H = 28
const SIDEBAR_WIDTH = "16rem"

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
  textScale: DEFAULT_TEXT_SCALE,
  probing: false,
  scope: false,
  logic: false,
  code: false,
}

export default function App() {
  const field = React.useRef<DotFieldHandle>(null)
  const [state, setState] = React.useState<FieldState>(emptyState)
  const [sidebarOpen, setSidebarOpen] = React.useState(true)
  const isMobile = useIsMobile()
  const fileInput = React.useRef<HTMLInputElement>(null)
  /** Set while an example that came programmed is on its way to the field: it starts once loaded. */
  const autorun = React.useRef(false)
  const onLoad = React.useCallback((doc: Schematic) => {
    field.current?.load(doc)
    if (!autorun.current) return
    autorun.current = false
    field.current?.restart()
  }, [])
  /**
   * An example as a project: its bench, its boards' sources, and the images prebuilt from them
   * (src/project/prebuilt.ts). Programmed, it runs as soon as it is on the field; a board the
   * images do not cover waits for Compile, with its code open.
   */
  const benchOf = React.useCallback(async (example: Example) => {
    const { doc, boards, errors } = await exampleBench(example, GRID)
    for (const e of errors) toast.error("Could not load the example's code", { description: e })
    const programmed = await programExample(example.id, boards)
    autorun.current = programmed
    return { name: example.name, doc, programmed, code: example.projects?.[0]?.ref }
  }, [])
  /** What a visit opens when it brings no project of its own: the example a link names, else the showcase. */
  const landing = React.useCallback(
    async (slug: string | null) => {
      const example = slug === null ? showcase : exampleBySlug(slug)
      if (!example) {
        toast(`There is no example “${slug}”`, { description: "Pick one from File → Examples." })
        return null
      }
      const { name, doc } = await benchOf(example)
      return { name, doc }
    },
    [benchOf],
  )
  const store = useProjects(onLoad, landing)
  const live = useLive(React.useCallback((doc: Schematic) => field.current?.merge(doc), []))
  const projects = React.useMemo(
    () => ({
      ...store,
      open: async (id: string) => {
        if (id !== store.current?.id) live.leave()
        await store.open(id)
      },
      create: async (name: string, doc?: Schematic) => {
        live.leave()
        await store.create(name, doc)
      },
      remove: async (id: string) => {
        if (id === store.current?.id) live.leave()
        await store.remove(id)
      },
    }),
    [store, live],
  )
  const ghosts = React.useMemo(
    () => live.peers.flatMap((p) => (p.moving ? [{ key: p.clientId, color: p.color, ...p.moving }] : [])),
    [live.peers],
  )
  const [projectsOpen, setProjectsOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)

  const startLive = async () => {
    const doc = field.current?.doc()
    if (!doc) return
    try {
      await live.start(projects.current?.name ?? "Live bench", doc)
    } catch (e) {
      toast.error("Could not start a live session", { description: (e as Error).message })
      return live.leave()
    }
    const link = live.linkFor()
    if (link) await navigator.clipboard.writeText(link).then(() => toast.success("Live session started", { description: "Link copied: send it to whoever joins." }), () => {})
  }

  const { onChange: storeChange } = store
  const { onChange: liveChange } = live
  const onFieldChange = React.useCallback(
    (doc: Schematic) => {
      storeChange(doc)
      liveChange(doc)
    },
    [storeChange, liveChange],
  )

  const autoJoined = React.useRef(false)
  const joinLive = useEvent(async () => {
    const room = roomFromPath()
    if (room) {
      const got = await live.join(room).catch(() => null)
      if (!got) {
        history.replaceState(null, "", "/")
        return void toast.error("That live session is not there", { description: "It has ended, or the link is cut short." })
      }
      await store.visit(got.name, got.doc)
      return
    }
    const hosted = hostedRoom()
    const doc = field.current?.doc()
    if (hosted && doc) await live.start(store.current?.name ?? "Live bench", doc).catch(() => live.leave())
  })
  React.useEffect(() => {
    if (!store.ready || autoJoined.current) return
    autoJoined.current = true
    void joinLive()
  }, [store.ready, joinLive])
  const hdlInput = React.useRef<HTMLInputElement>(null)
  const importHdl = React.useCallback(() => hdlInput.current?.click(), [])
  const onHdlFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!list.length) return
    const files = await readHdlFiles(list)
    if (!files.length) {
      toast.error("Nothing to import", { description: "Pick .vhd, .vhdl, .v or .sv files." })
      return
    }
    field.current?.importHdl(files)
  }

  const download = async (name: string, doc: Schematic) => downloadBlob(await projectFile(name, doc), fileName(name))

  const share = async () => {
    const doc = field.current?.doc()
    if (!doc) return
    const pending = toast.loading("Making a link…")
    let url: string
    try {
      url = await shareLink(projects.current?.name ?? "Shared bench", doc)
    } catch (e) {
      toast.error("Could not make a link", { description: (e as Error).message })
      return
    } finally {
      toast.dismiss(pending)
    }
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied", { description: url })
    } catch {
      toast("Share link", { description: url, action: { label: "Copy", onClick: () => void navigator.clipboard.writeText(url) } })
    }
  }

  const exportImage = async () => {
    const png = await field.current?.exportPng()
    if (!png) return void toast.error("Could not draw the bench")
    downloadBlob(png, fileName(projects.current?.name ?? "bench").replace(/\.emul$/, ".png"))
  }

  const save = () => {
    const doc = field.current?.doc()
    if (doc) void download(projects.current?.name ?? "bench", doc)
  }

  const downloadProject = async (id: string) => {
    const p = await projects.read(id)
    if (p) await download(p.meta.name, p.doc)
  }

  const newProject = () => void projects.create("Untitled")

  const open = React.useCallback(() => fileInput.current?.click(), [])

  /**
   * An example with code comes programmed and running, its sources on the boards for reading
   * and changing (Compile then builds them as usual). One whose images are missing opens on
   * its code, for Compile.
   */
  const loadExample = async (example: Example) => {
    const { name, doc, programmed, code } = await benchOf(example)
    await projects.create(name, doc)
    autorun.current = false
    if (!code) return
    if (!programmed) return field.current?.openCode(code)
    toast(`${example.name} is running`, {
      description: "Its firmware came ready-built. Open the code to read or change it; Compile builds your version.",
      action: { label: "Open code", onClick: () => field.current?.openCode(code) },
    })
  }

  const openCubeProject = async (entries: Promise<ProjectEntry[]>) => {
    const pending = toast.loading("Reading project…")
    let project
    try {
      project = await readCubeProject(await entries)
    } catch (e) {
      toast.error("Cannot open project", { description: (e as Error).message })
      return
    } finally {
      toast.dismiss(pending)
    }
    const { target } = project
    if (!target) return void toast.error(unsupportedChip(project).title, { description: unsupportedChip(project).description })
    const { doc, board } = cubeBench({ ...project, target }, GRID)
    await projects.create(project.name, doc)
    field.current?.openCode(board.props!.ref!)
    toast.success(`Opened ${project.name}`, { description: [`${project.files.length} files.`, ...importNotes(project, target)].join(" ") })
  }

  const openCubeFolder = async () => {
    const files = await pickFolder()
    if (files.length) await openCubeProject(filesEntries(files))
  }

  const openFile = async (file: File) => {
    if (isZip(file)) return openCubeProject(filesEntries([file]))
    const read = await readProjectFile(file)
    if (!read) {
      toast.error("Cannot open file", { description: `${file.name}: not an .emul project or a zipped STM32 project.` })
      return
    }
    await projects.create(read.name ?? nameFromFile(file.name), read.doc)
    announceUpgrade(read.notes)
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset first: picking the same file twice in a row has to fire the change again.
    e.target.value = ""
    if (file) await openFile(file)
  }

  const onDropFiles = useEvent(async (list: File[]) => {
    const project = list.find((f) => /\.emul$/i.test(f.name))
    if (project) return openFile(project)
    const hdl = await readHdlFiles(list)
    if (hdl.length) return field.current?.importHdl(hdl)
    toast.error("Nothing to open", { description: "Drop an .emul file, an STM32 project folder or .zip, or .vhd/.v files." })
  })

  const onDropProject = useEvent((entries: Promise<ProjectEntry[]>) => openCubeProject(entries))

  React.useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = "copy"
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (isProjectDrop(e.dataTransfer!)) void onDropProject(dropEntries(e.dataTransfer!))
      else void onDropFiles(Array.from(e.dataTransfer!.files))
    }
    window.addEventListener("dragover", onOver)
    window.addEventListener("drop", onDrop)
    return () => {
      window.removeEventListener("dragover", onOver)
      window.removeEventListener("drop", onDrop)
    }
  }, [onDropFiles, onDropProject])

  // ⌘S and ⌘O belong to the browser until we take them.
  const onKey = useEvent((e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    const key = e.key.toLowerCase()
    if (key !== "s" && key !== "o") return
    e.preventDefault()
    if (key === "s") save()
    else if (e.shiftKey) setProjectsOpen(true)
    else open()
  })
  React.useEffect(() => {
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onKey])

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <MenuBar
          field={field}
          state={state}
          sidebarOpen={sidebarOpen}
          onSidebarToggle={() => setSidebarOpen((v) => !v)}
          fieldInset={sidebarOpen && !isMobile ? SIDEBAR_WIDTH : "0px"}
          project={projects.current?.name ?? null}
          recent={projects.list.filter((p) => p.id !== projects.current?.id).slice(0, 8)}
          onNew={newProject}
          onProjects={() => setProjectsOpen(true)}
          onOpenProject={(id) => void projects.open(id)}
          onOpenFile={open}
          onOpenCube={() => void openCubeFolder()}
          onSaveFile={save}
          onShare={() => void share()}
          onShareDialog={() => setShareOpen(true)}
          onLive={() => setShareOpen(true)}
          people={live.room ? [live.me, ...live.peers] : []}
          live={live.status}
          onExportPng={() => void exportImage()}
          onImportHdl={importHdl}
          onExample={(example) => void loadExample(example)}
          style={{ height: MENU_H }}
        />
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen} style={{ minHeight: 0, flex: 1, "--sidebar-width": SIDEBAR_WIDTH } as React.CSSProperties}>
          <ComponentsSidebar
            onPick={(item) => field.current?.addAtCenter(item.id)}
            onHdlNew={(language) => field.current?.newHdl(language)}
            onHdlImport={importHdl}
            onHdlOpen={(id) => field.current?.openHdl(id)}
            style={{ top: MENU_H, height: `calc(100svh - ${MENU_H}px)` }}
          />
          <SidebarInset className="relative min-h-0 flex-1 overflow-hidden">
            <SidebarTrigger className="absolute top-3 left-3 z-10" />
            {projects.shared && (
              <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border bg-background/95 py-1 pr-1 pl-3 text-xs shadow-sm backdrop-blur-sm">
                <span className="text-muted-foreground">
                  {live.room ? "Live session: your edits reach everyone. Keep your own copy too?" : "Opened from a link: changes are not kept until you save it."}
                </span>
                <Button size="xs" onClick={() => void projects.keep(field.current?.doc() ?? { objects: [], wires: [], parts: {} })}>
                  Save to my projects
                </Button>
              </div>
            )}
            <DotField ref={field} onChange={onFieldChange} onStateChange={setState} onPointerWorld={live.onPointer}
              onMovePreview={live.onMove}
              onWirePreview={live.onWire}
              ghosts={ghosts}
              projectName={projects.current?.name}
            >
              <LiveCursors peers={live.peers} />
            </DotField>
          </SidebarInset>
        </SidebarProvider>
      </div>
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        live={live}
        empty={state.isEmpty}
        onStart={() => void startLive()}
        onCopyLink={() => void share()}
        onExportPng={() => void exportImage()}
      />
      <ProjectsSheet open={projectsOpen} onOpenChange={setProjectsOpen} projects={projects} onNew={newProject} onDownload={(id) => void downloadProject(id)} />
      <input ref={fileInput} type="file" accept=".emul,.zip" className="hidden" onChange={onFile} />
      <input ref={hdlInput} type="file" multiple accept={HDL_ACCEPT} className="hidden" onChange={onHdlFiles} />
      <Toaster position="bottom-center" richColors />
    </TooltipProvider>
  )
}
