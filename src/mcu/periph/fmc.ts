/**
 * FMC — flexible memory controller (RM0090 §37, RM0385 §13). What matters for the boards
 * here is the SDRAM controller: the two banks come up unusable, and firmware walks them
 * through the JEDEC initialisation (clock enable, precharge all, auto-refresh, load mode
 * register) with SDCMR before the memory answers. The NOR/PSRAM and NAND register sets are
 * kept so HAL init code runs, but nothing hangs on them.
 */
import type { Bus } from "../bus"
import { RegBlock, type RegDef } from "./regblock"

const FMC_BASE = 0xa0000000

const REGS: RegDef[] = [
  // Bank 1: NOR/PSRAM chip selects (BCRx/BTRx interleaved), write timings.
  { name: "BCR1", offset: 0x00, reset: 0x000030db },
  { name: "BTR1", offset: 0x04, reset: 0x0fffffff },
  { name: "BCR2", offset: 0x08, reset: 0x000030d2 },
  { name: "BTR2", offset: 0x0c, reset: 0x0fffffff },
  { name: "BCR3", offset: 0x10, reset: 0x000030d2 },
  { name: "BTR3", offset: 0x14, reset: 0x0fffffff },
  { name: "BCR4", offset: 0x18, reset: 0x000030d2 },
  { name: "BTR4", offset: 0x1c, reset: 0x0fffffff },
  // Bank 3: NAND.
  { name: "PCR", offset: 0x80, reset: 0x00000018 },
  { name: "SR", offset: 0x84, reset: 0x00000040 },
  { name: "PMEM", offset: 0x88, reset: 0xfcfcfcfc },
  { name: "PATT", offset: 0x8c, reset: 0xfcfcfcfc },
  { name: "ECCR", offset: 0x94 },
  { name: "BWTR1", offset: 0x104, reset: 0x0fffffff },
  { name: "BWTR2", offset: 0x10c, reset: 0x0fffffff },
  { name: "BWTR3", offset: 0x114, reset: 0x0fffffff },
  { name: "BWTR4", offset: 0x11c, reset: 0x0fffffff },
  // SDRAM banks 1 and 2.
  { name: "SDCR1", offset: 0x140, reset: 0x000002d0 },
  { name: "SDCR2", offset: 0x144, reset: 0x000002d0 },
  { name: "SDTR1", offset: 0x148, reset: 0x0fffffff },
  { name: "SDTR2", offset: 0x14c, reset: 0x0fffffff },
  { name: "SDCMR", offset: 0x150 },
  { name: "SDRTR", offset: 0x154, w1c: 1 },
  { name: "SDSR", offset: 0x158 },
]

/** SDCMR.MODE command codes. */
const CMD_NORMAL = 0
const CMD_CLK_ENABLE = 1
const CMD_PALL = 2
const CMD_AUTOREFRESH = 3
const CMD_LOAD_MODE = 4
const CMD_SELF_REFRESH = 5
const CMD_POWER_DOWN = 6

/** What one SDRAM bank has been through, in the order the JEDEC sequence wants it. */
type BankState = { clock: boolean; precharged: boolean; refreshes: number; mode: number; selfRefresh: boolean; powerDown: boolean }

export class Fmc extends RegBlock {
  bus: Bus | null = null
  onUnsupported: ((what: string) => void) | null = null
  readonly banks: BankState[] = [Fmc.freshBank(), Fmc.freshBank()]

  constructor() {
    super("FMC", FMC_BASE, 0x1000, REGS)
  }

  private static freshBank(): BankState {
    return { clock: false, precharged: false, refreshes: 0, mode: 0, selfRefresh: false, powerDown: false }
  }

  reset() {
    super.reset()
    if (this.banks) for (let i = 0; i < 2; i++) this.banks[i] = Fmc.freshBank()
    this.apply()
  }

  /**
   * A bank answers once the clock runs, it has been precharged, refreshed at least once and
   * its mode register loaded (the demo BSPs do exactly this, with 8 refreshes), and it is not
   * in self-refresh or power-down. Write protection (SDCR.WP) is enforced by the bus as well.
   */
  bankReady(i: number): boolean {
    const b = this.banks[i]
    return b.clock && b.precharged && b.refreshes > 0 && b.mode !== 0 && !b.selfRefresh && !b.powerDown
  }

  /** Push each bank's state onto the memory block that hangs on it. */
  private apply() {
    if (!this.bus) return
    for (let i = 0; i < 2; i++) {
      const mem = this.bus.external(i === 0 ? "sdram1" : "sdram2")
      if (!mem) continue
      mem.enabled = this.bankReady(i)
      mem.writeProtected = ((this.regs[(0x140 + i * 4) >>> 2] >>> 9) & 1) === 1
    }
  }

  protected onWrite(d: RegDef, next: number): number | void {
    if (d.name === "SDCR1" || d.name === "SDCR2") {
      const mem = this.bus?.external(d.name === "SDCR1" ? "sdram1" : "sdram2")
      if (mem) mem.writeProtected = ((next >>> 9) & 1) === 1
      return
    }
    if (d.name !== "SDCMR") return
    const mode = next & 7
    const targets = [(next >>> 4) & 1, (next >>> 3) & 1] // CTB1, CTB2
    const refreshes = ((next >>> 5) & 0xf) + 1
    const mrd = (next >>> 9) & 0x1fff
    for (let i = 0; i < 2; i++) {
      if (!targets[i]) continue
      const b = this.banks[i]
      switch (mode) {
        case CMD_NORMAL:
          b.selfRefresh = b.powerDown = false
          break
        case CMD_CLK_ENABLE:
          b.clock = true
          break
        case CMD_PALL:
          b.precharged = true
          break
        case CMD_AUTOREFRESH:
          if (b.precharged) b.refreshes += refreshes
          break
        case CMD_LOAD_MODE:
          b.mode = mrd
          break
        case CMD_SELF_REFRESH:
          b.selfRefresh = true
          break
        case CMD_POWER_DOWN:
          b.powerDown = true
          break
      }
      if (mode !== CMD_NORMAL && mode !== CMD_CLK_ENABLE && !b.clock) this.onUnsupported?.(`FMC SDRAM bank ${i + 1} command ${mode} before its clock was enabled`)
    }
    // The controller takes a few SDCLK cycles per command; nobody polls fast enough to see BUSY.
    this.apply()
    return 0
  }

  protected onRead(d: RegDef, current: number): number {
    // SDSR: BUSY (bit 5) never set (commands are instant); MODES1/2 report normal (0), self-refresh (1), power-down (2).
    if (d.name === "SDSR") {
      const modes = (i: number) => (this.banks[i].selfRefresh ? 1 : this.banks[i].powerDown ? 2 : 0)
      return (modes(0) << 1) | (modes(1) << 3)
    }
    return current
  }
}
