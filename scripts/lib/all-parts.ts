import { loadAllDefs } from "@/schematic/registry"

// Scripts read parts synchronously, as tests do: import this first and every part is loaded.
await loadAllDefs()
