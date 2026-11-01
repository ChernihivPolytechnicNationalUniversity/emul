/**
 * STM32 system-on-chip: the ARMv7-M core, its bus and the peripherals modelled so far, with
 * the pad interface the board model plugs into. Which part it is (F429, F746, ...) comes from
 * the chip profile: memory map, core identity, device id.
 */
import { blockName } from "./blocks"
import { Bus, type Peripheral } from "./bus"
import type { Clocked } from "./periph/clocked"
import { internalChannelVolts, STM32F429ZI, type ChipProfile, type MemoryRegion } from "./chip"
import { Cpu } from "./cpu"
import { CoreDebugger } from "./debugger"
import { parseFirmware, type Firmware } from "./elf"
import { CpuHalt, emulatorError } from "./faults"
import type { BlockInfo, CoreDebugCommand, CoreRegisters, DebugStop, DebugWrite, InspectReply, InspectRequest, MemoryChunk } from "@/debug/protocol"
import { RegBlock } from "./periph/regblock"
import { Lptim } from "./periph/lptim"
import { Exti, Gpio, GPIO_PORTS, type PadDrive } from "./periph/gpio"
import { parsePad, type PadRef } from "./pads"
import { FlashIf } from "./periph/flash"
import { Dbgmcu, Dwt, Pwr, Syscfg } from "./periph/misc"
import { Rcc, type ClockSource, type ClockTree } from "./periph/rcc"
import { Rtc } from "./periph/rtc"
import { Iwdg, Wwdg } from "./periph/wdg"
import { AdcBlock, adcPad, Dac, DAC_PADS, type Adc, type AdcSource } from "./periph/adc"
import { BackupSram } from "./periph/bkpsram"
import { Dma, DMA_SPECS, DMA1_REQUESTS, DMA2_REQUESTS } from "./periph/dma"
import { Dma2d } from "./periph/dma2d"
import { Fmc } from "./periph/fmc"
import { Ltdc } from "./periph/ltdc"
import { I2c, I2C_SPECS, i2cPads, type I2cLine, type I2cPad } from "./periph/i2c"
import { i2sMckPads, Spi, SPI_SPECS, spiPads, type SpiLine, type SpiPad } from "./periph/spi"
import { connectTimers, Tim, TIM_LINE, TIM_SPECS, timAuxPads, timPads, type TimPad } from "./periph/tim"
import { Usart, USART_SPECS, usartPads, type UsartPad } from "./periph/usart"

const LOAD_AVERAGED_OVER_SECONDS = 0.01
const LOAD_SLEEP_SHARE_STEP = 1 / 32
const LOAD_SHARE_HYSTERESIS = 0.75

/** Records accesses to peripheral blocks that have no model yet. */
class Unmodelled implements Peripheral {
  readonly name = "unmodelled"
  readonly base = 0x40000000
  readonly size = 0x20000000
  readonly hits = new Map<number, { reads: number; writes: number }>()
  private note(addr: number, write: boolean) {
    const block = addr & ~0x3ff
    const h = this.hits.get(block) ?? { reads: 0, writes: 0 }
    if (write) h.writes++
    else h.reads++
    this.hits.set(block, h)
  }
  read(offset: number): number {
    this.note(this.base + offset, false)
    return 0
  }
  write(offset: number): void {
    this.note(this.base + offset, true)
  }
  /** Modes of modelled blocks that the model lacks (e.g. "SPI1 CRC"), with how often they were turned on. */
  readonly features = new Map<string, number>()
  feature(what: string) {
    this.features.set(what, (this.features.get(what) ?? 0) + 1)
  }
  reset() {
    this.hits.clear()
    this.features.clear()
  }
  /** What the firmware has been talking to that is not there, by block name, busiest first. */
  summary(): { block: string; reads: number; writes: number }[] {
    const byBlock = new Map<string, { block: string; reads: number; writes: number }>()
    for (const [what, n] of this.features) byBlock.set(what, { block: what, reads: 0, writes: n })
    for (const [addr, h] of this.hits) {
      const block = blockName(addr)
      const b = byBlock.get(block) ?? { block, reads: 0, writes: 0 }
      b.reads += h.reads
      b.writes += h.writes
      byBlock.set(block, b)
    }
    return [...byBlock.values()].sort((a, b) => b.reads + b.writes - a.reads - a.writes)
  }
}

const AMBIENT_CELSIUS = 25
const PVD_EXTI_LINE = 16
const LPTIM_EXTI_LINE = 23
const AHB1ENR_BKPSRAMEN = 18
const VDDA_RESOLUTION = 1e-4
const INTERNAL_PULL_OHMS = 40e3
const FLOATING_NODE_LEAK_OHMS = 1e10
const DMA_STREAM_CR = 0x10
const DMA_STREAM_NDTR = 0x14
const DMA_STREAM_STRIDE = 0x18
const DMA_SxCR_EN = 1
const DMA_SxCR_CHSEL_SHIFT = 25

export { padName, parsePad, type PadRef } from "./pads"
export type ResetCause = "por" | "system" | "iwdg" | "wwdg" | "standby"
export type PowerMode = "run" | "sleep" | "stop" | "standby"
export type ClockStatus = {
  source: ClockTree["source"]
  pllSource: "HSE" | "HSI"
  sysclk: number
  hse: ClockSource | null
  lse: ClockSource | null
  /** "HSE on: no crystal on OSC_IN/OSC_OUT" while firmware waits for an oscillator that cannot come. */
  problems: string[]
}

export type PowerStatus = { mode: PowerMode; asleep: number; current: number; regulator: "main" | "low-power" | "under-drive" }

export class Stm32 {
  readonly chip: ChipProfile
  readonly bus: Bus
  readonly cpu: Cpu
  readonly rcc: Rcc
  readonly pwr: Pwr
  readonly flash: FlashIf
  /** BOOT0 as the board has it at reset (BOOT1 is read off PB2). Nothing on the board: low, boot from flash. */
  boot0 = false
  readonly syscfg: Syscfg
  readonly exti: Exti
  readonly gpio: Gpio[] = []
  readonly dwt: Dwt
  readonly dbgmcu: Dbgmcu
  readonly tim: Tim[] = []
  readonly lptim: Lptim | null
  readonly usart: Usart[] = []
  readonly spi: Spi[] = []
  readonly i2c: I2c[] = []
  readonly dma: Dma[] = []
  readonly adcBlock: AdcBlock
  readonly adc: Adc[]
  readonly dac: Dac
  readonly rtc: Rtc
  readonly bkpsram: BackupSram
  readonly fmc: Fmc
  readonly ltdc = new Ltdc()
  readonly dma2d = new Dma2d()
  readonly iwdg = new Iwdg()
  readonly wwdg = new Wwdg()
  /** Why the core last reset, for RCC's CSR flags. */
  private resetCause: ResetCause = "por"
  /** Resets since the firmware was loaded, other than power-on, and the last one's cause. */
  resets = 0
  lastReset: Exclude<ResetCause, "por"> | null = null
  /** The last power-on kept the backup domain: VBAT held it through the cut. */
  backupKept = false
  /**
   * Deep sleep in progress (SLEEPDEEP + WFI/WFE): Stop, or Standby with PDDS. The 1.2 V
   * domain's clocks are frozen; only the LSI/LSE-clocked RTC and IWDG keep running.
   */
  lowPower: "stop" | "standby" | null = null
  private lptimInterruptHeldInStop = false
  /** Clocked peripherals taken off the schedule for the deep sleep, put back on wake-up. */
  private readonly frozen = new Set<Clocked>()
  /** WKUP pin index that ended the Standby (−1: the RTC did), for PWR's flags. */
  private standbyWakePin = -1
  /** Cycle counters behind the run/sleep duty for the supply current and the status line. */
  private readonly supplyMeter = { cycles: 0, sleep: 0 }
  private readonly statusMeter = { cycles: 0, sleep: 0 }
  private readonly loadMeter = { cycles: 0, sleep: 0 }
  private loadAsleep = 0
  private loadSleepShare = 0
  /** Volts on a pad as the circuit has them (set by the board model); null: unknown, reads as 0 V. */
  analogRead: (pad: PadRef) => number | null = () => null
  analogSource: (pad: PadRef) => { ohms: number; farads: number } | null = () => null
  /** DAC output voltages by pad key while the channel is enabled. */
  private readonly dacOut = new Map<number, number>()
  /** USART RX taps by pad. */
  private readonly usartInputs = new Map<number, { usart: Usart; af: number }[]>()
  /** SPI input taps by pad (SCK/MOSI/NSS for a slave, MISO/NSS for a master). */
  private readonly spiInputs = new Map<number, { spi: Spi; af: number; line: SpiLine }[]>()
  /** I²C taps by pad: both lines are inputs too (open-drain bus, ACKs and stretching come back in). */
  private readonly i2cInputs = new Map<number, { i2c: I2c; af: number; line: I2cLine }[]>()
  /** Core cycle each active clocked peripheral (running timer, busy USART) was last advanced to. */
  private readonly synced = new Map<Clocked, number>()
  readonly unmodelled = new Unmodelled()
  /** Timer channel inputs by pad: which timers to tell when a pin changes. */
  private readonly timInputs = new Map<number, { tim: Tim; line: number; af: number }[]>()

