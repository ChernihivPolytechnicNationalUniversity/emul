import * as React from "react"
import { toast } from "sonner"
import { ChevronRightIcon, CopyMinusIcon, FileCodeIcon, FileIcon, FilePlusIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon } from "lucide-react"
import type { SourceFile } from "emul-shared/source"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"

type ExplorerProps = React.ComponentProps<"div"> & {
  files: SourceFile[]
  active: string | null
  onOpen: (path: string) => void
  /** Each may throw with a message for a toast (a bad path, a name taken). */
  onCreate: (rawPath: string) => void
  onRename: (path: string, rawTo: string, folder: boolean) => void
  onRemove: (path: string) => void
}

/** A row of the tree; folders are implied by the paths, so one with children is a folder. */
type Node = { name: string; path: string; children?: Node[] }

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const within = (path: string, dir: string) => dir === "" || path === dir || path.startsWith(dir + "/")
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/

/**
 * Folders first, then files, each alphabetical: the order VS Code shows. `extra` are folders
 * with no file in them yet (just made), which the paths alone could not tell.
 */
function tree(files: SourceFile[], extra: Iterable<string>): Node[] {
  const root: Node = { name: "", path: "", children: [] }
  const folder = (path: string): Node => {
    if (path === "") return root
    const parent = folder(parentOf(path))
    let node = parent.children!.find((n) => n.path === path && n.children)
    if (!node) {
      node = { name: nameOf(path), path, children: [] }
      parent.children!.push(node)
    }
    return node
  }
  for (const f of files) folder(parentOf(f.path)).children!.push({ name: nameOf(f.path), path: f.path })
  for (const dir of extra) folder(dir)
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name, "en"))
    for (const n of nodes) if (n.children) sort(n.children)
  }
  sort(root.children!)
  return root.children!
}

/** The rows as shown, top to bottom, for the keyboard to walk. */
function visible(nodes: Node[], collapsed: ReadonlySet<string>, out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n)
    if (n.children && !collapsed.has(n.path)) visible(n.children, collapsed, out)
  }
  return out
}

const CODE = /\.(c|h|cpp|hpp|cc|s)$/i

function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const Icon = CODE.test(name) ? FileCodeIcon : FileIcon
  return <Icon className={cn("size-3.5 shrink-0", CODE.test(name) ? "text-sky-600" : "text-muted-foreground", className)} />
}

/** What the tree is editing in place: a name for a new file or folder under a folder, or a node's new name. */
type Editing = { kind: "new-file" | "new-folder"; dir: string } | { kind: "rename"; path: string; folder: boolean }

const DRAG_TYPE = "application/x-emul-path"
type Dragged = { path: string; folder: boolean }

/**
 * The project's files as a tree, in the manner of VS Code's explorer: click to open, arrows to
 * walk, F2/Delete on the row, names edited in place, drag a file or folder into another folder,
 * right-click for the rest. Folders exist only as path prefixes: an empty one made here lives
 * until a file lands in it or the board changes.
 */
