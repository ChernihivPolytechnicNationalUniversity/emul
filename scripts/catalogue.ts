import { writeFileSync } from "node:fs"
import { catalogueSource, CATALOGUE_PATH } from "./lib/catalogue"

// Writes the catalogue a page loads up front: run after adding or changing a part or an example.
writeFileSync(CATALOGUE_PATH, await catalogueSource())
console.log(`wrote ${CATALOGUE_PATH}`)
