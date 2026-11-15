import "./lib/all-parts"
import { mkdirSync } from "node:fs"
import { PARTITIONS, partitionDocuments, readFixture, writeFixture } from "../tests/lib/partition-documents"

const overwrite = process.argv.includes("--overwrite")
mkdirSync(PARTITIONS, { recursive: true })
let written = 0
let kept = 0
for (const document of await partitionDocuments()) {
  if (readFixture(document.name) && !overwrite) {
    kept++
    continue
  }
  writeFixture(document)
  written++
  console.log(`wrote ${document.name}`)
}
console.log(`${written} written, ${kept} kept${kept && !overwrite ? " (--overwrite replaces them: only when a circuit is meant to change)" : ""}`)
