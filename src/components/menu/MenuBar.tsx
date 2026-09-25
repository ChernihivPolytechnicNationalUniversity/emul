import { Logo } from "./Logo"
import { useConfig } from "@/hooks/use-config"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Menubar,
  MenubarCheckboxItem as UiCheckboxItem,
  MenubarContent as UiContent,
  MenubarItem as UiItem,
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
import { examples, type Example } from "@/schematic/examples"
import { SPEEDS, formatSpeed } from "@/sim/speeds"

// A desktop menu is compact: small type, one line per command, a check column on the left
// that every row shares so labels line up, and a shortcut column on the right. The generated
// menu components are sized for touch and to the trigger's width, so each is restyled here.
const DEVELOPERS = ["true_normis", "cerobreath", "andrys1"]

const ITEM = "gap-6 rounded-sm py-1 pr-2 pl-6 text-xs whitespace-nowrap"
const CONTENT = "w-auto min-w-52 rounded-md p-1"

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
  <UiTrigger className={cn("h-5 px-2 text-xs font-normal", className)} {...props} />
)

type MenuBarProps = React.ComponentProps<"div"> & {
  /** The field this menu drives; null until it mounts. */
  field: React.RefObject<DotFieldHandle | null>
  state: FieldState
  sidebarOpen: boolean
  onSidebarToggle: () => void
  onOpenFile: () => void
  onSaveFile: () => void
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
  onOpenFile,
  onSaveFile,
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
      className={cn("flex h-7 shrink-0 items-center gap-2 border-b bg-background/80 px-2 backdrop-blur-sm", className)}
      {...props}
    >
      <Logo className="px-1 text-xs" />
      <Menubar className="h-auto gap-0 rounded-none border-0 bg-transparent p-0">
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={act((f) => f.clear())} disabled={state.isEmpty}>
              New
            </MenubarItem>
            <MenubarItem onClick={onOpenFile}>
              Open…
              <MenubarShortcut>⌘O</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={onSaveFile} disabled={state.isEmpty}>
              Save
              <MenubarShortcut>⌘S</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.newHdl("vhdl"))}>New VHDL component</MenubarItem>
            <MenubarItem onClick={act((f) => f.newHdl("verilog"))}>New Verilog component</MenubarItem>
            <MenubarItem onClick={onImportHdl}>Import VHDL / Verilog…</MenubarItem>
            <MenubarSeparator />
            <MenubarSub>
              <MenubarSubTrigger>Examples</MenubarSubTrigger>
              <MenubarSubContent className="min-w-44">
                {examples.map((example) => (
                  <MenubarItem key={example.id} onClick={() => onExample(example)}>
                    <example.icon />
                    {example.name}
                  </MenubarItem>
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
              <MenubarShortcut>⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.redo())} disabled={!state.canRedo}>
              Redo
              <MenubarShortcut>⇧⌘Z</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.cut())} disabled={!state.hasObjects}>
              Cut
              <MenubarShortcut>⌘X</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.copy())} disabled={!state.hasObjects}>
              Copy
              <MenubarShortcut>⌘C</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.paste())} disabled={!state.canPaste}>
              Paste
              <MenubarShortcut>⌘V</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.duplicate())} disabled={!state.hasObjects}>
              Duplicate
              <MenubarShortcut>⌘D</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.rotate(45))} disabled={!state.hasObjects}>
              Rotate 45° clockwise
              <MenubarShortcut>R</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.rotate(-45))} disabled={!state.hasObjects}>
              Rotate 45° counter-clockwise
              <MenubarShortcut>⇧R</MenubarShortcut>
            </MenubarItem>
            <MenubarItem variant="destructive" onClick={act((f) => f.deleteSelected())} disabled={!state.hasSelection}>
              Delete
              <MenubarShortcut>Del</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.selectAll())} disabled={state.isEmpty}>
              Select all
              <MenubarShortcut>⌘A</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.deselectAll())} disabled={!state.hasSelection}>
              Deselect
              <MenubarShortcut>Esc</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>

        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarCheckboxItem checked={sidebarOpen} onClick={onSidebarToggle}>
              Components sidebar
              <MenubarShortcut>⌘B</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.code} onClick={act((f) => f.toggleCode())}>
              Code editor
              <MenubarShortcut>⌘J</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarSeparator />
            <MenubarItem onClick={act((f) => f.zoomIn())}>
              Zoom in
              <MenubarShortcut>⌘+</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.zoomOut())}>
              Zoom out
              <MenubarShortcut>⌘−</MenubarShortcut>
            </MenubarItem>
            <MenubarItem onClick={act((f) => f.resetView())}>
              Reset view
              <MenubarShortcut>⌘0</MenubarShortcut>
            </MenubarItem>
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
              <MenubarShortcut>M</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.scope} onClick={act((f) => f.toggleScope())}>
              Oscilloscope
              <MenubarShortcut>O</MenubarShortcut>
            </MenubarCheckboxItem>
            <MenubarCheckboxItem checked={state.logic} onClick={act((f) => f.toggleLogic())}>
              Logic analyser
              <MenubarShortcut>L</MenubarShortcut>
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
    </div>
  )
}
