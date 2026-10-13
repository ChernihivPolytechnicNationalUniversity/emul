import type { Peripheral } from "../bus"

export class BackupSram implements Peripheral {
  readonly name = "BKPSRAM"
  readonly base: number
  readonly size: number
  private readonly bytes: Uint8Array
  private readonly view: DataView
  interfaceClocked: () => boolean = () => true
  backupDomainWritable: () => boolean = () => true

  constructor(base: number, size: number) {
    this.base = base
    this.size = size
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }

  read(offset: number, size: 1 | 2 | 4): number {
    return this.interfaceClocked() ? this.peek(offset, size) : 0
  }

  peek(offset: number, size: 1 | 2 | 4): number {
    if (offset + size > this.size) return 0
    return size === 4 ? this.view.getUint32(offset, true) : size === 2 ? this.view.getUint16(offset, true) : this.bytes[offset]
  }

  write(offset: number, value: number, size: 1 | 2 | 4): void {
    if (!this.interfaceClocked() || !this.backupDomainWritable() || offset + size > this.size) return
    if (size === 4) this.view.setUint32(offset, value >>> 0, true)
    else if (size === 2) this.view.setUint16(offset, value & 0xffff, true)
    else this.bytes[offset] = value & 0xff
  }

  reset() {}

  loseContents() {
    this.bytes.fill(0)
  }
}