  firmware: Firmware | null = null
  firmwareName = ""
  /** Simulated time in seconds since reset (as of the last completed run slice). */
  time = 0
  /** Cycle count and clock at the start of the slice in progress, for sub-slice timestamps. */
  private sliceStart = 0
  private sliceHz = 16e6
  /**
   * Pad levels driven by serial peripherals, with exact timestamps: the digital fast path the
   * board uses to deliver bits to a terminal or another MCU without the analog time step
   * quantizing them. Drained by the owner.
   */
  /** `pull` on a released pad: its weak pull-up (true) or pull-down (false), which then sets the net's level. */
  readonly digitalOut: { pad: PadRef; level: boolean | null; time: number; pull?: boolean }[] = []
  /**
   * Plain GPIO pads whose changes go through the digital fast path too (a bit-banged chip
   * select next to a hardware SPI must arrive in order with its clock). Set by the owner.
   */
  readonly digitalWatch = new Set<number>()
  private readonly digitalLevel = new Map<number, boolean | null>()
  /** The pull last reported for a released watched pad. */
  private readonly digitalPull = new Map<number, boolean | undefined>()
  /**
   * When set, emitting a digital edge ends the current `runUntil` early so the owner can hand
   * the edge to another core before this one runs on (lockstep for MCU-to-MCU links).
   */
  yieldOnOutput = false
  /** Exact time of the pad event being applied, when it is not "now" (a late delivery). */
  private eventTime: number | null = null
  /** Pad changes the outside world scheduled for exact times, earliest first. */
  private readonly padQueue: { pad: PadRef; level: boolean; time: number }[] = []
  /**
   * Time each peripheral-driven pad has spent high, for the board to turn fast switching
   * (PWM above the analog step rate) into a duty instead of sampling one instant of it.
   */
  private readonly afHigh = new Map<number, { level: boolean; since: number; high: number }>()
  private clockVersion = -1
  private clocksCache: ClockTree | null = null
  /** Set by an RCC write: the run slice ends so the new clock applies from that instruction on. */
  private clockDirty = false

