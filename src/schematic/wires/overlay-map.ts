type Layer<K, V> = { changes: ReadonlyMap<K, V>; removed: ReadonlySet<K>; weight: number }

export class OverlayMap<K, V> implements ReadonlyMap<K, V> {
  private readonly base: ReadonlyMap<K, V>
  private readonly layers: readonly Layer<K, V>[]
  private materialised: Map<K, V> | undefined

  constructor(parent: ReadonlyMap<K, V>, changes: ReadonlyMap<K, V>, removed: ReadonlySet<K>) {
    this.base = parent instanceof OverlayMap ? parent.base : parent
    const layers = parent instanceof OverlayMap ? [...parent.layers] : []
    if (changes.size || removed.size) {
      layers.push({ changes, removed, weight: 1 })
      while (layers.length > 1 && layers.at(-1)!.weight === layers.at(-2)!.weight) {
        const newer = layers.pop()!
        const older = layers.pop()!
        const merged = new Map(older.changes)
        const deleted = new Set(older.removed)
        for (const key of newer.removed) { merged.delete(key); deleted.add(key) }
        for (const [key, value] of newer.changes) merged.set(key, value)
        layers.push({ changes: merged, removed: deleted, weight: older.weight + newer.weight })
      }
    }
    this.layers = layers
  }

  get(key: K): V | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]
      if (layer.changes.has(key)) return layer.changes.get(key)
      if (layer.removed.has(key)) return undefined
    }
    return this.base.get(key)
  }

  has(key: K): boolean {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i]
      if (layer.changes.has(key)) return true
      if (layer.removed.has(key)) return false
    }
    return this.base.has(key)
  }

  private flatten(): Map<K, V> {
    if (this.materialised) return this.materialised
    const map = new Map(this.base)
    for (const layer of this.layers) {
      for (const key of layer.removed) map.delete(key)
      for (const [key, value] of layer.changes) map.set(key, value)
    }
    return (this.materialised = map)
  }

  get size() { return this.flatten().size }
  entries() { return this.flatten().entries() }
  keys() { return this.flatten().keys() }
  values() { return this.flatten().values() }
  [Symbol.iterator]() { return this.entries() }
  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
    this.flatten().forEach((value, key) => callback.call(thisArg, value, key, this))
  }
}
