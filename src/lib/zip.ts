export type ZipEntry = { path: string; size: number; read: () => Promise<Uint8Array> }

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
const END_RECORD_SIZE = 22
const MAX_ARCHIVE_COMMENT = 0xffff
const ZIP64_MARK = 0xffffffff
const ENCRYPTED = 0x1
const STORED = 0
const DEFLATED = 8

export function readZip(bytes: Uint8Array<ArrayBuffer>): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEndOfDirectory(view)
  if (end < 0) throw new Error("Not a zip archive.")
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if (at === ZIP64_MARK) throw new Error("ZIP64 is not supported. Zip only the project folder.")
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new Error("Archive is damaged.")
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const checksum = view.getUint32(at + 16, true)
    const compressedSize = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localHeader = view.getUint32(at + 42, true)
    const path = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (path.endsWith("/")) continue
    entries.push({
      path,
      size,
      read: async () => {
        if (flags & ENCRYPTED) throw new Error(`${path}: encrypted entries are not supported.`)
        const start = dataStart(view, localHeader, path)
        const data = bytes.subarray(start, start + compressedSize)
        const checked = (bytes: Uint8Array) => {
          if (crc32(bytes) !== checksum) throw new Error(`${path}: checksum mismatch, archive is damaged.`)
          return bytes
        }
        if (method === STORED && data.length === size) return checked(data.slice())
        if (method === DEFLATED) return checked(await inflate(data, size, path))
        if (method === STORED) throw new Error(`${path}: archive is damaged.`)
        throw new Error(`${path}: compression method ${method} is not supported.`)
      },
    })
  }
  return entries
}

function findEndOfDirectory(view: DataView): number {
  const last = view.byteLength - END_RECORD_SIZE
  for (let at = last; at >= 0 && at >= last - MAX_ARCHIVE_COMMENT; at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) return at
  }
  return -1
}

function dataStart(view: DataView, localHeader: number, path: string): number {
  if (view.getUint32(localHeader, true) !== LOCAL_HEADER) throw new Error(`${path}: archive is damaged.`)
  return localHeader + 30 + view.getUint16(localHeader + 26, true) + view.getUint16(localHeader + 28, true)
}

async function inflate(data: Uint8Array<ArrayBuffer>, size: number, path: string): Promise<Uint8Array> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  const out = new Uint8Array(size)
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (at + value.length > size) {
      await reader.cancel()
      throw new Error(`${path}: size mismatch, archive is damaged.`)
    }
    out.set(value, at)
    at += value.length
  }
  if (at !== size) throw new Error(`${path}: archive is damaged.`)
  return out
}

export type ZipInput = { path: string; content: string | Uint8Array }

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const UTF8_NAMES = 0x800
const VERSION_NEEDED = 20

function dosTimestamp(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function writeZip(inputs: ZipInput[], modified = new Date()): Promise<Uint8Array<ArrayBuffer>> {
  const { time, date } = dosTimestamp(modified)
  const encoder = new TextEncoder()
  const files = await Promise.all(
    inputs.map(async (f) => {
      const raw = typeof f.content === "string" ? encoder.encode(f.content) : f.content
      const packed = await deflate(raw)
      const deflated = packed.length < raw.length
      return { name: encoder.encode(f.path), data: deflated ? packed : raw, size: raw.length, method: deflated ? DEFLATED : STORED, crc: crc32(raw) }
    }),
  )
  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0)
  const directorySize = files.reduce((n, f) => n + 46 + f.name.length, 0)
  const out = new Uint8Array(localSize + directorySize + END_RECORD_SIZE)
  const view = new DataView(out.buffer)
  let at = 0
  const offsets: number[] = []
  for (const f of files) {
    offsets.push(at)
    view.setUint32(at, LOCAL_HEADER, true)
    view.setUint16(at + 4, VERSION_NEEDED, true)
    view.setUint16(at + 6, UTF8_NAMES, true)
    view.setUint16(at + 8, f.method, true)
    view.setUint16(at + 10, time, true)
    view.setUint16(at + 12, date, true)
    view.setUint32(at + 14, f.crc, true)
    view.setUint32(at + 18, f.data.length, true)
    view.setUint32(at + 22, f.size, true)
    view.setUint16(at + 26, f.name.length, true)
    out.set(f.name, at + 30)
    out.set(f.data, at + 30 + f.name.length)
    at += 30 + f.name.length + f.data.length
  }
  files.forEach((f, i) => {
    view.setUint32(at, DIRECTORY_ENTRY, true)
    view.setUint16(at + 4, VERSION_NEEDED, true)
    view.setUint16(at + 6, VERSION_NEEDED, true)
    view.setUint16(at + 8, UTF8_NAMES, true)
    view.setUint16(at + 10, f.method, true)
    view.setUint16(at + 12, time, true)
    view.setUint16(at + 14, date, true)
    view.setUint32(at + 16, f.crc, true)
    view.setUint32(at + 20, f.data.length, true)
    view.setUint32(at + 24, f.size, true)
    view.setUint16(at + 28, f.name.length, true)
    view.setUint32(at + 42, offsets[i]!, true)
    out.set(f.name, at + 46)
    at += 46 + f.name.length
  })
  view.setUint32(at, END_OF_DIRECTORY, true)
  view.setUint16(at + 8, files.length, true)
  view.setUint16(at + 10, files.length, true)
  view.setUint32(at + 12, directorySize, true)
  view.setUint32(at + 16, localSize, true)
  return out
}
