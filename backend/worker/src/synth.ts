import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { CELL_PINS, checkSynthOptions, evalInteger, guessTop, isCellType, languageOf, scanHdl, type CellType, type HdlLanguage, type HdlNetlist, type HdlPort, type PortDirection, type SynthOptions } from "emul-shared/hdl"
import type { SourceFile } from "emul-shared/source"

const YOSYS = process.env.YOSYS ?? "yosys"
const TIMEOUT_MS = 60_000
const MAX_LOG = 4 * 1024 * 1024
const MAX_CELLS = 200_000
const MAX_MEMORY_BITS = 16_384

export type SynthOutput = { ok: boolean; log: string; netlist?: HdlNetlist; error?: string }

const run = promisify(execFile)

export async function synth(files: SourceFile[], options: SynthOptions = {}): Promise<SynthOutput> {
  const bad = checkSynthOptions(options)
  if (bad) return { ok: false, log: "", error: bad }
  const hdl = files.filter((f) => languageOf(f.path))
  if (hdl.length === 0) return { ok: false, log: "", error: "no VHDL (.vhd) or Verilog (.v, .sv) sources" }
  const languages = new Set(hdl.map((f) => languageOf(f.path)!))
  if (languages.size > 1) return { ok: false, log: "", error: "VHDL and Verilog in one component are not supported: keep one language" }
  const language: HdlLanguage = languages.has("vhdl") ? "vhdl" : "verilog"
  if (scanHdl(hdl).length === 0) return { ok: false, log: "", error: `no ${language === "vhdl" ? "entity" : "module"} in the sources: a component needs one with ports` }
  const top = options.top ?? guessTop(hdl) ?? undefined
  const generics = Object.entries(options.generics ?? {})
    .map(([n, v]) => [n, v.trim()] as const)
    .filter(([, v]) => v !== "")

  const dir = await mkdtemp(path.join(tmpdir(), "emul-synth-"))
  const src = path.join(dir, "src")
  const out = path.join(dir, "out")
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C" }
  const lines: string[] = []
  const clean = (text: string) => text.split(`${src}/`).join("").split(`${out}/`).join("")
  const done = (result: SynthOutput): SynthOutput => ({ ...result, log: clean(result.log), error: result.error && clean(result.error) })
  const quoted = (paths: string[]) => paths.map((f) => JSON.stringify(f)).join(" ")
  try {
    for (const f of hdl) {
      const p = path.join(src, f.path)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, f.content)
    }
    await mkdir(out)

    const pre = path.join(out, "pre.json")
    const design = path.join(out, "design.il")
    const front = (std: string) => [
      ...(language === "vhdl"
        ? [
            `ghdl --std=${std} -fsynopsys --latches ${generics.map(([n, v]) => `-g${n}=${v.replace(/^"(.*)"$/, "$1")}`).join(" ")} ${hdl.map((f) => f.path).join(" ")} -e ${top ?? ""}`,
            "hierarchy -check -auto-top",
          ]
        : [`read_verilog -sv ${quoted(hdl.map((f) => f.path))}`, top ? `hierarchy -check -top ${top}${generics.map(([n, v]) => ` -chparam ${n} ${v}`).join("")}` : "hierarchy -check -auto-top"]),
      "proc",
      "flatten",
      "tribuf",
      "memory -nomap",
      "opt_clean",
      `write_json ${JSON.stringify(pre)}`,
      `write_rtlil ${JSON.stringify(design)}`,
    ]
    let std = language === "vhdl" ? "VHDL-2008" : "Verilog"
    let first = await yosys(front("08"), out, "front", src, env)
    if (first.error && language === "vhdl") {
      const older = await yosys(front("93c"), out, "front93", src, env)
      if (!older.error) {
        first = older
        std = "VHDL-93"
      }
    }
    lines.push(`# ${std}${top ? `, top ${top}` : ""}${generics.length ? `, ${generics.map(([n, v]) => `${n}=${v}`).join(", ")}` : ""}`)
    if (first.error) {
      lines.push(errors(first.log))
      const hint = language === "vhdl" && /\b(wait\s+(for|until|on)|after\s+\d)/i.test(hdl.map((f) => f.content.replace(/--[^\n]*/g, "")).join("\n")) ? TESTBENCH_HINT : ""
      if (hint) lines.push("", hint)
      return done({ ok: false, log: lines.join("\n"), error: first.error + (hint ? ` (${hint})` : "") })
    }
    const memory = memoryBits(JSON.parse(await readFile(pre, "utf8")) as YosysJson)
    if (memory > MAX_MEMORY_BITS)
      return done({ ok: false, log: lines.join("\n"), error: `${memory} bits of memory: the simulator keeps memory in flip-flops, so a component may have at most ${MAX_MEMORY_BITS} bits (${MAX_MEMORY_BITS / 8192} KB)` })

    const raw = path.join(out, "netlist.raw.json")
    const back = await yosys(
      [
        `read_rtlil ${JSON.stringify(design)}`,
        "synth -flatten",
        "dfflegalize -cell $_DFF_P_ 01 -cell $_DFFSR_PPP_ 01 -cell $_DLATCH_P_ 01 -cell $_DLATCHSR_PPP_ 01",
        "opt_clean -purge",
        "stat",
        `write_json ${JSON.stringify(raw)}`,
      ],
      out,
      "back",
      src,
      env,
    )
    lines.push("", "# yosys synth", back.error ? errors(back.log) : summary(first.log + back.log))
    if (back.error) return done({ ok: false, log: lines.join("\n"), error: back.error })

    const converted = convert(JSON.parse(await readFile(raw, "utf8")) as YosysJson, language)
    if (typeof converted === "string") return done({ ok: false, log: lines.join("\n"), error: converted })
    if (language === "vhdl") vhdlIndices(converted, hdl, options)
    lines.push(`# ${converted.top}: ${converted.ports.length} ports, ${converted.cells.length} cells`)
    return done({ ok: true, log: lines.join("\n") + "\n", netlist: converted })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const TESTBENCH_HINT = "wait for, wait until and after are testbench constructs: a component describes hardware, which has no delays to wait for; use a clock input and a counter instead"

async function yosys(commands: string[], out: string, name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ log: string; error?: string }> {
  const script = path.join(out, `${name}.ys`)
  const logPath = path.join(out, `${name}.log`)
  await writeFile(script, commands.join("\n"))
  const result = await exec(YOSYS, ["-q", "-m", "ghdl", "-l", logPath, "-s", script], cwd, env)
  const log = (await readFile(logPath, "utf8").catch(() => "")) + result.stderr
  const all = log.split("\n")
  const firstError = all.find((l) => /:\d+(:\d+)?:\s*error/i.test(l)) ?? all.find((l) => /error/i.test(l) && !/import failed/.test(l)) ?? all.find((l) => /error/i.test(l))
  return { log, error: result.error && (firstError?.trim() || result.error) }
}

function errors(log: string): string {
  return log
    .split("\n")
    .filter((l) => /error|warning/i.test(l) && !/^\s*(Warnings|Found and reported)/.test(l))
    .filter((l, i, all) => all.indexOf(l) === i)
    .join("\n")
}

function memoryBits(json: YosysJson): number {
  let bits = 0
  for (const mod of Object.values(json.modules))
    for (const cell of Object.values(mod.cells)) {
      if (!cell.type.startsWith("$mem")) continue
      const p = cell.parameters ?? {}
      bits += parseInt(p.SIZE ?? "0", 2) * parseInt(p.WIDTH ?? "0", 2)
    }
  return bits
}

function vhdlIndices(netlist: HdlNetlist, files: SourceFile[], options: SynthOptions) {
  const unit = scanHdl(files).find((u) => u.name.toLowerCase() === netlist.top.toLowerCase())
  if (!unit) return
  const values = { ...Object.fromEntries(unit.generics.map((g) => [g.name, g.value])), ...options.generics }
  for (const port of netlist.ports) {
    const range = unit.ranges[port.name.toLowerCase()]
    if (!range) continue
    const left = evalInteger(range.left, values)
    const right = evalInteger(range.right, values)
    if (left === null || right === null || Math.abs(left - right) + 1 !== port.bits.length) continue
    port.offset = Math.min(left, right)
    port.upto = range.dir === "to"
  }
}

function summary(log: string): string {
  log = log.slice(Math.max(0, log.lastIndexOf("Printing statistics")))
  const keep = log.split("\n").filter((l) => /warning|error|Number of cells|^\s+\$_/i.test(l) && !/^\s*Warnings: \d+ unique/.test(l))
  return keep.join("\n")
}

type YosysBit = number | "0" | "1" | "x" | "z"
type YosysJson = {
  modules: Record<
    string,
    {
      attributes?: Record<string, string>
      ports: Record<string, { direction: PortDirection; bits: YosysBit[]; offset?: number; upto?: number }>
      cells: Record<string, { type: string; parameters?: Record<string, string>; connections: Record<string, YosysBit[]> }>
      netnames: Record<string, { bits: YosysBit[]; attributes?: Record<string, string> }>
    }
  >
}

function convert(json: YosysJson, language: HdlLanguage): HdlNetlist | string {
  const entries = Object.entries(json.modules)
  const found = entries.find(([, m]) => m.attributes?.top && /1$/.test(m.attributes.top)) ?? (entries.length === 1 ? entries[0] : undefined)
  if (!found) return "no top-level unit after synthesis"
  const [top, mod] = found
  const ids = new Map<number, number>()
  const net = (b: YosysBit): number => {
    if (b === "1") return 1
    if (typeof b !== "number") return 0
    let id = ids.get(b)
    if (id === undefined) {
      id = ids.size + 2
      ids.set(b, id)
    }
    return id
  }
  const ports: HdlPort[] = Object.entries(mod.ports).map(([name, p]) => ({ name, dir: p.direction, bits: p.bits.map(net), offset: p.offset ?? 0, upto: p.upto === 1 }))
  if (ports.length === 0) return `${top} has no ports: a component needs inputs or outputs to wire`
  const cells: HdlNetlist["cells"] = []
  const unknown = new Set<string>()
  for (const cell of Object.values(mod.cells)) {
    if (cell.type === "$scopeinfo") continue
    if (!isCellType(cell.type)) {
      unknown.add(cell.type)
      continue
    }
    const type: CellType = cell.type
    cells.push([type, ...CELL_PINS[type].map((pin) => net(cell.connections[pin]?.[0] ?? "x"))])
  }
  if (unknown.size) return `cells the simulator does not model: ${[...unknown].join(", ")}`
  if (cells.length > MAX_CELLS) return `${cells.length} cells: more than the ${MAX_CELLS} a component may have`
  const init = new Set<number>()
  for (const n of Object.values(mod.netnames)) {
    const value = n.attributes?.init
    if (!value || !/^[01xz]+$/.test(value)) continue
    n.bits.forEach((b, i) => {
      if (value[value.length - 1 - i] === "1" && typeof b === "number") init.add(net(b))
    })
  }
  return { top, language, nets: ids.size + 2, ports, cells, init: [...init].sort((a, b) => a - b) }
}

async function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; error?: string }> {
  try {
    const { stdout, stderr } = await run(file, args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_LOG, killSignal: "SIGKILL" })
    return { stdout, stderr }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }
    const stdout = err.stdout ?? ""
    const stderr = err.stderr ?? ""
    if (err.code === "ENOENT") return { stdout, stderr, error: `${path.basename(file)} is not installed` }
    if (err.killed || err.signal) return { stdout, stderr, error: `${path.basename(file)} took longer than ${TIMEOUT_MS / 1000} s and was stopped` }
    const first = (stderr + stdout).split("\n").find((l) => /error/i.test(l))
    return { stdout, stderr, error: first?.trim() || `${path.basename(file)} exited with ${String(err.code)}` }
  }
}
