import { readZip } from "@/lib/zip"
import type { ProjectEntry } from "./cubemx"

const ZIP = /\.zip$/i

export const isZip = (file: File) => ZIP.test(file.name)

const fileEntry = (file: File, path = file.webkitRelativePath || file.name): ProjectEntry => ({
  path,
  size: file.size,
  read: async () => new Uint8Array(await file.arrayBuffer()),
})

export async function zipEntries(file: File): Promise<ProjectEntry[]> {
  return readZip(new Uint8Array(await file.arrayBuffer()))
}

export function filesEntries(files: File[]): Promise<ProjectEntry[]> {
  const zip = files.length === 1 && isZip(files[0]!) ? files[0]! : null
  return zip ? zipEntries(zip) : Promise.resolve(files.map((f) => fileEntry(f)))
}

export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.webkitdirectory = true
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])))
    input.addEventListener("cancel", () => resolve([]))
    input.click()
  })
}

const droppedRoots = (data: DataTransfer) =>
  Array.from(data.items)
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => !!entry)

const droppedZip = (data: DataTransfer) => (data.files.length === 1 && isZip(data.files[0]!) ? data.files[0]! : null)

export function isProjectDrop(data: DataTransfer): boolean {
  return !!droppedZip(data) || droppedRoots(data).some((r) => r.isDirectory)
}

export function dropEntries(data: DataTransfer): Promise<ProjectEntry[]> {
  const zip = droppedZip(data)
  if (zip) return zipEntries(zip)
  return Promise.all(droppedRoots(data).map(walk)).then((lists) => lists.flat())
}

async function walk(entry: FileSystemEntry): Promise<ProjectEntry[]> {
  if (entry.isDirectory && entry.name.startsWith(".")) return []
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    return [fileEntry(file, entry.fullPath)]
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const children: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    children.push(...batch)
  }
  return (await Promise.all(children.map(walk))).flat()
}
