/** PIC16 parts by profile: the PIC16F62x family shares one SoC class. */
import type { PicProfile } from "./chip"
import { PicMcu } from "./mcu"

export function createPic(chip: PicProfile): PicMcu {
  return new PicMcu(chip)
}
