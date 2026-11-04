import { Logo } from "./Logo"
import { useConfig } from "@/hooks/use-config"
import { CheckIcon, PlayIcon, Star } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Menubar,
  MenubarCheckboxItem as UiCheckboxItem,
  MenubarContent as UiContent,
  MenubarGroup,
  MenubarItem as UiItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem as UiRadioItem,
  MenubarSeparator,
  MenubarShortcut as UiShortcut,
  MenubarSub,
  MenubarSubContent as UiSubContent,
  MenubarSubTrigger as UiSubTrigger,
  MenubarTrigger as UiTrigger,
} from "@/components/ui/menubar"
import type { DotFieldHandle, FieldState } from "@/components/field/DotField"
import type { Example } from "@/schematic/examples"
import { exampleGroups } from "./example-groups"
import type { ProjectMeta } from "@/project/project-store"
import type { Identity } from "@/collab/identity"
import type { LiveStatus } from "@/collab/use-live"
import { Avatar } from "@/components/share/Avatar"
import { Button } from "@/components/ui/button"
import { SPEEDS, formatSpeed } from "@/sim/speeds"
import { TEXT_SCALES } from "@/components/field/text-scale"
import { KEYMAP, labelFor } from "@/lib/keymap"

// A desktop menu is compact: small type, one line per command, a check column on the left
// that every row shares so labels line up, and a shortcut column on the right. The generated
// menu components are sized for touch and to the trigger's width, so each is restyled here.
const DEVELOPERS = ["true_normis", "cerobreath", "andrys1"]

// Below md the same menus are worked with a finger: taller rows, larger type.
const ITEM = "gap-6 rounded-sm py-1 pr-2 pl-6 text-xs whitespace-nowrap max-md:py-2 max-md:text-sm"
const CONTENT = "w-auto min-w-52 max-w-[calc(100vw-1rem)] rounded-md p-1 max-md:max-h-[calc(100dvh-4rem)] max-md:overflow-y-auto"

const MenubarItem = ({ className, ...props }: React.ComponentProps<typeof UiItem>) => (
  <UiItem className={cn(ITEM, className)} {...props} />
)
const MenubarCheckboxItem = ({ className, ...props }: React.ComponentProps<typeof UiCheckboxItem>) => (
  <UiCheckboxItem className={cn(ITEM, className)} {...props} />
)
const MenubarRadioItem = ({ className, ...props }: React.ComponentProps<typeof UiRadioItem>) => (
  <UiRadioItem className={cn(ITEM, className)} {...props} />
)
const MenubarSubTrigger = ({ className, ...props }: React.ComponentProps<typeof UiSubTrigger>) => (
  <UiSubTrigger className={cn(ITEM, className)} {...props} />
)
const MenubarContent = ({ className, ...props }: React.ComponentProps<typeof UiContent>) => (
  <UiContent className={cn(CONTENT, className)} {...props} />
)
const MenubarSubContent = ({ className, ...props }: React.ComponentProps<typeof UiSubContent>) => (
  <UiSubContent className={cn(CONTENT, className)} {...props} />
)
const MenubarShortcut = ({ className, ...props }: React.ComponentProps<typeof UiShortcut>) => (
  <UiShortcut className={cn("pl-2 text-[0.6875rem] tracking-normal tabular-nums", className)} {...props} />
)
const MenubarTrigger = ({ className, ...props }: React.ComponentProps<typeof UiTrigger>) => (
  <UiTrigger className={cn("h-5 px-2 text-xs font-normal max-md:h-8 max-md:px-2 max-md:text-sm max-[359px]:px-1.5", className)} {...props} />
)

type MenuBarProps = React.ComponentProps<"div"> & {
  /** The field this menu drives; null until it mounts. */
  field: React.RefObject<DotFieldHandle | null>
  state: FieldState
  sidebarOpen: boolean
  onSidebarToggle: () => void
  fieldInset: string
  project: string | null
  recent: readonly ProjectMeta[]
  onNew: () => void
  onProjects: () => void
  onOpenProject: (id: string) => void
  onOpenFile: () => void
  onOpenCube: () => void
  onSaveFile: () => void
  onShare: () => void
  onShareDialog: () => void
  onLive: () => void
  people: readonly Identity[]
  live: LiveStatus
  onExportPng: () => void
  onImportHdl: () => void
  onExample: (example: Example) => void
}

/**
 * The window's menu bar, in the desktop tradition: every command the field understands is
 * listed here with its shortcut, so nothing is reachable only by knowing a key.
 */
