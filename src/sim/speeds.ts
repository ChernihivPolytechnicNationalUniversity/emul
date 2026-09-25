/** Simulation time step. */
export const DT = 20e-6

/** Presets of simulated seconds per real second. Slow motion is what makes a 50 Hz waveform readable. */
export const SPEEDS = [
  { value: 0.05, label: "Ultra slow" },
  { value: 0.1, label: "Very slow" },
  { value: 0.25, label: "Slow" },
  { value: 0.5, label: "Half speed" },
  { value: 1, label: "Real time" },
  { value: 2, label: "Fast" },
] as const

/** "0.25×", "1×", "0.013×" — every place a speed is shown reads the same. */
export const formatSpeed = (speed: number) => `${Number(speed.toPrecision(2))}×`
