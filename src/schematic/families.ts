/**
 * Parts the palette shows as one row: the same thing in several variants (part numbers, revisions,
 * polarities). A variant is a part of its own, with the id saved projects know it by; the family
 * only gathers them. Variants share their pins and where they sit (not always the part's size), so switching
 * one for another in the inspector keeps every wire: `tests/sim/catalogue.test.ts` checks it, and
 * fails when two parts that could be one row are left apart.
 *
 * The first variant is the one a click on the row places.
 */
export type Family = {
  id: string
  /** The row's name: what a student calls the part, short enough for a palette row. */
  name: string
  /** [part id, how the variant is told apart]. The label is short: the family's name is shown beside it. */
  variants: readonly (readonly [string, string])[]
  /** What the row says about its variants; by default their labels, or how many there are. */
  hint?: string
}

export const FAMILIES: readonly Family[] = [
  {
    id: "weact-blackpill",
    name: "WeAct Black Pill",
    variants: [
      ["weact-blackpill-f411", "STM32F411CE"],
      ["weact-blackpill-f401ce", "STM32F401CE"],
      ["weact-blackpill-f401cc", "STM32F401CC"],
    ],
    hint: "F411 · F401",
  },
  {
    id: "stm32f4x1-qfn48",
    name: "STM32F401 / F411",
    variants: [
      ["stm32f411ce", "STM32F411CE"],
      ["stm32f401ce", "STM32F401CE"],
      ["stm32f401cc", "STM32F401CC"],
    ],
    hint: "UFQFPN48",
  },
  {
    id: "pic16f62x",
    name: "PIC16F62x / 648A",
    variants: [
      ["pic16f628a", "PIC16F628A"],
      ["pic16f627a", "PIC16F627A"],
      ["pic16f648a", "PIC16F648A"],
      ["pic16lf627a", "PIC16LF627A"],
      ["pic16lf628a", "PIC16LF628A"],
      ["pic16lf648a", "PIC16LF648A"],
      ["pic16f627", "PIC16F627"],
      ["pic16f628", "PIC16F628"],
      ["pic16f627-04", "PIC16F627-04"],
      ["pic16f628-04", "PIC16F628-04"],
      ["pic16lf627", "PIC16LF627"],
      ["pic16lf628", "PIC16LF628"],
    ],
  },
  {
    id: "74hc595",
    name: "74HC595",
    variants: [
      ["hc595", "74HC595"],
      ["hct595", "74HCT595"],
    ],
    hint: "HC · HCT",
  },
  {
    id: "opamp",
    name: "Op amp",
    variants: [
      ["opamp-generic", "Ideal"],
      ["opamp-lm358", "LM358"],
      ["opamp-lm741", "LM741"],
      ["opamp-tl072", "TL072"],
      ["opamp-mcp6002", "MCP6002"],
      ["opamp-lmv358", "LMV358"],
    ],
  },
  {
    id: "buzzer",
    name: "Buzzer",
    variants: [
      ["buzzer-cem-1203-42", "CEM-1203(42)"],
      ["buzzer-at-1224-twt-5v-2", "AT-1224-TWT-5V-2-R"],
      ["buzzer-cmt-0904-83t", "CMT-0904-83T"],
      ["buzzer-tmb12a05", "TMB12A05"],
      ["buzzer-sdc1610m5-01", "SDC1610M5-01"],
      ["buzzer-cmi-9650c-030", "CMI-9650C-030"],
      ["buzzer-pkm13epyh4000-a0", "PKM13EPYH4000-A0"],
      ["buzzer-pkm17epp-2002-b0", "PKM17EPP-2002-B0"],
      ["buzzer-pkb24spch3601-b0", "PKB24SPCH3601-B0"],
    ],
  },
  {
    id: "bjt",
    name: "Transistor (BJT)",
    variants: [
      ["npn", "NPN"],
      ["pnp", "PNP"],
    ],
  },
  {
    id: "seven-segment",
    name: "7-segment display",
    variants: [
      ["seven-segment-cc", "Common cathode"],
      ["seven-segment-ca", "Common anode"],
    ],
    hint: "CC · CA",
  },
  {
    id: "seven-segment-4",
    name: "4-digit 7-segment",
    variants: [
      ["seven-segment-4-cc", "Common cathode"],
      ["seven-segment-4-ca", "Common anode"],
    ],
    hint: "CC · CA",
  },
  {
    id: "oled-i2c",
    name: "OLED I²C (SSD1306)",
    variants: [
      ["oled-ssd1306-i2c", '0.96" 128×64'],
      ["oled-ssd1306-i2c-32", '0.91" 128×32'],
    ],
    hint: '0.96" · 0.91"',
  },
  {
    id: "addressable-led",
    name: "Addressable LED",
    variants: [
      ["ws2812b", "WS2812B"],
      ["ws2812", "WS2812"],
      ["ws2812a", "WS2812A"],
      ["ws2812c", "WS2812C"],
      ["ws2812d", "WS2812D"],
      ["ws2812e", "WS2812E"],
      ["sk6812", "SK6812"],
      ["sk6812rgbw", "SK6812RGBW"],
      ["ws2815b-4pin", "WS2815B (4-pin)"],
    ],
    hint: "WS2812B · SK6812 …",
  },
  {
    id: "addressable-led-6pin",
    name: "Addressable LED, 6-pin",
    variants: [
      ["ws2812-6pin", "WS2812 (6-pin)"],
      ["ws2812s", "WS2812S"],
    ],
    hint: "WS2812 · WS2812S",
  },
  {
    id: "addressable-led-backup",
    name: "Addressable LED, BIN",
    variants: [
      ["ws2813", "WS2813"],
      ["ws2815", "WS2815"],
      ["ws2813b-rgbw", "WS2813B-RGBW"],
      ["ws2916a-rgbw", "WS2916A-RGBW"],
    ],
    hint: "WS2813 · WS2815 …",
  },
  {
    id: "addressable-led-relay",
    name: "Addressable LED, BI/BO",
    variants: [
      ["ws2813b", "WS2813B"],
      ["ws2816", "WS2816"],
      ["ws2916", "WS2916"],
    ],
    hint: "WS2813B · WS2816 …",
  },
  {
    id: "led-driver-3",
    name: "LED driver, 3-channel",
    variants: [
      ["ws2811", "WS2811"],
      ["ws2913", "WS2913"],
    ],
  },
  {
    id: "led-driver-5-backup",
    name: "LED driver, 5-ch + BIN",
    variants: [
      ["ws2805", "WS2805"],
      ["ws2914", "WS2914"],
    ],
  },
]

const BY_PART = new Map<string, Family>(FAMILIES.flatMap((f) => f.variants.map(([id]) => [id, f] as const)))

/** The family a part is a variant of, if any. */
export const familyOf = (defId: string): Family | undefined => BY_PART.get(defId)

/** How the variant `defId` is told apart within its family. */
export const variantLabel = (defId: string): string | undefined => BY_PART.get(defId)?.variants.find(([id]) => id === defId)?.[1]

const HINT_BUDGET = 20

/** What a family's row says about its variants. */
export function familyHint(f: Family): string {
  if (f.hint) return f.hint
  const labels = f.variants.map(([, label]) => label).join(" · ")
  return labels.length <= HINT_BUDGET ? labels : `${f.variants.length} variants`
}