export function MenuBar({
  field,
  state,
  sidebarOpen,
  onSidebarToggle,
  fieldInset,
  project,
  recent,
  onNew,
  onProjects,
  onOpenProject,
  onOpenFile,
  onOpenCube,
  onSaveFile,
  onShare,
  onShareDialog,
  onLive,
  people,
  live,
  onExportPng,
  onImportHdl,
  onExample,
  className,
  ...props
}: MenuBarProps) {
  const config = useConfig()
  const act = (run: (f: DotFieldHandle) => void) => () => {
    const f = field.current
    if (f) run(f)
  }

  return (
    <div
      data-slot="menu-bar"
      className={cn("relative flex h-7 shrink-0 items-center gap-2 border-b max-md:gap-0 bg-background/80 px-2 backdrop-blur-sm", className)}
      {...props}
    >
      <Logo className="px-1 text-xs max-[359px]:hidden" />
      <Menubar className="h-auto gap-0 rounded-none border-0 bg-transparent p-0">
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            {/* The bar has no room for the project's name on a phone: it heads File instead. */}
            {project && (
              <MenubarGroup className="md:hidden">
                <MenubarLabel className="max-w-64 truncate pl-6 text-xs">{project}</MenubarLabel>
                <MenubarSeparator />
              </MenubarGroup>
            )}
            <MenubarItem onClick={onNew}>New project</MenubarItem>
            <MenubarItem onClick={onProjects}>
              Projects…
              <MenubarShortcut>{labelFor(KEYMAP.projects)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSub>
              <MenubarSubTrigger disabled={recent.length === 0}>Open recent</MenubarSubTrigger>
              <MenubarSubContent className="min-w-44">
                {recent.map((p) => (
                  <MenubarItem key={p.id} onClick={() => onOpenProject(p.id)}>
                    {p.name}
                  </MenubarItem>
                ))}
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarItem onClick={onOpenFile}>
              Open file…
              <MenubarShortcut>{labelFor(KEYMAP.open)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={onOpenCube}>Open STM32 project…</MenubarItem>
            <MenubarItem onClick={onSaveFile} disabled={state.isEmpty}>
              Save to file
              <MenubarShortcut>{labelFor(KEYMAP.save)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={onLive} disabled={state.isEmpty && live === "off"}>
              Live session…
            </MenubarItem>
            <MenubarItem onClick={onShare} disabled={state.isEmpty}>
              Copy share link
            </MenubarItem>
            <MenubarItem onClick={onExportPng} disabled={state.isEmpty}>
              Export image (PNG)
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.newHdl("vhdl"))}>New VHDL component</MenubarItem>
            <MenubarItem onClick={act((f) => f.newHdl("verilog"))}>New Verilog component</MenubarItem>
            <MenubarItem onClick={onImportHdl}>Import VHDL / Verilog…</MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Examples</MenubarSubTrigger>
              {/* Grouped by the board the firmware runs on; ▶ marks the ones that open programmed and running. */}
              <MenubarSubContent className="max-h-[min(36rem,80svh)] min-w-44 overflow-y-auto">
                {exampleGroups().map((group, k) => (
                  <MenubarGroup key={group.title}>
                    {k > 0 && <MenubarSeparator />}
                    <MenubarLabel className="pl-6 text-[0.6875rem]">{group.title}</MenubarLabel>
                    {group.items.map(({ example, ready }) => (
                      <MenubarItem key={example.id} onClick={() => onExample(example)}>
                        <example.icon />
                        {example.name}
                        {ready && (
                          <MenubarShortcut title="Ready to run: opens with its firmware on the board and starts">
                            <PlayIcon className="size-2.5! fill-current" aria-label="ready to run" />
                          </MenubarShortcut>
                        )}
                      </MenubarItem>
                    ))}
                  </MenubarGroup>
                ))}
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={act((f) => f.undo())} disabled={!state.canUndo}>
              Undo
              <MenubarShortcut>{labelFor(KEYMAP.undo)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.redo())} disabled={!state.canRedo}>
              Redo
              <MenubarShortcut>{labelFor(KEYMAP.redo)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.cut())} disabled={!state.hasObjects}>
              Cut
              <MenubarShortcut>{labelFor(KEYMAP.cut)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.copy())} disabled={!state.hasObjects}>
              Copy
              <MenubarShortcut>{labelFor(KEYMAP.copy)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.paste())} disabled={!state.canPaste}>
              Paste
              <MenubarShortcut>{labelFor(KEYMAP.paste)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.duplicate())} disabled={!state.hasObjects}>
              Duplicate
              <MenubarShortcut>{labelFor(KEYMAP.duplicate)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.rotate(45))} disabled={!state.hasObjects}>
              Rotate 45° clockwise
              <MenubarShortcut>{labelFor(KEYMAP.rotate)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.rotate(-45))} disabled={!state.hasObjects}>
              Rotate 45° counter-clockwise
              <MenubarShortcut>{labelFor(KEYMAP.rotateBack)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.flip("horizontal"))} disabled={!state.hasObjects}>
              Mirror horizontally
              <MenubarShortcut>{labelFor(KEYMAP.flipHorizontal)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.flip("vertical"))} disabled={!state.hasObjects}>
              Mirror vertically
              <MenubarShortcut>{labelFor(KEYMAP.flipVertical)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem variant="destructive" onClick={act((f) => f.deleteSelected())} disabled={!state.hasSelection}>
              Delete
              <MenubarShortcut>{labelFor(KEYMAP.remove)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.selectAll())} disabled={state.isEmpty}>
              Select all
              <MenubarShortcut>{labelFor(KEYMAP.selectAll)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.deselectAll())} disabled={!state.hasSelection}>
              Deselect
              <MenubarShortcut>{labelFor(KEYMAP.deselect)}</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarCheckboxItem checked={sidebarOpen} onClick={onSidebarToggle}>
              Components sidebar
              <MenubarShortcut>{labelFor(KEYMAP.sidebar)}</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.code} onClick={act((f) => f.toggleCode())}>
              Code editor
              <MenubarShortcut>{labelFor(KEYMAP.code)}</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.zoomIn())}>
              Zoom in
              <MenubarShortcut>{labelFor(KEYMAP.zoomIn)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.zoomOut())}>
              Zoom out
              <MenubarShortcut>{labelFor(KEYMAP.zoomOut)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.resetView())}>
              Reset view
              <MenubarShortcut>{labelFor(KEYMAP.zoomReset)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Schematic text size</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value={String(state.textScale)}>
                  {TEXT_SCALES.map((scale) => (
                    <MenubarRadioItem key={scale} value={String(scale)} onClick={act((f) => f.setTextScale(scale))}>
                      <span className="tabular-nums">{Math.round(scale * 100)}%</span>
                    </MenubarRadioItem>
                  ))}
                </MenubarRadioGroup>
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Simulate</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={act((f) => f.toggleRun())} disabled={state.isEmpty}>
              {state.running ? "Pause" : "Run"}
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.restart())} disabled={!state.started}>
              Start over from 0 s
            </MenubarItem>
            <MenubarSeparator />
            <MenubarCheckboxItem checked={state.probing} onClick={act((f) => f.toggleProbe())}>
              Probe two points
              <MenubarShortcut>{labelFor(KEYMAP.measure)}</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.scope} onClick={act((f) => f.toggleScope())}>
              Oscilloscope
              <MenubarShortcut>{labelFor(KEYMAP.scope)}</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.logic} onClick={act((f) => f.toggleLogic())}>
              Logic analyser
              <MenubarShortcut>{labelFor(KEYMAP.logic)}</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Speed</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarRadioGroup value={String(state.speed)}>
                  {SPEEDS.map((s) => (
                    <MenubarRadioItem key={s.value} value={String(s.value)} onClick={act((f) => f.setSpeed(s.value))}>
                      <span className="w-9 shrink-0 tabular-nums text-muted-foreground">{formatSpeed(s.value)}</span>
                      {s.label}
                    </MenubarRadioItem>
                  ))}
                </MenubarRadioGroup>
                {/* A speed dragged on the slider is not one of the presets; say so rather than show no mark. */}
                {!SPEEDS.some((s) => s.value === state.speed) && (
                  <>
                    <MenubarSeparator />
                    <MenubarItem disabled>
                      <CheckIcon />
                      {formatSpeed(state.speed)}
                    </MenubarItem>
                  </>
                )}
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>Help</MenubarTrigger>
          <MenubarContent>
            <MenubarItem closeOnClick={false}>
              Version
              <MenubarShortcut className="text-foreground">{config.version}</MenubarShortcut>
            </MenubarItem>
            {DEVELOPERS.map((handle) => (
              <MenubarItem key={handle} render={<a href={`https://t.me/${handle}`} target="_blank" rel="noreferrer" />}>
                Developer
                <MenubarShortcut>@{handle}</MenubarShortcut>
              </MenubarItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      {project && (
        <button
          type="button"
          onClick={onProjects}
          title="Projects"
          className="absolute top-1/2 max-w-80 -translate-x-1/2 max-md:hidden max-lg:max-w-40 -translate-y-1/2 truncate rounded-sm px-2 text-xs text-muted-foreground transition-[left] duration-200 ease-linear hover:bg-accent hover:text-foreground"
          style={{ left: `calc(50% + ${fieldInset} / 2)` }}
        >
          {project}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        {live !== "off" && (
          <button type="button" onClick={onShareDialog} className="flex items-center -space-x-1.5" title="Live session">
            {live !== "live" && <span className="mr-2.5 size-1.5 animate-pulse rounded-full bg-amber-500" />}
            {people.slice(0, 5).map((p, i) => (
              <Avatar key={i} who={p} className="size-5 text-xs" />
            ))}
            {people.length > 5 && <span className="pl-2.5 text-xs text-muted-foreground">+{people.length - 5}</span>}
          </button>
        )}
        <Button
          size="xs"
          variant="ghost"
          nativeButton={false}
          className="h-5 gap-1 text-muted-foreground hover:text-foreground max-md:hidden"
          render={
            <a
              href="https://github.com/ChernihivPolytechnicNationalUniversity/emul"
              target="_blank"
              rel="noreferrer"
              title="Star εmul on GitHub"
            />
          }
        >
          <Star className="size-3 fill-amber-400 text-amber-400" />
          <span className="hidden lg:inline">Star on GitHub</span>
        </Button>
        <Button size="xs" className="h-5 max-md:h-7" onClick={onShareDialog}>
          Share
        </Button>
      </div>
    </div>
  )
}
