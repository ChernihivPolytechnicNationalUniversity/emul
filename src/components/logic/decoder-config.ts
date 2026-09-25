/** Screen widths on offer, in seconds: from a few SPI clocks to a whole second. */
export const LOGIC_SPANS = [20e-6, 50e-6, 100e-6, 200e-6, 500e-6, 1e-3, 2e-3, 5e-3, 10e-3, 20e-3, 50e-3, 0.1, 0.2, 0.5, 1] as const

export type Protocol = "none" | "uart" | "spi" | "i2c"

/** Decoder settings: which channel plays which bus signal (channel ids), and the bus options. */
export type DecoderConfig = {
  protocol: Protocol
  /** Signal role → channel id. */
  roles: Record<string, string>
  baud: number
  cpol: 0 | 1
  cpha: 0 | 1
}

export const DEFAULT_DECODER: DecoderConfig = { protocol: "none", roles: {}, baud: 115200, cpol: 0, cpha: 0 }