  /** `external`: memory the board hangs on the FMC (an SDRAM), on top of the chip's own map. */
  constructor(chip: ChipProfile = STM32F429ZI, external: MemoryRegion[] = []) {
    this.chip = chip
    const f40x = chip.line === "f40x"
    this.syscfg = new Syscfg(chip.line)
    this.fmc = new Fmc(!f40x)
    this.rcc = new Rcc(chip.lptim, chip.rccResets, !f40x)
    this.rtc = new Rtc(chip.rtcBackupRegisters)
    this.lptim = chip.lptim ? new Lptim(chip.lptim) : null
    this.vdda = chip.electrical.vdd
    this.bus = new Bus([...chip.memory, ...external], chip.core.bitBand)
    this.cpu = new Cpu(this.bus, chip.core)
    this.dbgmcu = new Dbgmcu(chip.idcode)
    this.pwr = new Pwr(chip.pwr, chip.electrical.pvd ?? null, chip.electrical.vdd, !f40x)
    const bus = this.bus
    const flashRegion = chip.memory.find((m) => m.kind === "flash")!
    this.flash = new FlashIf(chip.flash.map, chip.flash, flashRegion.base, f40x)
    this.flash.bus = bus
    bus.flashWriter = (addr, value, size) => this.flash.programWrite(addr, value, size)
    this.flash.onBusy = (seconds) => {
      this.cpu.cycles += Math.round(seconds * this.sliceHz)
    }
    this.flash.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
    // Wait states: the core pays ACR.LATENCY per new flash line unless the prefetch buffer
    // (sequential code) or the ART / instruction cache has it; data reads likewise (DCEN).
    this.cpu.flashRanges = [flashRegion.base, ...(flashRegion.aliases ?? [])].map((b) => [b, b + flashRegion.size])
    this.flash.onAcr = (acr, resetCaches) => {
      const v1 = chip.flash.map === "v1"
      this.cpu.flashTiming = {
        latency: acr & ((1 << chip.flash.latencyBits) - 1),
        prefetch: (acr & (1 << 8)) !== 0,
        cache: (acr & (1 << 9)) !== 0,
        lineBytes: v1 ? 16 : 32,
        dataLines: v1 ? (acr & (1 << 10) ? 8 : 0) : acr & (1 << 9) ? 64 : 0,
      }
      this.cpu.lineShift = v1 ? 4 : 5
      if (resetCaches) this.cpu.resetFlashCaches()
    }
    bus.onFlashRead = (addr) => this.cpu.dataPenalty(addr)
    this.installBootloaderStub()
    this.installFactoryBytes()
    this.rcc.now = () => this.now
    this.rcc.onChange = () => {
      if (this.lptim) this.sync(this.lptim)
      this.clockDirty = true
      this.cpu.stop = true
    }
    bus.attach(this.rcc)
    bus.attach(this.pwr)
    this.pwr.onUnsupported = (what) => this.unmodelled.feature(what)
    this.rcc.onUnsupported = (what) => this.unmodelled.feature(what)
    this.pwr.onPvdOutput = (vddBelow) => this.exti.edge(PVD_EXTI_LINE, vddBelow)
    this.bkpsram = new BackupSram(chip.backupSram.base, chip.backupSram.size)
    this.bkpsram.interfaceClocked = () => this.rcc.enabled("AHB1ENR", AHB1ENR_BKPSRAMEN)
    this.bkpsram.backupDomainWritable = () => this.pwr.backupDomainWritable()
    bus.attach(this.bkpsram)
    bus.attach(this.flash)
    this.syscfg.onRemap = (mode) => {
      if (mode === 2) this.unmodelled.feature("SYSCFG remap of the FMC at address 0")
      else bus.remap(mode === 0 ? "flash" : mode === 1 ? "system" : "sram")
    }
    bus.attach(this.syscfg)
    this.exti = new Exti(this.syscfg, (irq) => this.cpu.scs.raiseIrq(irq), chip.lptim ? LPTIM_EXTI_LINE + 1 : LPTIM_EXTI_LINE)
    this.exti.onEvent = () => {
      this.cpu.eventRegister = true
    }
    this.exti.onLine = (line) => this.timerEvent(`EXTI${line}`)
    // In Standby only the RTC lines (alarm 17, tamper/timestamp 21, wake-up 22) reach the chip.
    this.exti.onWake = (line) => {
      if (this.lowPower === "standby" && line >= 17) this.wakeFromStandby(-1)
      if (this.lowPower === "stop" && line === LPTIM_EXTI_LINE) this.releaseLptimInterrupt()
    }
    bus.attach(this.exti)
    this.cpu.onDeepSleep = () => this.enterDeepSleep()
    this.cpu.onDeepWake = () => this.leaveDeepSleep()
    this.cpu.onUnsupported = (what) => this.unmodelled.feature(what)
    const drainSpeeds = Object.entries(chip.electrical.pads?.releaseFromHighDrainsAtSpeed ?? {}).map(([pad, speed]) => ({ ref: parsePad(pad)!, speed }))
    // GPIOA–GPIOI on F40x, A–K on F42x/F7 (RM0090 Table 35 has no GPIOJ/K enable bits).
    for (let i = 0; i < (f40x ? 9 : GPIO_PORTS); i++) {
      const drainSpeed: number[] = []
      for (const { ref, speed } of drainSpeeds) if (ref.port === i) drainSpeed[ref.pin] = speed
      const g = new Gpio(i, drainSpeed)
      g.onInput = (port, pin, level) => {
        if (this.lowPower === "standby") {
          const wkup = this.pwr.wakeupPin(port, pin, level)
          if (wkup >= 0) this.wakeFromStandby(wkup)
        }
        this.exti.onPinChange(port, pin, level)
        if (this.lptim) {
          for (const p of this.chip.lptim!.pads) {
            const pad = parsePad(p.pad)!
            if (p.signal === "OUT" || pad.port !== port || pad.pin !== pin || !this.padHasAf(port, pin, p.af)) continue
            this.sync(this.lptim)
            this.lptim.pinEdge(p.signal, level)
          }
        }
        const taps = this.timInputs.get(port * 16 + pin)
        if (taps && !this.lowPower)
          for (const t of taps)
            if (this.padHasAf(port, pin, t.af)) {
              this.sync(t.tim)
              t.tim.input(t.line, level, this.eventTime === null ? 0 : Math.max(0, this.now - this.eventTime))
              this.schedule()
            }
        const rx = this.usartInputs.get(port * 16 + pin)
        if (rx)
          for (const u of rx)
            if (this.padHasAf(port, pin, u.af)) {
              this.sync(u.usart)
              u.usart.rxEdge(level)
              this.schedule()
            }
        const sp = this.spiInputs.get(port * 16 + pin)
        if (sp)
          for (const x of sp)
            if (this.padHasAf(port, pin, x.af)) {
              this.sync(x.spi)
              x.spi.pinEdge(x.line, level)
              this.schedule()
            }
        const ic = this.i2cInputs.get(port * 16 + pin)
        if (ic)
          for (const x of ic)
            if (this.padHasAf(port, pin, x.af)) {
              this.sync(x.i2c)
              x.i2c.pinEdge(x.line, level)
              this.schedule()
            }
      }
      g.onOutput = (port) => this.watchGpio(port)
      this.gpio.push(g)
      bus.attach(g)
    }
    for (const [i, spec] of DMA_SPECS.entries()) {
      const d = new Dma(spec, i === 0 ? DMA1_REQUESTS : DMA2_REQUESTS)
      d.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      d.sync = () => this.sync(d)
      d.reschedule = () => this.schedule()
      d.onActive = (on) => this.setActive(d, on)
      d.onUnsupported = (what) => this.unmodelled.feature(what)
      d.readBus = (addr, size) => this.bus.read(addr, size)
      d.writeBus = (addr, value, size) => this.bus.write(addr, value, size)
      d.levelOf = (source) => this.dmaLevel(source)
      this.dma.push(d)
      bus.attach(d)
    }
    for (const spec of TIM_SPECS) {
      const t = new Tim(spec, chip.tim)
      const pads = timPads(spec.name)
      const lines = [...pads.filter((p) => !p.complementary).map((p) => ({ ...p, line: p.channel })), ...timAuxPads(spec.name, chip.af).map((p) => ({ ...p, line: TIM_LINE[p.line] }))]
      t.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      t.onDmaRequest = (event) => this.dmaRequest(`${spec.name}_${event}`)
      t.onEvent = (event) => this.timerEvent(`${spec.name}_${event}`)
      t.sync = () => this.sync(t)
      t.reschedule = () => this.schedule()
      t.onRunning = (on) => this.setActive(t, on)
      t.onOutput = (index, level) => this.driveTimOutput(pads, index, level, t.eventLag)
      t.onUnsupported = (what) => this.unmodelled.feature(what)
      t.readLine = (line) => {
        for (const p of lines) if (p.line === line && this.padHasAf(p.port, p.pin, p.af)) return this.gpio[p.port].inputLevel(p.pin)
        return null
      }
      t.clockOn = () => this.rcc.apbClockOn(spec.apb, spec.rccBit)
      this.rcc.apbGated[spec.apb] |= 1 << spec.rccBit
      for (const p of lines) {
        const key = p.port * 16 + p.pin
        this.timInputs.set(key, [...(this.timInputs.get(key) ?? []), { tim: t, line: p.line, af: p.af }])
      }
      this.tim.push(t)
      bus.attach(t)
    }
    connectTimers(this.tim)
    this.rcc.onApbChange = (apb, changed, asserted) => {
      for (const t of this.tim) {
        const bit = 1 << t.spec.rccBit
        if (t.spec.apb !== apb || !(changed & bit)) continue
        this.sync(t)
        if (asserted & bit) t.reset()
        t.clockChanged()
      }
      this.schedule()
    }
    // UART7/UART8 and SPI4–6 are F42x/F7 only (RM0090 Table 35, Table 62).
    for (const spec of USART_SPECS.filter((u) => !f40x || (u.name !== "UART7" && u.name !== "UART8"))) {
      const u = new Usart(spec, chip.usart)
      const pads = usartPads(spec.name)
      u.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      u.onDmaRequest = (line) => this.dmaRequest(`${spec.name}_${line.toUpperCase()}`)
      u.sync = () => this.sync(u)
      u.reschedule = () => this.schedule()
      u.onActive = (on) => this.setActive(u, on)
      u.onTx = (level) => this.driveUsartTx(pads, level)
      u.onUnsupported = (what) => this.unmodelled.feature(what)
      for (const p of pads) {
        if (p.dir !== "rx") continue
        const key = p.port * 16 + p.pin
        this.usartInputs.set(key, [...(this.usartInputs.get(key) ?? []), { usart: u, af: p.af }])
      }
      this.usart.push(u)
      bus.attach(u)
    }
    for (const spec of SPI_SPECS.slice(0, f40x ? 3 : SPI_SPECS.length)) {
      const x = new Spi(spec, chip.spi)
      const pads = [...spiPads(spec.name, chip.af), ...i2sMckPads(spec.name, chip.af)]
      x.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      x.onDmaRequest = (line) => this.dmaRequest(`${spec.name}_${line.toUpperCase()}`)
      x.sync = () => this.sync(x)
      x.reschedule = () => this.schedule()
      x.onActive = (on) => this.setActive(x, on)
      x.onOut = (line, level, lag) => this.driveSpi(pads, line, level, lag)
      x.i2sClock = () => this.i2sClock()
      x.onUnsupported = (what) => this.unmodelled.feature(what)
      for (const p of pads) {
        if (p.line === "MOSI" || p.line === "SCK" || p.line === "MISO" || p.line === "NSS") {
          const key = p.port * 16 + p.pin
          this.spiInputs.set(key, [...(this.spiInputs.get(key) ?? []), { spi: x, af: p.af, line: p.line }])
        }
      }
      this.spi.push(x)
      bus.attach(x)
    }
    for (const spec of I2C_SPECS.slice(0, chip.i2cCount)) {
      const x = new I2c(spec, chip.i2c, !f40x)
      const pads = i2cPads(spec.name, chip.af)
      x.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      x.sync = () => this.sync(x)
      x.reschedule = () => this.schedule()
      x.onActive = (on) => this.setActive(x, on)
      x.onOut = (line, level) => this.driveI2c(pads, line, level)
      x.onUnsupported = (what) => this.unmodelled.feature(what)
      for (const p of pads) {
        const key = p.port * 16 + p.pin
        this.i2cInputs.set(key, [...(this.i2cInputs.get(key) ?? []), { i2c: x, af: p.af, line: p.line }])
      }
      this.i2c.push(x)
      bus.attach(x)
    }
    this.adcBlock = new AdcBlock(0x40012000, 3, chip.adc)
    this.adc = this.adcBlock.adcs
    this.dac = new Dac(chip.dac)
    this.adcBlock.common.onUnsupported = (what) => this.unmodelled.feature(what)
    this.adcBlock.common.onDmaRequest = () => this.dmaRequest("ADC1")
    this.adcBlock.common.dmaTransfersLeft = () => this.dmaTransfersLeft("ADC1")
    for (const a of this.adc) {
      a.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
      a.sync = () => this.sync(a)
      a.reschedule = () => this.schedule()
      a.onActive = (on) => this.setActive(a, on)
      a.onUnsupported = (what) => this.unmodelled.feature(what)
      a.onDmaRequest = () => this.dmaRequest(`ADC${a.index}`)
      a.dmaTransfersLeft = () => this.dmaTransfersLeft(`ADC${a.index}`)
      a.vref = chip.electrical.vdd
      a.internal = internalChannelVolts(chip, AMBIENT_CELSIUS)
      a.readSource = (channel) => this.adcSource(channel, a.index)
    }
    bus.attach(this.adcBlock)
    this.dac.vref = chip.electrical.vdd
    this.dac.onUnsupported = (what) => this.unmodelled.feature(what)
    this.dac.onDmaRequest = (ch) => this.dmaRequest(`DAC${ch + 1}`)
    this.dac.onOutput = (ch, volts) => {
      const pad = parsePad(DAC_PADS[ch])!
      const key = pad.port * 16 + pad.pin
      if (volts === null) this.dacOut.delete(key)
      else this.dacOut.set(key, volts)
      this.gpio[pad.port].version++
    }
    bus.attach(this.dac)
    for (const w of [this.iwdg, this.wwdg]) {
      w.sync = () => this.sync(w)
      w.reschedule = () => this.schedule()
      w.onActive = (on) => this.setActive(w, on)
      w.onReset = () => this.requestReset(w === this.iwdg ? "iwdg" : "wwdg")
      bus.attach(w)
    }
    this.wwdg.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
    if (this.lptim) {
      const timer = this.lptim
      timer.sync = () => {
        this.sync(timer)
        this.refreshLptimClock()
      }
      timer.reschedule = () => this.schedule()
      timer.onActive = (on) => this.setActive(timer, on)
      timer.raiseIrq = (irq) => {
        if (this.lowPower === "stop") this.lptimInterruptHeldInStop = true
        else this.cpu.scs.raiseIrq(irq)
      }
      timer.onWakeupEvent = () => this.exti.event(LPTIM_EXTI_LINE)
      timer.onUnsupported = (what) => this.unmodelled.feature(what)
      timer.onOutput = (level, lag) => this.driveLptim(level, lag)
      timer.readInput = (signal) => {
        for (const p of this.chip.lptim!.pads) {
          const pad = parsePad(p.pad)!
          if (p.signal === signal && this.padHasAf(pad.port, pad.pin, p.af)) return this.gpio[pad.port].inputLevel(pad.pin)
        }
        return null
      }
      this.rcc.onLptimReset = () => timer.reset()
      this.rtc.onAlarm = (alarm, level) => {
        this.sync(timer)
        timer.triggerEdge(alarm === "A" ? 1 : 2, level)
      }
      bus.attach(timer)
    }
    this.rtc.sync = () => this.sync(this.rtc)
    this.rtc.reschedule = () => this.schedule()
    this.rtc.onActive = (on) => this.setActive(this.rtc, on)
    this.rtc.onUnsupported = (what) => this.unmodelled.feature(what)
    this.rtc.onExti = (line) => this.exti.event(line)
    this.rtc.clockHz = () => this.rcc.rtcHz()
    bus.attach(this.rtc)
    this.cpu.onEvent = () => {
      for (const c of this.synced.keys()) this.sync(c)
      if (this.padQueue.length) this.drainPadQueue()
      this.schedule()
    }
    // External memory controller, display controller and the 2D accelerator.
    this.fmc.bus = bus
    this.fmc.onUnsupported = (what) => this.unmodelled.feature(what)
    bus.attach(this.fmc)
    bus.onUnreadyAccess = (mem, _addr, write) => this.unmodelled.feature(`${mem} ${write ? "written" : "read"} before the FMC initialised it`)
    this.ltdc.bus = bus
    this.ltdc.pixelClock = () => this.rcc.ltdcHz()
    this.ltdc.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
    this.ltdc.onActive = (on) => this.setActive(this.ltdc, on)
    this.ltdc.onUnsupported = (what) => this.unmodelled.feature(what)
    this.dma2d.bus = bus
    this.dma2d.raiseIrq = (irq) => this.cpu.scs.raiseIrq(irq)
    this.dma2d.onUnsupported = (what) => this.unmodelled.feature(what)
    // LTDC and DMA2D are F429/F439 and F7 only (RM0090 §16 p480, §11; Table 62 has no 88–90).
    if (!f40x) {
      bus.attach(this.ltdc)
      bus.attach(this.dma2d)
    }
    this.dwt = new Dwt(() => this.cpu.cycles)
    bus.attach(this.dwt)
    bus.attach(this.dbgmcu)
    bus.fallback = this.unmodelled
  }

