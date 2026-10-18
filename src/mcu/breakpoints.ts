/** Addresses a core stops at before executing; a change tells the core, which drops what it compiled across them. */
export class BreakpointSet extends Set<number> {
  onChange: (() => void) | null = null
  add(addr: number) {
    if (!this.has(addr)) {
      super.add(addr >>> 0)
      this.onChange?.()
    }
    return this
  }
  delete(addr: number) {
    const had = super.delete(addr >>> 0)
    if (had) this.onChange?.()
    return had
  }
  clear() {
    if (this.size) {
      super.clear()
      this.onChange?.()
    }
  }
}
