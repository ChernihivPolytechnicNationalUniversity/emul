import type { ComponentDef } from "./types"

/**
 * Every file of parts, each loaded the first time one of its parts is wanted: a page carries only
 * the catalogue (catalogue.gen.ts) up front. A new file of parts exports `defs` and gets a line
 * here, then `pnpm catalogue` writes its parts into the catalogue; a test fails until both are done.
 * The order is the palette's: a group lists its parts in the order they come here.
 */
export const PART_FILES: Record<string, () => Promise<{ defs: ComponentDef[] }>> = {
  "open746i-c": () => import("./components/open746i-c"),
  "nucleo-f429zi": () => import("./components/nucleo-f429zi"),
  "stm32f4-discovery": () => import("./components/stm32f4-discovery"),
  "olimex-stm32-h405": () => import("./components/olimex-stm32-h405"),
  "netduino-plus-2": () => import("./components/netduino-plus-2"),
  "weact-blackpill": () => import("./components/weact-blackpill"),
  "arduino-uno": () => import("./components/arduino-uno"),
  "arduino-nano": () => import("./components/arduino-nano"),
  "stm32-chip": () => import("./components/stm32-chip"),
  "avr-chip": () => import("./components/avr-chip"),
  "pic-chip": () => import("./components/pic-chip"),
  "clock": () => import("./components/clock"),
  "eeprom": () => import("./components/eeprom"),
  "hc595": () => import("./components/hc595"),
  "ne555": () => import("./components/ne555"),
  "opamp": () => import("./components/opamp"),
  "lcd7-f": () => import("./components/lcd7-f"),
  "buzzer": () => import("./components/buzzer"),
  "addressable": () => import("./components/addressable"),
  "charge-boost": () => import("./components/charge-boost"),
  "power-ics": () => import("./components/power-ics"),
  "meters": () => import("./components/meters"),
  "basic": () => import("./components/basic"),
  "polyfuse": () => import("./components/polyfuse"),
  "rgb-led": () => import("./components/rgb-led"),
  "seven-segment": () => import("./components/seven-segment"),
  "keypad": () => import("./components/keypad"),
  "encoder": () => import("./components/encoder"),
  "servo": () => import("./components/servo"),
  "lcd1602": () => import("./components/lcd1602"),
  "oled": () => import("./components/oled"),
}