  /**
   * Load a firmware image (ELF, Intel HEX or raw binary): the flash is erased and programmed
   * with it, the option bytes go back to factory values, and the MCU powers on.
   */
  load(data: ArrayBuffer, name = "") {
    this.firmware = parseFirmware(data, name)
    this.firmwareName = name
    this.bus.clearMemories()
    for (const seg of this.firmware.segments) this.bus.load(seg.addr, seg.data)
    this.flash.restoreOptions()
    this.reset()
    // Breakpoints go onto the new image before its first instruction runs.
    this.cpu.dbg?.onLoad(this.firmware)
  }

  // --- debugging ---------------------------------------------------------------------------------

  /** The debug unit, made the first time anything debugs this core (plain `cpu.breakpoints` halt it instead). */
  get debugger(): CoreDebugger {
    let d = this.cpu.dbg
    if (!d) {
      d = new CoreDebugger(this.cpu)
      this.cpu.dbg = d
      d.onLoad(this.firmware)
    }
    return d
  }

  debug(cmd: CoreDebugCommand) {
    const d = this.debugger
    switch (cmd.op) {
      case "breakpoints":
        d.setBreakpoints(cmd.list)
        break
      case "catch":
        d.catchFaults = cmd.faults
        break
      case "resume":
        d.resume()
        break
      case "step":
        d.step(cmd.step)
        break
    }
  }

  /** Where the core is stopped for the debugger, when it is. */
  get debugStop(): DebugStop | null {
    return this.cpu.dbg?.stop ?? null
  }

  /**
   * Registers and memory as they are, read without side effects: the debugger's view of a
   * stopped (or any) core. The request's writes come first, so what is read is after them.
   */
  inspect(req: InspectRequest): InspectReply {
    const cpu = this.cpu
    const writeErrors = req.write?.length ? this.applyWrites(req.write) : undefined
    let regs: CoreRegisters | null = null
    if (req.regs) {
      const r = [...cpu.r]
      r[15] = cpu.pc
      regs = {
        arch: "arm",
        pc: cpu.pc,
        sp: cpu.r[13],
        r,
        xpsr: cpu.xpsr,
        msp: cpu.getMsp(),
        psp: cpu.getPsp(),
        primask: cpu.primask,
        basepri: cpu.basepri,
        faultmask: cpu.faultmask,
        control: cpu.control,
        s: [...cpu.sBits],
        fpscr: cpu.fpscr,
        cycles: cpu.cycles,
        instructions: cpu.instructions,
        sleeping: cpu.sleeping,
      }
    }
    const blocks: BlockInfo[] | undefined = req.blocks
      ? this.bus.peripherals
          .filter((p) => p !== this.unmodelled)
          .map((p) => ({ name: p.name, base: p.base, size: p.size, registers: p instanceof RegBlock ? p.registerList().map((d) => ({ name: d.name, offset: d.offset })) : [] }))
          .sort((a, b) => a.base - b.base)
      : undefined
    return { regs, memory: (req.ranges ?? []).map((q) => this.peekRange(q.addr >>> 0, Math.max(0, Math.min(q.size, 1 << 24)))), blocks, stop: this.debugStop, time: this.time, halted: cpu.halted?.message ?? null, writeErrors }
  }

  /** The debugger's changes, in order; what could not be done, one message each. */
  private applyWrites(list: DebugWrite[]): string[] {
    const errors: string[] = []
    let stored = false
    for (const w of list) {
      const error = w.kind === "memory" ? this.pokeMemory(w.addr >>> 0, w.bytes) : this.pokeRegister(w.reg, w.value >>> 0)
      if (error) errors.push(error)
      else stored ||= w.kind === "memory"
    }
    // Code may have been changed under the decoded instructions: they are decoded again.
    if (stored) this.cpu.flushBlocks()
    return errors
  }

  /**
   * Bytes stored as the core's own stores would be: into RAM (a framebuffer notices), and into
   * a peripheral in the widths the bytes allow, so a register takes one store of its size and
   * does what such a store does. Flash is programmed through its controller and ROM not at
   * all; memory its controller has not set up takes nothing.
   */
  private pokeMemory(addr: number, bytes: Uint8Array): string | null {
    const bus = this.bus
    const at = (a: number) => `0x${(a >>> 0).toString(16).padStart(8, "0")}`
    for (let i = 0; i < bytes.length; ) {
      const a = (addr + i) >>> 0
      const mem = bus.memoryAt(a)
      if (mem) {
        if (mem.kind === "rom") return `${at(a)} is read-only memory`
        if (mem.isFlash) return `${at(a)} is in flash, which only a new build changes`
        if (!mem.enabled) return `${at(a)} is in ${mem.name}, which the program has not set up yet`
        if (mem.writeProtected) return `${at(a)} is in ${mem.name}, which the program has write-protected`
        const n = Math.min(bytes.length - i, mem.bytes.length - mem.offsetOf(a))
        for (let k = 0; k < n; k++) bus.write8((a + k) >>> 0, bytes[i + k])
        i += n
        continue
      }
      const left = bytes.length - i
      const size = left >= 4 && (a & 3) === 0 ? 4 : left >= 2 && (a & 1) === 0 ? 2 : 1
      if (bus.peek(a, size) === null) return `nothing answers at ${at(a)}`
      let v = 0
      for (let k = size - 1; k >= 0; k--) v = v * 256 + bytes[i + k]
      try {
        bus.write(a, v, size)
      } catch (e) {
        return `${at(a)}: ${(e as Error).message}`
      }
      i += size
    }
    return null
  }

  /** A core register set from outside, as a probe sets it; the flags only of xPSR (IPSR and EPSR are the core's). */
  private pokeRegister(name: string, v: number): string | null {
    const cpu = this.cpu
    const r = /^r(\d{1,2})$/.exec(name)
    const n = r ? Number(r[1]) : ({ sp: 13, lr: 14, pc: 15 } as Record<string, number>)[name] ?? -1
    const s = /^s(\d{1,2})$/.exec(name)
    if (n >= 0 && n <= 12) cpu.r[n] = v
    else if (n === 13) cpu.r[13] = v & ~3
    else if (n === 14) cpu.r[14] = v
    else if (n === 15) {
      cpu.pc = cpu.nextPc = (v & ~1) >>> 0
      // The stop is where the core now goes on from.
      const d = cpu.dbg
      if (d?.stop) d.stop = { ...d.stop, pc: cpu.pc }
    } else if (s && Number(s[1]) < 32) cpu.sBits[Number(s[1])] = v
    else
      switch (name) {
        case "xpsr":
          cpu.apsr = v
          break
        case "msp":
          cpu.setMsp(v & ~3)
          break
        case "psp":
          cpu.setPsp(v & ~3)
          break
        case "primask":
          cpu.primask = v & 1
          break
        case "faultmask":
          cpu.faultmask = v & 1
          cpu.updateAccess()
          break
        case "basepri":
          cpu.basepri = v & 0xff
          break
        case "control":
          cpu.setControl(v)
          break
        case "fpscr":
          cpu.fpscr = v
          break
        default:
          return `no register ${name}`
      }
    return null
  }

