import { portPins, type HdlLanguage, type HdlNetlist, type HdlPort } from "emul-shared/hdl"
import type { SourceFile } from "emul-shared/source"
import { HdlIcon } from "./icons"
import type { ComponentDef, Element, HdlModule, PinDef } from "./types"

export const HDL_PREFIX = "hdl:"
export const HDL_CATEGORY = "HDL"

const ABS_MAX = 7
const PIN_CURRENT = 25e-3
const LABEL_CELLS = 0.26

export const isHdlDef = (id: string) => id.startsWith(HDL_PREFIX)

export function newModuleId(): string {
  return `${HDL_PREFIX}${crypto.randomUUID().slice(0, 8)}`
}

export function sourceKey(m: Pick<HdlModule, "files" | "top" | "generics">): string {
  const text = JSON.stringify([m.files.map((f) => [f.path, f.content]), m.top ?? "", Object.entries(m.generics ?? {}).filter(([, v]) => v.trim() !== "").sort()])
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

export const isModified = (m: HdlModule) => !m.netlist || m.builtFrom !== sourceKey(m)

function orderedPins(port: HdlPort): string[] {
  const pins = portPins(port).map((p) => p.pin)
  return port.bits.length > 1 ? pins.reverse() : pins
}

export function hdlDef(m: HdlModule): ComponentDef | null {
  const netlist = m.netlist
  if (!netlist) return null
  const left = netlist.ports.filter((p) => p.dir === "input").flatMap(orderedPins)
  const right = netlist.ports.filter((p) => p.dir !== "input").flatMap(orderedPins)
  const dirOf = new Map(netlist.ports.flatMap((p) => portPins(p).map(({ pin }) => [pin, p.dir] as const)))
  const taken = new Set([...left, ...right].map((p) => p.toUpperCase()))
  const free = (...ids: string[]) => ids.find((id) => !taken.has(id)) ?? `${ids[0]}_PWR`
  const vcc = free("VCC", "VDD", "VCC_PWR")
  const gnd = free("GND", "VSS", "GND_PWR")
  const longest = (pins: string[]) => pins.reduce((n, p) => Math.max(n, p.length), 0)
  const inner = Math.max(4, Math.ceil((longest(left) + longest(right)) * LABEL_CELLS + 1.5), Math.ceil(m.name.length * 0.24 + 1))
  const W = inner + 2 + ((inner + 2) % 2)
  const rows = Math.max(left.length, right.length, 2)
  const H = rows + 2
  const note = (pin: string) => {
    const dir = dirOf.get(pin)
    return dir === "input" ? "Input" : dir === "output" ? "Output, 25 mA absolute maximum" : "Bidirectional (drives or releases), 25 mA absolute maximum"
  }
  const pins: PinDef[] = [
    ...left.map((id, i): PinDef => ({ id, label: id, x: 1, y: 1 + i, side: "left", labelAt: "right", kind: "digital", note: note(id) })),
    ...right.map((id, i): PinDef => ({ id, label: id, x: W - 1, y: 1 + i, side: "right", labelAt: "left", kind: "digital", note: note(id) })),
    { id: vcc, label: "VCC", x: W / 2, y: 0, side: "top", labelAt: "right", kind: "power", note: `Logic supply, ${ABS_MAX} V absolute maximum` },
    { id: gnd, label: "GND", x: W / 2, y: H, side: "bottom", labelAt: "right", kind: "gnd" },
  ]
  const model: Element[] = [
    { kind: "R", a: vcc, b: gnd, value: 100e3, limits: { voltage: ABS_MAX, fail: "short" } },
    ...[...left, ...right].map((node): Element => ({ kind: "GPIO", node, vddNode: vcc, limits: { voltage: ABS_MAX, current: PIN_CURRENT, fail: "open" } })),
  ]
  return {
    id: m.id,
    name: m.name,
    description: `${netlist.language === "vhdl" ? "VHDL" : "Verilog"} · ${netlist.top} · ${netlist.cells.length} cells`,
    category: HDL_CATEGORY,
    icon: HdlIcon,
    prefix: "U",
    width: W,
    height: H,
    pins,
    parts: [],
    body: [
      { type: "rect", x: 1, y: 0.5, w: W - 2, h: H - 1, rx: 0.2, fill: "board" },
      { type: "text", x: W / 2, y: H - 0.85, text: m.name, size: 0.34 },
      { type: "text", x: W / 2 - 0.4, y: 0.15, text: "{ref}", size: 0.3, anchor: "end", muted: true },
    ],
    model,
  }
}

export const TEMPLATES: Record<HdlLanguage, (name: string) => SourceFile> = {
  vhdl: (name) => ({
    path: `${name}.vhd`,
    content: `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ${name} is
  generic (WIDTH : natural := 4);
  port (
    clk : in  std_logic;
    rst : in  std_logic;
    q   : out std_logic_vector(WIDTH - 1 downto 0)
  );
end entity;

architecture rtl of ${name} is
  signal count : unsigned(WIDTH - 1 downto 0) := (others => '0');
begin
  process (clk, rst)
  begin
    if rst = '1' then
      count <= (others => '0');
    elsif rising_edge(clk) then
      count <= count + 1;
    end if;
  end process;

  q <= std_logic_vector(count);
end architecture;
`,
  }),
  verilog: (name) => ({
    path: `${name}.v`,
    content: `module ${name} #(parameter WIDTH = 4) (
  input  wire             clk,
  input  wire             rst,
  output reg  [WIDTH-1:0] q = 0
);
  always @(posedge clk or posedge rst)
    if (rst) q <= 0;
    else     q <= q + 1;
endmodule
`,
  }),
}

export function netlistPins(netlist: HdlNetlist): string[] {
  return netlist.ports.flatMap((p) => portPins(p).map((x) => x.pin))
}
