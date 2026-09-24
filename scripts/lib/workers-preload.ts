/**
 * Preload that puts every core of every SimLoop a script makes into a worker thread, to run
 * the node checks over the worker path:
 *
 *   EMUL_WORKERS=1 pnpm test:sim
 */
import { spawnNodeCore } from "./core-threads"
;(globalThis as { __emulSpawnCore?: typeof spawnNodeCore }).__emulSpawnCore = spawnNodeCore
