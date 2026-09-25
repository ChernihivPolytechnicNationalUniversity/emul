import * as React from "react"
import { BinaryIcon, FilePlusIcon, FileQuestionIcon, FolderUpIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

type Props = {
  /** The path the image names the file by. */
  path: string
  line: number
  fn: string | null
  /** The site is still being asked for it (an ST library file). */
  loading: boolean
  onAddFiles: (files: File[]) => void
  onDisassembly: () => void
}

/**
 * The place the core is stopped at has no source here: say which file it is, and take it —
 * the file itself or the folder it is in (a CubeIDE project's Core/, Drivers/). The file is
 * kept with the board, read-only, and source-level debugging goes on in it.
 */
export function SourceMissing({ path, line, fn, loading, onAddFiles, onDisassembly }: Props) {
  const file = React.useRef<HTMLInputElement>(null)
  const folder = React.useRef<HTMLInputElement>(null)
  const name = path.split("/").pop() ?? path
  React.useEffect(() => {
    // `webkitdirectory` is not in React's props for <input>.
    folder.current?.setAttribute("webkitdirectory", "")
  }, [])
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ""
    if (files.length) onAddFiles(files)
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm">
      {loading ? <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" /> : <FileQuestionIcon className="size-8 text-muted-foreground" />}
      <div>
        <div className="font-medium">{loading ? `Fetching ${name}…` : `No source for ${name}`}</div>
        <div className="mt-1 font-mono text-xs break-all text-muted-foreground">
          {path}:{line}
          {fn ? ` · in ${fn}` : ""}
        </div>
      </div>
      {!loading && (
        <>
          <p className="max-w-md text-xs text-muted-foreground">
            The program was built from a file that is not in this board's project. Add it (or the folder it is in) and debugging goes on in the source: it is kept with the board, read-only, and never compiled.
          </p>
          <div className="flex flex-wrap justify-center gap-1.5">
            <input ref={file} type="file" multiple accept=".c,.h,.cpp,.hpp,.cc,.s,.S,.inc" className="hidden" onChange={take} />
            <input ref={folder} type="file" className="hidden" onChange={take} />
            <Button size="sm" onClick={() => file.current?.click()}>
              <FilePlusIcon />
              Add {name}…
            </Button>
            <Button size="sm" variant="outline" onClick={() => folder.current?.click()}>
              <FolderUpIcon />
              Add a folder…
            </Button>
            <Button size="sm" variant="outline" onClick={onDisassembly}>
              <BinaryIcon />
              Disassembly
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