  /** `size` bytes from `addr`: memories copied as they are, registers peeked a word at a time. */
  private peekRange(addr: number, size: number): MemoryChunk {
    const bytes = new Uint8Array(size)
    const invalid: [number, number][] = []
    const bad = (lo: number, hi: number) => {
      const last = invalid[invalid.length - 1]
      if (last && last[1] === lo) last[1] = hi
      else invalid.push([lo, hi])
    }
    const end = addr + size
    for (let a = addr; a < end; ) {
      const mem = this.bus.memoryAt(a)
      if (mem) {
        const off = mem.offsetOf(a)
        const n = Math.min(end - a, mem.bytes.length - off)
        bytes.set(mem.bytes.subarray(off, off + n), a - addr)
        a += n
        continue
      }
      const word = a & ~3
      const v = this.bus.peek(word >>> 0, 4)
      const stop = Math.min(end, word + 4)
      if (v === null) bad(a, stop)
      else for (let b = a; b < stop; b++) bytes[b - addr] = (v >>> ((b - word) * 8)) & 0xff
      a = stop
    }
    return invalid.length ? { addr, bytes, invalid } : { addr, bytes }
  }

  /**
   * System memory holds ST's bootloader (UART/USB DFU), which is not modelled: a stub that
   * sleeps forever sits there, and booting into it is reported in the inspector.
   */
  private installBootloaderStub() {
    const at = this.bus.bytesAt(this.chip.flash.system.base)
    if (!at) return
    const view = new DataView(at.bytes.buffer, at.offset)
    view.setUint32(0, 0x20000400, true)
    view.setUint32(4, this.chip.flash.system.base + 0x41, true)
    view.setUint16(0x40, 0xbf30, true) // wfi
    view.setUint16(0x42, 0xe7fd, true) // b.n back to the wfi
  }

  private installFactoryBytes() {
    const factory = this.chip.factory
    if (!factory) return
    const viewAt = (addr: number) => {
      const where = this.bus.bytesAt(addr)!
      return new DataView(where.bytes.buffer, where.bytes.byteOffset + where.offset)
    }
    const otp = this.bus.bytesAt(factory.otp.base)!
    otp.bytes.fill(0xff, otp.offset, otp.offset + factory.otp.size)
    factory.uid.words.forEach((word, i) => viewAt(factory.uid.at + 4 * i).setUint32(0, word, true))
    for (const half of [factory.flashSizeKb, factory.vrefintCal, factory.tsCal1, factory.tsCal2, factory.packageData]) viewAt(half.at).setUint16(0, half.value, true)
  }

  /** A watchdog or SYSRESETREQ: the core restarts at the next slice boundary with the cause flagged. */
  private requestReset(cause: Exclude<ResetCause, "por">) {
    this.resetCause = cause
    this.cpu.requestReset()
    this.cpu.stop = true
  }

  // --- low-power modes (RM0090 §5.3) -----------------------------------------------------

  /**
   * WFI/WFE with SLEEPDEEP: Stop, or Standby when PWR selects it. Everything clocked from the
   * 1.2 V domain freezes (timers, serial blocks, SysTick, WWDG); the RTC and IWDG run on. HSE
   * and the PLLs go off, so the wake-up runs on HSI. In Standby the I/Os float as well.
   */
  private enterDeepSleep() {
    const standby = this.pwr.standby()
    // The nRST_STOP / nRST_STDBY option bytes turn the mode into a reset.
    if (standby ? this.flash.resetOnStandby() : this.flash.resetOnStop()) {
      this.requestReset("system")
      return
    }
    if (this.lptim) this.sync(this.lptim)
    this.lowPower = standby ? "standby" : "stop"
    this.refreshLptimClock()
    for (const c of [...this.synced.keys()]) {
      this.sync(c)
      if (c === this.rtc || c === this.iwdg || (c === this.lptim && !standby)) continue
      this.frozen.add(c)
      this.synced.delete(c)
    }
    if (standby) {
      this.pwr.stopPvdForStandby()
      this.standbyWakePin = -1
      for (const g of this.gpio) g.powerDown()
    }
    this.rcc.enterStop()
    this.schedule()
  }

  /** A wake-up event ended a Stop: the regulator and HSI take their time, then the clocks resume. */
  private leaveDeepSleep() {
    if (!this.lowPower) return
    const kind = this.lowPower === "standby" ? "standby" : this.pwr.stopKind()
    this.cpu.cycles += Math.round((this.chip.electrical.wakeup[kind] ?? this.chip.electrical.wakeup.stopLp) * this.sliceHz)
    for (const c of this.frozen) this.synced.set(c, this.cpu.cycles)
    this.frozen.clear()
    this.lowPower = null
    this.releaseLptimInterrupt()
    this.refreshLptimClock()
    for (const t of this.tim) t.clockChanged()
    this.schedule()
  }

  private releaseLptimInterrupt() {
    if (!this.lptimInterruptHeldInStop) return
    this.lptimInterruptHeldInStop = false
    this.cpu.scs.raiseIrq(this.chip.lptim!.irq)
  }

  /** Standby ends in a reset after the regulator's wake-up time; PWR remembers it was one (SBF) and which WKUP pin did it. */
  private wakeFromStandby(pin: number) {
    this.standbyWakePin = pin
    this.cpu.cycles += Math.round(this.chip.electrical.wakeup.standby * this.sliceHz)
    this.requestReset("standby")
  }

  /** VDD below this holds the core in reset: the BOR level from the option bytes, else the POR threshold. */
  /**
   * What the circuit puts on the oscillator pins. Without a board the bench defaults apply
   * (the Nucleo's 8 MHz MCO into OSC_IN and an LSE crystal already running); a board or the
   * crystals wired to a bare chip replace them, null meaning nothing is there.
   */
  setClockSources(hse: ClockSource | null, lse: ClockSource | null) {
    this.rcc.hse = hse
    this.rcc.lse = lse
  }

  /** The system clock source and its rate, plus what is wrong with HSE/LSE if firmware waits on one. */
  clockStatus(): ClockStatus {
    const c = this.clocks
    return { source: c.source, pllSource: this.rcc.get("PLLCFGR") & (1 << 22) ? "HSE" : "HSI", sysclk: c.sysclk, hse: this.rcc.hse, lse: this.rcc.lse, problems: [this.rcc.hseProblem(), this.rcc.lseProblem()].filter((p): p is string => p !== null) }
  }

  get porThreshold() {
    return this.flash.borThreshold()
  }

  /** Where the core is, power-wise: running, in Sleep after WFI/WFE, or in a deep sleep. */
  get powerMode(): PowerMode {
    if (this.lowPower) return this.lowPower
    return this.cpu.sleeping ? "sleep" : "run"
  }

  /** Fraction of the cycles since this meter was last read that the core spent asleep. */
  private sleepFraction(meter: { cycles: number; sleep: number }) {
    const dc = this.cpu.cycles - meter.cycles
    const ds = this.cpu.sleepCycles - meter.sleep
    meter.cycles = this.cpu.cycles
    meter.sleep = this.cpu.sleepCycles
    return dc > 0 ? ds / dc : this.cpu.sleeping ? 1 : 0
  }

  /**
   * Typical supply current, A, for the mode and clock: the datasheet's figures, run and sleep
   * blended by how much of the time the core slept (`asleep`, 0–1). Not an activity model —
   * the same value for a busy loop and for a NOP loop.
   */
  private supplyOf(asleep: number): number {
    const e = this.chip.electrical
    if (this.lowPower === "standby") return e.idd.standby
    if (this.lowPower === "stop") return e.idd[this.pwr.stopKind()] ?? e.idd.stopLp
    const mhz = this.clocks.hclk / 1e6
    const run = e.idd.run[0] + e.idd.run[1] * mhz
    const sleep = e.idd.sleep[0] + e.idd.sleep[1] * mhz
    return run * (1 - asleep) + sleep * asleep
  }
  /** Supply current, A, averaged over the cycles since the previous call (the board's load). */
  supplyCurrent(): number {
    return this.supplyOf(this.sleepFraction(this.supplyMeter))
  }
  supplyLoad(): number {
    const cycles = this.cpu.cycles - this.loadMeter.cycles
    const asleep = this.sleepFraction(this.loadMeter)
    this.loadAsleep += (asleep - this.loadAsleep) * -Math.expm1(-cycles / this.clocks.hclk / LOAD_AVERAGED_OVER_SECONDS)
    if (Math.abs(this.loadAsleep - this.loadSleepShare) > LOAD_SHARE_HYSTERESIS * LOAD_SLEEP_SHARE_STEP) this.loadSleepShare = Math.round(this.loadAsleep / LOAD_SLEEP_SHARE_STEP) * LOAD_SLEEP_SHARE_STEP
    return this.supplyOf(this.loadSleepShare)
  }
  /** The power line for the inspector: mode, sleep duty since the last call, and the current estimate. */
  powerStatus(): PowerStatus {
    const asleep = this.lowPower ? 1 : this.sleepFraction(this.statusMeter)
    const kind = this.pwr.stopKind()
    return { mode: this.powerMode, asleep, current: this.supplyOf(asleep), regulator: kind === "stop" ? "main" : kind === "stopLp" ? "low-power" : "under-drive" }
  }

