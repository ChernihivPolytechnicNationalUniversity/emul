# Architecture

## Layout

- `src/mcu/` — the emulator: `cpu.ts`, `decode.ts`, `jit.ts` (blocks compiled to JavaScript), `scs.ts` (NVIC/SysTick/SCB), `bus.ts`, `periph/*`, `chip.ts` (profiles), `stm32f429.ts` (the SoC class `Stm32`), `debugger.ts` (breakpoints and stepping, beside the core), `core-worker.ts` (one core in a worker of its own)
- `src/sim/` — analog engine (`engine.ts`), netlist, the co-simulation loop (`loop.ts`) and its worker, `core-host.ts` (a core in this thread or in a worker, over a SharedArrayBuffer), digital parts (`digital.ts`)
- `src/schematic/` — component definitions (`components/*`), examples, geometry, `mcu-model.ts`; wiring in `nets.ts` (the net map), `wiring.ts` (connect, tap), `wire-colors.ts` (palette, shortcuts, the automatic rule)
- `src/debug/` — the debugger's reading of an image: `dwarf/*` (DWARF 2–5: units, line programs, range and location lists, call frame information, expressions, macros), `lines.ts` (the line table, shared by the core and the editor), `info.ts`, `unwind.ts`, `values.ts` and `eval.ts` (values and C expressions over a stop's memory), `disasm.ts`, `sources.ts` (where a file the image names comes from); `session.ts` is the UI's controller for the whole bench
- `src/components/` — the React UI; `code/` is the editor panel (Monaco, explorer, tabs, build output), `debug/` its debugger toolbar and panes
- `src/project/` — a board's firmware project: file operations that mirror the API's rules, the template, the build-service client, and the STM32 project import and export (`cubemx.ts` reads the `.ioc` and decides what to keep; `entries.ts` turns a picked folder, a drop or a `.zip` into files, `.zip`s through `src/lib/zip.ts`; `cubeide.ts` makes an STM32CubeIDE project from a board's code, its `.cproject` and `.project` from the templates in `cubeide/`, the drivers and the build service's files from the site's `/st/` through `st-sources`' index)
- `firmware/` — test firmware and HAL apps (`hal/Src/main.c` blink, `square.c`, `pwm.c`, `uart.c`, `spi.c`, `spi-slave.c`, `i2c.c`, `dma.c`, `adc.c`, `wdg.c`), the lab's CubeIDE project (`lab1/`), the Open746I-C demos (`lcd/`), and their built images in `examples/` for the test scripts; the site bundles the sources as the examples' projects (`src/schematic/projects.ts`)
- `scripts/` — the test drivers above
- `backend/` — the services below: `api/`, `worker/` (firmware builds, and HDL synthesis in a second image), `shared/`

## Services

The site is static. Work that needs a machine — building firmware — goes through two more containers,
each from its own Dockerfile and built in parallel by CI:

- `api/` — Fastify, on the site's host under `/api`. `POST /api/jobs` takes `{kind, target, files: [{path, content}], options?: {opt}}`, stores the
  project in S3 and enqueues; `GET /api/jobs/:id` reports the state and, once done, the job's files as presigned S3 URLs (15 min) —
  the browser fetches them from the store directly, the bucket stays private. `/healthz` is 503 while Redis is down.
  `POST /api/shares` takes a zstd `.emul` project (`application/zstd`, 60 per IP an hour), stores it and returns an 8-character id;
  `GET /api/shares/:id` serves it back. The site opens `/s/<id>` as a read-only view of that project.
- `api/src/collab.ts` — live sessions, a second process from the same image (`pnpm collab`, port 8788), on the site's host
  under `/collab`. Hocuspocus over WebSocket: one Yjs document per room (`/r/<10 chars>`), the bench split into one entry
  per object, wire, part state and HDL module (`src/collab/elements.ts`), last writer wins per entry. Rooms are kept in
  Redis for 7 days and fanned out across replicas through Redis. Cursors, names and in-progress drags travel as
  awareness, never as document edits.
- `worker/` — BullMQ consumer; one handler per job kind in `worker/src/handlers.ts` (`echo` lists the project back, `build` compiles it),
  each leaving files in `out/` and saying whether the project passed; a compile error is a completed job with `ok: false` and a log,
  only the service's own failure fails the job. The worker holds **no store credentials**: each job carries presigned GET URLs for its
  sources and presigned PUT URLs for its outputs (an hour), because it runs a compiler over code it did not write and a
  `.incbin "/proc/1/environ"` must find nothing worth taking; the compiler also gets an empty environment.
