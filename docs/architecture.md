# Architecture

## Layout

- `src/mcu/` — the emulator: `cpu.ts`, `decode.ts`, `jit.ts` (blocks compiled to JavaScript), `scs.ts` (NVIC/SysTick/SCB), `bus.ts`, `periph/*`, `chip.ts` (profiles), `stm32f429.ts` (the SoC class `Stm32`), `core-worker.ts` (one core in a worker of its own)
- `src/sim/` — analog engine (`engine.ts`), netlist, the co-simulation loop (`loop.ts`) and its worker, `core-host.ts` (a core in this thread or in a worker, over a SharedArrayBuffer), digital parts (`digital.ts`)
- `src/schematic/` — component definitions (`components/*`), examples, geometry, `mcu-model.ts`; wiring in `nets.ts` (the net map), `wiring.ts` (connect, tap), `wire-colors.ts` (palette, shortcuts, the automatic rule)
- `src/components/` — the React UI; `code/` is the editor panel (Monaco, explorer, tabs, build output)
- `src/project/` — a board's firmware project: file operations that mirror the API's rules, the template, the build-service client
- `firmware/` — test firmware and HAL apps (`hal/Src/main.c` blink, `square.c`, `pwm.c`, `uart.c`, `spi.c`, `spi-slave.c`, `i2c.c`, `dma.c`, `adc.c`, `wdg.c`), the lab's CubeIDE project (`lab1/`), the Open746I-C demos (`lcd/`), and their built images in `examples/` for the test scripts; the site bundles the sources as the examples' projects (`src/schematic/projects.ts`)
- `scripts/` — the test drivers above
- `backend/` — the services below: `api/`, `worker/`, `shared/`

## Services

The site is static. Work that needs a machine — building firmware — goes through two more containers,
each from its own Dockerfile and built in parallel by CI:

- `api/` — Fastify, on the site's host under `/api`. `POST /api/jobs` takes `{kind, target, files: [{path, content}]}`, stores the
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
jobs/<id>/input/project.json   target, createdAt, files with size and sha256
jobs/<id>/input/src/<path>     sources as sent; paths relative, plain characters, source extensions only
jobs/<id>/out/<name>           firmware.elf, firmware.map, build.log, …
jobs/<id>/result.json          ok, artifacts, finishedAt, durationMs — kept after Redis forgets the job
```

Both read `REDIS_URL`; the API also `S3_BUCKET`, `S3_ENDPOINT` (MinIO; unset for AWS), `S3_PUBLIC_ENDPOINT` (the host browsers reach, presigned URLs are signed for it), `S3_REGION`, `S3_FORCE_PATH_STYLE`,
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (unset: the SDK's default chain), and a missing bucket fails it at start; the worker `WORKER_CONCURRENCY`.
Locally: `pnpm api`, `pnpm worker`; the Vite dev server proxies `/api` to the API. The editor's completions come from
`public/symbols/<chip>.json` (`scripts/symbols.ts` over the staged ST sources: `sh backend/worker/toolchain/stage-st.sh /tmp/st && pnpm symbols /tmp/st public/symbols`);
the site image does this at build time, a dev checkout without it has the project's own symbols only.

## The build

`worker/src/build.ts` compiles a project the way STM32CubeIDE would, with GNU Arm Embedded (Debian's `gcc-arm-none-eabi`, newlib nano):
the project's `.c`/`.cpp`/`.s` files, every folder holding a header on the include path, ST's HAL and CMSIS, `-O2 -g3 -Wall
-ffunction-sections -fdata-sections`, `--gc-sections`, one `firmware.elf` plus `firmware.map`. What a CubeMX project has and a
bare one does not — the "batteries" — comes from `worker/targets/<chip>/`: the linker script, `startup_*.s`, `system_*.c`, `*_it.c`,
`*_hal_msp.c`, `*_hal_conf.h` (every module on) and, for all chips, `targets/common/syscalls.c` (weak `_write`, `_sbrk`, …). A project
file with the same name replaces the battery, so a CubeIDE export drops in as is (`firmware/lab1` is one). The HAL is compiled once
per chip into `libhal.a` when the image is built (`worker/toolchain/`: ST's repos at pinned tags), so a build takes about a second;
a project with its own `stm32fNxx_hal_conf.h` gets the HAL compiled from source against it instead (~10 s). 120 s and 4 MB of log
are the limits. `targets/<chip>/target.json` names the chip, CPU flags, defines and linker script; adding a chip is adding a folder
and a line in the Dockerfile.

## Threads

The UI thread draws; the simulation worker runs the analog solver, the digital parts and the
loop; and, when the page is cross-origin isolated (the dev server and nginx send the COOP/COEP
headers), every MCU core runs in a worker of its own, pipelined one 20 µs step ahead of the
solver — pad and pin levels cross with 20 µs of latency, which the inspector says ("Runs:
worker (pipelined)"). A core with a digital part on its nets (an I²C EEPROM, the GT911) drops
into step with the loop while that traffic lasts, and two cores sharing a net stay in the
solver's thread in lockstep. Without isolation everything runs in the simulation worker.
`pnpm bench "" 4 --workers` measures the worker arrangement under node.

