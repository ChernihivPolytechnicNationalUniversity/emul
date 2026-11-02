import { CpuIcon } from "lucide-react"
import { template } from "@/project/template"
import { builder } from "../builder"
import type { Example } from "../examples"
import { discoveryProject, netduinoProject } from "../projects"

/**
 * The STM32F4-Discovery on its own, running the board's starting project (src/project/template.ts):
 * 168 MHz from the 8 MHz crystal, LD4 → LD3 → LD5 → LD6 lit in turn every 150 ms, B1 USER reversing
 * the direction.
 */
export const discoveryRunningLight: Example = {
  id: "discovery-running-light",
  name: "Discovery running light",
  description: "STM32F4-Discovery: the four user LEDs chase round the board, the USER button reverses them.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: async () => template("stm32f407vg") }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("stm32f4-discovery", 0, 0)
    return doc
  },
}

/**
 * The Discovery's accelerometer (firmware/discovery/tilt): WHO_AM_I tells the LIS302DL from the
 * LIS3DSH, X/Y read every 20 ms light the LED on the side the board tips to. Tilt it with the
 * board's Roll and Pitch in the inspector.
 */
export const discoveryTilt: Example = {
  id: "discovery-tilt",
  name: "Discovery tilt",
  description: "STM32F4-Discovery: the on-board accelerometer over SPI; tip the board (Roll/Pitch) and the LED on that side lights.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: discoveryProject("tilt") }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("stm32f4-discovery", 0, 0, { roll: "20" })
    return doc
  },
}

/**
 * The Discovery's audio chips (firmware/discovery/audio): the CS43L22 set up over I2C1 as ST's
 * driver does and fed a 400 Hz tone by I2S3 with DMA, heard on the bench's speaker; the MP45DT02
 * read by I2S2 with DMA, LD5 lighting while it is loud. Raise "Sound at the microphone" in the
 * inspector.
 */
export const discoveryAudio: Example = {
  id: "discovery-audio",
  name: "Discovery audio",
  description: "STM32F4-Discovery: a tone through the CS43L22 to the headphone jack, and the MP45DT02 microphone as a clap detector.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: discoveryProject("audio") }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("stm32f4-discovery", 0, 0)
    return doc
  },
}

/** The Olimex STM32-H405 running its starting project: STAT (PC12) blinks, faster while BUT (PA0) is held. */
export const h405Blink: Example = {
  id: "h405-blink",
  name: "STM32-H405 blink",
  description: "Olimex STM32-H405: the STAT LED blinks every 500 ms, every 100 ms while BUT is held.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: async () => template("stm32f405rg") }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("olimex-stm32-h405", 0, 0)
    return doc
  },
}

/**
 * The Netduino Plus 2 (firmware/netduino): 168 MHz from its 25 MHz crystal, the blue LED blinking
 * (faster while BTN is held), the header power switched on, the ENC28J60 powered, clocked from MCO1,
 * and its revision read back over SPI1.
 */
export const netduinoBlink: Example = {
  id: "netduino-blink",
  name: "Netduino Plus 2 blink",
  description: "Netduino Plus 2: the blue LED blinks, BTN speeds it up; the header rails and the ENC28J60 are switched on.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: netduinoProject }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("netduino-plus-2", 0, 0)
    return doc
  },
}