  /**
   * Reset. A power-on ("por", the default: firmware load, the board's VDD coming up) clears
   * everything — unless `backup` says VBAT held the backup domain (RTC, backup registers,
   * BDCR) through the outage; a system reset keeps it too and leaves the cause in RCC's CSR
   * reset flags. A Standby exit is a reset too, flagged in PWR rather than RCC.
   */
  /**
   * Time passed with VDD off and VBAT on: the RTC counts on if its clock is the LSE (the LSI
   * and HSE die with VDD). Called once when VDD returns, with the length of the outage.
   */
  runOnBattery(seconds: number) {
    if (seconds <= 0 || ((this.rcc.get("BDCR") >>> 8) & 3) !== 1) return
    this.rtc.refreshClock()
    this.rtc.tickSeconds(seconds)
  }

  reset(cause: ResetCause = "por", opts: { backup?: boolean; supplyKept?: boolean } = {}) {
    const backupSramKept = this.backupSramSurvives(cause, opts)
    // VDD back with VBAT still up: everything restarts but the backup domain stays as it was.
    this.rcc.powerOn = this.rtc.powerOn = cause === "por" && !opts.backup
    const vddCameUp = cause === "por" && !opts.supplyKept
    this.pwr.powerOn = vddCameUp
    this.pwr.backupDomainReset = cause === "por" && !opts.backup
    if (cause === "por") {
      this.resets = 0
      this.lastReset = null
      this.backupKept = !!opts.backup
    } else {
      this.resets++
      this.lastReset = cause
    }
    // RAM is lost; flash keeps what the firmware programmed into it. Images that load straight
    // into RAM (an SRAM-linked build) are put back for the boot.
    this.bus.clearRam()
    if (this.firmware) for (const seg of this.firmware.segments) if (this.bus.memoryAt(seg.addr)?.kind === "ram") this.bus.load(seg.addr, seg.data)
    this.bus.resetPeripherals()
    if (!backupSramKept) this.bkpsram.loseContents()
    // CSR reset flags: PIN for every reset; POR/BOR only for power-on; the watchdogs and SFTRST by cause.
    if (cause === "standby") this.pwr.flagStandbyExit(this.standbyWakePin)
    else {
      const flag = vddCameUp ? (1 << 27) | (1 << 25) : cause === "por" ? 0 : cause === "iwdg" ? 1 << 29 : cause === "wwdg" ? 1 << 30 : 1 << 28
      this.rcc.set("CSR", ((this.rcc.get("CSR") & 0x00ffffff) | (1 << 26) | flag) >>> 0)
    }
    this.synced.clear()
    this.frozen.clear()
    this.lowPower = null
    this.lptimInterruptHeldInStop = false
    this.supplyMeter.cycles = this.supplyMeter.sleep = this.statusMeter.cycles = this.statusMeter.sleep = 0
    this.loadMeter.cycles = this.loadMeter.sleep = this.loadAsleep = this.loadSleepShare = 0
    this.padQueue.length = 0
    this.digitalOut.length = 0
    this.digitalLevel.clear()
    this.digitalPull.clear()
    this.dacOut.clear()
    this.afHigh.clear()
    this.cpu.nextEventCycle = Infinity
    this.time = 0
    this.sliceStart = 0
    this.clockVersion = -1
    this.cpu.resetRequested = false
    if (this.firmware) {
      const vector = this.flash.bootAddress(this.boot0, this.gpio[1].inputLevel(2))
      // The F4 aliases the booted memory at address 0 (the F7 keeps its fixed ITCM map).
      if (this.chip.boot === "pins") this.bus.remap(vector === 0x20000000 ? "sram" : vector === this.chip.flash.system.base ? "system" : "flash")
      this.cpu.reset(vector)
      if (vector === this.chip.flash.system.base) this.unmodelled.feature("system bootloader (BOOT0 high)")
      if (this.flash.iwdgHardware()) this.iwdg.hardwareStart()
    } else this.cpu.halted = new CpuHalt("fault", "no firmware loaded", 0)
    this.cpu.dbg?.onReset()
  }

  private refreshLptimClock(hclk = this.rcc.clocks().hclk) {
    if (!this.lptim) return
    const clock = this.rcc.lptimClock(this.lowPower !== null)
    this.lptim.setClock(clock.hz, hclk, clock.enabled, clock.operational && this.lowPower !== "standby")
  }

  private driveLptim(level: boolean, lag: number, port?: number) {
    for (const p of this.chip.lptim?.pads ?? []) {
      if (p.signal !== "OUT") continue
      const pad = parsePad(p.pad)!
      if (port !== undefined && port !== pad.port) continue
      if (!this.padHasAf(pad.port, pad.pin, p.af)) continue
      this.gpio[pad.port].setAfOutput(pad.pin, level, true)
      this.trackAf(pad.port, pad.pin, level)
      const key = pad.port * 16 + pad.pin
      if (this.digitalWatch.has(key) && this.digitalLevel.get(key) !== level) {
        this.digitalLevel.set(key, level)
        this.emit(pad, level, this.now - lag)
      }
    }
  }

  get clocks(): ClockTree {
    if (this.clockVersion !== this.rcc.version || !this.clocksCache) {
      const c = this.rcc.clocks()
      this.clocksCache = c
      this.clockVersion = this.rcc.version
      for (const t of this.tim) t.setClock(t.spec.apb === 1 ? c.timclk1 : c.timclk2, c.hclk)
      for (const u of this.usart) u.setClock(u.spec.apb === 1 ? c.pclk1 : c.pclk2, c.hclk)
      for (const x of this.spi) x.setClock(x.spec.apb === 1 ? c.pclk1 : c.pclk2, c.hclk)
      for (const x of this.i2c) x.setClock(c.pclk1, c.hclk)
      for (const a of this.adc) a.setClock(c.pclk2, c.hclk)
      this.iwdg.setClock(c.hclk)
      this.wwdg.setClock(c.pclk1, c.hclk)
      this.rtc.setClock(c.hclk)
      this.rtc.refreshClock()
      this.refreshLptimClock(c.hclk)
      this.ltdc.setClock(c.hclk)
    }
    return this.clocksCache
  }

  /** Firmware loaded, not halted, and not stopped by the debugger. */
  get running() {
    return this.firmware !== null && this.cpu.halted === null && !this.cpu.dbg?.stop
  }

  /**
   * Advance by `seconds` of simulated time. The core clock may change on the way (RCC writes),
   * so time is accounted in slices. Returns false once the core has halted.
   */
  run(seconds: number): boolean {
    return this.runUntil(this.time + seconds)
  }

  /**
   * Advance until simulated time `end`; a caller driving the core from an external clock uses
   * this so an instruction's overshoot in one call is absorbed by the next, not compounded.
   */
  runUntil(end: number): boolean {
    if (!this.running) return false
    for (const g of this.gpio) g.settleDrains()
    try {
      while (this.time < end) {
        const hz = this.clocks.hclk
        const version = this.rcc.version
        // Run in slices small enough that a clock switch mid-way costs little accuracy.
        const cycles = Math.max(1, Math.round((end - this.time) * hz))
        const slice = Math.min(cycles, 20000)
        // Cycles added between slices (a Standby wake-up from a pad edge) count in this one.
        const before = this.sliceStart
        this.sliceHz = hz
        this.cpu.run(slice)
        const spent = this.cpu.cycles - before
        this.time += spent / hz
        this.sliceStart = this.cpu.cycles
        // A breakpoint halts the core without spending cycles; stop instead of spinning.
        if (this.cpu.halted) return false
        // Stopped for the debugger (a breakpoint, a finished step): the slice ends here.
        if (this.cpu.dbg?.stop) return false
        if (this.cpu.resetRequested) {
          const cause = this.resetCause === "por" ? "system" : this.resetCause
          this.resetCause = "por"
          // The timeline goes on across the reset (only the core's own clock restarts).
          const now = this.time
          this.reset(cause)
          this.time = Math.max(end, now)
          return true
        }
        if (this.cpu.stop) {
          this.cpu.stop = false
          // A clock change: the slice ended so the next one runs at the new rate.
          if (this.clockDirty) {
            this.clockDirty = false
            continue
          }
          // An edge went out and the owner wants to pass it on before this core runs further.
          return true
        }
        void version
      }
    } catch (e) {
      if (!(e instanceof CpuHalt)) this.cpu.halted = emulatorError(e, this.cpu.pc)
      return false
    }
    return true
  }

