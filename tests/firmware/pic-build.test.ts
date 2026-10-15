/**
 * The build service's PIC path (backend/worker/src/build.ts): the editor's template for a new
 * PIC16F62x (src/project/template.ts) built with SDCC, an MPASM-style program built with gpasm,
 * both run on the bench; the compilers' messages read back as editor diagnostics. SDCC and gpasm
 * come from the emul-pic image (`pnpm firmware-pic`) through firmware/pic/bin.
 */
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { PIC16F627_04, PIC16F628A } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import { parseDiagnostics } from "@/project/diagnostics"
import { template } from "@/project/template"
import { build } from "../../backend/worker/src/build"

const BIN = join(__dirname, "..", "..", "firmware", "pic", "bin")
process.env.SDCC = join(BIN, "sdcc")
process.env.GPASM = join(BIN, "gpasm")

beforeAll(() => {
  try {
    execFileSync("docker", ["image", "inspect", "emul-pic"], { stdio: "ignore" })
  } catch {
    throw new Error("no emul-pic image: build it with `pnpm firmware-pic`")
  }
})

/** Run an image on a part and collect what it sends on RB2/TX at 9600 baud (decoded from the pin's edges). */
function serialOut(hex: Buffer, seconds: number, chip = PIC16F628A) {
  const m = createPic(chip)
  m.load(new Uint8Array(hex).buffer, "firmware.hex")
  m.digitalWatch.add(18)
  m.runUntil(seconds)
  const edges = m.digitalOut.filter((e) => e.pad.port === 1 && e.pad.pin === 2)
  const at = (t: number) => {
    let l: boolean | null = null
    for (const e of edges) if (e.time <= t) l = e.level
    return l
  }
  const tb = 1 / 9615.38
  let text = ""
  let i = 0
  while (i < edges.length) {
    const e = edges[i]
    if (e.level === false && i > 0 && edges[i - 1].level === true) {
      let v = 0
      for (let k = 0; k < 8; k++) if (at(e.time + (k + 1.5) * tb)) v |= 1 << k
      text += String.fromCharCode(v)
      const end = e.time + 9.5 * tb
      while (i < edges.length && edges[i].time < end) i++
      continue
    }
    i++
  }
  return { text, m }
}

describe("PIC builds in the build service", () => {
  it("the editor's template builds with SDCC and runs: ticks on the USART, the LED on RB3", async () => {
    const files = template("pic16f628a")
    const out = await build("pic16f628a", files)
    expect(out.error, out.log).toBeUndefined()
    expect(out.ok).toBe(true)
    expect(out.elf!.subarray(0, 1).toString()).toBe(":")
    const { text, m } = serialOut(out.elf!, 2.2)
    expect(text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect(m.config).toBe(0x3f30)
    expect(m.unmodelled.size).toBe(0)
  }, 60_000)

  it("the same template on the PIC16F627-04 (the original silicon, its own SDCC device)", async () => {
    const out = await build("pic16f627-04", template("pic16f627-04"))
    expect(out.ok, out.log).toBe(true)
    expect(serialOut(out.elf!, 1.2, PIC16F627_04).text).toMatch(/^tick 0\r\n/)
  }, 60_000)

  it("a project with main.asm builds with gpasm, its __CONFIG in the image", async () => {
    const asm = [
      "        list    p=16f628a",
      "        #include <p16f628a.inc>",
      "        __CONFIG _INTOSC_OSC_NOCLKOUT & _WDT_OFF & _PWRTE_OFF & _MCLRE_ON & _BOREN_OFF & _LVP_OFF",
      "        org     0",
      "        movlw   0x42",
      "loop    goto    loop",
      "        end",
    ].join("\n")
    const out = await build("pic16f628a", [{ path: "main.asm", content: asm }])
    expect(out.ok, out.log).toBe(true)
    const m = createPic(PIC16F628A)
    m.load(new Uint8Array(out.elf!).buffer, "firmware.hex")
    m.runUntil(1e-3)
    expect(m.cpu.w).toBe(0x42)
    expect(m.config).toBe(0x3f38)
  }, 60_000)

  it("compiler errors come back as diagnostics on the project's lines", async () => {
    const bad = await build("pic16f628a", [{ path: "main.c", content: "#include <pic14regs.h>\nvoid main(void) {\n  PORTB = undefined_thing;\n}\n" }])
    expect(bad.ok).toBe(false)
    const d = parseDiagnostics(bad.log).filter((x) => x.severity === "error")
    expect(d[0]).toMatchObject({ path: "main.c", line: 3 })
    const asm = await build("pic16f628a", [{ path: "main.asm", content: "        list p=16f628a\n        org 0\n        movwf nowhere\n        end\n" }])
    expect(asm.ok).toBe(false)
    expect(parseDiagnostics(asm.log).find((x) => x.severity === "error")).toMatchObject({ path: "main.asm", line: 3 })
  }, 60_000)
})
