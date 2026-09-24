import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const FIRMWARE = join(import.meta.dirname, "..", "..", "firmware")

function read(path: string, hint: string) {
  if (!existsSync(path)) throw new Error(`${path} is missing — ${hint}`)
  return readFileSync(path)
}

export const example = (name: string) => read(join(FIRMWARE, "examples", name), "it is committed, check the checkout")

export const exampleBase64 = (name: string) => example(name).toString("base64")

export const halPath = (name: string) => join(FIRMWARE, "hal", "build", name)

export const hal = (name: string) => read(halPath(name), "build it with `make -C firmware/hal`")

export const buffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
