/**
 * Flash and boot: firmware/hal/Src/flash.c on the F429 model — a boot counter logged into sector 4
 * across five resets with an erase when the log fills, byte/halfword/word programming, a store while
 * locked, option bytes turning Stop into a reset — then power-cycles the chip (flash persists),
 * reloads the firmware (flash and option bytes go back), and boots with BOOT0 high into the
 * system-memory stub and into SRAM.
 */
import { describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

describe("flash and boot on the F429", () => {
  const image = buffer(hal("flash.elf"))
  const blink = buffer(hal("blink.elf"))
  const mcu = new Stm32F429()
  mcu.load(image, "flash.elf")

  const sym = (name: string) => mcu.firmware?.symbols.find((s) => s.name === name)?.value
  const word = (name: string) => {
    const a = sym(name)
    return a === undefined ? -1 : mcu.bus.read32(a)
  }
  const LOG = 0x08010000
  const logSlot = (i: number) => mcu.bus.read32(LOG + 4 * i)

  const resets: { cause: string; at: number; vars: Record<string, number> }[] = []
  const origReset = mcu.reset.bind(mcu)
  mcu.reset = (cause = "por") => {
    const vars: Record<string, number> = {}
    for (const v of ["boots", "slot", "phase", "patternOk", "lockedError", "obUser", "stopReset", "errors"]) vars[v] = word(v)
    resets.push({ cause, at: mcu.time, vars })
    origReset(cause)
  }
  function run(seconds: number, step = 1e-3) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) if (!mcu.run(Math.min(step, end - mcu.time))) break
  }
  function runUntilPhase(value: number, limit: number) {
    const end = mcu.time + limit
    while (mcu.time < end && mcu.running && word("phase") !== value) if (!mcu.run(Math.min(1e-4, end - mcu.time))) break
  }
  function runUntilResets(n: number, limit: number) {
    const end = mcu.time + limit
    while (mcu.time < end && mcu.running && resets.length < n) if (!mcu.run(Math.min(1e-4, end - mcu.time))) break
  }

  it("boot 1: an empty log, programming, a locked store", () => {
    runUntilResets(1, 0.05)
    expect(mcu.cpu.halted?.message).toBeUndefined()
    expect(mcu.running).toBe(true)
    expect(resets[0]?.cause ?? "none", "software reset after the tests").toBe("system")
    expect.soft(resets[0].vars.boots, "boot counter started at 1").toBe(1)
    expect.soft(logSlot(0), "slot 0 holds it").toBe(1)
    expect.soft(resets[0].vars.patternOk, "byte/halfword/word programmed and AND-ed").toBe(1)
    expect.soft(resets[0].vars.lockedError, "a store while locked → PGSERR, nothing written").toBe(1)
    expect.soft(resets[0].vars.errors, "no HAL errors").toBe(0)
  })

  it("boot 2: option bytes make Stop a reset", () => {
    runUntilResets(2, 0.05)
    expect(resets.length, "second reset").toBe(2)
    expect.soft(logSlot(1), "boot 2 logged in slot 1").toBe(2)
    expect.soft(resets[1].vars.obUser.toString(16), "factory USER option bytes read back").toBe("e0")
    expect.soft(resets[1].vars.errors, "Stop with nRST_STOP=0 reset the chip").toBe(0)
    expect.soft(mcu.flash.resetOnStop(), "option bytes survived the reset (nRST_STOP still 0)").toBe(true)
  })

  it("boots 3 and 4", () => {
    runUntilResets(3, 0.05)
    expect.soft(resets[2]?.vars.stopReset ?? -1, "boot 3 saw a software reset flag").toBe(1)
    expect.soft(((resets[2]?.vars.obUser ?? 0) >>> 0).toString(16), "boot 3 read nRST_STOP=0 in the user bytes").toBe("a0")
    expect.soft(mcu.flash.resetOnStop(), "nRST_STOP restored").toBe(false)
    runUntilResets(4, 0.05)
    expect.soft(`${logSlot(0)} ${logSlot(1)} ${logSlot(2)} ${logSlot(3)}`, "four boots logged").toBe("1 2 3 4")
  })

  it("boot 5: the log is full, the sector is erased", () => {
    // The erase is one stalled instruction: the longest 10 µs step on the way to phase 3 is it.
    let stall = 0
    while (word("phase") < 3 && mcu.running && mcu.time < 2) {
      const t = mcu.time
      mcu.run(1e-5)
      stall = Math.max(stall, mcu.time - t)
    }
    expect.soft(stall * 1e3, "sector 4 (64 KB) erase stalled the core (ms)").toBeNear(550, 1)
    runUntilPhase(9, 0.05)
    expect.soft(`${logSlot(0)} ${logSlot(1).toString(16)}`, "log restarted: slot 0 = 5, slot 1 erased").toBe("5 ffffffff")
    expect.soft(`${mcu.padDrive(parsePad("PB0")!)} ${mcu.powerMode}`, "LD1 on, idle").toBe("high sleep")
    expect.soft(resets.filter((r) => r.vars.errors !== 0), "no HAL errors in any life").toEqual([])
    expect.soft(`${mcu.resets} by ${mcu.lastReset}`, "reset count and cause").toBe("4 by system")
  })

  it("keeps flash across a power cycle", () => {
    mcu.reset("por")
    runUntilPhase(9, 0.05)
    expect.soft(`${logSlot(0)} ${logSlot(1)}`, "boot 6 appended to the surviving log").toBe("5 6")
    expect.soft(mcu.bus.read32(0x1fffc000).toString(16), "option bytes as read from 0x1FFFC000").toBe("5513aaec")
  })

  it("starts a fresh part on a firmware reload", () => {
    mcu.load(image, "flash.elf")
    run(0.002)
    expect(`${logSlot(0)} ${logSlot(1).toString(16)}`, "log erased with the flash").toBe("1 ffffffff")
  })

  it("bites with the hardware watchdog option byte and blink never feeding it", () => {
    mcu.load(blink, "blink.elf")
    run(0.0005)
    mcu.bus.write32(0x40023c08, 0x08192a3b)
    mcu.bus.write32(0x40023c08, 0x4c5d6e7f)
    expect.soft(mcu.flash.get("OPTCR") & 1, "OPTKEYR unlocked OPTCR").toBe(0)
    mcu.bus.write32(0x40023c14, (mcu.flash.get("OPTCR") & ~(1 << 5)) | 2)
    expect.soft(mcu.flash.iwdgHardware(), "WDG_SW = hardware").toBe(true)
    mcu.reset("system")
    const before = resets.length
    const t0 = mcu.time
    run(0.7)
    const bite = resets.slice(before).find((r) => r.cause === "iwdg")
    expect(bite?.cause ?? "none", "IWDG bit with nobody feeding it").toBe("iwdg")
    expect.soft((bite!.at - t0) * 1e3, "512 ms after the reset (4095 ticks of LSI/4)").toBeNear(512, 1)
  })

  it("runs blink at 180 MHz with LATENCY 5 and the ART on", () => {
    mcu.load(blink, "blink.elf")
    run(0.01)
    const ft = mcu.cpu.flashTiming
    expect.soft(`${ft.latency} ws, prefetch ${ft.prefetch ? "on" : "off"}, cache ${ft.cache ? "on" : "off"}`, "ACR as the HAL set it").toBe("5 ws, prefetch on, cache on")
    const cpi = (seconds: number) => {
      const c0 = mcu.cpu.cycles
      const i0 = mcu.cpu.instructions
      run(seconds)
      return (mcu.cpu.cycles - c0) / (mcu.cpu.instructions - i0)
    }
    const cached = cpi(0.01)
    expect.soft(cached, "hot loop runs out of the ART (cycles per instruction)").toBeNear(1.9, 0.4)
    mcu.bus.write32(0x40023c00, 5) // caches and prefetch off, 5 wait states stay
    const bare = cpi(0.01)
    expect.soft(bare - cached, "caches off: 5 wait states per line and per literal (extra CPI)").toBeNear(2.1, 0.8)
    mcu.bus.write32(0x40023c00, 0x105) // prefetch only
    const prefetched = cpi(0.01)
    expect.soft(prefetched, "prefetch alone hides most of it").toBeLessThan(bare)
    expect.soft(prefetched, "prefetch alone hides most of it").toBeGreaterThan(cached)
  })

  it("follows BOOT0 and BOOT1", () => {
    mcu.load(image, "flash.elf")
    mcu.boot0 = true
    mcu.reset("por")
    run(0.002)
    expect.soft(`0x${mcu.cpu.scs.vtor.toString(16)}`, "boots into system memory").toBe("0x1fff0000")
    expect.soft(mcu.powerMode, "the bootloader stub sleeps").toBe("sleep")
    expect.soft([...mcu.unmodelled.features.keys()].join(","), "reported as unmodelled").toBe("system bootloader (BOOT0 high)")
    mcu.setPad(parsePad("PB2")!, true)
    mcu.reset("por")
    run(0.001)
    expect.soft(`0x${mcu.cpu.scs.vtor.toString(16)}`, "BOOT1 (PB2) high too: SRAM boot").toBe("0x20000000")
    expect.soft(mcu.cpu.halted?.reason ?? "running", "nothing there: lockup").toBe("fault")
    mcu.boot0 = false
    mcu.setPad(parsePad("PB2")!, false)
    mcu.reset("por")
    run(0.01)
    expect.soft(`0x${mcu.cpu.scs.vtor.toString(16)} ${mcu.running ? "running" : "halted"}`, "BOOT0 low: flash again").toBe("0x8000000 running")
  })
})
