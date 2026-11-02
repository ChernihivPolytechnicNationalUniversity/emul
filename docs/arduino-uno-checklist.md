# Arduino Uno Rev3 (A000066): what the documents say, row by row

The genuine Arduino UNO Rev3, through-hole ATmega328P-PU in a socket, as drawn in the Rev3e design
files. Nothing is modelled that is not in a row here; where the documents are silent, the row is a
question until it is decided. Parts already modelled for the Arduino Nano (A000005) are reused.

Documents (copies are kept outside the repository, in the project's docs/arduino-uno folder):

| | |
|---|---|
| SCH | A000066-schematics.pdf, "UNO-TH_Rev3e", 06/03/19 |
| CAD | A000066-cad-files.zip: UNO-TH_Rev3e.sch / .brd (Eagle 9.3.1), CC BY-SA 4.0 |
| DS | A000066-datasheet.pdf (product reference manual, 8 pages) |
| PIN | A000066-full-pinout.pdf, A000066-pinout.png |
| BT | Arduino AVR core boards.txt, `uno.*` entries |
| LP2985 | TI SLVS522S (May 2025) |
| LMV358 | TI SLOS263Y (Aug 2023) |
| FDN340P | onsemi FDN340P/D |
| MF-MSMF | Bourns MF-MSMF series |
| CG-MLC | Bourns ChipGuard MLC series |
| 16U2 | Atmel 7799 ATmega8U2/16U2/32U2 |
| NCP1117 | onsemi NCP1117/D: **missing**, the site refuses downloads |
| CSTCE | Murata CSTCE16M0V53-R0: **missing**, the site refuses downloads |

Status: **reuse**: already modelled (Nano or the chip), wired the same way; **todo**: documented, to be
modelled with a test; **soon**: documented, drawn on the board under a "soon" badge and listed under
"Not modelled" in the inspector; **info**: changes no behaviour; **decide**: needs the user or a
missing document.

## Board and layout

| # | Fact | Source | Status |
|---|---|---|---|
| B1 | Outline 68.58 × 53.34 mm; the notched right edge (66.04 → 68.58 mm between y 5.08 and 37.846, 45° corners); 1 mm corner radii | CAD .brd layer 20 | todo (art) |
| B2 | Mounting holes Ø3.2 at (66.04, 35.56), (66.04, 7.62), (15.24, 50.8), (13.97, 2.54) | CAD .brd | todo (art) |
| B3 | Every part at its .brd position and rotation (ZU4 DIP-28 at 46.355/16.383 R180, X2 USB-B at 3.81/38.1, X1 jack at 5.334/8.382, U3 16U2 QFN-32, U1 SOT-223, Y1 HC-49 crystal, Y2 resonator, LEDs L/TX/RX at x 27.94, ON at 58.42/36.576, RESET at 6.35/49.403, ICSP at 64.897/27.94, ICSP1 at 18.288/46.228) | CAD .brd | todo (art) |
| B4 | Headers: IOH 10 pins centred at x 30.226, IOL 8 pins at x 54.61 (both y 50.8); POWER 8 at x 36.83, AD 6 at x 57.15 (both y 2.54). IOH sits 0.06" (160 mil) off the 0.1" grid against IOL | CAD .brd | todo (seat shift as Open746I-C) |
| B5 | Silk: "UNO", "Arduino" (TM), "DIGITAL (PWM~)", "ANALOG IN", "POWER", pin names, "MADE IN ITALY", TX/RX/L/ON; real Arduino logo (∞ with − and +) | CAD .brd layers 21/25, photo | todo (art; logo from the official vector mark) |
| B6 | Board rotated as the real one lies: USB-B and the jack on the left, digital header along the top | photo | todo |

## Power

| # | Fact | Source | Status |
|---|---|---|---|
| P1 | USB VBUS (XUSB) → F1 MF-MSMF050-2 (hold 0.5 A, trip 1.0 A, 0.15–1.0 Ω) → USBVCC | SCH, MF-MSMF | reuse (Nano F1) |
| P2 | T1 FDN340P between USBVCC (D) and +5V (S); its body diode feeds +5V from USB before the gate is low; VGS(th) −0.4/−0.8/−1.5 V, RDS(on) 60/70 mΩ at −4.5 V, 110 mΩ at −2.5 V | SCH, FDN340P | todo |
| P3 | U5A LMV358: CMP = VIN through RN1 10k/10k (VIN/2) against +3V3; VIN above ≈ 6.6 V drives GATE_CMD high and turns T1 off, so USB stops feeding +5V | SCH | todo |
| P4 | Barrel jack X1 (2.1 mm) → D1 M7 (1 A, 1000 V) → VIN; PC1 47 µF/25 V | SCH, DS BOM | todo (D1 VF needs the M7 sheet: decide) |
| P5 | U1 NCP1117ST50T3G: VIN → +5V, PC2 47 µF + C2 100 nF | SCH | decide (NCP1117 sheet missing) |
| P6 | VIN 6–20 V allowed at the VIN pad, USB at most 5.5 V | DS §2.2 | todo (limits) |
| P7 | U2 LP2985-33DBVR: +5V → +3V3, ON/OFF tied to +5V, C3 1 µF; 150 mA, dropout 280 mV typ at 150 mA (legacy), GND current 850 µA at 150 mA, VIN abs max 16 V, thermal shutdown 170 °C | SCH, LP2985 §5 | todo |
| P8 | ON LED (green) from +5V through RN4 two 1 kΩ sections in parallel (500 Ω) | SCH net N$3 | todo |
| P9 | POWER header: NC, IOREF (= +5V), RESET, 3V3, 5V, GND, GND, VIN | SCH, DS pinout | todo |
| P10 | AVCC fed from +5V through L2 10 µH, C10 100 nF; C6 100 nF on VCC | SCH net AVCC | todo |

## ATmega328P side

| # | Fact | Source | Status |
|---|---|---|---|
| M1 | ATmega328P-PU (DIP-28): no ADC6/ADC7 | SCH | reuse (atmega328p chip) |
| M2 | Fuses as Arduino burns them: low 0xFF, high 0xDE (BOOTRST, 256-word boot section), extended 0xFD, lock 0x0F; sketch limit 32256 bytes | BT `uno.bootloader.*` | todo |
| M3 | Optiboot in the boot section | BT `uno.bootloader.file` | soon (as on the Nano: empty boot section runs straight into the sketch) |
| M4 | Y2 CSTCE16M0V53-R0 16 MHz resonator, R2 1 MΩ across XTAL1/XTAL2 | SCH | decide (tolerance needs the Murata sheet) |
| M5 | RESET: RN1 10 kΩ pull-up, D2 CD1206-S01575 to +5V, RESET button (TS42) to GND, also on POWER.3 and ICSP.5 | SCH net RESET | reuse (Nano pattern) |
| M6 | RESET-EN solder jumper (closed as shipped) passes DTR through C5 100 nF; cutting it stops the auto-reset | SCH, PIN | todo (inspector option) |
| M7 | "L" LED: D13 (SCK) → U5B LMV358 follower → RN2 1 kΩ → yellow LED; the pin itself only sees the op amp's input | SCH nets SCK, L13 | todo |
| M8 | IOH: SCL, SDA (= A5/A4), AREF, GND, 13…8; IOL 7…0; AD A0…A5 | SCH, PIN | todo |
| M9 | ICSP (328P): 1 MISO, 2 +5V, 3 SCK, 4 MOSI, 5 RESET, 6 GND | SCH | todo |
| M10 | AREF with C4 100 nF | SCH | todo |

## USB bridge (ATmega16U2)

| # | Fact | Source | Status |
|---|---|---|---|
| U1 | 16U2 TXD1 (PD3) → RN4 1 kΩ → D0/RX; D1/TX → RN4 1 kΩ → 16U2 RXD1 (PD2) | SCH nets M8RXD/M8TXD | todo (bridge as the Nano's FT232: idle-high output through 1 kΩ, host serial pins) |
| U2 | TX/RX LEDs (yellow) from +5V through RN2 1 kΩ into 16U2 PD5/PD4, lit while the firmware pulls them low | SCH nets N$35/N$36 | todo (lit while the line is active; the firmware's pulse stretch: soon) |
| U3 | DTR = 16U2 PD7 → C5 → RESET: a port opening resets the 328P | SCH net DTR | soon (as on the Nano) |
| U4 | 16U2 runs from +5V, its own 16 MHz crystal Y1 (22 pF C9/C11, R1 1 MΩ), RESET2 with RN1 10 kΩ + D3 | SCH | info (art) |
| U5 | ICSP1 (16U2) and JP2 (16U2 PB4–PB7, not mounted) | SCH | soon (no 16U2 firmware is emulated) |
| U6 | USB ESD Z1/Z2 CG0603MLC-05E, RN3 22 Ω data series, L1 BLM21 ferrite on the shield, GROUND solder jumper | SCH | info |

## Toolchain and examples

| # | Fact | Source | Status |
|---|---|---|---|
| T1 | Compile as `uno`: `-DARDUINO_AVR_UNO`, variant `standard`, F_CPU 16 MHz | BT | todo |
| T2 | The 16 popular sketches (`pnpm firmware-arduino`) run on the Uno as on the Nano | tests/sim/nano-popular.test.ts | todo |

## Questions

| # | Question |
|---|---|
| Q1 | NCP1117 and CSTCE16M0V53 data sheets: onsemi and Murata refuse scripted downloads; the user downloads them, or rows P5 and M4 wait |
| Q2 | DS BOM names U5 "LMV358LIST-A.9" while the schematic says LMV358IDGKR: same die, different package; the schematic's MSOP-8 is drawn |

## Assumptions to check

Figures the documents do not give, set by judgement so the parts behave; each is marked in the
part's inspector and is to be replaced when a source is found.

| # | Assumption | Where |
|---|---|---|
| A1 | NCP1117 junction-to-ambient time constant 2 s, thermal shutdown hysteresis 15 °C (back on at 160 °C) | `power-ics.ts` NCP1117_THERMAL |
| A2 | LP2985 junction-to-ambient time constant 1 s | `power-ics.ts` LP2985_THERMAL |
| A3 | Ceramic resonator start-up 0.5 ms | `clock.ts` RESONATOR_STARTUP |
| A4 | MF-MSMF trip point midway between Ihold and Itrip; reset by cooling with the heating's time constant (≈17 s for the MF-MSMF050) down to Ihold's heat | `netlist.ts` ptcModel |