- `shared/` — the contract between them: job types, the S3 layout, the queue, Redis and S3 clients, env config.

One prefix per job in the bucket, expired by a lifecycle rule after 7 days (ids are ULIDs, so they sort by time and never repeat):

```
jobs/<id>/input/project.json   target, options, createdAt, files with size and sha256
jobs/<id>/input/src/<path>     sources as sent; paths relative, plain characters, source extensions only
jobs/<id>/out/<name>           firmware.elf, firmware.map, build.log, …
jobs/<id>/result.json          ok, artifacts, finishedAt, durationMs — kept after Redis forgets the job
```

Shared projects sit under `shares/<id>.emul` and are not expired (the lifecycle rule covers `jobs/` only).

Both read `REDIS_URL`; the API also `S3_BUCKET`, `S3_ENDPOINT` (MinIO; unset for AWS), `S3_PUBLIC_ENDPOINT` (the host browsers reach, presigned URLs are signed for it), `S3_REGION`, `S3_FORCE_PATH_STYLE`,
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (unset: the SDK's default chain), and a missing bucket fails it at start; the worker `WORKER_CONCURRENCY`.
Locally: `pnpm api`, `pnpm worker`; the Vite dev server proxies `/api` to the API. The editor's completions come from
`public/symbols/<chip>.json` (`scripts/symbols.ts` over the staged ST sources: `sh backend/worker/toolchain/stage-st.sh /tmp/st && pnpm symbols /tmp/st public/symbols`);
the site image does this at build time, a dev checkout without it has the project's own symbols only. The debugger's ST
sources (`public/st/`, the files the images name as `/opt/st/…`, the build service's own files with its linker scripts and `target.json`, and an `index.json` listing them, which the STM32CubeIDE export packs from) and peripheral register maps
(`public/peripherals/<chip>.json`, from the CMSIS device headers) come the same way: `pnpm st-sources /tmp/st public/st && pnpm peripherals /tmp/st public/peripherals`.

## The build

`worker/src/build.ts` compiles a project the way STM32CubeIDE would, with GNU Arm Embedded (Debian's `gcc-arm-none-eabi`, newlib nano):
the project's `.c`/`.cpp`/`.s` files, every folder holding a header on the include path, ST's HAL and CMSIS, `-g3 -Wall
-ffunction-sections -fdata-sections` at the optimization level the job names (`options.opt`: `-O0`, `-Og`, `-O1`, `-O2`, `-O3` or `-Os`;
`-O2` when it names none, while the editor asks for `-O0` unless the board says otherwise), `--gc-sections`, one `firmware.elf` plus
`firmware.map`. `-g3` at every level keeps the macros for the debugger's expressions. What a CubeMX project has and a
bare one does not — the "batteries" — comes from `worker/targets/<chip>/`: the linker script, `startup_*.s`, `system_*.c`, `*_it.c`,
`*_hal_msp.c`, `*_hal_conf.h` (every module on) and, for all chips, `targets/common/syscalls.c` (weak `_write`, `_sbrk`, …). A project
file with the same name replaces the battery, so a CubeIDE export drops in as is (`firmware/lab1` is one); a project's own `startup_*.s` replaces the
battery's whatever it is called (CubeIDE names it after the part, `Core/Startup/startup_stm32f746igtx.s`), and of several linker scripts the `_FLASH` one links. The HAL is compiled once
per chip into `libhal.a` when the image is built (`worker/toolchain/`: ST's repos at pinned tags; `-O2` whatever the project asks), so a build takes about a second;
a project with its own `stm32fNxx_hal_conf.h` gets the HAL compiled from source against it instead (~10 s). 120 s and 4 MB of log
are the limits. `targets/<chip>/target.json` names the chip, CPU flags, defines and linker script; adding a chip is adding a folder
and a line in the Dockerfile.

## HDL components

A component can be described in VHDL or Verilog: File › New VHDL/Verilog component, or Import VHDL / Verilog… for existing files.
The sources live in the schematic (`Schematic.library`, one `HdlModule` per component, with the top unit and generic values), so a
saved file carries its components and every placed instance shares one definition. Build sends a `synth` job to the `hdl` queue,
which a second worker image (`backend/worker/Dockerfile.hdl`, Debian trixie with GHDL 5 and Yosys, `WORKER_QUEUE=hdl`) takes:

- VHDL goes through GHDL inside Yosys (ghdl-yosys-plugin, built in the image at a commit pinned for GHDL 5), `--std=08 -fsynopsys --latches`,
  retried as VHDL-93 when 2008 fails; Verilog goes to `read_verilog -sv`. The top is the one asked for, else the unit with ports that
  nothing else instantiates (a testbench has no ports, and what it instantiates does not count).
- Yosys runs twice over an RTLIL snapshot: `proc; flatten; tribuf; memory -nomap` first, so a memory over 16 Kbit is refused in a
  fraction of a second instead of being mapped to flip-flops for a minute; then `synth -flatten`, flip-flops and latches legalised to
  `$_DFF_P_`, `$_DFFSR_PPP_`, `$_DLATCH_P_`, `$_DLATCHSR_PPP_`, and the JSON packed into `netlist.json` (`backend/shared/src/hdl.ts`:
  nets as integers, 0 and 1 the constants). VHDL port ranges (`0 to 7`, `8 downto 1`) are restored from the source.
- Only synthesisable code is accepted: `wait for`, `after`, `report` and file I/O are testbench constructs with no hardware behind them.

The netlist is saved with the module, so a schematic runs without the service. `src/schematic/hdl.ts` turns it into a symbol (inputs
left, outputs and inouts right, VCC and GND; 7 V and 25 mA per pin absolute maximum) and `src/sim/hdl.ts` simulates it as a digital
part: event-driven, combinational cells settle first and every flip-flop then samples at once, `inout` pins drive through their
tri-state buffers and release otherwise (several on one net resolve together, low winning a conflict), and a loop that never settles is reported on the inspector instead of hanging the step.
Inputs arrive from the digital nets like any digital part's, so a clock from a pulse source is resolved to the analog step (20 µs)
and one from an MCU pin exactly. A rebuild replaces the part on the running bench with the new netlist, starting from power-on with
the levels its nets have now. Cost is per clock edge and grows with the flip-flop count: about 3 µs for a UART, 9 µs for a small
8-bit CPU, 1.3 ms for a 2 KB RAM (53 000 cells).

## Switching inside a step

The analog step is fixed at 20 µs, which is fine for an RC network and far too coarse for a latch: a 555 at
4.8 kHz switching only on step boundaries would be off by tens of per cent. A latched element (`TMR`, the
NE555) therefore switches where its comparator actually crosses. `Engine.step` solves the step with the states
it starts with, finds the earliest crossing of any timer by interpolating each comparator's margin across the
step (`findTimerEvent`), re-solves up to that instant and refines it by regula falsi until the margin is within
1 µV (`settleEvent`), commits that part of the step, flips the latch and solves the rest — repeating for every
crossing, up to sixteen per timer a step. Trial solves are transactional: an arc a discarded trial struck is put
back before the step is solved again. After a flip the step goes on in controlled sub-steps, each twice the last:
the first, 2 % of the step, by backward Euler so the capacitor current from before the switch does not leak into
the step after it; the next ones by the θ-method, except while some capacitor would settle faster than the next
sub-step (its capacitance over the conductance its nodes see on the last Jacobian) and its present current would
give the trapezoidal rule a kick over 50 mV — then backward Euler again, because the trapezoidal rule integrating
a node that has already settled from the current it had while settling throws it past the supply (1 nF on a 555's
output read 5.3 V on 5 V, 100 nF 26 V). Control ends once a sub-step would reach the whole step or three steps
after the switch. The control carries over into the next step when a switch lands at the
end of one. The latch states are part of the switch mask, so the operating-point memo and the settled path see a
flip as a change of circuit. `onTimer` reports every output transition with its exact time.

Digital parts with a supply of their own (the 74HC595) declare its model nodes (`supply`) and get `sense` called
each step with their VCC and their pin voltages: power-on and power-off, VCC out of range, an input sitting
between VIL and VIH. On a net nothing drives digitally, such a part reads the voltage against its own
`thresholds` instead of the 3.3 V STM32 levels the loop uses for everything else; on a net an MCU or another part
drives, it gets the exact-time edges like any digital part — unless the voltage there, held for two steps, says
the opposite of what the driver claims (a 2 V chip's high on a 6 V chip's input), in which case it takes the
voltage and warns. Its pins are GPIO elements switching to its internal VCC and GND rails, with a drive resistance
that scales with its supply, rated against its own ground.

Edges digital parts produce carry their propagation delay, so they are dispatched in time order: while a level is
being delivered (and while the loop thresholds analog nets or senses supplies), a part's new edges wait in a queue
sorted by time and go out once the delivery is over. A clock shared by two chips reaches both before either one's
delayed output reaches the other. Edges an MCU makes a few nanoseconds apart are still delivered one by one, each
with whatever its parts answer, so a part's reply can overtake a second MCU edge less than its propagation delay
behind the first.

## Buzzers

Every preset in `BUZZER_PRESETS` (`src/sim/buzzer.ts`, with the physics) is a datasheet and a
palette entry of its own: `src/schematic/components/buzzer.ts` builds one `ComponentDef` per
preset, id `buzzer-<preset id>`, carrying only its kind's model elements and inspector fields (the
four kinds' circuits have nothing in common), with the preset's values as the fields' placeholders.
`buzzerSpec(preset, props)` lays the overrides over the preset; `createDigitalPart` finds the preset
from the def id (`buzzerOfDef`). The symbol is 4 × 5 cells with both pins at the bottom; the
reference and, under it, the preset's `badge` (muted) sit above the bowl, on the side away from the
pins, so no wire runs through them in any rotation, and `+` is text, so it stays upright.

Every number a preset carries is read off its manufacturer's datasheet, and where a datasheet gives
both, the typical value rather than the guaranteed minimum or maximum: a simulated part should do
what a real one on the bench does. The sources, the readings and what is inferred are listed per
preset in the coursework's knowledge base (`docs/emul-buzzer/research/preset-verification.md` and
`sheets/`). Each preset also says whether its rated level is A-weighted (`ratedWeighting`), as its
datasheet measured it.

- **Passive magnetic**: the coil's resistance (rated for the power a 50 % square at the top of the
  operating range puts into it, heating with a 3 s time constant, failing open) in series with its
  inductance. No manufacturer publishes the inductance; it is the value that makes a coil switched
  at the rated voltage and frequency through a freewheeling diode draw the datasheet's mean current
  (1.65 mH for the CEM-1203(42), 2.48 mH for the AT-1224, 0.28 mH for the CMT-0904).
- **Passive piezo**: C0 between the pins and a Butterworth–Van Dyke motional branch through two
  hidden nodes: Cm a tenth of C0 (audible sounders' resonance and anti-resonance put the ratio at
  0.1–0.17), Lm resonating with Cm at the part's resonance, Rm setting its Q. The datasheet's
  capacitance is what a meter reads at its measuring frequency (1 kHz for the PKM13, 120 Hz for the
  PKM17), where the motional branch adds Cm / (1 − (f/f0)²), so C0 is solved for that reading to come
  out exact (4.97 nF for the PKM13's 5.5 nF). The datasheet's maximum input is a drive rating: over
  it, judged on the drive's amplitude (Vo-p, as the sheet defines it) rather than an instantaneous
  peak, the part warns; the ceramic depolarises, and C0 fails open, only at twice it, an inference
  from PZT's coercive field over a thin disc, since no maker publishes a destruction voltage.
  Operating-range warnings, here and for the other kinds, allow 2 % so that a part on exactly its
  limit through a switch's few millivolts does not warn.
- **Active** (magnetic or piezo): one resistor whose value the part answers live (`$osc`). Its
  oscillator starts at 0.8 × the bottom of the operating range and stops 10 % lower — no datasheet
  states either — and then switches the load between V / (2·I(V)) and 100 kΩ at the tone, half a
  period each, so the supply sees the ripple a blocking oscillator makes and its mean current is the
  datasheet's at whatever voltage it is on. Level, tone and current follow the datasheet's curves
  against the supply (`supply` on the preset, points read off the curves): an SDC1610M5-01 goes from
  89.3 dB(A), 2468 Hz and 15.9 mA at 4 V to 91.8 dB(A), 2340 Hz and 24.5 mA at 7 V, as TDK draws it.
  A part whose maker publishes no curves borrows the shape of the nearest one that does, scaled to
  its own rated point. Reversed it is 1 MΩ, and beside it runs a hidden reverse path from
  pin 2 to pin 1, the way a blocking oscillator (an NPN with the coil in its collector) conducts
  reversed: a 7 V zener (the transistor's emitter–base breakdown, typical for a small NPN), a diode
  (its base–collector junction, forward) and the oscillator's on-resistance standing for the coil.
  Up to 7 V reversed it draws nothing. Past that it clamps: a passive coil's kick on a shared rail
  (the "Buzzers on DC" example, where releasing SW1 drove the node to −8.5 V and an instant
  `reverse` rating used to kill the TMB12A05) now stops near −8 V and puts µJ into the junction.
  The zener is rated 0.15 W with the coil's 3 s heating time constant, so a sustained reverse is a
  matter of power and time: a stiff 12 V reversed drives 42 mA, 0.3 W, and the part dies in about
  2 s; the threshold for the TMB12A05 is about 9.9 V. An active piezo's driver IC gets the same
  path for want of its schematic (its 375 Ω on-resistance puts its threshold near 16 V).

The `Buzzer` digital part (`createDigitalPart`) runs beside the circuit. Each step it reads the
drive off the solved nodes (`senses` may name an internal node: the loop falls back to the netlist's
`nodeNet`): the coil current (V(1) − V($m)) / R, or the voltage across a piezo, or for an active
part its supply, from which its own oscillator makes a square at the tone, each step sampled as
the share of the step it is high. The drive goes through the sounder's response as a force, and
the pressure that comes out is both what the inspector reads and what the speaker plays. Each
resonance is the acceleration of a driven mass on a spring, s² / (s² + s·ω/Q + ω²); a part has one
or several (`frequency`/`q` and `modes`, relative to the first), and an enclosed sounder may add a
cavity high-pass of the same form (`cavity`), which gives the steeper fall below resonance its
Helmholtz cavity makes. Several modes are summed in power, Σ g²·|r_k|², because a coherent sum puts
notches between them that no datasheet curve shows (13 dB deep at 3.6 kHz for the CEM-1203(42)).
That magnitude is realised as one causal, minimum-phase filter: its zeros are the left-half-plane
square roots of the roots of Σ g_k² Π_{j≠k} D_j(s)D_j(−s), a polynomial in s² found by
Durand–Kerner in frequency normalised to the first mode (`src/sim/polynomial.ts`). Every pole and
zero is carried to the 20 µs step by z = e^{sT} and the gain matched at the first mode; that keeps
the response within 0.1 dB of the analog fit up to 12 kHz for every preset, where per-section
prewarped bilinear biquads were 0.4–1.9 dB out. The modes are fitted to each part's published
frequency response: a magnetic part's to its square-wave sweep, through the coil current a square
makes in R–L with a freewheeling diode, with the rated point held exact; a piezo's to its
square-wave sweep the same way where the maker publishes a consistent one (the PKM13, 0.9 dB rms),
otherwise to its sine sweep (the transfer function itself), peak by peak, with the half-power width
for Q (the fits and the digitized curves are kept in the coursework's knowledge base,
`docs/emul-buzzer/`). The peaks a
square drive makes at f1/3 and f1/5 come out by themselves. When the part is configured, a quarter of a second of its
datasheet's rated drive is run through the same filters and the scale set so that it reads the
rated level, A-weighted or flat as the datasheet measured it. An active part's oscillator drive is
scaled so that the level, through the same filters, lands on its datasheet's level-against-supply
curve at the tone it is then making. A magnetic part's force is its coil current (the magnet's bias
makes it linear), so a part driven under its operating range is quieter in proportion and nothing
more; no datasheet gives a steeper fall. The level is an A-weighted mean square over 5 ms (a 52 ms beep reads its level, and its tail is gone within 30 ms); the drive's
frequency comes from its rising crossings. The snapshot holds the level and tone of the last beep
for 1.5 s, and warns — after 50 ms, or 0.5 s for DC — about DC through a coil or across a piezo, a
drive outside the operating range, an active part below its start voltage, reversed (past its breakdown: the current it conducts and
whether that kills it), over its maximum, or switched on and off more than 50 times a second (it can only gate its own tone). The sound
arcs on the symbol (`PartDef` `sound`) take the level, 50 dB(A) dark to 100 dB(A) full, in tenths, so
the field re-renders only when they visibly change.

The palette's MOSFETs avalanche: the body diode breaks down at 1.2 × the rated Vds (V(BR)DSS is a
minimum; parts break down above it), and its heating time constant is EAS / Pmax, so a pulse
shorter than that fails it once its energy passes the datasheet's single-pulse avalanche energy,
and a longer one is held against Pmax. A coil let go without a flyback diode is clamped instead of
killing the part on its Vds rating. A buzzer coil's kick lasts L·I / (V(BR) − Vdd) ≈ 2 µs, inside
one step: the step's share of it is what the solver sees.

## The linear solve

Each Newton iteration factors the MNA matrix and substitutes through it (`src/sim/sparse-lu.ts`). The matrix is
stamped dense, but every stamp goes through `Engine.cell`, which marks the entry in the factor's structural
pattern, so the pattern is every entry any stamp has touched, zero or not, as SPICE's `spGetElement` allocates
it. The first factorization orders the pivots the way Sparse 1.3 does in ngspice (`spOrderAndFactor` with
`DIAGONAL_PIVOTING`): the smallest Markowitz product (r − 1)(c − 1) among the diagonal entries that pass the
threshold, the whole matrix only when none does, a pivot accepted when it is at least 10⁻³ of the largest entry
left in its column (ngspice's `PIVREL`) and above 10⁻¹⁸. It records the fill-in, and every later factorization
walks only that pattern in that order. The order is redone when a stamp lands outside the pattern or when a
reused pivot falls under the threshold against its column, a stricter test than ngspice's `spFactor`, which
reuses the order until a pivot is exactly zero; KLU's guide recommends a check of this kind after `klu_refactor`.
On the examples the order is redone one to seven times in two simulated seconds.

The dense factorization this replaced cost O(n³) every step. On the metronome (53 unknowns, 115 elements) a 20 µs
step took 113 µs in Node, 46 of them in the factorization; it now takes about 45. Measured in headless
Chromium on the same machine, the metronome ran at 0.12× real time and now runs at 0.62×, the NE555 flasher at
1.3× and now 3.8×, the charge-and-boost board at 1.2× and now 3.4×. The rest of that gain came from walking
per-kind index lists instead of every element (strike checks, the switch mask, the Newton stamps), reusing the
operating-point memo's arrays, caching each part's heating factor per step length, and caching a wire's marker
speed while its current holds within 0.1 %.

## Threads

The UI thread draws; the simulation worker runs the analog solver, the digital parts and the
loop; and, when the page is cross-origin isolated (the dev server and nginx send the COOP/COEP
headers), every MCU core runs in a worker of its own, pipelined one 20 µs step ahead of the
solver — pad and pin levels cross with 20 µs of latency, which the inspector says ("Runs:
worker (pipelined)"). A core with a digital part on its nets (an I²C EEPROM, the GT911) drops
into step with the loop while that traffic lasts, and two cores sharing a net stay in the
solver's thread in lockstep. Without isolation everything runs in the simulation worker.

## The debugger

Breakpoints and steps are the core's business: `src/mcu/debugger.ts` sits beside the CPU in whichever thread runs it and
resolves breakpoints (a source line, a function, an address) against the image's own line table (`src/debug/lines.ts`, the code
the editor marks lines with). A compiled block ends where a breakpoint is, so the JIT keeps its speed between them. A line step
runs until a statement of another line starts, with blocks split at line boundaries while it lasts; step over and step out run
to the return address under a temporary breakpoint, the stack pointer checked so a recursive call does not end them early; an
interrupt taken mid-step runs to its return. A fault stops the core as it is entered (vector catch, on unless the board turns it
off), and so does a `BKPT`.

A probe on a real board halts the core while the world runs on; here the bench is one machine. A stop on any core ends the
solver step it happened in and pauses the loop (`SimLoop.debugStops`), so the circuit freezes with the program, and a step takes
the whole bench along for as long as it runs: stepping over `HAL_Delay(500)` runs the circuit 500 ms. A core in a worker reports
its stop in the output bank of its SharedArrayBuffer. Registers and memory are read at a stop by message (`inspect`) and never
disturb a peripheral: a USART's DR or an I²C status register is peeked, not read.

The UI's side is `src/debug/session.ts`. At a stop it fetches the registers and the chip's RAM, unwinds the stack through the call
frame information and the exception frames (a handler shows what it interrupted), and evaluates what the views ask for: variables
through their location lists, C expressions over the program's types, the macros (`GPIOB->ODR`). Memory it does not have is
fetched, and the view is read again. A value set from the views (`src/debug/assign.ts`) becomes writes that travel with an
`inspect`: the core makes them first and the reply reads the state after them. Memory is stored as the core's own stores
would be (a peripheral register does what a store to it does; flash and ROM refuse), a caller's register goes to the stack
slot its callee saved it in, and a member of a struct the compiler split into registers sends the whole struct back. The
DWARF reader and the evaluator come with the code panel's chunk, not the page's. A file
the image names is shown from the board's project when the image was built from it (Compile records the files' hashes on the
board, so a file edited since the build is flagged), from a read-only source added for the debugger and saved with the
board, or from the site's `/st/`. Failing all of those, the disassembly is the view; it is one click away for any image, HEX and
BIN included.
