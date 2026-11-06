import { describe, expect, it } from "vitest"
import { OverlayMap } from "@/schematic/wires/overlay-map"

describe("local map snapshots", () => {
  it("keeps old values, deletions and undefined entries through repeated compaction", () => {
    const base = new Map<string, number | undefined>([["a", 1], ["b", 2], ["empty", undefined]])
    let current: ReadonlyMap<string, number | undefined> = base
    const snapshots: { actual: ReadonlyMap<string, number | undefined>; expected: Map<string, number | undefined> }[] = []
    let expected = new Map(base)
    for (let edit = 0; edit < 512; edit++) {
      const key = `key${edit % 13}`
      const removed = new Set([key, edit % 2 ? "a" : "b"])
      const changes = new Map<string, number | undefined>([[key, edit % 3 ? edit : undefined]])
      current = new OverlayMap(current, changes, removed)
      expected = new Map(expected)
      for (const key of removed) expected.delete(key)
      for (const [key, value] of changes) expected.set(key, value)
      snapshots.push({ actual: current, expected })
    }
    for (const { actual, expected } of snapshots) {
      expect.soft([...actual]).toEqual([...expected])
      expect.soft(actual.size).toBe(expected.size)
      for (const key of ["a", "b", "empty", "missing", ...expected.keys()]) {
        expect.soft(actual.has(key), key).toBe(expected.has(key))
        expect.soft(actual.get(key), key).toBe(expected.get(key))
      }
    }
    expect.soft([...base]).toEqual([["a", 1], ["b", 2], ["empty", undefined]])
  })

  it("compacts only changed entries without walking the untouched document", () => {
    let walked = 0
    class DocumentMap extends Map<number, number> {
      [Symbol.iterator]() { walked++; return super[Symbol.iterator]() }
    }
    const base = new DocumentMap(Array.from({ length: 40_000 }, (_, i) => [i, i]))
    let current: ReadonlyMap<number, number> = base
    for (let edit = 0; edit < 1024; edit++) current = new OverlayMap(current, new Map([[edit % 8, -edit]]), new Set())
    expect.soft(walked, "no whole-document snapshot on an edit").toBe(0)
    expect.soft(current.get(39_999)).toBe(39_999)
    expect.soft(current.get(7)).toBe(-1023)
  })
})