export function Explorer({ files, active, onOpen, onCreate, onRename, onRemove, className, ...props }: ExplorerProps) {
  const [emptyFolders, setEmptyFolders] = React.useState<Set<string>>(() => new Set())
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set())
  const [editing, setEditing] = React.useState<Editing | null>(null)
  /** The row the keyboard is on; the active file when nothing else has been walked to. */
  const [focused, setFocused] = React.useState<string | null>(null)
  const [dropDir, setDropDir] = React.useState<string | null>(null)
  /** The row the context menu was opened on; null for the empty space below the tree. */
  const target = React.useRef<Node | null>(null)
  const [menuNode, setMenuNode] = React.useState<Node | null>(null)

  // A folder made here counts as empty only while no file is in it.
  const folders = React.useMemo(() => [...emptyFolders].filter((d) => !files.some((f) => f.path.startsWith(d + "/"))), [emptyFolders, files])
  const nodes = React.useMemo(() => tree(files, folders), [files, folders])
  const rows = React.useMemo(() => visible(nodes, collapsed), [nodes, collapsed])
  const cursor = focused ?? active
  const cursorNode = rows.find((n) => n.path === cursor)
  /** Where a new file or folder goes from the header buttons: the folder on the cursor, or the cursor's. */
  const cursorDir = cursorNode ? (cursorNode.children ? cursorNode.path : parentOf(cursorNode.path)) : ""

  const expand = (dir: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      // Every folder on the way down opens, or the row would be out of sight.
      dir.split("/").forEach((_, i, parts) => next.delete(parts.slice(0, i + 1).join("/")))
      return next
    })
  const toggle = (path: string, open?: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (open ?? next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const collapseAll = () => setCollapsed(new Set(rows.filter((n) => n.children).map((n) => n.path)))

  const startNew = (kind: "new-file" | "new-folder", dir: string) => {
    expand(dir)
    setEditing({ kind, dir })
  }
  const pick = (node: Node) => {
    setFocused(node.path)
    if (node.children) toggle(node.path)
    else onOpen(node.path)
  }

  const attempt = (title: string, fn: () => void) => {
    try {
      fn()
    } catch (e) {
      toast.error(title, { description: (e as Error).message })
    }
  }
  const commit = (edit: Editing, name: string) => {
    setEditing(null)
    const trimmed = name.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
    if (!trimmed) return
    const dir = edit.kind === "rename" ? parentOf(edit.path) : edit.dir
    const full = dir ? `${dir}/${trimmed}` : trimmed
    if (edit.kind === "rename") attempt("Could not rename", () => onRename(edit.path, full, edit.folder))
    else if (edit.kind === "new-file") attempt("Could not create the file", () => onCreate(full))
    else {
      if (!FOLDER_NAME.test(trimmed)) {
        toast.error("Could not create the folder", { description: `"${trimmed}" is not a folder name (letters, digits, . _ -)` })
        return
      }
      setEmptyFolders((s) => new Set(s).add(full))
      expand(full)
      setFocused(full)
    }
  }
  const remove = (node: Node) => {
    if (node.children && !files.some((f) => f.path.startsWith(node.path + "/"))) {
      setEmptyFolders((s) => {
        const next = new Set(s)
        next.delete(node.path)
        return next
      })
      return
    }
    onRemove(node.path)
  }
  /** Drop a node into a folder: the same rename, with the name kept. */
  const move = (dragged: Dragged, dir: string) => {
    if (parentOf(dragged.path) === dir || (dragged.folder && within(dir, dragged.path))) return
    const to = dir ? `${dir}/${nameOf(dragged.path)}` : nameOf(dragged.path)
    attempt("Could not move", () => onRename(dragged.path, to, dragged.folder))
    expand(dir)
  }
  const dragged = (e: React.DragEvent): Dragged | null => {
    try {
      return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as Dragged
    } catch {
      return null
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return
    const i = rows.findIndex((n) => n.path === cursor)
    const node = rows[i]
    const step = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))]
      if (next) setFocused(next.path)
    }
    switch (e.key) {
      case "ArrowDown":
        step(i < 0 ? 0 : i + 1)
        break
      case "ArrowUp":
        step(i < 0 ? 0 : i - 1)
        break
      case "ArrowRight":
        if (!node?.children) return
        if (collapsed.has(node.path)) toggle(node.path, true)
        else step(i + 1)
        break
      case "ArrowLeft":
        if (node?.children && !collapsed.has(node.path)) toggle(node.path, false)
        else if (node && parentOf(node.path)) setFocused(parentOf(node.path))
        break
      case "Home":
        step(0)
        break
      case "End":
        step(rows.length - 1)
        break
      case "Enter":
      case " ":
        if (node) pick(node)
        break
      case "F2":
        if (node) setEditing({ kind: "rename", path: node.path, folder: !!node.children })
        break
      case "Delete":
        if (node) remove(node)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const renderNode = (node: Node, depth: number): React.ReactNode => {
    const folder = !!node.children
    const open = folder && !collapsed.has(node.path)
    const renaming = editing?.kind === "rename" && editing.path === node.path
    const adding = editing && editing.kind !== "rename" && editing.dir === node.path && folder
    const dropTarget = folder ? node.path : parentOf(node.path)
    return (
      <React.Fragment key={node.path}>
        <div
          role="treeitem"
          aria-selected={node.path === active}
          aria-expanded={folder ? open : undefined}
          draggable={!renaming}
          className={cn(
            "flex h-6 cursor-default items-center gap-1 pr-2 text-xs select-none hover:bg-accent/60",
            node.path === active && "bg-accent text-accent-foreground",
            (node.path === cursor || menuNode?.path === node.path) && "ring-1 ring-inset ring-ring",
            dropDir === node.path && "bg-primary/15",
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => pick(node)}
          onDoubleClick={() => !folder && setEditing({ kind: "rename", path: node.path, folder: false })}
          onContextMenu={() => (target.current = node)}
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ path: node.path, folder } satisfies Dragged))
            e.dataTransfer.effectAllowed = "move"
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = "move"
            setDropDir(dropTarget)
          }}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropDir(null)
            const d = dragged(e)
            if (d) move(d, dropTarget)
          }}
        >
          {folder ? (
            <>
              <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
              {open ? <FolderOpenIcon className="size-3.5 shrink-0 text-amber-600" /> : <FolderIcon className="size-3.5 shrink-0 text-amber-600" />}
            </>
          ) : (
            <FileTypeIcon name={node.name} className="ml-[1.125rem]" />
          )}
          {renaming ? (
            <NameInput initial={node.name} onDone={(v) => commit(editing, v)} onCancel={() => setEditing(null)} />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </div>
        {adding && <NewRow kind={editing.kind} depth={depth + 1} onDone={(v) => commit(editing, v)} onCancel={() => setEditing(null)} />}
        {open && node.children!.map((c) => renderNode(c, depth + 1))}
      </React.Fragment>
    )
  }

  const menuDir = menuNode ? (menuNode.children ? menuNode.path : parentOf(menuNode.path)) : ""

  return (
    <div data-slot="explorer" className={cn("flex min-h-0 flex-col bg-sidebar text-sidebar-foreground", className)} {...props}>
      <div className="flex h-8 shrink-0 items-center gap-0.5 pr-1 pl-3">
        <span className="flex-1 truncate text-[0.6875rem] font-medium tracking-wider text-muted-foreground uppercase">Explorer</span>
        <Button variant="ghost" size="icon-xs" aria-label="New file" title="New file" onClick={() => startNew("new-file", cursorDir)}>
          <FilePlusIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="New folder" title="New folder" onClick={() => startNew("new-folder", cursorDir)}>
          <FolderPlusIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Collapse all" title="Collapse all" onClick={collapseAll}>
          <CopyMinusIcon />
        </Button>
      </div>
      <ContextMenu
        onOpenChange={(open) => {
          setMenuNode(open ? target.current : null)
          if (!open) target.current = null
        }}
      >
        <ContextMenuTrigger
          role="tree"
          tabIndex={0}
          className={cn("min-h-0 flex-1 overflow-auto py-1 outline-none", dropDir === "" && "bg-primary/10")}
          onContextMenu={(e) => {
            // Right-clicking below the last row: the menu is for the project root.
            if (e.target === e.currentTarget) target.current = null
          }}
          onKeyDown={onKeyDown}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
            e.preventDefault()
            setDropDir("")
          }}
          onDragLeave={(e) => e.target === e.currentTarget && setDropDir(null)}
          onDrop={(e) => {
            e.preventDefault()
            setDropDir(null)
            const d = dragged(e)
            if (d) move(d, "")
          }}
        >
          {nodes.map((n) => renderNode(n, 0))}
          {editing && editing.kind !== "rename" && editing.dir === "" && (
            <NewRow kind={editing.kind} depth={0} onDone={(v) => commit(editing, v)} onCancel={() => setEditing(null)} />
          )}
          {files.length === 0 && !editing && folders.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">No files yet. Right-click, or press + above.</div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onClick={() => startNew("new-file", menuDir)}>
            <FilePlusIcon />
            New file…
          </ContextMenuItem>
          <ContextMenuItem onClick={() => startNew("new-folder", menuDir)}>
            <FolderPlusIcon />
            New folder…
          </ContextMenuItem>
          {menuNode && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() =>
                  navigator.clipboard.writeText(menuNode.path).then(
                    () => toast(`Copied ${menuNode.path}`),
                    () => toast.error("Could not copy"),
                  )
                }
              >
                Copy path
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => setEditing({ kind: "rename", path: menuNode.path, folder: !!menuNode.children })}>
                Rename…
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => remove(menuNode)}>
                Delete
                <ContextMenuShortcut>Del</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onClick={collapseAll}>
            <CopyMinusIcon />
            Collapse all
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

