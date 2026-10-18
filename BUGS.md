# Bugs

## Compile on a running board freezes the simulation

Found 2026-09-23 on https://emul.digituni.org/ (release of `b7b1055`), Chrome 153, Windows 11.

**Steps**

1. File → Examples → `Lab 1: running light`. The board opens without an image: the inspector
   says "No program: the MCU pins float".
2. Run. Simulated time advances.
3. Open the code panel and press Compile. The build succeeds ("U1 programmed · Built in
   1.29 s") and the inspector shows `firmware.elf`, 1.568 MB.

**What happens**

- Simulated time stops (it stayed at 31.233 s) and never moves again. The toolbar still shows
  Pause, so the loop thinks it is running.
- Pause, then Run: time does not move.
- Simulate → Start over from 0 s, then Run: the button goes back to Run and no time counter
  appears; the simulation does not start at all.
- Only a page reload recovers, which loses the compiled image.

**Expected**

The new image boots on the running board, as `42ea0ea` ("a new image on a running board
resets the core host too, so a worker core runs again after Compile") set out to do. `pnpm
reflash` covers that path, so either the deployed build takes a path the driver does not, or
it regressed after it.

**Workaround**

Reload, open the example, Compile *before* the first Run, then Run. The core starts at
50 MHz from the PLL and the running light works.

**Not captured**

The console showed nothing, but tracking was only switched on after the freeze; reproduce
with DevTools open from the start to see whether a worker threw.

**Fixed** (2026-10-13; the first cause already on 2026-09-24)

- The freeze reported here was the loop running, and blocking in `Atomics.wait` on, a core whose
  worker had not started yet; a browser cannot start a nested worker while its parent is
  blocked, so neither ever moved. `e6dfe73` (2026-09-24, after this build) runs a core only once
  its worker is `ready`. Checked 2026-10-13 with headless Chromium on https://emul.digituni.org/,
  the example opened without an image, Run, Compile after 4 s and after 32 s: "U1 programmed" and
  the time keeps going.
- The same freeze still followed any error inside a core worker: its run loop died and the loop
  waited for its answer for ever. It happened on the working tree on 2026-10-13 — Compile on a
  running Lab 1 board, the worker threw `this.refreshLptimClock is not a function` from a file
  caught mid-edit, time stopped at 11.741 s, exactly as above. Now an error inside a run halts
  that core with "emulator error: …" and the worker answers; a worker silent for 10 s is given up
  on ("the core's worker stopped answering"), and the bench runs on
  (`tests/sim/core-failure.test.ts`).

## Wheel zoom can freeze the page for good

Found 2026-10-12 on `main` (5dc15c4), production build, headless Chromium, during `field-bench
boards` at 25 boards: 3 hangs in about 8 runs, always with other load on the machine; the 400-board
zoom of a branch run hung the same way.

**Cause (paused in the debugger while hung, `~/tmp/emul-bench-logs/hang-main-pause-stack.log`)**

- `src/components/field/use-viewport.ts` `follow`: the first animation frame's timestamp can be
  earlier than the `performance.now()` taken when the zoom started, so `dt` came out at −312 ms,
  the smoothing factor at −85 and the scale at −6.97.
- `src/components/field/dot-grid.ts` `dotGridStyle` never leaves its loop for a negative scale
  (`cellPx = −167`, `level = Infinity`).
- `src/components/field/wire-flow.ts` computes its time step the same way.

**Expected:** a zoom step never makes the scale negative; `dt` clamped at 0.

**Fixed** (2026-10-13): `use-viewport.ts` and `wire-flow.ts` take their step from `easeFactor`
(`src/components/field/easing.ts`), 0 for an interval that is not positive and never past 1, and
keep their reference time from going backwards; the wire flow's slide is clamped the same way;
`dotGridStyle` draws nothing for a scale it cannot draw (`tests/sim/field-easing.test.ts`).
The clamp left two stalls (review, 2026-10-13): a wire-flow frame stamped before a push ended the
loop with the dash where it was, and a zoom stood still for as long as the stamps lagged. Both now
time from the first frame's own stamp (`frameClock`), the flow's slide starts on the first frame
after a push, and the loop runs until slide and width arrive.

## A diode with a high forward voltage never conducts

Found 2026-10-14 while bringing up the LCD 1602's backlight (Vishay: 4.2 V at 20 mA) in the
"Nucleo I²C LCD 1602" example, in Chrome and in `pnpm vitest`.

**What happens**

The backlight LED, 5 V through 100 Ω, carried 0.7 µA with 4.99 V across it. The same happened
to a GaP green seven-segment die (SA56-11GWA, fitted emission 0.6).

**Cause**

`engine.ts` evaluated a diode's current at `exp(min(v / nVt, 80))`. A junction whose saturation
current is tiny — a high VF at a modest emission coefficient, or a very steep curve — only
starts to conduct past e^80: 4.17 V / (1.8 × 25.85 mV) is 89.6. The cap held its current at
Is·e^80, a fraction of a microamp, at any voltage.

**Fixed** (2026-10-14): the cap is `max(80, vcrit / nVt + 10)` (`diodeExpCap`), so it moves only
for junctions whose critical voltage lies past e^80 and every existing part keeps its 80.
`tests/sim/seven-segment.test.ts` now drives a segment of every colour on the bench, and
`tests/sim/nucleo-lcd-i2c.test.ts` checks the backlight's current, not just that it is above zero.

## The first key press on a keypad prints a whole column

Found 2026-10-14 in Chrome on the "Nucleo 4×4 keypad" example: the first press of `1` printed
`147*`; later presses were right.

**Cause**

A pressed key joins a row pad and a column pad of one core into one net, which makes the core
`coupled` and `mapInputs` moves it from its worker into the loop's thread (`relocate`). The move
makes a fresh core and loads the image again, mid-press: the scan restarts against drivers
left on the nets by the old core, and column 1 reads low for every row.

**Fixed** (2026-10-14): a core that a switch could couple — a key, a button or a jumper between
two of its pads — is moved when the document is mapped, before it runs, so a press never moves
it. `tests/sim/nucleo-keypad.test.ts` presses `1` with the core in a worker thread.

## A pulse source slows the whole bench to a crawl

Found 2026-10-14: the tier-0 parts on one bench with a pulse source on the servo ran at 0.16×
in Chrome, 0.26× in `vitest` (3.9 s for 1 s simulated), against 1.6× without it.

**Cause**

The engine treated any source with an AC component as a sine: no remembered operating points
and no settled steps, so every 20 µs step took a full Newton solve, even across the 20 ms
between a 50 Hz pulse's edges where the source is DC.

**Fixed** (2026-10-14): only a sine keeps the solver from those paths. A pulse source's level is
part of the switch mask (an edge ends a settled run as a switch does), its voltage is matched
as a live value against a remembered point, the RMS averages move on through the settled steps,
and a lone core runs ahead no further than the next edge. The bench takes 0.87 s for 1 s.
`tests/sim/led-eye.test.ts` checks the LED's eye level, current and RMS readings against full
solves.

## Widely used I²C LCD code prints garbage

Found 2026-10-14 running ControllersTech's i2c-lcd (the LCD1602 I²C tutorial code) unmodified
on the backpack: both lines filled with stray characters. The same code works on real modules.

**Cause**

Two things. The PCF8574 comes up with every port high, E included, but the module's bus started
with E low, so the first write's falling E latched nothing. And in 4-bit mode a nibble sent while
the controller was busy still counted as a half. That code sends 20h as a whole byte: its low 0
becomes the first half of the next instruction, 28h's 2 completes 02h (return home), and 28h's 8
lands while that runs. On a module the 8 is lost and the pairing comes back; here it was kept as
a half, and every instruction and character after it was split across two.

**Fixed** (2026-10-14): the backpack primes the module's lines high at power-on (the first
write's timing is not reported, no program set it up), and a nibble sent while busy is dropped
without counting as a half. `tests/sim/lcd1602.test.ts` replays both on the backpack.

## The call stack goes on below Reset_Handler

Found 2026-10-15 on `feat/debug-target`, Chrome, the debugger's test program on a Nucleo: stopped
in `factorial`, the call stack read `factorial ← main ← Reset_Handler`, then an "exception 0"
marker, `Default_Handler` and `Reset_Handler` again.

**Cause:** `src/debug/unwind.ts` took LR's reset value 0xFFFFFFFF, which Reset_Handler saves, for
an EXC_RETURN and walked a hardware frame read from past the top of RAM. The tests never saw it:
their stop view did not fetch the memory the unwinding missed, as the session does.

**Fixed** (2026-10-15): an EXC_RETURN ends in 1, 9 or D (ARMv7-M B1.5.8); the tests' stop views
fetch what the unwinding missed and walk again (`tests/sim/debug.test.ts`).
