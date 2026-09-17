/**
 * Preload that puts every core of every SimLoop a script makes into a worker thread, to run
 * the node checks over the worker path:
 *
 *   node --import tsx --import ./scripts/lib/workers-preload.ts scripts/lab1-sim.ts
 */
import { spawnNodeCore } from "./core-threads"
;(globalThis as { __emulSpawnCore?: typeof spawnNodeCore }).__emulSpawnCore = spawnNodeCore
