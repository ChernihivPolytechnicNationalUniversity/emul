import { describe, expect, it } from "vitest"
import { FULL_SCALE_PASCALS, SoundStream } from "@/sim/sound-stream"

const SOURCE = 50_000
const OUTPUT = 48_000
const TICK = 0.004
const QUANTUM = 128

function play(opts: { speed: number; seconds: number; hz: number; pascals: number }) {
  const stream = new SoundStream(SOURCE, OUTPUT)
  const out: number[] = []
  let produced = 0
  let simTime = 0
  let wall = 0
  let rendered = 0
  const block = new Float32Array(QUANTUM)
  while (wall < opts.seconds) {
    wall += 0.001
    while (produced * TICK < wall) {
      produced++
      const n = Math.round(TICK * opts.speed * SOURCE)
      const samples = new Float32Array(n)
      for (let k = 0; k < n; k++) samples[k] = opts.pascals * Math.SQRT2 * Math.sin(2 * Math.PI * opts.hz * (simTime + k / SOURCE))
      simTime += n / SOURCE
      stream.receive({ t: "samples", samples, pitch: opts.hz })
    }
    while (rendered / OUTPUT < wall) {
      stream.render(block)
      out.push(...block)
      rendered += QUANTUM
    }
  }
  return { stream, out: Float32Array.from(out) }
}

function measure(out: Float32Array, from: number) {
  const tail = out.subarray(Math.round(from * OUTPUT))
  let crossings = 0
  let first = -1
  let last = -1
  let sum = 0
  let worstStep = 0
  for (let n = 1; n < tail.length; n++) {
    sum += tail[n] * tail[n]
    worstStep = Math.max(worstStep, Math.abs(tail[n] - tail[n - 1]))
    if (tail[n - 1] < 0 && tail[n] >= 0) {
      crossings++
      if (first < 0) first = n
      last = n
    }
  }
  return { hz: ((crossings - 1) * OUTPUT) / (last - first), rms: Math.sqrt(sum / tail.length), worstStep }
}

describe("buzzer sound: the stream from the simulation to the speaker", () => {
  const smoothStep = (hz: number, peak: number) => 2 * Math.PI * hz * peak / OUTPUT

  it.each([1, 0.6, 0.25, 2])("keeps a 2.08 kHz tone at its pitch with the simulation at %s× real time, without clicks", (speed) => {
    const { out } = play({ speed, seconds: 1.5, hz: 2080, pascals: 0.05 })
    const m = measure(out, 0.3)
    expect.soft(m.hz, "pitch heard (Hz)").toBeNearRel(2080, 0.005)
    expect.soft(m.worstStep, "largest step between output samples: the tone's own slope, no jump").toBeLessThan(1.3 * smoothStep(2080, (0.05 * Math.SQRT2) / FULL_SCALE_PASCALS))
  })

  it("plays 90 dB SPL at full scale and 60 dB SPL 30 dB under it", () => {
    const quiet = measure(play({ speed: 1, seconds: 1, hz: 1000, pascals: 0.02 }).out, 0.3).rms
    expect.soft(quiet, "60 dB SPL as RMS of full scale").toBeNearRel(0.02 / FULL_SCALE_PASCALS, 0.02)
    expect.soft(20 * Math.log10(FULL_SCALE_PASCALS / Math.SQRT2 / 20e-6), "full scale (dB SPL)").toBeNear(90, 0.01)
  })

  it("holds about 60 ms of sound once primed, and only jumps whole periods when it has to", () => {
    const steady = play({ speed: 1, seconds: 2, hz: 2000, pascals: 0.2 })
    expect.soft(steady.stream.buffered() / SOURCE, "buffered (s)").toBeNear(0.06, 0.03)
    expect.soft(steady.stream.jumps, "jumps at real time").toBeLessThan(3)
    const slow = play({ speed: 0.6, seconds: 2, hz: 2000, pascals: 0.2 })
    expect.soft(slow.stream.jumps, "jumps at 0.6×: it repeats periods to fill 40 % of the time").toBeGreaterThan(5)
  })

  it("fades out on pause instead of stopping dead, and stays silent", () => {
    const { stream } = play({ speed: 1, seconds: 0.5, hz: 2000, pascals: 0.5 })
    stream.receive({ t: "pause" })
    const block = new Float32Array(QUANTUM)
    const tail: number[] = []
    for (let k = 0; k < 20; k++) {
      stream.render(block)
      tail.push(...block)
    }
    const after = tail.slice(Math.round(0.025 * OUTPUT))
    expect.soft(Math.max(...after.map(Math.abs)), "silent 25 ms on").toBe(0)
    let worst = 0
    for (let n = 1; n < tail.length; n++) worst = Math.max(worst, Math.abs(tail[n] - tail[n - 1]))
    expect.soft(worst, "no step bigger than the tone's own").toBeLessThan(1.3 * smoothStep(2000, (0.5 * Math.SQRT2) / FULL_SCALE_PASCALS))
  })
})
