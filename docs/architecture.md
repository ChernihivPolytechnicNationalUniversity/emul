# Architecture

## Layout

- `src/mcu/` — the emulator: `cpu.ts`, `decode.ts`, `jit.ts` (blocks compiled to JavaScript), `scs.ts` (NVIC/SysTick/SCB), `bus.ts`, `periph/*`, `chip.ts` (profiles), `stm32f429.ts` (the SoC class `Stm32`), `debugger.ts` (breakpoints and stepping, beside the core), `core-worker.ts` (one core in a worker of its own)
- `src/sim/` — analog engine (`engine.ts`), netlist, the co-simulation loop (`loop.ts`) and its worker, `core-host.ts` (a core in this thread or in a worker, over a SharedArrayBuffer), digital parts (`digital.ts`)
- `src/schematic/` — component definitions (`components/*`), examples, geometry, `mcu-model.ts`; wiring in `nets.ts` (the net map), `wiring.ts` (connect, tap), `wire-colors.ts` (palette, shortcuts, the automatic rule)
- `src/debug/` — the debugger's reading of an image: `dwarf/*` (DWARF 2–5: units, line programs, range and location lists, call frame information, expressions, macros), `lines.ts` (the line table, shared by the core and the editor), `info.ts`, `unwind.ts`, `values.ts` and `eval.ts` (values and C expressions over a stop's memory), `disasm.ts`, `sources.ts` (where a file the image names comes from); `session.ts` is the UI's controller for the whole bench
- `src/components/` — the React UI; `code/` is the editor panel (Monaco, explorer, tabs, build output), `debug/` its debugger toolbar and panes
- `src/project/` — a board's firmware project: file operations that mirror the API's rules, the template, the build-service client
- `firmware/` — test firmware and HAL apps (`hal/Src/main.c` blink, `square.c`, `pwm.c`, `uart.c`, `spi.c`, `spi-slave.c`, `i2c.c`, `dma.c`, `adc.c`, `wdg.c`), the lab's CubeIDE project (`lab1/`), the Open746I-C demos (`lcd/`), and their built images in `examples/` for the test scripts; the site bundles the sources as the examples' projects (`src/schematic/projects.ts`)
- `scripts/` — the test drivers above
- `backend/` — the services below: `api/`, `worker/` (firmware builds, and HDL synthesis in a second image), `shared/`

## Services

The site is static. Work that needs a machine — building firmware — goes through two more containers,
each from its own Dockerfile and built in parallel by CI:

- `api/` — Fastify, on the site's host under `/api`. `POST /api/jobs` takes `{kind, target, files: [{path, content}], options?: {opt}}`, stores the
  project in S3 and enqueues; `GET /api/jobs/:id` reports the state and, once done, the job's files as presigned S3 URLs (15 min) —
  the browser fetches them from the store directly, the bucket stays private. `/healthz` is 503 while Redis is down.
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

Both read `REDIS_URL`; the API also `S3_BUCKET`, `S3_ENDPOINT` (MinIO; unset for AWS), `S3_PUBLIC_ENDPOINT` (the host browsers reach, presigned URLs are signed for it), `S3_REGION`, `S3_FORCE_PATH_STYLE`,
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (unset: the SDK's default chain), and a missing bucket fails it at start; the worker `WORKER_CONCURRENCY`.
Locally: `pnpm api`, `pnpm worker`; the Vite dev server proxies `/api` to the API. The editor's completions come from
`public/symbols/<chip>.json` (`scripts/symbols.ts` over the staged ST sources: `sh backend/worker/toolchain/stage-st.sh /tmp/st && pnpm symbols /tmp/st public/symbols`);
the site image does this at build time, a dev checkout without it has the project's own symbols only. The debugger's ST
sources (`public/st/`, the files the images name as `/opt/st/…`, and the build service's startup files) and peripheral register maps
(`public/peripherals/<chip>.json`, from the CMSIS device headers) come the same way: `pnpm st-sources /tmp/st public/st && pnpm peripherals /tmp/st public/peripherals`.

## The build

`worker/src/build.ts` compiles a project the way STM32CubeIDE would, with GNU Arm Embedded (Debian's `gcc-arm-none-eabi`, newlib nano):
the project's `.c`/`.cpp`/`.s` files, every folder holding a header on the include path, ST's HAL and CMSIS, `-g3 -Wall
-ffunction-sections -fdata-sections` at the optimization level the job names (`options.opt`: `-O0`, `-Og`, `-O1`, `-O2`, `-O3` or `-Os`;
`-O2` when it names none, while the editor asks for `-O0` unless the board says otherwise), `--gc-sections`, one `firmware.elf` plus
`firmware.map`. `-g3` at every level keeps the macros for the debugger's expressions. What a CubeMX project has and a
bare one does not — the "batteries" — comes from `worker/targets/<chip>/`: the linker script, `startup_*.s`, `system_*.c`, `*_it.c`,
`*_hal_msp.c`, `*_hal_conf.h` (every module on) and, for all chips, `targets/common/syscalls.c` (weak `_write`, `_sbrk`, …). A project
file with the same name replaces the battery, so a CubeIDE export drops in as is (`firmware/lab1` is one). The HAL is compiled once
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
