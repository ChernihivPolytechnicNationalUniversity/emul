import { workerData } from "node:worker_threads"
import { Stm32 } from "../../src/mcu/stm32f429"

const tripAtSeconds: number = workerData.tripAtSeconds
const runUntil = Stm32.prototype.runUntil

Stm32.prototype.runUntil = function (this: Stm32, end: number) {
  if (this.time >= tripAtSeconds)
    this.cpu.run = () => {
      throw new TypeError("the emulator tripped")
    }
  return runUntil.call(this, end)
}

await import("../../src/mcu/core-worker")