  /**
   * Run up to `n` of the loop's steps in one go, as the loop would one at a time (step `j`
   * ends at the loop's clock `time` plus `j` steps, less `base`), while nothing the loop
   * reads changes: the pads, the supply current (`idd` before the first step), an edge out, a
   * stop. The step where something did change, or the `n`th, is the last one run; `quiet` is
   * asked after each step before it and makes it the last by returning false. Returns the
   * steps run; `stepIdd` is the last step's supply current, which the loop takes instead of
   * reading the meter again.
   */
  runSteps(time: number, base: number, dt: number, n: number, idd: number, quiet: () => boolean): number {
    const version = this.padVersion()
    let t = time
    for (let k = 1; ; k++) {
      const end = t + dt - base
      this.runUntil(end)
      this.stepIdd = this.supplyLoad()
      if (k >= n || !this.running || this.time < end || this.digitalOut.length !== 0 || this.padVersion() !== version || this.stepIdd !== idd || !quiet()) return k
      t += dt
    }
  }
  stepIdd = 0

  // --- clocked peripherals ---------------------------------------------------------------
  //
  // Timers and serial shifters are not ticked per instruction. Each active one remembers the
  // core cycle it was last advanced to; it is caught up when its registers are touched, when a
  // pin it listens to changes, and when its next event comes due — the core keeps the earliest
  // due cycle of all of them in `nextEventCycle`, one compare per instruction.

  /** Advance an active peripheral to the present core cycle. */
  private sync(c: Clocked) {
    const at = this.synced.get(c)
    if (at === undefined) return
    const now = this.cpu.cycles
    if (now > at) {
      this.synced.set(c, now)
      c.tick(now - at)
    }
  }
  /** Point the core at the earliest pending event. */
  private schedule() {
    let next = Infinity
    for (const [c, caughtUpTo] of this.synced) {
      const due = caughtUpTo + c.cyclesUntilEvent()
      if (due < next) next = due
    }
    if (this.padQueue.length) {
      const due = this.cpu.cycles + Math.max(1, Math.ceil((this.padQueue[0].time - this.now) * this.sliceHz))
      if (due < next) next = due
    }
    this.cpu.nextEventCycle = next
  }
  /** Apply every scheduled pad change whose time has come. */
  private drainPadQueue() {
    const now = this.now
    while (this.padQueue.length && this.padQueue[0].time <= now + 1e-12) {
      const ev = this.padQueue.shift()!
      this.eventTime = ev.time
      this.setPad(ev.pad, ev.level)
      this.eventTime = null
    }
  }
  private setActive(c: Clocked, on: boolean) {
    if (on) {
      if (!this.synced.has(c)) this.synced.set(c, this.cpu.cycles)
    } else this.synced.delete(c)
    this.schedule()
  }

  // --- DMA requests ----------------------------------------------------------------------

  /** A peripheral's request line fired (or turned on): every stream routed to it gets one. */
  private dmaRequest(source: string) {
    for (const d of this.dma) {
      this.sync(d)
      d.request(source)
    }
    this.schedule()
  }

  /** A timer event by name ("TIM3_UP", "TIM2_TRGO", "TIM1_CH2"): the ADC and DAC triggers that name it. */
  private timerEvent(name: string) {
    for (const a of this.adc) {
      if (a.regularTrigger !== name && a.injectedTrigger !== name) continue
      this.sync(a)
      a.trigger(name)
    }
    if (this.dac.triggerOf(0) === name || this.dac.triggerOf(1) === name) this.dac.trigger(name)
    this.schedule()
  }

  /** Current level of a level-type request line; null for pulse sources (timers) and the unmodelled. */
  private dmaLevel(source: string): boolean | null {
    const m = /^(U?S?ART\d)_(TX|RX)$/.exec(source)
    if (m) {
      const u = this.usart.find((x) => x.spec.name === m[1])
      return u ? u.dmaLevel(m[2] === "TX" ? "tx" : "rx") : null
    }
    const sp = /^(SPI\d)_(TX|RX)$/.exec(source)
    if (sp) {
      const x = this.spi.find((y) => y.spec.name === sp[1])
      return x ? x.dmaLevel(sp[2] === "TX" ? "tx" : "rx") : null
    }
    return null
  }

  // --- pads ------------------------------------------------------------------------------

  private padHasAf(port: number, pin: number, af: number) {
    const g = this.gpio[port]
    return g.mode(pin) === 2 && g.af(pin) === af
  }

  /** The alternate function a pad is switched to, or null while it is a plain GPIO/analog pin. */
  padAf(p: PadRef): number | null {
    const g = this.gpio[p.port]
    return g.mode(p.pin) === 2 ? g.af(p.pin) : null
  }

  /** Simulated time right now, inside a run slice. */
  get now(): number {
    return this.time + (this.cpu.cycles - this.sliceStart) / this.sliceHz
  }

  /**
   * Log an edge on the digital fast path, stamped with the exact time of its cause. An
   * open-drain pad never drives high: its "high" is a release (null), and the bus decides.
   */
  private emit(pad: PadRef, level: boolean | null, time = this.eventTime ?? this.now) {
    if (level && this.gpio[pad.port].openDrain(pad.pin)) level = null
    const pull = level === null ? this.weakPull(pad.port, pad.pin) : undefined
    if (level === null) this.digitalPull.set(pad.port * 16 + pad.pin, pull)
    this.digitalOut.push(pull === undefined ? { pad, level, time } : { pad, level, time, pull })
    if (this.yieldOnOutput) this.cpu.stop = true
  }

  /** A released pad's own pull: up (true), down (false), or none. */
  private weakPull(port: number, pin: number): boolean | undefined {
    const pull = this.gpio[port].pull(pin)
    return pull === 1 ? true : pull === 2 ? false : undefined
  }

  /** A GPIO register changed: watched pads that now drive a different level go out as edges. */
  private watchGpio(port: number) {
    if (this.lptim) this.driveLptim(this.lptim.level, 0, port)
    if (!this.digitalWatch.size) return
    const g = this.gpio[port]
    for (let pin = 0; pin < 16; pin++) {
      const key = port * 16 + pin
      if (!this.digitalWatch.has(key)) continue
      const d = g.driveOf(pin)
      const level = d === "high" ? true : d === "low" ? false : null
      // A released pad whose pull changed is an edge too: the pull alone sets the net (an SPI's SCK
      // held at its idle level by PUPDR before SPE, RM0090 §28.3.1).
      if (this.digitalLevel.get(key) === level && (level !== null || this.digitalPull.get(key) === this.weakPull(port, pin))) continue
      this.digitalLevel.set(key, level)
      this.emit({ port, pin }, level)
    }
  }

  /** Note a peripheral-driven pad level for the duty accounting. */
  private trackAf(port: number, pin: number, level: boolean | null) {
    const key = port * 16 + pin
    if (this.gpio[port].openDrain(pin)) {
      this.afHigh.delete(key)
      return
    }
    const now = this.now
    const t = this.afHigh.get(key)
    if (!t) {
      if (level !== null) this.afHigh.set(key, { level, since: now, high: 0 })
      return
    }
    if (t.level) t.high += now - t.since
    t.since = now
    if (level === null) this.afHigh.delete(key)
    else t.level = level
  }

  /**
   * Fraction of the interval since the last call that a peripheral-driven pad was high, or
   * null when nothing drives it that way. Resets the accounting.
   */
  /** Whether any pad is being toggled by a peripheral (a PWM), so duties are worth taking. */
  hasDuty(): boolean {
    return this.afHigh.size !== 0
  }
  /** The pads (port*16+pin) a peripheral drives, whose duty `takeDuty` reports. */
  dutyPads(): IterableIterator<number> {
    return this.afHigh.keys()
  }
  /** What `takeDuty` would return now, leaving the accounting as it is. */
  peekDuty(p: PadRef, interval: number): number | null {
    const t = this.afHigh.get(p.port * 16 + p.pin)
    if (!t) return null
    const high = t.level ? t.high + (this.now - t.since) : t.high
    return interval > 0 ? Math.min(1, high / interval) : t.level ? 1 : 0
  }
  takeDuty(p: PadRef, interval: number): number | null {
    const t = this.afHigh.get(p.port * 16 + p.pin)
    if (!t) return null
    const now = this.now
    if (t.level) t.high += now - t.since
    t.since = now
    const duty = interval > 0 ? Math.min(1, t.high / interval) : t.level ? 1 : 0
    t.high = 0
    return duty
  }

  /** An I²C line changed: drive (low) or release every pad configured for it, and log the edge. */
  private driveI2c(pads: I2cPad[], line: I2cLine, level: boolean) {
    for (const p of pads) {
      if (p.line !== line || !this.padHasAf(p.port, p.pin, p.af)) continue
      this.gpio[p.port].setAfOutput(p.pin, level, true)
      this.trackAf(p.port, p.pin, level)
      this.emit({ port: p.port, pin: p.pin }, level)
    }
  }