function NewRow({ kind, depth, onDone, onCancel }: { kind: "new-file" | "new-folder"; depth: number; onDone: (name: string) => void; onCancel: () => void }) {
  return (
    <div className="flex h-6 items-center gap-1 pr-2 text-xs" style={{ paddingLeft: 6 + depth * 12 }}>
      {kind === "new-folder" ? (
        <>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <FolderIcon className="size-3.5 shrink-0 text-amber-600" />
        </>
      ) : (
        <FileIcon className="ml-[1.125rem] size-3.5 shrink-0 text-muted-foreground" />
      )}
      <NameInput initial="" placeholder={kind === "new-folder" ? "folder" : "name.c"} onDone={onDone} onCancel={onCancel} />
    </div>
  )
}

/** A bare input where the name was: Enter commits, Escape cancels, so does clicking away. */
function NameInput({
  initial,
  placeholder,
  onDone,
  onCancel,
}: {
  initial: string
  placeholder?: string
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the stem, as VS Code does, so typing replaces the name and keeps the extension.
    const dot = initial.lastIndexOf(".")
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      spellCheck={false}
      className="h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-xs outline-none"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key !== "Enter" && e.key !== "Escape") return
        // The editor takes focus in the same tick; without this the key lands there as a newline.
        e.preventDefault()
        if (e.key === "Enter") onDone(e.currentTarget.value)
        else onCancel()
      }}
      onBlur={(e) => onDone(e.currentTarget.value)}
    />
  )
}
