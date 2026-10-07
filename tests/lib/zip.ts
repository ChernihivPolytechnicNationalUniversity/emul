import { crc32, deflateRawSync } from "node:zlib"

export type ZipInput = { path: string; content?: string | Uint8Array; deflate?: boolean; dataDescriptor?: boolean }

const UTF8_NAMES = 0x800
const SIZES_AFTER_DATA = 0x8

export function zip(inputs: ZipInput[]): Uint8Array<ArrayBuffer> {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const input of inputs) {
    const name = Buffer.from(input.path)
    const raw = typeof input.content === "string" ? Buffer.from(input.content) : Buffer.from(input.content ?? [])
    const data = input.deflate ? deflateRawSync(raw) : raw
    const crc = crc32(raw)
    const flags = UTF8_NAMES | (input.dataDescriptor ? SIZES_AFTER_DATA : 0)
    const method = input.deflate ? 8 : 0

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(method, 8)
    if (!input.dataDescriptor) {
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(data.length, 18)
      header.writeUInt32LE(raw.length, 22)
    }
    header.writeUInt16LE(name.length, 26)
    const descriptor = Buffer.alloc(input.dataDescriptor ? 16 : 0)
    if (input.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(data.length, 8)
      descriptor.writeUInt32LE(raw.length, 12)
    }
    local.push(header, name, data, descriptor)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(flags, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += header.length + name.length + data.length + descriptor.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(inputs.length, 8)
  end.writeUInt16LE(inputs.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...local, directory, end]))
}