  /** A USART TX level changed: drive every TX pad configured for it, and log the edge. */
  private driveUsartTx(pads: UsartPad[], level: boolean | null) {
    for (const p of pads) {
      if (p.dir !== "tx") continue
      if (level === null) {
        this.gpio[p.port].setAfOutput(p.pin, false, false)
        this.trackAf(p.port, p.pin, null)
        const key = p.port * 16 + p.pin
        if (this.digitalWatch.has(key) && this.digitalLevel.get(key) !== null) {
          this.digitalLevel.set(key, null)
          this.emit({ port: p.port, pin: p.pin }, null)
        }
      } else if (this.padHasAf(p.port, p.pin, p.af)) {
        this.gpio[p.port].setAfOutput(p.pin, level, true)
        this.trackAf(p.port, p.pin, level)
        this.emit({ port: p.port, pin: p.pin }, level)
      }
    }
  }

  private i2sClockVersion = -1
  private i2sClockHz = 0
  /** I2S2/I2S3 kernel clock: PLLI2S R, re-read when the RCC changes (I2S_CKIN, I2SSRC = 1, is not modelled: no clock). */
  private i2sClock(): number {
    if (this.i2sClockVersion !== this.rcc.version) {
      this.i2sClockVersion = this.rcc.version
      this.i2sClockHz = this.rcc.i2sHz() ?? 0
    }
    return this.i2sClockHz
  }

  /** An SPI line changed (`lag` seconds ago): drive every pad configured for it, and log the edge. */
  private driveSpi(pads: SpiPad[], line: SpiLine, level: boolean | null, lag = 0) {
    for (const p of pads) {
      if (p.line !== line) continue
      const key = p.port * 16 + p.pin
      const time = (this.eventTime ?? this.now) - lag
      if (level === null) {
        this.gpio[p.port].setAfOutput(p.pin, false, false)
        this.trackAf(p.port, p.pin, null)
        // Released (SPE or I2SE cleared): the pad falls back to its pull, and the net learns it now.
        if (this.digitalWatch.has(key) && this.digitalLevel.get(key) !== null) {
          this.digitalLevel.set(key, null)
          this.emit({ port: p.port, pin: p.pin }, null, time)
        }
      } else if (this.padHasAf(p.port, p.pin, p.af)) {
        this.gpio[p.port].setAfOutput(p.pin, level, true)
        this.trackAf(p.port, p.pin, level)
        this.digitalLevel.set(key, level)
        this.emit({ port: p.port, pin: p.pin }, level, time)
      }
    }
  }

  /** Set a pad level at an exact simulated time (now or later): the digital fast path in. */
  hasPad(p: PadRef): boolean {
    return !!this.gpio[p.port] && Number.isInteger(p.pin) && p.pin >= 0 && p.pin < 16
  }
  setPadAt(p: PadRef, level: boolean, time: number) {
    if (!this.hasPad(p)) return
    if (time <= this.now) {
      // Already due (or late): apply now, but let responses carry the cause's own time.
      this.eventTime = Math.min(time, this.now)
      this.setPad(p, level)
      this.eventTime = null
      return
    }
    const ev = { pad: p, level, time }
    let i = this.padQueue.length
    while (i > 0 && this.padQueue[i - 1].time > time) i--
    this.padQueue.splice(i, 0, ev)
    this.schedule()
  }

  /** A timer channel output changed: drive every pad that is configured for it. */
  private driveTimOutput(pads: TimPad[], index: number, level: boolean | null, lag: number) {
    const channel = index >> 1
    const complementary = (index & 1) === 1
    for (const p of pads) {
      if (p.channel !== channel || !!p.complementary !== complementary) continue
      if (level === null) {
        this.gpio[p.port].setAfOutput(p.pin, false, false)
        this.trackAf(p.port, p.pin, null)
      } else if (this.padHasAf(p.port, p.pin, p.af)) {
        this.gpio[p.port].setAfOutput(p.pin, level, true)
        this.trackAf(p.port, p.pin, level)
        const key = p.port * 16 + p.pin
        if (this.digitalWatch.has(key) && this.digitalLevel.get(key) !== level) {
          this.digitalLevel.set(key, level)
          // The compare or update happened `lag` before the core's present (a late catch-up).
          this.emit({ port: p.port, pin: p.pin }, level, this.now - lag)
        }
      }
    }
  }

  setBattery(volts: number) {
    for (const a of this.adc) a.vbat = volts
  }

  private adcSource(channel: number, adc: number): AdcSource | null {
    const pad = adcPad(adc, channel)
    if (!pad) return null
    const dacChannel = DAC_PADS.indexOf(`P${"ABCDEFGHIJK"[pad.port]}${pad.pin}`)
    const throughDacBuffer = dacChannel >= 0 && this.dacOut.has(pad.port * 16 + pad.pin) && this.gpio[pad.port].mode(pad.pin) === 3 && this.dac.buffered(dacChannel)
    const volts = this.analogRead(pad)
    if (volts === null) return { ...this.loneNetSource(pad), throughDacBuffer }
    const source = this.analogSource(pad)
    return { volts, ohms: source?.ohms ?? 0, farads: source?.farads ?? 0, throughDacBuffer }
  }

  private loneNetSource(pad: PadRef): Omit<AdcSource, "throughDacBuffer"> {
    const drive = this.padDrive(pad)
    const farads = this.chip.electrical.pinCapacitance
    const driverOhms = this.chip.electrical.outputOhms ?? 0
    if (typeof drive === "number") return { volts: drive, ohms: 0, farads }
    switch (drive) {
      case "high":
        return { volts: this.vdda, ohms: driverOhms, farads }
      case "low":
        return { volts: 0, ohms: driverOhms, farads }
      case "pullup":
        return { volts: this.vdda, ohms: INTERNAL_PULL_OHMS, farads }
      case "pulldown":
        return { volts: 0, ohms: INTERNAL_PULL_OHMS, farads }
      default:
        return { volts: 0, ohms: FLOATING_NODE_LEAK_OHMS, farads }
    }
  }

  private dmaTransfersLeft(source: string): number {
    let left = 0
    this.dma.forEach((d, i) => {
      this.sync(d)
      const routes = i === 0 ? DMA1_REQUESTS : DMA2_REQUESTS
      routes.forEach((channels, stream) => {
        const cr = d.peekWord(DMA_STREAM_CR + DMA_STREAM_STRIDE * stream)
        const routed = (channels[(cr >>> DMA_SxCR_CHSEL_SHIFT) & 7] ?? "").split("/").includes(source)
        if (cr & DMA_SxCR_EN && routed) left = Math.max(left, d.peekWord(DMA_STREAM_NDTR + DMA_STREAM_STRIDE * stream))
      })
    })
    return left
  }

  private backupSramSurvives(cause: ResetCause, opts: { backup?: boolean; supplyKept?: boolean }): boolean {
    if (opts.supplyKept) return true
    if (cause === "por") return !!opts.backup && this.pwr.backupRegulatorOn()
    if (cause === "standby") return this.pwr.backupRegulatorOn()
    return true
  }

  private vdda: number
  private vrefPlus: number | null = null
  setSupply(volts: number) {
    if (Math.abs(volts - this.vdda) < VDDA_RESOLUTION) return
    this.vdda = volts
    this.pwr.setVdd(volts)
    if (this.vrefPlus === null) this.referTo(volts)
  }
  setReference(volts: number) {
    if (this.vrefPlus !== null && Math.abs(volts - this.vrefPlus) < VDDA_RESOLUTION) return
    this.vrefPlus = volts
    this.referTo(volts)
  }
  private referTo(volts: number) {
    for (const a of this.adc) a.vref = volts
    this.dac.setVref(volts)
  }

  padDrive(p: PadRef): PadDrive {
    // A DAC output overrides the pad while its channel is on (the pin is in analog mode then).
    const dac = this.dacOut.get(p.port * 16 + p.pin)
    if (dac !== undefined && this.gpio[p.port].mode(p.pin) === 3) return dac
    return this.gpio[p.port].padDrive(p.pin)
  }
  setPad(p: PadRef, level: boolean, sampledUnder?: PadDrive) {
    if (!this.hasPad(p)) return
    const g = this.gpio[p.port]
    if (sampledUnder !== undefined && g.readsBack(p.pin) && sampledUnder !== g.currentDrive(p.pin)) return
    g.setInput(p.pin, level)
  }
  setReadback(p: PadRef, code: number) {
    this.gpio[p.port].setReadback(p.pin, code)
  }
  setWiredPads(keys: Iterable<number>) {
    const masks = new Array<number>(this.gpio.length).fill(0)
    for (const key of keys) if (key >>> 4 < masks.length) masks[key >>> 4] |= 1 << (key & 15)
    this.gpio.forEach((port, i) => port.setSensed(masks[i]))
  }
  /** Sum of GPIO versions: cheap "anything changed on the pads?" check. */
  padVersion(): number {
    let v = 0
    for (const g of this.gpio) v += g.version
    return v
  }
}

/** The part on the NUCLEO-F429ZI; what the older scripts and tests instantiate. */
export class Stm32F429 extends Stm32 {
  constructor() {
    super(STM32F429ZI)
  }
}
