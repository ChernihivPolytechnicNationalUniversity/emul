/** DS9405 Table 33/35 typical start-up times: 2 ms for a MHz crystal, 2 s for a 32 kHz watch crystal. */
export const crystalStartup = (hz: number) => (hz < 1e6 ? 2 : 2e-3)

/** Assumed until checked: a ceramic resonator is up in 0.5 ms, a quarter of a MHz crystal's 2 ms (Murata gives no figure). */
export const RESONATOR_STARTUP = 0.5e-3
