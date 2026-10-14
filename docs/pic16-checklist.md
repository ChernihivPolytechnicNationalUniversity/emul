# PIC16F62x: what the documents say, row by row

Every fact the documents give about the PIC16F627A/628A/648A and the original PIC16F627/628,
one row each, with where it is written. Nothing is modelled that is not in a row here; where the
documents are silent or contradict each other, the row is a question until it is decided.

Documents (text copies are kept outside the repository):

| | |
|---|---|
| DS40044G | PIC16F627A/628A/648A Data Sheet (2009) |
| DS40300C | PIC16F62X (PIC16F627/628) Data Sheet (2003) |
| DS41196G | PIC16F627A/628A/648A EEPROM Memory Programming Specification (2006) |
| DS80151B | PIC16F627A/628A Rev. A Silicon Errata (2003) |
| DS33023A | PICmicro Mid-Range MCU Family Reference Manual (1997), the sections the data sheet refers to |

Status: **done (core)** — modelled and tested (`tests/firmware/pic-core.test.ts`, `pic-flags.test.ts`);
**fix** — modelled wrongly, to be corrected; **todo** — documented, to be modelled with a test;
**D*n*** — decided below; **decide** — the documents contradict themselves or leave it open,
to be settled with the user before the block is written; **check PDF** — the text copy lost a
figure, to be read from the PDF page; **info** — a note that changes no behaviour.


## Summary

| Status | Rows |
|---|---|
| todo | 1233 |
| done (SoC) | 183 |
| done (core) | 168 |
| info | 160 |
| **decide** | 48 |
| **check PDF** | 9 |

| D1 | 2 |

| D4 | 2 |
| D5 | 1 |
| D2 | 1 |
| D3 | 1 |
| total | 1813 |

## Decisions where the documents are silent or contradict each other

Taken as real silicon most plausibly behaves; each says why. Rows that point here say **D*n***.

**D1. Reserved opcodes** (P4-218, P8-165) run as a one-cycle NOP and are reported in the inspector
("reserved opcode 0x…"). The documents promise nothing; the unused codes sit in the
`00 0000 0xxx xxxx` group whose decoded neighbours (NOP variants, RETURN, OPTION, SLEEP) do nothing to
data, so doing nothing is the likeliest outcome — and the report keeps the user from relying on it.

**D2. Power-on "x" values** (P8-079, Table 14-7): W, FSR, the general purpose RAM, C/DC/Z, TMR0,
TMR1, CCPR1, EEDATA/EEADR, the port latches and the (unreadable) stack pointer come up random on
every power-on reset and are kept by the other resets, as SRAM cells do. The inspector marks RAM the
program has not written since power-on. Firmware that forgets to initialise fails as on silicon
(P8-050).

**D3. "The CPU executes a NOP in the cycle immediately following the instruction which clears GIE"**
(§14.5 note 2, P8-104): read as the interrupt response that was about to start being dropped; the next
instruction runs normally. Losing the instruction after every `BCF INTCON,GIE` would break the data
sheet's own EEPROM write sequence (Example 13-2 re-checks GIE right after clearing it), so it cannot be
what the note means.

**D4. Asynchronous interrupt latency** (P8-108 vs P8-110, Figure 14-15): 3–4 TCY. Rule for every such
conflict: the device data sheet DS40044G wins over the family reference manual DS33023A; DS40300C is
used only for the original 627/628.

**D5. TRIS 7** (P4-309): no port C, so there is no TRISC latch to load — a NOP.

**D6. SLEEP with GIE = 1 while an enabled flag is set**: the "complete as a NOP" gate (§14.8.1 note,
DS33023A §26.4.2) is the wake-up term of Figure 14-14, which does not include GIE, so SLEEP completes
as a NOP here too; the interrupt is then taken as usual.

**D7. An interrupt requested during a two-cycle instruction**: 0004h starts three cycles after the Q1
that samples the request, whatever instruction is running ("the latency is the same for one or
two-cycle instructions", Figure 14-15 note 2); the address pushed is the one that instruction would
have continued at (its branch target).

**D9. Power-on reset level**: §14.4.1 gives "a VDD rise … in the range of 1.2–1.7 V"; the middle, 1.45 V.

**D10. POR re-arming**: D003 says a POR is ensured when VDD starts from VSS; the part is put back into
power-on reset when VDD falls under the same 1.45 V, so a supply that collapses and recovers resets it.

**D11. Leaving Program/Verify mode** (DS41196G P7-057: "not described"): only through a reset — MCLR
low for TMCL or a power-on. A part left with RB4/PGM high under LVP, or VPP brought straight down to VDD,
stays in Program/Verify and does not run, which is what such boards are known to do.

**D12. OSCF on resets** (P4-094): Tables 14-6 and 14-7 give 1 on MCLR/WDT/BOR resets, Table 14-5 "u";
two tables against one: 1.

**D13. TRISA5** (P1-211): reads 1 (Example 5-1, Table 4-4), not the 0 Figure 5-5 draws.

**D14. OST after a brown-out** (P4-067): runs, as Table 14-3 lists it; §14.4.3's "only on POR or wake-up"
is read as the text being shorter than its table.

**D15. Wake-up delays**: INTOSC by VDD from Table 17-5 F14 (6/4/3 µs at 2/3/5 V; Table 14-3's single
6 µs is the 2 V figure); RC/ER about 1 µs (Figure 14-17 note 2); EC none.

**D16. T0CKI synchronisation**: the increment lands 3 TOSC after the next Q2/Q4 sample, 3–5 TOSC after the
edge — inside DS33023A's 3–7 TOSC (P9-023); the original parts' speed switch (P6-012, undocumented) takes
the A parts' 2 + 8 clock pulses.

**D8. The 48 rows marked decide** are settled the same way, block by block, before each block is
written; the decision is added here.

## DS40044G §1–5, §19: architecture, memory, registers, ports, packages

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P1-001 | Operating speed DC – 20 MHz (static design: clock may go down to DC) | Front page "High-Performance RISC CPU", p.3 | timing | todo |
| P1-002 | 35 single-word instructions; all single cycle except branches (2 cycles) | Front page p.3; §1 p.7; §3 p.11 | timing | todo |
| P1-003 | 8-level deep hardware stack | Front page p.3; §1 p.7 | behaviour | todo |
| P1-004 | Direct, Indirect and Relative addressing modes | Front page p.3 | behaviour | todo |
| P1-005 | Internal oscillator: precision 4 MHz factory calibrated to ±1% | Front page "Special Microcontroller Features" p.3 | timing | todo |
| P1-006 | Low-power internal 48 kHz oscillator | Front page p.3 | timing | todo |
| P1-007 | Dual-speed internal oscillator: run-time selectable between 4 MHz and 48 kHz | Front page "Low-Power Features" p.3 | behaviour | todo |
| P1-008 | Wake-up from Sleep 4 μs typical at 3.0V (dual-speed INTOSC) | Front page p.3 | timing | todo |
| P1-009 | External oscillator support for crystals and resonators | Front page p.3 | behaviour | todo |
| P1-010 | Standby current 100 nA @ 2.0V typical | Front page p.3 | electrical | todo |
| P1-011 | Operating current 12 μA @ 32 kHz, 2.0V typical | Front page p.3 | electrical | todo |
| P1-012 | Operating current 120 μA @ 1 MHz, 2.0V typical | Front page p.3 | electrical | todo |
| P1-013 | Watchdog Timer current 1 μA @ 2.0V typical | Front page p.3 | electrical | todo |
| P1-014 | Timer1 oscillator current 1.2 μA @ 32 kHz, 2.0V typical | Front page p.3 | electrical | todo |
| P1-015 | Power-saving Sleep mode | Front page p.3 | behaviour | todo |
| P1-016 | Programmable weak pull-ups on PORTB | Front page p.3 | pin | todo |
| P1-017 | Multiplexed Master Clear / input pin (RA5/MCLR) | Front page p.3 | pin | todo |
| P1-018 | Watchdog Timer with independent oscillator ("its own on-chip RC oscillator") | Front page p.3; §1 p.7 | behaviour | todo |
| P1-019 | Low-voltage programming; ICSP via two pins | Front page p.3 | behaviour | todo |
| P1-020 | Programmable code protection | Front page p.3 | behaviour | todo |
| P1-021 | Brown-out Reset, Power-on Reset, Power-up Timer, Oscillator Start-up Timer present | Front page p.3 | behaviour | todo |
| P1-022 | Wide operating voltage range 2.0-5.5V (feature list) | Front page p.3 | electrical | todo |
| P1-023 | Industrial and extended temperature range | Front page p.3 | electrical | todo |
| P1-024 | Flash endurance 100,000 writes; EEPROM endurance 1,000,000 writes; 40 year data retention | Front page p.3 | memory | todo |
| P1-025 | 16 I/O pins with individual direction control | Front page p.3; Table 1-1 | pin | todo |
| P1-026 | High current sink/source for direct LED drive | Front page p.3 | electrical | todo |
| P1-027 | Analog comparator module: two analog comparators; programmable on-chip VREF; selectable internal or external reference; comparator outputs externally accessible | Front page p.3 | behaviour | todo |
| P1-028 | Timer0: 8-bit timer/counter with 8-bit programmable prescaler | Front page p.3 | behaviour | todo |
| P1-029 | Timer1: 16-bit timer/counter with external crystal/clock capability | Front page p.3 | behaviour | todo |
| P1-030 | Timer2: 8-bit timer/counter with 8-bit period register, prescaler and postscaler | Front page p.3 | behaviour | todo |
| P1-031 | CCP module: 16-bit Capture/Compare, 10-bit PWM | Front page p.3 | behaviour | todo |
| P1-032 | Addressable USART/SCI | Front page p.3 | behaviour | todo |
| P1-033 | Memory sizes: 627A Flash 1024 words, SRAM 224 B, EEPROM 128 B; 628A 2048 / 224 / 128; 648A 4096 / 256 / 256. All: 16 I/O, 1 CCP, USART Y, 2 comparators, timers 2/1 (8/16-bit) | Front page device table p.3; Table 1-1 p.7; Table 3-1 p.11; Table B-1 p.171 | memory | todo |
| P1-034 | Program memory word width 14 bits; data 8 bits (e.g. 1024 x 14, 224 x 8, 128 x 8) | Table 3-1 p.11; Table B-1 | memory | todo |
| P1-035 | LF variants (PIC16LF627A/628A/648A) have identical memory sizes to F variants | Table 1-1 p.7; Table 3-1 | memory | todo |
| P1-036 | Max frequency 20 MHz for all six variants including LF | Table 1-1 p.7 | timing | todo |
| P1-037 | Voltage range: PIC16F6xxA 3.0-5.5 V; PIC16LF6xxA 2.0-5.5 V | Table 1-1 p.7; Product ID p.179 | electrical | todo |
| P1-038 | Note: front-page "2.0-5.5V" applies only to LF parts; F parts are 3.0-5.5V per Table 1-1. Emulator must take VDD min from the variant | Front page vs Table 1-1 | note | info |
| P1-039 | 10 interrupt sources | Table 1-1 p.7 | behaviour | todo |
| P1-040 | Brown-out Reset available on all variants; internal voltage reference on all | Table 1-1 | behaviour | todo |
| P1-041 | Packages: 18-pin DIP, SOIC, 20-pin SSOP, 28-pin QFN | Table 1-1 p.7 | pin | todo |
| P1-042 | All devices have Power-on Reset, selectable WDT, selectable code-protect and high I/O current capability | Table 1-1 footnote p.7 | behaviour | todo |
| P1-043 | Serial programming uses clock pin RB6 and data pin RB7 | Table 1-1 footnote p.7 | pin | todo |
| P1-044 | Harvard architecture, separate 14-bit instruction bus and 8-bit data bus; two-stage pipeline | §1 p.7; §3 p.11 | behaviour | todo |
| P1-045 | "8 oscillator configurations"; text names RC (single-pin), LP (minimises power), XT (standard crystal), INTOSC (two-speed internal), HS (high-speed crystal), EC (external clock) | §1 p.7 | behaviour | todo |
| P1-046 | Note: §1 says 8 oscillator configurations but only names 6 (RC, LP, XT, INTOSC, HS, EC); the RA6 I/O vs CLKOUT variants of RC/INTOSC are implied by Fig 5-6/5-7 FOSC codes, detail lives in §14 | §1 p.7 vs Fig 5-6/5-7 | note | info |
| P1-047 | Sleep wake-up sources: several external interrupts, internal interrupts and Resets | §1 p.7 | behaviour | todo |
| P1-048 | Instruction cycle 200 ns @ 20 MHz | §3 p.11 | timing | todo |
| P1-049 | All SFRs including the program counter are mapped in data memory; orthogonal instruction set (any operation, any register, any addressing mode) | §3 p.11 | memory | todo |
| P1-050 | 8-bit ALU; arithmetic is two's complement unless otherwise stated | §3 p.11 | behaviour | todo |
| P1-051 | W register is 8-bit and NOT an addressable register | §3 p.11 | register | todo |
| P1-052 | Two-operand instructions: one operand W, other a file register or immediate; single-operand: W or file register | §3 p.11 | behaviour | todo |
| P1-053 | ALU may affect C, DC, Z in STATUS; C and DC act as Borrow and Digit Borrow (inverted polarity) in subtraction (SUBLW, SUBWF) | §3 p.11; §4.2.2.1 Note p.24 | behaviour | todo |
| P1-054 | EEPROM data retained without power; RAM lost when power removed | §3 p.11 | memory | todo |
| P1-055 | Block diagram: 13-bit PC, 8-level x 13-bit stack, 14-bit program bus, RAM address 9 bits via Addr MUX from 7-bit direct address or 8-bit FSR indirect address; higher-order address bits come from STATUS | Figure 3-1 + Note 1 p.12 | memory | todo |
| P1-056 | Pin RA0/AN0: RA0 input ST, output CMOS (bidirectional I/O); AN0 analog comparator input | Table 3-2 p.13; Table 5-1 p.37 | pin | todo |
| P1-057 | Pin RA1/AN1: RA1 ST/CMOS; AN1 analog comparator input | Table 3-2; Table 5-1 | pin | todo |
| P1-058 | Pin RA2/AN2/VREF: RA2 ST/CMOS; AN2 analog comparator input; VREF analog output | Table 3-2; Table 5-1 | pin | todo |
| P1-059 | Pin RA3/AN3/CMP1: RA3 ST/CMOS; AN3 analog input; CMP1 = comparator 1 output, CMOS | Table 3-2; Table 5-1 | pin | todo |
| P1-060 | Pin RA4/T0CKI/CMP2: RA4 input ST, output OD (open drain); T0CKI input ST; CMP2 comparator 2 output OD | Table 3-2; Table 5-1 | pin | todo |
| P1-061 | Pin RA5/MCLR/VPP: RA5 is input-only, ST, no output driver; MCLR input ST, active-low Reset; VPP programming voltage input | Table 3-2; Table 5-1; §5.1 p.33 | pin | todo |
| P1-062 | Voltage on MCLR/VPP must not exceed VDD during normal device operation | Table 3-2 p.13; Table 5-1 p.37 | electrical | todo |
| P1-063 | Applying VPP voltage levels to RA5 makes the device enter Programming mode (an RA5 input driven above VDD exits normal run) | §5.1 Note 1 p.33; Fig 5-5 "HV Detect → Program mode" | failure-mode | todo |
| P1-064 | Note: VPP input type is "—" in Table 3-2 but "HV" in Table 5-1 | Table 3-2 p.13 vs Table 5-1 p.37 | note | info |
| P1-065 | Pin RA6/OSC2/CLKOUT: RA6 ST/CMOS I/O; OSC2 crystal output (XTAL) in crystal modes; CLKOUT CMOS output in RC/INTOSC mode at 1/4 of OSC1 frequency | Table 3-2; Table 5-1 | pin | todo |
| P1-066 | Pin RA7/OSC1/CLKIN: RA7 ST/CMOS I/O; OSC1 crystal input (XTAL); CLKIN ST external clock input, RC biasing pin | Table 3-2; Table 5-1 | pin | todo |
| P1-067 | Pin RB0/INT: RB0 input TTL, output CMOS, weak pull-up programmable; INT external interrupt input ST | Table 3-2; Table 5-3 p.45 | pin | todo |
| P1-068 | Pin RB1/RX/DT: RB1 TTL/CMOS with pull-up; RX USART receive input ST; DT synchronous data I/O, input ST, output CMOS | Table 3-2; Table 5-3 | pin | todo |
| P1-069 | Pin RB2/TX/CK: RB2 TTL/CMOS; TX USART transmit output CMOS; CK synchronous clock I/O, input ST, output CMOS; weak pull-up | Table 3-2; Table 5-3 | pin | todo |
| P1-070 | Note: Table 3-2 puts "Can be software programmed for internal weak pull-up" on the RB2 row, Table 5-3 puts it on the CK row instead (RB2 row says only "Bidirectional I/O port"). Fig 5-10 shows a weak pull-up on the pin, so treat RB2 as having a pull-up | Table 3-2 p.13 vs Table 5-3 p.45 | note | info |
| P1-071 | Pin RB3/CCP1: RB3 TTL/CMOS with pull-up; CCP1 Capture/Compare/PWM I/O, input ST, output CMOS | Table 3-2; Table 5-3 | pin | todo |
| P1-072 | Pin RB4/PGM: RB4 TTL/CMOS, interrupt-on-change, weak pull-up; PGM low-voltage programming input ST. When LVP enabled, interrupt-on-change and weak pull-up on RB4 are disabled | Table 3-2 p.14; Table 5-3; Fig 5-12 note | pin | todo |
| P1-073 | Pin RB5: TTL/CMOS, interrupt-on-change, weak pull-up; no alternate function | Table 3-2; Table 5-3 | pin | todo |
| P1-074 | Pin RB6/T1OSO/T1CKI/PGC: RB6 TTL/CMOS, IOC, pull-up; T1OSO Timer1 oscillator output (XTAL); T1CKI Timer1 clock input ST; PGC ICSP clock input ST | Table 3-2; Table 5-3 | pin | todo |
| P1-075 | Pin RB7/T1OSI/PGD: RB7 TTL/CMOS, IOC, pull-up; T1OSI Timer1 oscillator input (XTAL); PGD ICSP data I/O, input ST, output CMOS | Table 3-2; Table 5-3 | pin | todo |
| P1-076 | VSS ground for logic and I/O; VDD positive supply for logic and I/O | Table 3-2 p.14 | pin | todo |
| P1-077 | PORTA port inputs are all Schmitt Trigger; PORTB port inputs are all TTL; PORTB alternate-function inputs (INT, RX, DT, CK, CCP1, T1CKI, PGM, PGC, PGD) are ST | Table 3-2; Tables 5-1, 5-3; Figs 5-8..5-15 | pin | todo |
| P1-078 | PDIP-18/SOIC-18 pinout: 1 RA2/AN2/VREF, 2 RA3/AN3/CMP1, 3 RA4/T0CKI/CMP2, 4 RA5/MCLR/VPP, 5 VSS, 6 RB0/INT, 7 RB1/RX/DT, 8 RB2/TX/CK, 9 RB3/CCP1, 10 RB4/PGM, 11 RB5, 12 RB6/T1OSO/T1CKI/PGC, 13 RB7/T1OSI/PGD, 14 VDD, 15 RA6/OSC2/CLKOUT, 16 RA7/OSC1/CLKIN, 17 RA0/AN0, 18 RA1/AN1 | Pin Diagrams p.4 | pin | todo |
| P1-079 | SSOP-20 has two VSS and two VDD pins; signal set as PDIP. Pins 1–10 on one side carry RA2, RA3, RA4, RA5, VSS, VSS, RB0, RB1, RB2, RB3 and 11–20 carry RB4, RB5, RB6, RB7, VDD, VDD, RA6, RA7, RA0, RA1 (sets taken from the diagram; the per-pin order is scrambled in the text extraction) | Pin Diagrams p.4 | pin | todo |
| P1-080 | Note: SSOP-20 pin-number-to-signal mapping cannot be read reliably from the pdftotext extraction (rotated labels); verify against the PDF before modelling an SSOP footprint | Pin Diagrams p.4 | note | **check PDF** |
| P1-081 | QFN-28 pinout (readable part): 1 RA5/MCLR/VPP, 2 NC, 3 VSS, 4 NC, 5 VSS, 6 NC, 7 RB0/INT, 11 NC, 14 NC, 15 RB6/T1OSO/T1CKI/PGC, 16 RB7/T1OSI/PGD, 17 VDD, 18 NC, 19 VDD, 20 RA6/OSC2/CLKOUT, 21 RA7/OSC1/CLKIN, 22 NC, 25 NC. Pins 8,9,10,12,13 carry RB1..RB5 and 23,24,26,27,28 carry RA0..RA4 (exact order scrambled in extraction). Exposed pad on bottom | Pin Diagrams p.4; §19 QFN drawing p.168 | pin | todo |
| P1-082 | Note: QFN-28 was revised in Rev B (pin diagram) and Rev G (package marking §19.1); per-pin order of RA0–RA4 / RB1–RB5 must be verified against the PDF | p.4; Appendix A p.171 | note | **check PDF** |
| P1-083 | Clock input (OSC1/CLKIN) internally divided by four into non-overlapping quadrature clocks Q1, Q2, Q3, Q4; instruction cycle = 4 Q cycles | §3.1, §3.2 p.15 | timing | done (core) |
| P1-084 | PC incremented every Q1; instruction fetched from program memory and latched into IR in Q4; decoded and executed in the following Q1–Q4 | §3.1 p.15 | timing | done (core) |
| P1-085 | Execution cycle: fetched instruction latched in IR in Q1, decoded/executed in Q2–Q4; data memory read in Q2 (operand read), written in Q4 (destination write) | §3.2 p.15 | timing | done (core) |
| P1-086 | Fetch of PC+1 overlaps execution of PC; an instruction that changes PC (e.g. GOTO) takes two cycles because the prefetched instruction is flushed | §3.2; Example 3-1; Note p.15 | timing | done (core) |
| P1-087 | Example 3-1: CALL SUB_1 at addr 3 causes the already-fetched BSF PORTA,3 to be flushed (never executed) and SUB_1 fetched then executed | Example 3-1 p.15 | behaviour | done (core) |
| P1-088 | CLKOUT pin shows the instruction-cycle clock (Fig 3-2 waveform aligned to Q1..Q4) | Figure 3-2 p.15 | timing | todo |
| P1-089 | 13-bit PC addresses 8K x 14 space (0000h–1FFFh); implemented: 627A 1K (0000h–03FFh), 628A 2K (0000h–07FFh), 648A 4K (0000h–0FFFh) | §4.1 p.17; Fig 4-1 | memory | done (core) |
| P1-090 | Accessing a program location above the implemented size wraps around within the first 1K/2K/4K | §4.1 p.17 | memory | done (core) |
| P1-091 | Reset vector 0000h; interrupt vector 0004h; on-chip program memory starts at 0005h after vectors | §4.1; Figure 4-1 p.17 | memory | done (core) |
| P1-092 | Stack holds PC<12:0> (13 bits) pushed/popped by CALL, RETURN, RETFIE, RETLW (and interrupt) | Figure 4-1; §4.3.2 p.30 | behaviour | done (core) |
| P1-093 | Data memory partitioned into 4 banks of 128 bytes; SFRs in the first 32 locations of each bank | §4.2 p.17 | memory | done (core) |
| P1-094 | Bank select via STATUS RP1:RP0: 00 Bank0, 01 Bank1, 10 Bank2, 11 Bank3 | Table 4-2 p.17; Register 4-1 | register | done (core) |
| P1-095 | GPR (627A/628A): Bank0 20h–7Fh, Bank1 A0h–FFh, Bank2 120h–14Fh and 170h–17Fh, Bank3 1F0h–1FFh | Table 4-1 p.17; Fig 4-2 | memory | done (core) |
| P1-096 | GPR (648A): Bank0 20h–7Fh, Bank1 A0h–FFh, Bank2 120h–17Fh, Bank3 1F0h–1FFh | Table 4-1 p.17; Fig 4-3 | memory | done (core) |
| P1-097 | Common RAM: F0h–FFh, 170h–17Fh and 1F0h–1FFh map back to 70h–7Fh (16 bytes shared across all banks) | §4.2 p.17; Figs 4-2/4-3 | memory | done (core) |
| P1-098 | 627A/628A Bank0 GPR 20h–6Fh = 80 bytes + 70h–7Fh 16 bytes; Bank1 A0h–EFh 80 bytes; Bank2 120h–14Fh 48 bytes; 150h–16Fh unimplemented; Bank3 1A0h–1EFh unimplemented (total 224) | Figure 4-2 p.18 | memory | done (core) |
| P1-099 | 648A Bank2 GPR 120h–16Fh 80 bytes; Bank3 1A0h–1EFh unimplemented (total 256) | Figure 4-3 p.19 | memory | done (core) |
| P1-100 | Unimplemented data memory locations read as '0' | Figs 4-2/4-3 legend; Tables 4-3..4-6 legend | memory | done (core) |
| P1-101 | Register file 224 x 8 (627A/628A), 256 x 8 (648A); accessible directly or indirectly via FSR | §4.2.1 p.17 | memory | done (core) |
| P1-102 | Note: Table 4-1 lists Bank1 GPR as "A0h-FF", which includes the F0h–FFh common area also described as mapping to 70h–7Fh; Bank1 has 80 unique bytes (A0h–EFh) | Table 4-1 vs Fig 4-2 | note | info |
| P1-103 | INDF at 00h/80h/100h/180h: not a physical register; addressing it uses FSR. Reset value shown xxxx xxxx | Tables 4-3..4-6; Fig 4-2 Note 1 | register | done (core) |
| P1-104 | TMR0 at 01h and 101h (mirrored in Bank0 and Bank2), POR xxxx xxxx | Table 4-3, 4-5; Fig 4-2 | register | todo |
| P1-105 | OPTION at 81h and 181h (Bank1 and Bank3), POR 1111 1111, other resets 1111 1111 | Tables 4-4, 4-6, 5-4 | register | todo |
| P1-106 | PCL at 02h/82h/102h/182h, POR 0000 0000 | Tables 4-3..4-6 | register | done (core) |
| P1-107 | STATUS at 03h/83h/103h/183h, POR 0001 1xxx | Tables 4-3..4-6; Register 4-1 | register | done (core) |
| P1-108 | FSR at 04h/84h/104h/184h, POR xxxx xxxx | Tables 4-3..4-6 | register | done (core) |
| P1-109 | PORTA at 05h only (105h unimplemented); POR xxxx 0000; other resets qqqu 0000 | Table 4-3, 4-5; Table 5-2 p.37 | register | todo |
| P1-110 | TRISA at 85h only (185h unimplemented); POR 1111 1111; other resets 1111 1111 | Tables 4-4, 4-6, 5-2 | register | todo |
| P1-111 | PORTB at 06h and 106h; POR xxxx xxxx; other resets uuuu uuuu | Tables 4-3, 4-5, 5-4 | register | todo |
| P1-112 | TRISB at 86h and 186h; POR 1111 1111; other resets 1111 1111 | Tables 4-4, 4-6, 5-4 | register | todo |
| P1-113 | Unimplemented SFR addresses: 07h–09h, 0Dh, 13h, 14h, 1Bh–1Eh; 87h–89h, 8Dh, 8Fh–91h, 93h–97h, 9Eh; 105h, 107h–109h, 10Ch–11Fh; 185h, 187h–189h, 18Ch–19Fh | Tables 4-3..4-6 | register | todo |
| P1-114 | PCLATH at 0Ah/8Ah/10Ah/18Ah: bits 7:5 unimplemented (read 0), bits 4:0 write buffer for upper 5 bits of PC; POR ---0 0000 | Tables 4-3..4-6 | register | done (core) |
| P1-115 | INTCON at 0Bh/8Bh/10Bh/18Bh; POR 0000 000x | Tables 4-3..4-6; Register 4-3 | register | todo |
| P1-116 | PIR1 at 0Ch (bank0 only); bits EEIF CMIF RCIF TXIF — CCP1IF TMR2IF TMR1IF; POR 0000 -000 | Table 4-3; Register 4-5 | register | todo |
| P1-117 | TMR1L 0Eh, TMR1H 0Fh: holding registers for LSB/MSB of 16-bit TMR1; POR xxxx xxxx | Table 4-3 | register | todo |
| P1-118 | T1CON 10h: — — T1CKPS1 T1CKPS0 T1OSCEN T1SYNC TMR1CS TMR1ON; POR --00 0000 | Table 4-3 | register | todo |
| P1-119 | TMR2 11h POR 0000 0000 | Table 4-3 | register | todo |
| P1-120 | T2CON 12h: — TOUTPS3 TOUTPS2 TOUTPS1 TOUTPS0 TMR2ON T2CKPS1 T2CKPS0; POR -000 0000 | Table 4-3 | register | todo |
| P1-121 | CCPR1L 15h, CCPR1H 16h POR xxxx xxxx | Table 4-3 | register | todo |
| P1-122 | CCP1CON 17h: — — CCP1X CCP1Y CCP1M3 CCP1M2 CCP1M1 CCP1M0; POR --00 0000 | Table 4-3 | register | todo |
| P1-123 | RCSTA 18h: SPEN RX9 SREN CREN ADEN FERR OERR RX9D; POR 0000 000x | Table 4-3 | register | todo |
| P1-124 | TXREG 19h POR 0000 0000; RCREG 1Ah POR 0000 0000 | Table 4-3 | register | todo |
| P1-125 | CMCON 1Fh: C2OUT C1OUT C2INV C1INV CIS CM2 CM1 CM0; POR 0000 0000, other resets 0000 0000 | Table 4-3; Table 5-2 | register | todo |
| P1-126 | PIE1 8Ch: EEIE CMIE RCIE TXIE — CCP1IE TMR2IE TMR1IE; POR 0000 -000 | Table 4-4; Register 4-4 | register | todo |
| P1-127 | PCON 8Eh: — — — — OSCF — POR BOR; POR ---- 1-0x | Table 4-4; Register 4-6 | register | todo |
| P1-128 | PR2 92h Timer2 period register POR 1111 1111 | Table 4-4 | register | todo |
| P1-129 | TXSTA 98h: CSRC TX9 TXEN SYNC — BRGH TRMT TX9D; POR 0000 -010 | Table 4-4 | register | todo |
| P1-130 | SPBRG 99h POR 0000 0000 | Table 4-4 | register | todo |
| P1-131 | EEDATA 9Ah POR xxxx xxxx; EEADR 9Bh POR xxxx xxxx | Table 4-4 | register | todo |
| P1-132 | EECON1 9Ch: — — — — WRERR WREN WR RD; POR ---- x000 | Table 4-4 | register | todo |
| P1-133 | EECON2 9Dh: not a physical register; POR ---- ---- | Table 4-4; Fig 4-2 Note 1 | register | todo |
| P1-134 | VRCON 9Fh: VREN VROE VRR — VR3 VR2 VR1 VR0; POR 000- 0000, other resets 000- 0000 | Table 4-4; Table 5-2 | register | todo |
| P1-135 | Bank0-only peripheral SFRs (PIR1, TMR1L/H, T1CON, TMR2, T2CON, CCPR1L/H, CCP1CON, RCSTA, TXREG, RCREG, CMCON) are NOT mirrored in Bank2 (10Ch–11Fh unimplemented); Bank1-only SFRs (PIE1, PCON, PR2, TXSTA, SPBRG, EE*, VRCON) not mirrored in Bank3 | Tables 4-5, 4-6 | memory | todo |
| P1-136 | SFR register legend: '-' = unimplemented read as '0', u unchanged, x unknown, q depends on condition. Full reset initialisation in Table 14-6 and 14-7 | Tables 4-3..4-6 legend + Note 1 | note | info |
| P1-137 | STATUS bit7 IRP: indirect bank select, 1 = Bank 2,3 (100h–1FFh), 0 = Bank 0,1 (00h–FFh); R/W-0 | Register 4-1 p.24 | register | done (core) |
| P1-138 | STATUS bits 6:5 RP<1:0>: direct bank select 00 = 00h–7Fh, 01 = 80h–FFh, 10 = 100h–17Fh, 11 = 180h–1FFh; R/W-0 | Register 4-1 | register | done (core) |
| P1-139 | STATUS bit4 TO (R-1): 1 after power-up, CLRWDT or SLEEP; 0 when WDT time-out occurred | Register 4-1 | register | done (core) |
| P1-140 | STATUS bit3 PD (R-1): 1 after power-up or CLRWDT; 0 after SLEEP instruction | Register 4-1 | register | done (core) |
| P1-141 | STATUS bit2 Z (R/W-x): 1 if arithmetic/logic result is zero | Register 4-1 | register | done (core) |
| P1-142 | STATUS bit1 DC (R/W-x): carry out of 4th low-order bit for ADDWF, ADDLW, SUBLW, SUBWF; borrow polarity reversed | Register 4-1 | register | done (core) |
| P1-143 | STATUS bit0 C (R/W-x): carry out of MSb for ADDWF, ADDLW, SUBLW, SUBWF; borrow polarity reversed; subtraction executed by adding two's complement of second operand; RRF/RLF load C with low/high-order bit of source | Register 4-1 + Note | register | done (core) |
| P1-144 | TO and PD are not writable by any instruction (read-only) | §4.2.2.1 p.24 | register | done (core) |
| P1-145 | If STATUS is the destination of an instruction that affects Z, DC or C, the write to those three bits is disabled; they are set/cleared by the instruction logic instead | §4.2.2.1 p.24 | behaviour | done (core) |
| P1-146 | CLRF STATUS clears the upper three bits (IRP, RP1, RP0) and sets Z, leaving STATUS = 000uu1uu | §4.2.2.1 p.24 | behaviour | done (core) |
| P1-147 | Recommended to alter STATUS only with BCF, BSF, SWAPF, MOVWF (they affect no status bits) | §4.2.2.1 p.24 | note | info |
| P1-148 | OPTION bit7 RBPU: 1 = PORTB pull-ups disabled; 0 = pull-ups enabled by individual port latch values (R/W-1) | Register 4-2 p.25 | register | todo |
| P1-149 | OPTION bit6 INTEDG: 1 = interrupt on rising edge of RB0/INT; 0 = falling edge (R/W-1) | Register 4-2 | register | todo |
| P1-150 | OPTION bit5 T0CS: 1 = transition on RA4/T0CKI/CMP2; 0 = internal instruction cycle clock (CLKOUT) (R/W-1) | Register 4-2 | register | todo |
| P1-151 | OPTION bit4 T0SE: 1 = increment on high-to-low transition on RA4/T0CKI; 0 = low-to-high (R/W-1) | Register 4-2 | register | todo |
| P1-152 | OPTION bit3 PSA: 1 = prescaler assigned to WDT; 0 = assigned to Timer0 (R/W-1) | Register 4-2 | register | todo |
| P1-153 | OPTION bits 2:0 PS: TMR0 rate 000 1:2, 001 1:4, 010 1:8, 011 1:16, 100 1:32, 101 1:64, 110 1:128, 111 1:256; WDT rate 000 1:1, 001 1:2, 010 1:4, 011 1:8, 100 1:16, 101 1:32, 110 1:64, 111 1:128 | Register 4-2 p.25 | register | todo |
| P1-154 | 1:1 TMR0 prescale achieved by assigning prescaler to WDT (PSA = 1); see §6.3.1 on switching assignment | §4.2.2.2 Note p.25 | behaviour | todo |
| P1-155 | OPTION name: OPTION_REG; addresses 81h, 181h | Register 4-2 | register | todo |
| P1-156 | INTCON holds enables/flags for all sources except the comparator (and other peripherals in PIE1/PIR1) | §4.2.2.3 p.26 | register | todo |
| P1-157 | INTCON bit7 GIE: 1 enables all un-masked interrupts, 0 disables all (R/W-0) | Register 4-3 p.26 | register | todo |
| P1-158 | INTCON bit6 PEIE: enables all un-masked peripheral interrupts (R/W-0) | Register 4-3 | register | todo |
| P1-159 | INTCON bit5 T0IE TMR0 overflow enable; bit4 INTE RB0/INT enable; bit3 RBIE RB port change enable (all R/W-0) | Register 4-3 | register | todo |
| P1-160 | INTCON bit2 T0IF: TMR0 overflowed, must be cleared in software (R/W-0) | Register 4-3 | register | todo |
| P1-161 | INTCON bit1 INTF: RB0/INT interrupt occurred, cleared in software (R/W-0) | Register 4-3 | register | todo |
| P1-162 | INTCON bit0 RBIF (R/W-x): 1 when at least one of RB<7:4> changed state, cleared in software | Register 4-3 | register | todo |
| P1-163 | Interrupt flag bits are set when the condition occurs regardless of the corresponding enable bit or GIE | §4.2.2.3 Note p.26; §4.2.2.5 Note p.28 | behaviour | todo |
| P1-164 | User software should clear the appropriate flag before enabling an interrupt (a stale flag fires immediately on enable) | §4.2.2.5 Note p.28 | failure-mode | todo |
| P1-165 | PIE1 bit7 EEIE EE write complete; bit6 CMIE comparator; bit5 RCIE USART receive; bit4 TXIE USART transmit; bit3 unimplemented read '0'; bit2 CCP1IE; bit1 TMR2IE TMR2-to-PR2 match; bit0 TMR1IE TMR1 overflow; all implemented bits R/W-0 | Register 4-4 p.27 | register | todo |
| P1-166 | PIR1 bit7 EEIF (R/W-0): EEPROM write completed, cleared in software | Register 4-5 p.28 | register | todo |
| P1-167 | PIR1 bit6 CMIF (R/W-0): comparator output has changed | Register 4-5 | register | todo |
| P1-168 | PIR1 bit5 RCIF (R-0, read-only): 1 = USART receive buffer full, 0 = empty | Register 4-5 | register | todo |
| P1-169 | PIR1 bit4 TXIF (R-0, read-only): 1 = USART transmit buffer empty, 0 = full | Register 4-5 | register | todo |
| P1-170 | PIR1 bit3 unimplemented, reads '0' | Register 4-5 | register | todo |
| P1-171 | PIR1 bit2 CCP1IF (R/W-0): capture mode = TMR1 capture occurred; compare mode = TMR1 compare match; PWM mode unused; cleared in software | Register 4-5 | register | todo |
| P1-172 | PIR1 bit1 TMR2IF TMR2-to-PR2 match; bit0 TMR1IF TMR1 overflow; both R/W-0, cleared in software | Register 4-5 | register | todo |
| P1-173 | Note: PIR1 POR value 0000 -000 implies TXIF reads 0 after POR (transmit buffer "full"), while TXSTA TRMT POR = 1 (shift register empty); check against §12 | Table 4-3 vs Table 4-4 | note | info |
| P1-174 | PCON bits 7:4 unimplemented, read '0'; bit2 unimplemented, read '0' | Register 4-6 p.29 | register | todo |
| P1-175 | PCON bit3 OSCF (R/W-1): INTOSC frequency 1 = 4 MHz typical, 0 = 48 kHz typical | Register 4-6 | register | todo |
| P1-176 | PCON bit1 POR (R/W-0): 0 = Power-on Reset occurred, must be set in software afterwards; 1 = no POR | Register 4-6 | register | todo |
| P1-177 | PCON bit0 BOR (R/W-x): 0 = Brown-out Reset occurred, must be set in software afterwards; 1 = no BOR | Register 4-6 | register | todo |
| P1-178 | BOR is unknown on POR; user sets it and checks on later resets. BOR status is "don't care"/unpredictable when brown-out circuit disabled (BOREN cleared in Configuration Word) | §4.2.2.6 Note p.29 | behaviour | todo |
| P1-179 | PCON distinguishes POR, external MCLR Reset, WDT Reset and BOR | §4.2.2.6 p.29 | behaviour | todo |
| P1-180 | PC is 13 bits; low byte PCL readable/writable; high byte PC<12:8> not directly readable/writable, loaded from PCLATH | §4.3 p.30 | register | done (core) |
| P1-181 | On any Reset the PC is cleared | §4.3 p.30 | behaviour | done (core) |
| P1-182 | Write to PCL as destination: PC<12:8> ← PCLATH<4:0>, PC<7:0> ← ALU result | §4.3; Figure 4-4 p.30 | behaviour | done (core) |
| P1-183 | GOTO/CALL: PC<10:0> ← opcode<10:0>, PC<12:11> ← PCLATH<4:3> | §4.3; Figure 4-4 | behaviour | done (core) |
| P1-184 | Computed GOTO via ADDWF PCL: table crossing a 256-byte PCL boundary needs care (PCLATH not auto-incremented); see AN556 | §4.3.1 p.30 | failure-mode | todo |
| P1-185 | Stack: 8-level x 13-bit; not in program or data space; stack pointer not readable/writable | §4.3.2 p.30 | behaviour | done (core) |
| P1-186 | PC pushed on CALL or interrupt branch; popped on RETURN, RETLW, RETFIE; PCLATH not affected by push or pop | §4.3.2 p.30 | behaviour | done (core) |
| P1-187 | Stack is circular: 9th push overwrites value from 1st push, 10th overwrites 2nd, etc. | §4.3.2 p.30 | failure-mode | done (core) |
| P1-188 | No status bits indicate stack overflow or underflow | §4.3.2 Note 1 | failure-mode | done (core) |
| P1-189 | No PUSH/POP instructions; push/pop only via CALL, RETURN, RETLW, RETFIE or interrupt vectoring | §4.3.2 Note 2 | note | done (core) |
| P1-190 | INDF access uses data pointed to by FSR; effective 9-bit address = IRP (STATUS<7>) : FSR<7:0> | §4.4 p.30; Figure 4-5 p.31 | behaviour | done (core) |
| P1-191 | Reading INDF itself indirectly (FSR pointing at INDF) produces 00h | §4.4 p.30 | behaviour | done (core) |
| P1-192 | Writing INDF indirectly (FSR pointing at INDF) is a no-operation, although Status bits may be affected | §4.4 p.30 | behaviour | done (core) |
| P1-193 | Direct addressing: 9-bit address = RP1:RP0 : opcode<6:0> | Figure 4-5 p.31 | behaviour | done (core) |
| P1-194 | Example 4-1: clear 20h–2Fh using FSR/INDF loop terminating on BTFSS FSR,4 (usable as an indirect-addressing test) | Example 4-1 p.30 | behaviour | todo |
| P1-195 | Two ports PORTA and PORTB; when a peripheral is enabled the pin generally may not be used as GPIO | §5.0 p.33 | pin | done (SoC) |
| P1-196 | PORTA is an 8-bit wide latch | §5.1 p.33 | register | done (SoC) |
| P1-197 | TRIS bit '1' = output driver hi-Z (input); '0' = latch contents driven on pin (both ports) | §5.1, §5.2 | pin | done (SoC) |
| P1-198 | Reading PORTx reads pin states; writing writes the latch; all writes are read-modify-write (pins read, modified, written to latch) | §5.1, §5.2, §5.3.1 | behaviour | done (SoC) |
| P1-199 | PORTA pins selected as comparator (analog) inputs read as '0' | §5.1 p.33; Fig 5-1 (Analog Input Mode gates ST buffer) | pin | done (SoC) |
| P1-200 | On Reset TRISA = all inputs; digital inputs RA<3:0> disabled and comparator inputs forced to ground (to reduce current) | §5.1 Note 2 p.33 | behaviour | done (SoC) |
| P1-201 | TRISA<7:6> overridden by oscillator configuration; when overridden, PORTA<7:6> data reads '0' and TRISA<7:6> are ignored | §5.1 Note 3 p.33 | pin | done (SoC) |
| P1-202 | TRISA still controls direction of RA pins used as comparator inputs; user must keep them as inputs (output driver would fight the analog signal) | §5.1 p.33 | failure-mode | todo |
| P1-203 | RA2 also VREF output: very high-impedance output; TRISA<2> must be input; use high-impedance loads | §5.1 p.33 | electrical | todo |
| P1-204 | Fig 5-2: VROE switch connects VREF to RA2 pin | Figure 5-2 p.34 | pin | todo |
| P1-205 | In one comparator mode RA3 and RA4 become comparator outputs; TRISA<4:3> must be cleared for outputs to appear | §5.0/5.1 p.33 | pin | todo |
| P1-206 | Figs 5-3/5-4: output mux selects comparator output instead of data latch when CMCON comparator mode = 110 (RA3 = C1 out, RA4 = C2 out) | Figure 5-3, 5-4 p.34-35 | pin | todo |
| P1-207 | RA4 output is N-channel to VSS only (open drain), no P-channel; needs external pull-up to drive high; also applies to CMP2 output | Figure 5-4 p.35; Table 5-1 | electrical | done (SoC) |
| P1-208 | RA4 Schmitt buffer feeds TMR0 clock input | Figure 5-4 | pin | todo |
| P1-209 | Example 5-1: writing CMCON = 0x07 turns comparators off and enables PORTA digital I/O | Example 5-1 p.33 | behaviour | done (SoC) |
| P1-210 | Example 5-1 comment: TRISA<5> always reads as '1'; TRISA<7:6> depend on oscillator mode | Example 5-1 p.33 | register | done (SoC) |
| P1-211 | Note: Fig 5-5 draws RD TRISA for RA5 tied to VSS (suggesting '0'), contradicting the Example 5-1 comment that TRISA<5> always reads '1'; and TRISA reset is listed 1111 1111 | Fig 5-5 p.35 vs Example 5-1 p.33 | note | **decide** |
| P1-212 | RA5/MCLR: MCLRE configuration bit selects MCLR vs RA5 input; MCLR path has a "MCLR filter"; HV detect drives Program mode | Figure 5-5; Table 5-2 Note 1 | pin | done (SoC) |
| P1-213 | RA6: output mux drives CLKOUT (FOSC/4) when FOSC = 101 or 111 (INTOSC or RC with RA6 = CLKOUT) | Figure 5-6 + Note 2 p.35 | pin | todo |
| P1-214 | RA6: digital I/O path (latch/TRIS/ST buffer read) enabled when FOSC = 011, 100, 110 (Note 1: INTOSC with RA6 = I/O or RC with RA6 = I/O) | Figure 5-6 + Note 1 | pin | done (SoC) |
| P1-215 | Note: Fig 5-6 lists FOSC = 011 as an RA6-I/O mode but its Note 1 only names INTOSC and RC; 011 is presumably EC (defined in §14). Confirm against Register 14-1 | Figure 5-6 p.35 | note | **decide** |
| P1-216 | RA6 in other FOSC modes is the OSC2 oscillator circuit output (fed from OSC1) | Figure 5-6 | pin | done (SoC) |
| P1-217 | RA7: digital I/O path enabled only when FOSC = 100 or 101 (INTOSC with CLKOUT and INTOSC with I/O); otherwise pin goes to clock circuits | Figure 5-7 + Note 1 p.36 | pin | done (SoC) |
| P1-218 | Note: Table 5-1 describes T0CKI as "External clock input for TMR0 or comparator output", Table 3-2 says "Timer0 clock input" | Table 5-1 vs Table 3-2 | note | info |
| P1-219 | Table 5-2 PORTA: RA5 bit note "MCLRE configuration bit sets RA5 functionality"; PORTA reset bits 7:5 = q on non-POR resets ("qqqu 0000") | Table 5-2 p.37 | register | done (SoC) |
| P1-220 | PORTA bits 3:0 reset to 0 on POR and all other resets (reads '0' since comparators default to analog, Note 2) | Table 5-2; §5.1 Note 2 | register | done (SoC) |
| P1-221 | PORTB: 8-bit bidirectional; alternate functions (INT, USART, CCP, TMR1 clock in/out) may override TRIS when enabled | §5.2 p.38 | pin | done (SoC) |
| P1-222 | PORTB weak pull-ups ≈200 μA typical each | §5.2 p.38 | electrical | done (SoC) |
| P1-223 | All PORTB pull-ups enabled by clearing RBPU (OPTION<7>); pull-up automatically off on any pin configured as output | §5.2 p.38 | pin | done (SoC) |
| P1-224 | PORTB pull-ups disabled on Power-on Reset (RBPU = 1) | §5.2 p.38 | behaviour | done (SoC) |
| P1-225 | Interrupt-on-change on RB<7:4> only; only pins configured as inputs participate (outputs excluded from comparison) | §5.2 p.38 | behaviour | done (SoC) |
| P1-226 | IOC compares input pins with the old value latched on the last read of PORTB; mismatch outputs OR'ed to set RBIF (INTCON<0>) | §5.2 p.38 | behaviour | done (SoC) |
| P1-227 | IOC latches: RBIF compare uses latches clocked on Q1 and Q3 | Figs 5-12..5-15 | timing | todo |
| P1-228 | RB change interrupt can wake the device from Sleep | §5.2 p.38 | behaviour | done (SoC) |
| P1-229 | Clearing IOC: (a) any read or write of PORTB ends the mismatch, then (b) clear RBIF. A persisting mismatch keeps setting RBIF (clearing RBIF without reading PORTB does not stick) | §5.2 p.38 | behaviour | done (SoC) |
| P1-230 | If a change on an RB<7:4> pin occurs while a PORTB read is executing (start of Q2), RBIF may not get set | §5.2 Note p.38 | failure-mode | todo |
| P1-231 | Polling PORTB is not recommended while using the IOC feature (reads reset the mismatch reference) | §5.2 p.38 | failure-mode | todo |
| P1-232 | IOC + pull-ups intended for keypad wake-up on key press (AN552) | §5.2 p.38 | note | info |
| P1-233 | RB0/INT: port buffer TTL; INT path through Schmitt Trigger; weak P-ch pull-up gated by RBPU | Figure 5-8 p.38 | pin | todo |
| P1-234 | RB1/RX/DT: output mux selects USART data output when peripheral selected (SPEN); Peripheral OE drives the pin direction only when peripheral select active; USART receive input via Schmitt Trigger; RBPU and SPEN shown controlling pull-up | Figure 5-9 + Note 1 p.39 | pin | todo |
| P1-235 | RB2/TX/CK: output mux selects USART TX/CK output when SPEN set; Peripheral OE active only with peripheral select; USART slave clock input via Schmitt Trigger | Figure 5-10 + Note 1 p.39 | pin | todo |
| P1-236 | RB3/CCP1: CCP1CON selects CCP output into output mux; Peripheral OE; CCP input via Schmitt Trigger; weak pull-up gated by RBPU | Figure 5-11 p.40 | pin | todo |
| P1-237 | Note: Fig 5-11 labels the mux inputs reversed relative to Figs 5-9/5-10 (CCP output on '0', data latch on '1'), and the OE signal carries footnote (2) while only Note 1 exists | Figure 5-11 p.40 | note | info |
| P1-238 | RB4/PGM: LVP configuration bit routes pin to PGM input (Schmitt) and disables RB4 IOC and weak pull-up | Figure 5-12 + Note p.41 | pin | done (SoC) |
| P1-239 | RB6: T1OSCEN input disables digital port use; pin feeds TMR1 clock via Schmitt Trigger, serial programming clock, and Timer1 oscillator (with RB7) | Figure 5-14 p.43 | pin | todo |
| P1-240 | RB7: T1OSCEN; pin is Timer1 oscillator input linked to RB6; serial programming data input via Schmitt Trigger | Figure 5-15 p.44 | pin | todo |
| P1-241 | Table 5-4: OPTION at 81h,181h reset 1111 1111 all resets; PORTB RB4 note "LVP configuration bit sets RB4 functionality" | Table 5-4 p.45 | register | done (SoC) |
| P1-242 | Read-modify-write on a port: BCF/BSF read all 8 pins, modify one bit, write all 8 to the latch; an input pin's current level overwrites its latch bit, so later switching it to output drives an unexpected value | §5.3.1 p.46 | failure-mode | done (SoC) |
| P1-243 | Example 5-2: with RB7:6 externally pulled up, BCF PORTB,7 → latch 01pp pppp; BCF TRISB,7 then BCF TRISB,6 → pins 10pp pppp (not the expected 00pp pppp) because the RMW latched RB7's pin value high | Example 5-2 p.46 | behaviour | done (SoC) |
| P1-244 | A pin actively driving high or low must not be driven externally at the same time (wired-OR/wired-AND); resulting high currents may damage the chip | §5.3.1 p.46 | failure-mode | todo |
| P1-245 | Port write happens at the end of the instruction cycle (Q4); port read data must be valid at the beginning of the cycle (sampled early, ~Q2) | §5.3.2 p.46; Figure 5-16 | timing | done (SoC) |
| P1-246 | Write followed immediately by read of same port may read the previous pin state; data setup time = 0.25 TCY − TPD (TPD = propagation delay Q1 to output valid); problematic at higher clock frequencies; insert NOP | §5.3.2; Figure 5-16 Note 2 p.46 | timing | todo |
| P1-247 | Package marking: line formats XX..X customer info, YY year, WW week (week of Jan 1 = '01'), NNN traceability code, e3 = Pb-free matte tin | §19.1 p.163 | note | info |
| P1-248 | Package drawings for PDIP-18, SOIC-18 (.300"), SSOP-20, QFN-28 (with exposed pad, D2/E2) are present but their dimension tables are font-garbled in the text extraction | §19 p.164–169 | note | info |
| P1-249 | Product ID: PIC16F627A/628A/648A(T) VDD 3.0V–5.5V; PIC16LF627A/628A/648A(T) VDD 2.0V–5.5V; T = tape and reel | Product ID p.179 | electrical | todo |
| P1-250 | Temperature ranges: I = −40°C to +85°C; E = −40°C to +125°C | Product ID p.179 | electrical | todo |
| P1-251 | Package codes: P = PDIP, SO = SOIC (gull wing, 7.50 mm body), SS = SSOP (5.30 mm), ML = QFN (28 lead) | Product ID p.179 | pin | todo |
| P1-252 | Product ID examples: PIC16F627A-E/P 301 = extended temp, PDIP, 20 MHz, normal VDD; PIC16LF627A-I/SO = industrial, SOIC, 20 MHz, extended VDD limits | Product ID p.179 | electrical | todo |
| P1-253 | Migration from 627/628: ER mode renamed RC mode | Appendix C.1 item 1 p.172 | note | info |
| P1-254 | Code protection is whole-memory via single config bit<13> CP (CP0/CP1 of 627/628 removed) | Appendix C.1 item 2 | behaviour | todo |
| P1-255 | BOD renamed BOR | Appendix C.1 item 3 | note | info |
| P1-256 | Enabling BOR does NOT automatically enable PWRT (unlike PIC16F627/628) | Appendix C.1 item 4 | behaviour | todo |
| P1-257 | INTRC renamed INTOSC | Appendix C.1 item 5 | note | info |
| P1-258 | Timer1 oscillator designed for 32.768 kHz (627/628 version ran up to 200 kHz) | Appendix C.1 item 6 | timing | todo |
| P1-259 | Dual-speed oscillator mode (OSCF switching) works only in INTOSC mode (627/628 also in ER mode) | Appendix C.1 item 7 | behaviour | todo |
| P1-260 | Appendix D note: process differences may make this device perform differently from earlier versions | Appendix D Note p.172 | note | info |
| P1-261 | Revision history: Rev B revised QFN pin diagram, Figure 5-4 (RA4 block), Register 7-1 TMR1ON, Example 13-4 EEPROM refresh, SUBWF example 1, DC tables 17-2/17-3, Tables 17-4/17-6; Rev D revised Example 13-2 EEPROM write and D020/D020E; Rev G corrected 28-QFN in §19.1 | Appendix A p.171 | note | info |
| P1-262 | Index contains entries for features not on this device (CCP2, CCP2CON, RC6/TX/CK, RC7/RX/DT, A/D special event trigger, MPLAB C18): copy-paste artefacts, ignore | Index p.175–178 | note | info |
| P1-263 | Index points to sections outside this range worth checking: Data EEPROM spurious write protection / write verify / code-protect operation (p.93–95), PORTB interrupt (p.110), PCON (p.104), Sleep (p.112), WDT (p.111), Dual-speed oscillator (p.101), CONFIG register (p.98), TRIS and OPTION instructions (p.126, 129) | Index p.175–178 | note | info |
| P1-264 | Errata may exist describing operational differences from the data sheet per silicon revision | Front matter "Errata" p.5 | note | info |

## Cross-references
- Table 14-6 and Table 14-7 (this data sheet, §14): full register initialisation for each reset type (POR, MCLR, WDT, BOR, wake-up); referenced by Tables 4-3..4-6 Note 1.
- §6.3.1 "Switching Prescaler Assignment": safe TMR0/WDT prescaler reassignment; referenced by the OPTION register note.
- §14 (Special Features / Configuration Word): FOSC codes used in Figs 5-6/5-7, MCLRE, LVP, BOREN, CP bit<13>.
- §12 USART, §9 CCP, §10 Comparator (CMCON modes, mode 110), §11 VRCON: own the bit definitions of the peripheral SFRs listed in Tables 4-3/4-4.
- AN556 "Implementing a Table Read" (DS00556): computed GOTO across 256-byte PCL boundaries (§4.3.1).
- AN552 "Implementing Wake-up on Key Strokes" (DS00552): PORTB interrupt-on-change and pull-ups for keypad wake-up (§5.2).
- Device errata sheet (per silicon revision), via microchip.com: operational differences from this data sheet (front matter p.5).
- Appendix D: PIC16C62X/CE62X and PIC16C622A migration documents, available on microchip.com (no DS number given).
- No reference to DS33023 (Mid-Range Reference Manual) or DS41196 appears in these ranges.

## DS40044G §6–9: Timer0, Timer1, Timer2, CCP

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P2-001 | Timer0 is an 8-bit timer/counter, readable and writable | §6.0, p.47 | register | done (SoC) |
| P2-002 | Timer0 has an 8-bit software-programmable prescaler (shared with WDT) | §6.0, p.47 | behaviour | todo |
| P2-003 | Timer0 clock source selectable: internal or external | §6.0, p.47 | behaviour | done (SoC) |
| P2-004 | Timer0 interrupt on overflow from FFh to 00h | §6.0, §6.1, p.47 | behaviour | done (SoC) |
| P2-005 | Timer0 external clock has edge select | §6.0, p.47 | behaviour | todo |
| P2-006 | Timer mode selected by clearing T0CS (OPTION<5>); TMR0 increments every instruction cycle when no prescaler is used | §6.0, p.47 | behaviour | done (SoC) |
| P2-007 | Writing TMR0 inhibits the increment for the following two instruction cycles (user may compensate by writing an adjusted value) | §6.0, p.47; Fig 6-1 "SYNC 2 Cycles" | timing | done (SoC) |
| P2-008 | Counter mode selected by setting T0CS; TMR0 increments on every rising or falling edge of pin RA4/T0CKI/CMP2 | §6.0, p.47 | pin | done (SoC) |
| P2-009 | T0SE (OPTION<4>) selects edge: T0SE=0 rising edge, T0SE=1 falling edge (doc: "Clearing the T0SE bit selects the rising edge") | §6.0, p.47 | register | done (SoC) |
| P2-010 | Prescaler assignment by PSA (OPTION<3>): PSA=0 assigns prescaler to Timer0, PSA=1 to WDT | §6.0, §6.3, p.47–48; Fig 6-1 | register | done (SoC) |
| P2-011 | Prescaler is not readable or writable | §6.0 p.47; §6.3 p.48 | register | todo |
| P2-012 | When assigned to Timer0, prescale values 1:2, 1:4, ..., 1:256 selectable via PS<2:0> (OPTION<2:0>) (8-to-1 MUX in Fig 6-1) | §6.0, §6.3, Fig 6-1, p.47–48 | register | done (SoC) |
| P2-013 | Timer0 overflow FFh→00h sets T0IF (INTCON<2>) | §6.1, p.47 | behaviour | done (SoC) |
| P2-014 | Timer0 interrupt masked by clearing T0IE (INTCON<5>) | §6.1, p.47 | register | done (SoC) |
| P2-015 | T0IF must be cleared in software (ISR) before re-enabling the interrupt; hardware does not clear it | §6.1, p.47 | behaviour | done (SoC) |
| P2-016 | Timer0 interrupt cannot wake the processor from Sleep: timer is shut off during Sleep | §6.1, p.47 | behaviour | done (SoC) |
| P2-017 | External clock for Timer0 is synchronized with internal phase clocks (TOSC); there is a delay in actual TMR0 increment after synchronization | §6.2, p.47 | timing | todo |
| P2-018 | No prescaler: external clock = prescaler output; synchronization done by sampling prescaler output on Q2 and Q4 | §6.2.1, p.47 | timing | todo |
| P2-019 | No prescaler: T0CKI must be high ≥ 2TOSC (+ small RC delay 20 ns) and low ≥ 2TOSC (+ 20 ns); otherwise edges may be missed | §6.2.1, p.47 | electrical | todo |
| P2-020 | With prescaler: external clock divided by asynchronous ripple-counter prescaler, prescaler output symmetrical | §6.2.1, p.47 | behaviour | todo |
| P2-021 | With prescaler: T0CKI period ≥ 4TOSC (+ small RC delay 40 ns) divided by the prescaler value; T0CKI high and low time only need meet minimum pulse width 10 ns | §6.2.1, p.47 | electrical | todo |
| P2-022 | T0CKI timing parameters 40, 41, 42 in Table 17-8 | §6.2.1, p.47 | note | info |
| P2-023 | Single 8-bit counter acts as Timer0 prescaler or WDT postscaler; assigning to Timer0 means WDT has no postscaler and vice-versa | §6.3, p.48 | behaviour | done (SoC) |
| P2-024 | When prescaler assigned to Timer0, any instruction writing TMR0 (e.g. CLRF 1, MOVWF 1, BSF 1,x) clears the prescaler | §6.3, p.48 | behaviour | done (SoC) |
| P2-025 | When prescaler assigned to WDT, CLRWDT clears the prescaler along with the WDT | §6.3, p.48 | behaviour | todo |
| P2-026 | Fig 6-1: T0CS mux selects FOSC/4 (0) or T0CKI pin XOR T0SE (1); PSA mux selects prescaler output or bypass into SYNC (2 cycles) → TMR0; WDT side: PSA selects WDT direct or via prescaler to WDT time-out | Fig 6-1, p.48 | behaviour | todo |
| P2-027 | Fig 6-1 contains a label "TMR1 Clock Source" near the T0CKI/T0SE path; unclear (likely drawing artifact). Fig note: T0SE, T0CS, PSA, PS<2:0> are OPTION register bits | Fig 6-1, p.48 | note | **decide** |
| P2-028 | Prescaler assignment can be changed on-the-fly; Timer0→WDT switch must follow Example 6-1 to avoid unintended device Reset | §6.3.1, p.49 | failure-mode | todo |
| P2-029 | Example 6-1 (Timer0→WDT): BCF STATUS,RP0; CLRWDT; CLRF TMR0 (clears TMR0 and prescaler); BSF STATUS,RP0; MOVLW '00101111'b; MOVWF OPTION_REG; CLRWDT; MOVLW '00101xxx'b; MOVWF OPTION_REG; BCF STATUS,RP0. Lines 5–7 (MOVLW 00101111/MOVWF/CLRWDT) required only if desired PS<2:0> are 000 or 001 | Example 6-1, p.49 | behaviour | todo |
| P2-030 | Example 6-2 (WDT→Timer0): CLRWDT (clear WDT and prescaler); BSF STATUS,RP0; MOVLW b'xxxx0xxx'; MOVWF OPTION_REG; BCF STATUS,RP0. Precaution required even if WDT is disabled | §6.3.1, Example 6-2, p.49 | behaviour | todo |
| P2-031 | TMR0 at 01h, 101h; POR xxxx xxxx; other resets uuuu uuuu | Table 6-1, p.49 | register | done (SoC) |
| P2-032 | INTCON at 0Bh, 8Bh, 10Bh, 18Bh: GIE PEIE T0IE INTE RBIE T0IF INTF RBIF; POR 0000 000x; other resets 0000 000u | Table 6-1, p.49 | register | done (SoC) |
| P2-033 | OPTION at 81h, 181h: RBPU INTEDG T0CS T0SE PSA PS2 PS1 PS0; POR 1111 1111; other resets 1111 1111 (so after reset T0CS=1 counter mode, PSA=1 prescaler to WDT, 1:128 WDT) | Table 6-1, p.49 | register | done (SoC) |
| P2-034 | TRISA at 85h: TRISA7..TRISA0; POR 1111 1111; other resets 1111 1111 (TRISA4 relevant for T0CKI) | Table 6-1, p.49 | register | done (SoC) |
| P2-035 | Table 6-1 header says OPTION(2) but footnote is "Note 1: Option is referred by OPTION_REG in MPLAB IDE" — footnote number mismatch | Table 6-1, p.49 | note | info |
| P2-036 | Timer1: 16-bit timer/counter of TMR1H:TMR1L, both readable/writable; increments 0000h→FFFFh and rolls over to 0000h | §7.0, p.50 | register | todo |
| P2-037 | TMR1 overflow latches TMR1IF (PIR1<0>); interrupt enabled by TMR1IE (PIE1<0>) | §7.0, p.50 | behaviour | todo |
| P2-038 | Timer1 modes: timer or counter, selected by TMR1CS (T1CON<1>); Timer mode increments every instruction cycle; Counter mode increments on every rising edge of external clock | §7.0, p.50 | behaviour | todo |
| P2-039 | TMR1ON (T1CON<0>) enables (1) / stops (0) Timer1 | §7.0; Reg 7-1, p.50 | register | todo |
| P2-040 | Timer1 has an internal "Reset input" generated by the CCP module | §7.0, p.50 | behaviour | todo |
| P2-041 | When T1OSCEN=1, RB7/T1OSI/PGD and RB6/T1OSO/T1CKI/PGC become inputs; TRISB<7:6> ignored | §7.0, p.50 | pin | todo |
| P2-042 | T1CON at 10h: bits 7-6 unimplemented read '0'; T1CKPS1 T1CKPS0 T1OSCEN T1SYNC TMR1CS TMR1ON all R/W-0 | Reg 7-1, p.50 | register | todo |
| P2-043 | T1CKPS<1:0>: 11=1:8, 10=1:4, 01=1:2, 00=1:1 | Reg 7-1, p.50 | register | todo |
| P2-044 | T1OSCEN: 1 = oscillator enabled; 0 = oscillator shut off (inverter and feedback resistor turned off to eliminate power drain) | Reg 7-1 + Note 1, p.50; Fig 7-1 Note 1 p.51 | register | todo |
| P2-045 | T1SYNC (TMR1CS=1): 1 = do not synchronize external clock, 0 = synchronize; with TMR1CS=0 bit ignored (internal clock) | Reg 7-1, p.50; §7.1 p.51 | register | todo |
| P2-046 | TMR1CS: 1 = external clock from RB6/T1OSO/T1CKI/PGC (rising edge); 0 = internal FOSC/4 | Reg 7-1, p.50 | register | todo |
| P2-047 | Timer mode (TMR1CS=0): input clock FOSC/4; T1SYNC has no effect | §7.1, p.51 | behaviour | todo |
| P2-048 | Synchronized counter (TMR1CS=1): increments on every rising edge on RB7/T1OSI/PGD when T1OSCEN=1, or RB6/T1OSO/T1CKI/PGC when T1OSCEN=0 | §7.2, p.51 | pin | todo |
| P2-049 | Register 7-1 says TMR1CS=1 clock is from RB6/T1OSO/T1CKI/PGC, while §7.2 says RB7/T1OSI when T1OSCEN set — source pin depends on T1OSCEN (oscillator output vs T1CKI) | Reg 7-1 vs §7.2, Fig 7-1, p.50–51 | note | info |
| P2-050 | T1SYNC=0: external clock synchronized with internal phase clocks; synchronization after the prescaler; prescaler is an asynchronous ripple counter | §7.2, p.51 | behaviour | todo |
| P2-051 | Synchronized counter mode in Sleep: TMR1 does not increment even with external clock present (sync circuit off); prescaler continues to increment | §7.2, p.51 | behaviour | todo |
| P2-052 | Sync counter, prescaler 1:1: sampling on Q2 and Q4; T1CKI high ≥ 2 TOSC (+20 ns) and low ≥ 2 TOSC (+20 ns); delay in TMR1 increment after sync | §7.2.1, p.51 | electrical | todo |
| P2-053 | Sync counter, prescaler ≠1:1: T1CKI period ≥ 4 TOSC (+40 ns) divided by prescaler value; high/low only need min pulse width 10 ns | §7.2.1, p.51 | electrical | todo |
| P2-054 | Timer1 external clock timing parameters 45, 46, 47 in Table 17-8 | §7.2.1, §7.3.1, p.51–52 | note | info |
| P2-055 | Fig 7-1: T1OSC between RB7/T1OSI and RB6/T1OSO; TMR1CS mux (FOSC/4 vs T1OSC/T1CKI) → prescaler 1,2,4,8 (T1CKPS<1:0>) → synchronize det (Sleep input) → T1SYNC mux → gated by TMR1ON → TMR1H:TMR1L → TMR1IF on overflow | Fig 7-1, p.51 | behaviour | todo |
| P2-056 | Asynchronous counter (T1SYNC=1): not synchronized; increments asynchronously; continues during Sleep and overflow interrupt wakes processor | §7.3, p.52 | behaviour | todo |
| P2-057 | In Asynchronous counter mode Timer1 cannot be used as time base for capture or compare | §7.3 Note, p.52 | failure-mode | todo |
| P2-058 | Unsynchronized clock must meet minimum high/low times (Table 17-8 params 45, 46, 47) | §7.3.1, p.52 | electrical | todo |
| P2-059 | Reading TMR1H or TMR1L while running from async external clock gives valid read (hardware), but 16-bit read as two 8-bit reads may straddle an overflow | §7.3.2, p.52 | behaviour | todo |
| P2-060 | Writing Timer1 while incrementing (async) may cause write contention → unpredictable value; recommendation: stop timer then write | §7.3.2, p.52 | failure-mode | todo |
| P2-061 | Example 7-1 (16-bit read of free-running timer, interrupts disabled): read TMR1H→TMPH, TMR1L→TMPL, re-read TMR1H, SUBWF TMPH; if Z good read; else re-read TMR1H then TMR1L (TMR1L may have rolled over) | Example 7-1, p.52 | behaviour | todo |
| P2-062 | Timer1 oscillator: crystal oscillator between T1OSI (input) and T1OSO (amplifier output), enabled by T1OSCEN (T1CON<3>); runs during Sleep; intended for 32.768 kHz watch crystal | §7.4, p.53 | behaviour | todo |
| P2-063 | Table 7-1: 32.768 kHz, C1 = 15 pF, C2 = 15 pF (design guidance only; see AN826) | Table 7-1, p.53 | electrical | todo |
| P2-064 | User must provide software delay for Timer1 oscillator start-up (no hardware start-up timer stated) | §7.4, p.53 | timing | todo |
| P2-065 | CCP1 in Compare mode with CCP1M<3:0>=1011 (special event trigger) resets Timer1 | §7.5, p.53 | behaviour | todo |
| P2-066 | Special event trigger does not set TMR1IF (PIR1<0>) | §7.5 Note, p.53; Fig 9-2 Note p.58 | behaviour | todo |
| P2-067 | Special event Timer1 reset requires Timer1 in timer or synchronized counter mode; in async counter mode reset may not work | §7.5, p.53 | failure-mode | todo |
| P2-068 | If a write to Timer1 coincides with a special event trigger, the write takes precedence | §7.5, p.53 | behaviour | todo |
| P2-069 | In special event mode CCPR1H:CCPR1L effectively becomes the Timer1 period register | §7.5, p.53; §9.2.4 p.59 | behaviour | todo |
| P2-070 | TMR1H/TMR1L not reset to 00h on POR or any Reset (only CCP1 special event trigger resets them) | §7.6, p.53 | register | todo |
| P2-071 | T1CON reset to 00h on POR or BOR (timer off, 1:1 prescale); unaffected by all other resets | §7.6, p.53 | register | todo |
| P2-072 | Timer1 prescaler counter cleared on writes to TMR1H or TMR1L | §7.7, p.53 | behaviour | todo |
| P2-073 | PIR1 at 0Ch: EEIF CMIF RCIF TXIF — CCP1IF TMR2IF TMR1IF; POR 0000 -000; other 0000 -000 | Table 7-2, 8-1, 9-2, 9-4 | register | todo |
| P2-074 | PIE1 at 8Ch: EEIE CMIE RCIE TXIE — CCP1IE TMR2IE TMR1IE; POR 0000 -000; other 0000 -000 | Table 7-2, 8-1, 9-2, 9-4 | register | todo |
| P2-075 | TMR1L at 0Eh, TMR1H at 0Fh: POR xxxx xxxx; other resets uuuu uuuu | Table 7-2, p.53; Table 9-2 p.59 | register | todo |
| P2-076 | T1CON at 10h: POR --00 0000; other resets --uu uuuu | Table 7-2, p.53; Table 9-2 | register | todo |
| P2-077 | Timer2: 8-bit timer with prescaler and postscaler; can be PWM time base for CCP | §8.0, p.54 | behaviour | todo |
| P2-078 | TMR2 readable/writable, cleared on any device Reset | §8.0, p.54 | register | todo |
| P2-079 | Timer2 input clock FOSC/4 with prescale 1:1, 1:4 or 1:16 via T2CKPS<1:0> (T2CON<1:0>) | §8.0, p.54 | behaviour | todo |
| P2-080 | TMR2 increments from 00h until it matches PR2, then resets to 00h on the next increment cycle (period = PR2+1 counts) | §8.0, p.54 | timing | todo |
| P2-081 | PR2 readable/writable, initialized to FFh on Reset | §8.0, p.54 | register | todo |
| P2-082 | Match output goes through 4-bit postscaler (1:1 to 1:16 inclusive) to set TMR2IF (PIR1<1>) | §8.0, p.54 | behaviour | todo |
| P2-083 | Clearing TMR2ON (T2CON<2>) shuts Timer2 off to minimize power | §8.0, p.54 | behaviour | todo |
| P2-084 | Prescaler and postscaler counters cleared on: write to TMR2; write to T2CON; any device Reset (POR, MCLR, WDT, BOR) | §8.1, p.54 | behaviour | todo |
| P2-085 | TMR2 is not cleared when T2CON is written | §8.1, p.54 | behaviour | todo |
| P2-086 | TMR2 output (before postscaler) fed to Synchronous Serial Port module, which optionally uses it to generate shift clock | §8.2, p.54 | behaviour | todo |
| P2-087 | Fig 8-1: FOSC/4 → prescaler (1:1,1:4,1:16) → TMR2 → comparator with PR2 → EQ resets TMR2 and drives TMR2 output and postscaler (TOUTPS<3:0>) → TMR2IF | Fig 8-1, p.54 | behaviour | todo |
| P2-088 | T2CON at 12h: bit 7 unimplemented read '0'; TOUTPS3..0 (bits 6-3), TMR2ON (bit 2), T2CKPS1..0 (bits 1-0) all R/W-0 | Reg 8-1, p.55 | register | todo |
| P2-089 | TOUTPS<3:0>: 0000=1:1, 0001=1:2, ..., 1111=1:16 (postscale = value+1) | Reg 8-1, p.55 | register | todo |
| P2-090 | T2CKPS<1:0>: 00=1:1, 01=1:4, 1x=1:16 | Reg 8-1, p.55 | register | todo |
| P2-091 | TMR2 at 11h: POR 0000 0000; other resets 0000 0000 | Table 8-1 p.55; Table 9-4 p.61 | register | todo |
| P2-092 | T2CON at 12h: POR -000 0000; Table 8-1 other resets -000 0000 | Table 8-1, p.55 | register | todo |
| P2-093 | Contradiction: Table 9-4 gives T2CON "all other resets" = uuuu uuuu, Table 8-1 gives -000 0000; §8.1 says any reset clears pre/postscaler counters | Table 8-1 p.55 vs Table 9-4 p.61 | note | **decide** |
| P2-094 | PR2 at 92h: POR 1111 1111; other resets 1111 1111 | Table 8-1 p.55; Table 9-4 p.61 | register | todo |
| P2-095 | CCP resource mapping: Capture→Timer1, Compare→Timer1, PWM→Timer2 | Table 9-1, p.57 | behaviour | todo |
| P2-096 | CCPR1 = CCPR1L (low) + CCPR1H (high); CCP1CON controls; all readable/writable (except CCPR1H read-only in PWM, see P2-143) | §9.0, p.57 | register | todo |
| P2-097 | CCP1CON at 17h: bits 7-6 unimplemented read '0'; CCP1X CCP1Y CCP1M3..0 R/W-0 | Reg 9-1, p.57 | register | todo |
| P2-098 | CCP1X:CCP1Y (bits 5-4): unused in Capture and Compare; in PWM the two LSbs of duty cycle (eight MSbs in CCPR1L) | Reg 9-1, p.57 | register | todo |
| P2-099 | CCP1M=0000: Capture/Compare/PWM off (resets CCP1 module) | Reg 9-1, p.57 | register | todo |
| P2-100 | CCP1M=0100: Capture every falling edge | Reg 9-1, p.57 | register | todo |
| P2-101 | CCP1M=0101: Capture every rising edge | Reg 9-1, p.57 | register | todo |
| P2-102 | CCP1M=0110: Capture every 4th rising edge | Reg 9-1, p.57 | register | todo |
| P2-103 | CCP1M=0111: Capture every 16th rising edge | Reg 9-1, p.57 | register | todo |
| P2-104 | CCP1M=1000: Compare, set output on match (CCP1IF set) | Reg 9-1, p.57 | register | todo |
| P2-105 | CCP1M=1001: Compare, clear output on match (CCP1IF set) | Reg 9-1, p.57 | register | todo |
| P2-106 | CCP1M=1010: Compare, software interrupt on match (CCP1IF set, CCP1 pin unaffected) | Reg 9-1, p.57; §9.2.3 p.59 | register | todo |
| P2-107 | CCP1M=1011: Compare, trigger special event (CCP1IF set; CCP1 resets TMR1) | Reg 9-1, p.57 | register | todo |
| P2-108 | CCP1M=11xx: PWM mode | Reg 9-1, p.57 | register | todo |
| P2-109 | CCP1M codes 0001, 0010, 0011 are not listed (undefined in this document) | Reg 9-1, p.57 | note | info |
| P2-110 | Capture: on event at RB3/CCP1, CCPR1H:CCPR1L captures 16-bit TMR1 value | §9.1, p.58 | behaviour | todo |
| P2-111 | Capture sets CCP1IF (PIR1<2>); must be cleared in software | §9.1, p.58 | behaviour | todo |
| P2-112 | If another capture occurs before CCPR1 is read, the old captured value is lost (overwritten) | §9.1, p.58 | behaviour | todo |
| P2-113 | Capture mode: RB3/CCP1 should be input (TRISB<3>=1) | §9.1.1, p.58 | pin | todo |
| P2-114 | If RB3/CCP1 configured as output in Capture mode, a write to the port can cause a capture condition | §9.1.1 Note, p.58 | failure-mode | todo |
| P2-115 | Fig 9-1: RB3/CCP1 → prescaler ÷1,4,16 and edge detect (CCP1CON<3:0>, Q's) → capture enable copies TMR1H/TMR1L to CCPR1H/CCPR1L; sets CCP1IF | Fig 9-1, p.58 | behaviour | todo |
| P2-116 | Capture needs Timer1 in Timer or Synchronized Counter mode; in Asynchronous Counter mode capture may not work | §9.1.2, p.58 | failure-mode | todo |
| P2-117 | Changing Capture mode may generate a false capture interrupt; user should keep CCP1IE (PIE1<2>) clear and clear CCP1IF after the change | §9.1.3, p.58 | failure-mode | todo |
| P2-118 | Capture prescaler counter cleared whenever CCP turned off or not in Capture mode; hence any Reset clears it | §9.1.4, p.58 | behaviour | todo |
| P2-119 | Switching directly from one capture prescaler to another may generate an interrupt and does not clear the prescaler counter, so the first capture may be from a non-zero prescaler | §9.1.4, p.58 | failure-mode | todo |
| P2-120 | Example 9-1: CLRF CCP1CON (module off), MOVLW NEW_CAPT_PS, MOVWF CCP1CON — clears prescaler counter and avoids the false interrupt | Example 9-1, p.58 | behaviour | todo |
| P2-121 | Compare: 16-bit CCPR1 constantly compared against TMR1; on match RB3/CCP1 is driven high, driven low, or unchanged per CCP1M<3:0>; CCP1IF set at same time | §9.2, p.58 | behaviour | todo |
| P2-122 | Fig 9-2: match → output logic (SR latch Q) → RB3/CCP1 via TRISB<3> output enable; special event resets Timer1 but does not set TMR1IF | Fig 9-2 + Note, p.58 | behaviour | todo |
| P2-123 | Compare mode: user must make RB3/CCP1 an output (TRISB<3>=0) | §9.2.1, p.59 | pin | todo |
| P2-124 | Clearing CCP1CON forces RB3/CCP1 compare output latch to default low; this is not the PORTB data latch | §9.2.1 Note, p.59 | pin | todo |
| P2-125 | Compare needs Timer1 in Timer or Synchronized Counter mode; async counter mode compare may not work | §9.2.2, p.59 | failure-mode | todo |
| P2-126 | Software interrupt mode: CCP1 pin not affected; only CCP interrupt generated (if enabled) | §9.2.3, p.59 | behaviour | todo |
| P2-127 | Special event trigger occurs immediately on match TMR1H:TMR1L == CCPR1H:CCPR1L; TMR1 not reset until the next rising edge of the TMR1 clock (so CCPR1 is a 16-bit period register) | §9.2.4, p.59 | timing | todo |
| P2-128 | Special event trigger "also starts an A/D conversion provided that the A/D module is enabled" (no A/D register appears in this range's tables) | §9.2.4, p.59 | note | info |
| P2-129 | Changing CCPR1H:CCPR1L between the clock edge that generates the special event trigger and the edge that generates the TMR1 Reset removes the match and prevents the Reset | §9.2.4 Note, p.59 | failure-mode | todo |
| P2-130 | TRISB at 86h, 186h: POR 1111 1111; other 1111 1111 | Table 9-2 p.59; Table 9-4 p.61 | register | todo |
| P2-131 | CCPR1L at 15h, CCPR1H at 16h: POR xxxx xxxx; other uuuu uuuu | Table 9-2 p.59; Table 9-4 p.61 | register | todo |
| P2-132 | CCP1CON at 17h: POR --00 0000; other resets --00 0000 | Table 9-2 p.59; Table 9-4 p.61 | register | todo |
| P2-133 | PWM: CCP1 pin produces up to 10-bit resolution PWM; TRISB<3> must be cleared to make CCP1 an output | §9.3, p.60 | pin | todo |
| P2-134 | Clearing CCP1CON forces CCP1 PWM output latch to default low (not the PORTB data latch) | §9.3 Note, p.60 | pin | todo |
| P2-135 | Fig 9-3: CCPR1L → CCPR1H (slave) + CCP1CON<5:4> latch → comparator with TMR2 (8-bit concatenated with 2-bit internal Q clock or 2 bits of prescaler = 10-bit time base) → R of SR latch; comparator TMR2==PR2 → clear timer, set CCP1 pin, latch duty cycle | Fig 9-3 + Note 1, p.60 | behaviour | todo |
| P2-136 | PWM period = [(PR2) + 1] · 4 · Tosc · (TMR2 prescale value); frequency = 1/period | §9.3.1, p.60 | timing | todo |
| P2-137 | When TMR2 == PR2, on the next increment cycle: TMR2 cleared; CCP1 pin set (except duty = 0%: pin not set); duty latched from CCPR1L into CCPR1H | §9.3.1, p.60 | behaviour | todo |
| P2-138 | Timer2 postscaler not used for PWM frequency (can give a different interrupt/servo update rate) | §9.3.1 Note, p.60 | note | info |
| P2-139 | Fig 9-4: output high at TMR2=PR2 rollover, low at TMR2=duty cycle, period between TMR2=PR2 events | Fig 9-4, p.60 | behaviour | todo |
| P2-140 | Duty cycle 10-bit value = CCPR1L (8 MSbs) : CCP1CON<5:4> (2 LSbs) | §9.3.2, p.61 | register | todo |
| P2-141 | PWM duty cycle = (CCPR1L:CCP1CON<5:4>) · Tosc · (TMR2 prescale value) | §9.3.2, p.61 | timing | todo |
| P2-142 | CCPR1L and CCP1CON<5:4> writable any time; duty not latched into CCPR1H until PR2/TMR2 match (period complete) | §9.3.2, p.61 | behaviour | todo |
| P2-143 | In PWM mode CCPR1H is read-only | §9.3.2, p.61 | register | todo |
| P2-144 | CCPR1H plus a 2-bit internal latch double-buffer the duty cycle (glitchless) | §9.3.2, p.61 | behaviour | todo |
| P2-145 | CCP1 pin cleared when CCPR1H:2-bit latch equals TMR2 concatenated with 2-bit internal Q clock or 2 bits of TMR2 prescaler | §9.3.2, p.61 | timing | todo |
| P2-146 | Max PWM resolution (bits) = log(Fosc / (F_PWM × TMR2 prescaler)) / log(2) | §9.3.2, p.61 | timing | todo |
| P2-147 | If duty cycle value is longer than the PWM period, CCP1 pin is not cleared (stays high, 100%) | §9.3.2 Note, p.61 | behaviour | todo |
| P2-148 | PWM setup: 1) write PR2; 2) write CCPR1L and CCP1CON<5:4>; 3) clear TRISB<3>; 4) set TMR2 prescale and enable Timer2 via T2CON (step 5, configure CCP1 for PWM, is not listed in this document) | §9.3.3, p.61 | note | info |
| P2-149 | Table 9-3 test vector @20 MHz: 1.22 kHz, prescaler 16, PR2=0xFF, 10 bits | Table 9-3, p.61 | timing | todo |
| P2-150 | Table 9-3: 4.88 kHz, prescaler 4, PR2=0xFF, 10 bits | Table 9-3, p.61 | timing | todo |
| P2-151 | Table 9-3: 19.53 kHz, prescaler 1, PR2=0xFF, 10 bits | Table 9-3, p.61 | timing | todo |
| P2-152 | Table 9-3: 78.12 kHz, prescaler 1, PR2=0x3F, 8 bits | Table 9-3, p.61 | timing | todo |
| P2-153 | Table 9-3: 156.3 kHz, prescaler 1, PR2=0x1F, 7 bits | Table 9-3, p.61 | timing | todo |
| P2-154 | Table 9-3: 208.3 kHz, prescaler 1, PR2=0x17, 6.5 bits (formula gives log2(96) ≈ 6.58; table rounds to 6.5) | Table 9-3, p.61 | note | info |
| P2-155 | Table 9-4 T2CON POR -000 0000 shows bit 7 '-' but "other resets" uuuu uuuu includes bit 7 as 'u' (inconsistent notation) | Table 9-4, p.61 | note | **decide** |
| P2-156 | Register 9-1 text for 1011 lacks closing parenthesis; Reg 9-1 refers to "CCPRxL"/"CCPx" generic names for CCPR1L/CCP1 | Reg 9-1, p.57 | note | info |

## Cross-references
- PIC Mid-Range MCU Family Reference Manual (DS33023): additional Timer0 info (§6.0), CCP module info (§9.0), example PWM period/duty calculation (§9.3.2).
- Table 17-8 (Electrical Specifications, this data sheet): T0CKI params 40, 41, 42; T1CKI params 45, 46, 47.
- AN826 "Crystal Oscillator Basics and Crystal Selection for rfPIC and PIC Devices" (DS00826): Timer1 crystal/capacitor selection.
- §9.2.4 / Section 9.0 (CCP) from Timer1 §7.0/§7.5/§7.6; §8.0 (Timer2) from §9.3.1; Synchronous Serial Port module (§8.2) as user of TMR2 output; A/D module (§9.2.4) as special event target.

## DS40044G §10–13: comparators, voltage reference, USART, data EEPROM

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P3-001 | Comparator module has two analog comparators; inputs multiplexed with RA0–RA3; on-chip VREF module can also be a comparator input | §10.0, p63 | behaviour | todo |
| P3-002 | CMCON at address 01Fh. Bits: 7 C2OUT (R-0), 6 C1OUT (R-0), 5 C2INV (R/W-0), 4 C1INV (R/W-0), 3 CIS (R/W-0), 2-0 CM<2:0> (R/W-0) | Register 10-1, p63 | register | todo |
| P3-003 | CMCON reset value: POR 0000 0000, all other Resets 0000 0000 | Table 10-1 / Table 11-1, p68/p71 | register | todo |
| P3-004 | C2OUT: with C2INV=0, 1 = C2 VIN+ > C2 VIN-, 0 = VIN+ < VIN-; with C2INV=1, 1 = VIN+ < VIN-, 0 = VIN+ > VIN- | Register 10-1 bit 7, p63 | register | todo |
| P3-005 | C1OUT: same polarity rules as C2OUT using C1INV (C1INV=0: 1 = C1 VIN+ > VIN-; C1INV=1: 1 = VIN+ < VIN-) | Register 10-1 bit 6, p63 | register | todo |
| P3-006 | C2INV / C1INV: 1 = output inverted, 0 = not inverted | Register 10-1 bits 5,4, p63 | register | todo |
| P3-007 | C1OUT/C2OUT are read-only (writes ignored) | Register 10-1 (R-0); §10.5 "These bits are read-only", p66 | register | todo |
| P3-008 | CIS when CM=001: 1 = C1 VIN- connects to RA3; 0 = C1 VIN- connects to RA0 | Register 10-1 bit 3, p63 | register | todo |
| P3-009 | CIS when CM=010: 1 = C1 VIN- to RA3 and C2 VIN- to RA2; 0 = C1 VIN- to RA0 and C2 VIN- to RA1 | Register 10-1 bit 3, p63; Figure 10-1, p64 | register | todo |
| P3-010 | CIS has no documented effect in modes other than 001 and 010 | Register 10-1 bit 3, p63 | note | info |
| P3-011 | Eight comparator modes selected by CM<2:0>; TRISA controls data direction of comparator pins in each mode | §10.1, p64 | behaviour | todo |
| P3-012 | Mode CM=000 "Comparators Reset (POR default)": RA0, RA3, RA1, RA2 all analog (A); C1 and C2 Off, outputs read as '0' | Figure 10-1, p64 | behaviour | todo |
| P3-013 | Mode CM=111 "Comparators Off": RA0, RA3, RA1, RA2 all digital inputs (D); C1 and C2 Off, read as '0' (figure shows VSS tie) | Figure 10-1, p64 | behaviour | todo |
| P3-014 | Mode CM=100 "Two Independent Comparators": C1 VIN-=RA0 (A), VIN+=RA3 (A) -> C1VOUT; C2 VIN-=RA1 (A), VIN+=RA2 (A) -> C2VOUT | Figure 10-1, p64 | behaviour | todo |
| P3-015 | Mode CM=010 "Four Inputs Multiplexed to Two Comparators": RA0, RA3, RA1, RA2 all A; C1 VIN- = RA0 (CIS=0)/RA3 (CIS=1); C2 VIN- = RA1 (CIS=0)/RA2 (CIS=1); VIN+ of both from VREF module | Figure 10-1, p64; §10.3.2, p65 | behaviour | todo |
| P3-016 | Mode CM=011 "Two Common Reference Comparators": RA0 A (C1 VIN-), RA3 D (digital), RA1 A (C2 VIN-), RA2 A (VIN+, common reference to both comparators); outputs C1VOUT, C2VOUT internal only | Figure 10-1, p64 | behaviour | todo |
| P3-017 | Mode CM=110 "Two Common Reference Comparators with Outputs": RA0 A (C1 VIN-), RA1 A (C2 VIN-), RA2 A (common VIN+); RA3/AN3/CMP1 marked D and carries C1 output; RA4/T0CKI/CMP2 carries C2 output as Open Drain | Figure 10-1, p64; §10.5, p66 | pin | todo |
| P3-018 | Mode CM=101 "One Independent Comparator": RA0 D, RA3 D, C1 Off (read as '0', VIN+ shown to VSS); C2 VIN-=RA1 (A), VIN+=RA2 (A) -> C2VOUT | Figure 10-1, p64 | behaviour | todo |
| P3-019 | Mode CM=001 "Three Inputs Multiplexed to Two Comparators": RA0 A, RA3 A, RA1 A, RA2 A; C1 VIN- = RA0 (CIS=0)/RA3 (CIS=1); C2 VIN- = RA1; RA2 = VIN+ (shared by C1 and C2 per figure); outputs C1VOUT, C2VOUT | Figure 10-1, p64 | behaviour | todo |
| P3-020 | Figure legend: A = Analog Input, port reads zeros always; D = Digital Input | Figure 10-1 legend, p64 | pin | todo |
| P3-021 | AMBIGUITY: §10.5 says comparator outputs go to RA3 and RA4 pins when CM=110 or 001, but Figure 10-1 shows CM=001 with RA3 as an analog input (CIS mux) and no pin outputs; only CM=110 shows pin outputs (RA4 open drain) | §10.5 p66 vs Figure 10-1 p64 | note | **decide** |
| P3-022 | Changing the comparator mode: the output level may not be valid for the specified mode change delay (Table 17-2) | §10.1, p64 | timing | todo |
| P3-023 | Note 1: comparator interrupts should be disabled during a mode change, otherwise a false interrupt may occur | §10.1 Note 1, p64 | failure-mode | todo |
| P3-024 | Note 2: comparators can have an inverted output (see Figure 10-1) | §10.1 Note 2, p64 | note | info |
| P3-025 | Example 10-1 init: CLRF PORTA; read CMCON & 0xC0 to flag reg; CMCON=0x03 (CM=011); TRISA=0x07; 10 µs delay (DELAY10); MOVF CMCON,F "to end change condition"; BCF PIR1,CMIF; BSF PIE1,CMIE; BSF INTCON,PEIE; BSF INTCON,GIE | Example 10-1, p65 | behaviour | todo |
| P3-026 | INCONSISTENCY: Example 10-1 text says RA3 and RA4 configured as digital outputs and RA2 as V+ of both comparators (matches CM=110 behaviour), but code writes CMCON=0x03 (CM=011, no pin outputs) | §10 text before Example 10-1, p65 | note | **decide** |
| P3-027 | INCONSISTENCY: Example 10-1 comment "TRISA<7:5> always read '0'", but Table 10-1/11-1 list TRISA7..TRISA5 implemented with reset 1111 1111 | Example 10-1 p65 vs Table 10-1 p68 | note | **decide** |
| P3-028 | Comparator output is digital low when VIN+ < VIN-, high when VIN+ > VIN- (non-inverted); shaded uncertainty regions due to input offset and response time | §10.2, Figure 10-2, p65 | behaviour | todo |
| P3-029 | Common Mode voltage spec in Table 17-2 | §10.2, p65 | electrical | todo |
| P3-030 | External reference: comparators may use same or different references; reference must be between VSS and VDD; can be applied to either comparator pin | §10.3.1, p65 | electrical | todo |
| P3-031 | Internal reference used only in CM=010; internal VREF applied to VIN+ of both comparators | §10.3.2, p65 | behaviour | todo |
| P3-032 | Response time = minimum time after selecting new reference or input source before output valid; if internal reference changed, use VREF max delay (Table 17-3); otherwise comparator max delay (Table 17-2, p142) | §10.4, p65 | timing | todo |
| P3-033 | Comparator outputs readable via CMCON<7:6>; may also be driven directly on RA3 and RA4 | §10.5, p66 | pin | todo |
| P3-034 | When output multiplexors are switched, each pin outputs the unsynchronized comparator output | §10.5, p66 | pin | todo |
| P3-035 | TRISA bits still act as output enable/disable for RA3/AN3/CMP1 and RA4/T0CKI/CMP2 in comparator-output mode | §10.5, p66 | pin | todo |
| P3-036 | Note 1: reading PORT, pins configured as analog inputs read '0'; digital-input pins convert analog input per Schmitt Trigger input specification | §10.5 Note 1, p66 | pin | todo |
| P3-037 | Note 2: analog levels on a pin defined as digital input may cause the input buffer to consume more current than specified | §10.5 Note 2, p66 | electrical | todo |
| P3-038 | Figure 10-3: CnVOUT passes through CnINV to the pin and into a D-latch read onto data bus (CMCON<7:6>) enabled by RD CMCON (Q3 shown); a second latch (Q1 shown, cleared by Reset) compared against output sets CMIF; "From other Comparator" OR-ed into CMIF | Figure 10-3, p66 | behaviour | todo |
| P3-039 | CMIF set whenever output value of either comparator changes; software must track CMCON<7:6> to know which changed | §10.6, p67 | behaviour | todo |
| P3-040 | CMIF is PIR1<6>; must be cleared by writing '0'; writing '1' initiates a simulated interrupt | §10.6, p67 | register | todo |
| P3-041 | Interrupt requires CMIE (PIE1<6>), PEIE (INTCON<6>) and GIE set; CMIF still set if any is clear | §10.6, p67 | behaviour | todo |
| P3-042 | Note: if CMCON change (C1OUT/C2OUT) occurs while a read is being executed (start of Q2), CMIF may not get set | §10.6 Note, p67 | failure-mode | todo |
| P3-043 | ISR clear: (a) any write or read of CMCON ends mismatch condition; (b) clear CMIF. Mismatch condition keeps setting CMIF until CMCON is read | §10.6, p67 | behaviour | todo |
| P3-044 | Sleep: active comparator stays active; interrupt functional if enabled and wakes the device | §10.7, p67 | behaviour | todo |
| P3-045 | Sleep: powered comparators raise Sleep current above power-down spec; each operating comparator adds current per comparator specs; set CM=111 to minimize | §10.7, p67 | electrical | todo |
| P3-046 | Wake from Sleep does not affect CMCON contents | §10.7, p67 | behaviour | todo |
| P3-047 | Device Reset forces CMCON to reset state, CM=000 (all potential inputs analog); comparators powered-down during Reset interval | §10.8, p67 | behaviour | todo |
| P3-048 | Analog input must be between VSS and VDD; deviation >0.6V either way forward-biases a protection diode and latch-up may occur | §10.9, p67; Figure 10-4 (VT=0.6V) | failure-mode | todo |
| P3-049 | Max recommended analog source impedance 10 kΩ (RS < 10K); external components on analog pin should have very little leakage | §10.9, p67; Figure 10-4, p68 | electrical | todo |
| P3-050 | Analog input model: CPIN = 5 pF, ILEAKAGE = ±500 nA, VT = 0.6V diodes to VDD/VSS, RIC interconnect resistance | Figure 10-4, p68 | electrical | todo |
| P3-051 | Comparator-related registers: INTCON (0Bh/8Bh/10Bh/18Bh) POR 0000 000x, other 0000 000u; PIR1 0Ch 0000 -000/0000 -000 (EEIF,CMIF,RCIF,TXIF,—,CCP1IF,TMR2IF,TMR1IF); PIE1 8Ch 0000 -000 (EEIE,CMIE,RCIE,TXIE,—,CCP1IE,TMR2IE,TMR1IE); TRISA 85h 1111 1111/1111 1111 | Table 10-1, p68 | register | todo |
| P3-052 | Typo: Table 10-1 labels CMCON bit 4 "C1NV" (Register 10-1 says C1INV) | Table 10-1, p68 | note | **decide** |
| P3-053 | VREF module: 16-tap resistor ladder, two ranges, power-down function; 16 distinct levels per range | §11.0/§11.1, p69 | behaviour | todo |
| P3-054 | VRCON at address 9Fh: bit7 VREN (R/W-0), bit6 VROE (R/W-0), bit5 VRR (R/W-0), bit4 unimplemented read '0', bits3-0 VR<3:0> (R/W-0) | Register 11-1, p69 | register | todo |
| P3-055 | VRCON reset: POR 000- 0000, all other Resets 000- 0000 | Table 11-1, p71 | register | todo |
| P3-056 | VREN: 1 = VREF circuit powered on; 0 = powered down, no IDD drain | Register 11-1 bit 7, p69 | register | todo |
| P3-057 | VROE: 1 = VREF output on RA2 pin; 0 = disconnected from RA2 | Register 11-1 bit 6, p69 | register | todo |
| P3-058 | VRR: 1 = Low range; 0 = High range | Register 11-1 bit 5, p69 | register | todo |
| P3-059 | VRR=1: VREF = (VR<3:0>/24) × VDD; 0 ≤ VR ≤ 15 | Register 11-1; equations §11.0, p69 | behaviour | todo |
| P3-060 | VRR=0: VREF = 1/4 × VDD + (VR<3:0>/32) × VDD | Register 11-1; equations §11.0, p69 | behaviour | todo |
| P3-061 | Test vector (doc): VDD=5.0V, VRCON=0xA6 (VREN=1, VROE=0, VRR=1, VR=6) -> 1.25V; Example also sets CMCON=0x02, TRISA=0x07, 10 µs delay | Example 11-1, p70 | behaviour | todo |
| P3-062 | Test vectors (computed from the doc equations, VDD=5.0V): VRR=1 VR=0 -> 0V, VR=15 -> 3.125V; VRR=0 VR=0 -> 1.25V, VR=15 -> 3.59375V | §11.0 equations, p69 | behaviour | todo |
| P3-063 | INCONSISTENCY: Example 11-1 comment says "RA3-RA0 are outputs" while it writes TRISA=0x07 (RA2:0 inputs) | Example 11-1, p70 | note | **decide** |
| P3-064 | VREF settling time must be considered when changing output (Table 17-3) | §11.0, p69 | timing | todo |
| P3-065 | Ladder: 8R at top (VREN switch to VDD), 16 R stages, 8R at bottom switched by VRR to VSS; 16-1 analog mux by VR<3:0>; R defined in Table 17-3 | Figure 11-1, p70 | electrical | todo |
| P3-066 | Full VSS–VDD range cannot be reached (top/bottom transistors); VREF is VDD-derived and tracks VDD fluctuations; absolute accuracy in Table 17-3 | §11.2, p70 | electrical | todo |
| P3-067 | Sleep: VRCON unaffected on wake by interrupt or WDT time-out; disable module to minimize Sleep current | §11.3, p70 | behaviour | todo |
| P3-068 | Reset clears VREN, VROE, VRR (selects high range) and VR<3:0> | §11.4, p70 | behaviour | todo |
| P3-069 | VREF module operates independently of the comparator module | §11.5, p70 | behaviour | todo |
| P3-070 | VREF output connected to RA2 if TRISA<2> = 1 and VROE = 1 | §11.5, p70 | pin | todo |
| P3-071 | VROE with an input signal present on RA2 increases current; RA2 as digital output with VREF enabled also increases current | §11.5, p70 | electrical | todo |
| P3-072 | RA2 as simple D/A output has limited drive; buffer (op amp) required for external use; VREF output impedance R depends on VRCON<3:0> and VRCON<5> | §11.5, Figure 11-2 Note 1, p70-71 | electrical | todo |
| P3-073 | USART (SCI) modes: Asynchronous full-duplex; Synchronous Master half-duplex; Synchronous Slave half-duplex | §12.0, p73 | behaviour | todo |
| P3-074 | SPEN (RCSTA<7>) and TRISB<2:1> must be set to configure RB2/TX/CK and RB1/RX/DT as USART pins | §12.0, p73; Register 12-2 bit 7, p74 | pin | todo |
| P3-075 | TXSTA at 98h: bit7 CSRC R/W-0, bit6 TX9 R/W-0, bit5 TXEN R/W-0, bit4 SYNC R/W-0, bit3 unimplemented '0', bit2 BRGH R/W-0, bit1 TRMT R-1, bit0 TX9D R/W-0 | Register 12-1, p73 | register | todo |
| P3-076 | TXSTA reset: POR 0000 -010, other Resets 0000 -010 (TRMT=1) | Table 12-2, p75 | register | todo |
| P3-077 | CSRC: async don't care; sync 1 = Master (clock from BRG), 0 = Slave (external clock) | Register 12-1 bit 7, p73 | register | todo |
| P3-078 | TX9: 1 = 9-bit transmission, 0 = 8-bit | Register 12-1 bit 6, p73 | register | todo |
| P3-079 | TXEN: 1 = transmit enabled; Note 1: SREN/CREN overrides TXEN in SYNC mode | Register 12-1 bit 5 + Note 1, p73 | register | todo |
| P3-080 | SYNC: 1 = Synchronous, 0 = Asynchronous | Register 12-1 bit 4, p73 | register | todo |
| P3-081 | BRGH: async 1 = high speed, 0 = low speed; sync: unused | Register 12-1 bit 2, p73 | register | todo |
| P3-082 | TRMT: 1 = TSR empty, 0 = TSR full; read-only | Register 12-1 bit 1, p73 | register | todo |
| P3-083 | TX9D: 9th bit of transmit data (can be parity) | Register 12-1 bit 0, p73 | register | todo |
| P3-084 | RCSTA at 18h: bit7 SPEN R/W-0, bit6 RX9 R/W-0, bit5 SREN R/W-0, bit4 CREN R/W-0, bit3 ADEN R/W-0, bit2 FERR R-0, bit1 OERR R-0, bit0 RX9D R-x | Register 12-2, p74 | register | todo |
| P3-085 | RCSTA reset: POR 0000 000x, other Resets 0000 000x | Table 12-2, p75 | register | todo |
| P3-086 | SPEN: 1 = serial port enabled (pins configured as serial port when TRISB<2:1> set), 0 = disabled | Register 12-2 bit 7, p74 | register | todo |
| P3-087 | RX9: 1 = 9-bit reception, 0 = 8-bit | Register 12-2 bit 6, p74 | register | todo |
| P3-088 | SREN: async don't care; sync master 1 = enable single receive, cleared after reception complete; sync slave unused | Register 12-2 bit 5, p74 | register | todo |
| P3-089 | CREN: async 1 = continuous receive; sync 1 = continuous receive until CREN cleared (CREN overrides SREN) | Register 12-2 bit 4, p74 | register | todo |
| P3-090 | ADEN: async 9-bit (RX9=1): 1 = address detect, interrupt and load of receive buffer only when RSR<8> set; 0 = all bytes received, 9th bit usable as parity; unused in async 8-bit and sync | Register 12-2 bit 3, p74 | register | todo |
| P3-091 | FERR: 1 = framing error (updated by reading RCREG and receiving next valid byte) | Register 12-2 bit 2, p74 | register | todo |
| P3-092 | OERR: 1 = overrun error (cleared by clearing CREN) | Register 12-2 bit 1, p74 | register | todo |
| P3-093 | RX9D: 9th bit of received data (can be parity) | Register 12-2 bit 0, p74 | register | todo |
| P3-094 | SPBRG at 99h, reset 0000 0000 (POR and other); TXREG at 19h reset 0000 0000; RCREG at 1Ah reset 0000 0000 | Tables 12-2, 12-6, 12-7, p75/81/84 | register | todo |
| P3-095 | BRG: dedicated 8-bit, SPBRG sets period of a free-running 8-bit timer; serves async and sync | §12.1, p75 | behaviour | todo |
| P3-096 | Baud formula: SYNC=0 BRGH=0: FOSC/(64(X+1)); SYNC=0 BRGH=1: FOSC/(16(X+1)); SYNC=1: FOSC/(4(X+1)), BRGH=1 NA in sync; X = SPBRG 0..255; formulas apply only in Master mode (internal clock) | Table 12-1, p75; §12.1 | behaviour | todo |
| P3-097 | Example 12-1: FOSC=16 MHz, 9600 baud, BRGH=0, SYNC=0 -> x=25.042, SPBRG=25, calculated 9615, error 0.16% | Equation/Example 12-1, p75 | behaviour | todo |
| P3-098 | Error = (Calculated − Desired)/Desired | Equation 12-1, p75 | behaviour | todo |
| P3-099 | BRGH=1 may reduce baud error even at slow rates | §12.1, p75 | note | info |
| P3-100 | Writing SPBRG resets (clears) the BRG timer, so the new rate is output without waiting for overflow | §12.1, p75 | timing | todo |
| P3-101 | RX pin data sampled three times by a majority-detect circuit | §12.1, p75 | behaviour | todo |
| P3-102 | Table 12-3 (Synchronous baud rates): columns FOSC = 20, 16, 10, 7.15909, 5.0688, 4, 3.579545, 1 MHz, 32.768 kHz; rows 0.3,1.2,2.4,9.6,19.2,76.8,96,300,500 K, HIGH (SPBRG=0), LOW (SPBRG=255) | Table 12-3, p76 | timing | todo |
| P3-103 | Table 12-3 vectors: 20 MHz 19.2K -> 19.53 KBAUD +1.73% SPBRG 255; 20 MHz 500K -> 500, 0%, 9; 20 MHz HIGH 5000 (0), LOW 19.53 (255); 16 MHz 19.2K -> 19.23 +0.16% 207; 10 MHz 9.6K -> 9.766 +1.73% 255; 1 MHz HIGH 250, LOW 0.9766; 32.768 kHz 0.3K -> 0.303 +1.14% 26, HIGH 8.192, LOW 0.032 | Table 12-3, p76 | timing | todo |
| P3-104 | ERRATUM Table 12-3: at 4 MHz the 96K row reads "1000 +4.17% 9" and HIGH reads "100"; formula FOSC/(4(X+1)) gives HIGH = 1000 at SPBRG=0 and 100 at SPBRG=9 (values look swapped/typo). Also 7.15909/5.0688 rows have errors without '%' and 5.0688 300K error "5.60%" unsigned | Table 12-3, p76 | note | **decide** |
| P3-105 | Table 12-4 (Async BRGH=0) same FOSC columns; vectors: 20 MHz 9.6K -> 9.469 −1.36% 32; 20 MHz 300K -> 312.5 +4.17% 0; 20 MHz HIGH 312.5 / LOW 1.221; 16 MHz 9.6K -> 9.615 +0.16% 25; 4 MHz 2.4K -> 2.404 25; 4 MHz HIGH 62.500; 5.0688 MHz 9.6K -> 9.9 +3.13% 7; 1 MHz 0.3K -> 0.300 +0.16% 51; 32.768 kHz 0.3K -> 0.256 −14.67% 1, HIGH 0.512, LOW 0.0020 | Table 12-4, p77 | timing | todo |
| P3-106 | ERRATUM Table 12-4: 4 MHz 1.2K/2.4K error shown "+1.67%" (formula gives ~+0.16%); 4 MHz LOW shown 3.906 (formula FOSC/(64·256) = 0.244); 10 MHz 19.2K error "+1.73V" | Table 12-4, p77 | note | **decide** |
| P3-107 | Table 12-5 (Async BRGH=1): rows 9600,19200,38400,57600,115200,250000,625000,1250000; vectors: 20 MHz 9600 -> 9.615 +0.16% 129; 20 MHz 115200 -> 113.636 −1.36% 10; 20 MHz 1250000 -> 1250 0% 0; 16 MHz 250000 -> 250 0% 3; 10 MHz 625000 -> 625 0% 0; 4 MHz 9600 -> 9615.385 0.160% 25; 4 MHz 250000 -> 250000 0.000% 0; 5.068 MHz 250000 -> 316750 26.700% 0; 1 MHz 9600 -> 8.928 −6.994% 6; 32.768 kHz all NA | Table 12-5, p78 | timing | todo |
| P3-108 | Table 12-5 mixes units (KBAUD for some columns, baud for others) | Table 12-5, p78 | note | info |
| P3-109 | Async format: NRZ, 1 Start bit, 8 or 9 data bits, 1 Stop bit; LSb first; TX and RX independent but share format and baud rate | §12.2, p79 | behaviour | todo |
| P3-110 | BRG produces clock x16 or x64 of bit shift rate depending on BRGH | §12.2, p79 | timing | todo |
| P3-111 | No hardware parity; can be implemented in software as 9th bit | §12.2, p79 | behaviour | todo |
| P3-112 | Asynchronous mode is stopped during Sleep | §12.2, p79 | behaviour | todo |
| P3-113 | Async selected by clearing SYNC (TXSTA<4>) | §12.2, p79 | behaviour | todo |
| P3-114 | TSR loaded from TXREG only after Stop bit of previous load transmitted; transfer takes one TCY, then TXREG empty and TXIF (PIR1<4>) set | §12.2.1, p79 | timing | todo |
| P3-115 | TXIF set regardless of TXIE; cannot be cleared in software; resets only when new data loaded into TXREG | §12.2.1, p79 | behaviour | todo |
| P3-116 | Note 2: TXIF is set when TXEN is set | §12.2.1 Note 2, p79 | behaviour | todo |
| P3-117 | TRMT read-only, set when TSR empty; no interrupt logic tied to it (poll only) | §12.2.1, p79 | behaviour | todo |
| P3-118 | Note 1: TSR is not mapped in data memory | §12.2.1 Note 1, p79 | memory | todo |
| P3-119 | Transmission does not occur until TXREG loaded and BRG produced a shift clock; can also load TXREG first then set TXEN | §12.2.1, p79 | timing | todo |
| P3-120 | When TSR empty, write to TXREG transfers immediately to TSR leaving TXREG empty; back-to-back transfers possible (Figure 12-3) | §12.2.1, p79; Figure 12-3, p81 | behaviour | todo |
| P3-121 | Clearing TXEN during transmission aborts it and resets transmitter; RB2/TX/CK reverts to high-impedance | §12.2.1, p79 | pin | todo |
| P3-122 | 9-bit TX: set TX9; write TX9D before TXREG, else immediate TXREG->TSR transfer can load an incorrect 9th bit | §12.2.1, p79 | failure-mode | todo |
| P3-123 | Async TX setup: (1) TRISB<1>,<2>=1 (output drive controlled by peripheral); (2) SPBRG, BRGH; (3) SYNC=0, SPEN=1; (4) TXIE; (5) TX9; (6) TXEN (sets TXIF); (7) TX9D; (8) load TXREG (starts transmission) | §12.2.1 steps, p80 | behaviour | todo |
| P3-124 | Figure 12-1: TX block: TXREG -> TSR (8 bits + TX9D as bit 8 when TX9) -> pin buffer controlled by SPEN; TXIF/TXIE interrupt; TRMT from TSR; BRG clocks TSR when TXEN | Figure 12-1, p80 | behaviour | todo |
| P3-125 | Figure 12-2/12-3 waveforms: Start bit, bit0..bit7/8, Stop bit; TXIF and TRMT timing for single and back-to-back words | Figures 12-2, 12-3, p80-81 | timing | todo |
| P3-126 | Async RX: data recovery block is a high-speed shifter at x16 the baud rate; main receive shifter operates at the bit rate or at FOSC | §12.2.2, p82 | timing | todo |
| P3-127 | Async reception enabled by setting CREN (RCSTA<4>) | §12.2.2, p82 | behaviour | todo |
| P3-128 | After sampling the Stop bit, RSR data transferred to RCREG (if empty); on completion RCIF (PIR1<5>) set; RCIE (PIE1<5>) enables interrupt | §12.2.2, p82 | behaviour | todo |
| P3-129 | RCIF read-only, cleared by hardware when RCREG read and empty | §12.2.2, p82 | register | todo |
| P3-130 | RCREG is double-buffered two-deep FIFO; two bytes can be held while a third shifts into RSR; RCREG can be read twice | §12.2.2, p82 | memory | todo |
| P3-131 | Overrun: on Stop bit detection of third byte with RCREG still full, OERR set and RSR word lost | §12.2.2, p82 | failure-mode | todo |
| P3-132 | OERR cleared only by resetting receive logic (CREN cleared then set); while OERR set, RSR->RCREG transfers are inhibited | §12.2.2, p82 | failure-mode | todo |
| P3-133 | FERR set if Stop bit detected as clear | §12.2.2, p82 | failure-mode | todo |
| P3-134 | FERR and RX9D are buffered with the data (FIFO); reading RCREG loads new RX9D and FERR; read RCSTA before RCREG to keep old values | §12.2.2, p82 | behaviour | todo |
| P3-135 | Figure 12-4 RX block: SPBRG -> ÷64 or ÷16, data recovery, RSR (Start, bits 0..7, Stop (8)), RX9/ADEN/RSR<8> gate "Enable Load of Receive Buffer", RX9D+RCREG 2-level FIFO, RCIF/RCIE | Figure 12-4, p82 | behaviour | todo |
| P3-136 | Async RX setup: (1) TRISB<1>,<2>=1; (2) SPBRG/BRGH; (3) SYNC=0, SPEN=1; (4) RCIE; (5) RX9; (6) CREN; (7) RCIF on completion; (8) read RCSTA (9th bit, errors); (9) read RCREG; (10) OERR -> clear CREN | §12.2.2 steps, p84 | behaviour | todo |
| P3-137 | Address detect: with RX9=1 and ADEN=1, on last bit RSR -> receive buffer, RSR<8> -> RX9D, receive interrupt set if and only if RSR<8>=1 | §12.3.1, p85 | behaviour | todo |
| P3-138 | Address byte identified by 9th bit = 1, data byte by 9th bit = 0 | §12.3.1, p85 | behaviour | todo |
| P3-139 | ADEN=1: data bytes ignored — not loaded into receive buffer, no interrupt; if another byte shifts into RSR, previous data byte lost | §12.3.1, p85 | behaviour | todo |
| P3-140 | ADEN takes effect only when RX9=1; ADEN=0: all bytes received, 9th bit usable as parity | §12.3.1, p85 | behaviour | todo |
| P3-141 | Figure 12-5: data byte (bit8=0) then address byte (bit8=1) with ADEN=1 -> only address byte reaches RCREG and sets RCIF | Figure 12-5, p83 | behaviour | todo |
| P3-142 | Figure 12-6: address byte then data byte with ADEN still 1 -> data byte not loaded | Figure 12-6, p83 | behaviour | todo |
| P3-143 | Figure 12-7: address byte, then ADEN cleared -> following data byte loaded into RCREG regardless of bit 8 | Figure 12-7, p83 | behaviour | todo |
| P3-144 | Address detect setup steps: TRIS, SPBRG/BRGH, SYNC, SPEN, RCIE, RX9, ADEN, CREN or SREN, RCIF, read RCREG, OERR clear by CREN, if addressed clear ADEN and RCIF | §12.3.1.1, p85 | behaviour | todo |
| P3-145 | AMBIGUITY: §12.3.1.1 step 3 says "setting or clearing bit SYNC" and step 7 "CREN or SREN", though async requires SYNC=0 and SREN is don't-care in async; step 11 says clear RCIF though RCIF is read-only (cleared by reading RCREG) | §12.3.1.1, p85; §12.2.2 | note | **decide** |
| P3-146 | Sync master: half-duplex (TX and RX not simultaneous); SYNC=1, SPEN=1 (RB2=CK, RB1=DT), CSRC=1 for master (clock out on CK) | §12.4, p86 | behaviour | todo |
| P3-147 | Sync master TX: TSR loaded after last bit of previous load; TXREG->TSR in one Tcycle then TXIF set; TXIF not software-clearable; TRMT poll | §12.4.1, p86 | timing | todo |
| P3-148 | Sync master TX: first data bit shifted out on next available rising edge of CK; data out stable around falling edge | §12.4.1, p86; Figure 12-8, p87 | timing | todo |
| P3-149 | BRG kept in Reset when TXEN, CREN and SREN all clear; setting TXEN starts BRG and creates shift clock immediately (load TXREG then set TXEN, Figure 12-9) | §12.4.1, p86; Figure 12-9, p87 | timing | todo |
| P3-150 | Sync master: clearing TXEN during transmission aborts, resets transmitter; DT and CK revert to high-impedance | §12.4.1, p86 | pin | todo |
| P3-151 | Sync master: setting CREN or SREN during transmission aborts it, DT goes hi-Z (for reception); CK remains output if CSRC=1; transmitter logic not reset (only disconnected); clear TXEN to reset it | §12.4.1, p86 | behaviour | todo |
| P3-152 | If SREN set to interrupt an on-going TX, after the single word is received SREN clears and port reverts to transmitting (TXEN still set); DT immediately switches from hi-Z to driving; clear TXEN to avoid | §12.4.1, p86 | failure-mode | todo |
| P3-153 | Sync 9-bit TX: write TX9D before TXREG; if TSR empty and TXREG written first, the "present" TX9D is loaded | §12.4.1, p86 | failure-mode | todo |
| P3-154 | Sync master TX setup: TRIS, SPBRG, SYNC+SPEN+CSRC, TXIE, TX9, TXEN, TX9D, load TXREG per transmission | §12.4.1 steps, p86 | behaviour | todo |
| P3-155 | Figure 12-8: sync master SPBRG=0, continuous TX of two 8-bit words; one bit per Q1–Q4 cycle shown | Figure 12-8, p87 | timing | todo |
| P3-156 | Sync master RX enabled by SREN (RCSTA<5>) or CREN (RCSTA<4>); data sampled on RB1/RX/DT on falling edge of clock | §12.4.2, p88 | timing | todo |
| P3-157 | SREN = single word; CREN = continuous until cleared; both set -> CREN takes precedence | §12.4.2, p88 | behaviour | todo |
| P3-158 | Sync RX: after last bit, RSR -> RCREG (if empty), RCIF set; RCIF read-only, cleared when RCREG read and empty; 2-deep FIFO | §12.4.2, p88 | behaviour | todo |
| P3-159 | Sync RX overrun: on clocking last bit of third byte with RCREG full, OERR set, RSR word lost; clear by clearing CREN; OERR inhibits RSR->RCREG | §12.4.2, p88 | failure-mode | todo |
| P3-160 | Sync RX: 9th bit buffered with data; reading RCREG loads new RX9D; read RCSTA first | §12.4.2, p88 | behaviour | todo |
| P3-161 | Sync master RX setup: TRIS, SPBRG, SYNC+SPEN+CSRC, ensure CREN and SREN clear, RCIE, RX9, SREN (single) or CREN (continuous), RCIF, read RCSTA, read RCREG, OERR -> clear CREN | §12.4.2 steps, p88 | behaviour | todo |
| P3-162 | Figure 12-10: sync master RX with SREN=1 and "BRG = 0" (presumably SPBRG=0); SREN self-clears after bit 7; RCIF set | Figure 12-10, p89 | timing | todo |
| P3-163 | Typo: Table 12-10 PIE1 bit 7 labelled "EPIE" and reset "-000 0000 / -000 -000" vs "0000 -000" elsewhere | Table 12-10, p88 | note | **decide** |
| P3-164 | Sync slave: shift clock supplied externally on RB2/TX/CK; entered by clearing CSRC; allows transfer/receive during Sleep | §12.5, p89 | behaviour | todo |
| P3-165 | Sync slave TX identical to master except in Sleep. Two words written to TXREG then SLEEP: (a) first word transfers to TSR and transmits; (b) second stays in TXREG; (c) TXIF not set; (d) when first word shifted out, second transfers to TSR and TXIF set; (e) if TXIE set, wakes chip; if GIE set, branches to 0004h | §12.5.1, p89 | behaviour | todo |
| P3-166 | Sync slave TX setup: TRIS, SYNC+SPEN with CSRC=0, clear CREN and SREN, TXIE, TX9, TXEN, TX9D, load TXREG | §12.5.1 steps, p89 | behaviour | todo |
| P3-167 | Sync slave RX: identical to master except Sleep; SREN is don't care in slave | §12.5.2, p90 | behaviour | todo |
| P3-168 | Sync slave RX in Sleep: if CREN set before SLEEP, a word may be received; RSR->RCREG and, if RCIE set, interrupt wakes chip; branches to 0004h if GIE set | §12.5.2, p90 | behaviour | todo |
| P3-169 | Sync slave RX setup: TRIS, SYNC+SPEN with CSRC=0, RCIE, RX9, CREN, RCIF, read RCSTA, read RCREG, OERR -> clear CREN (text step 2 erroneously says "synchronous master serial port") | §12.5.2 steps, p90 | behaviour | todo |
| P3-170 | No FERR behaviour is described for synchronous modes (§12.4.2 only mentions 9th bit buffering) | §12.4.2, p88 | note | info |
| P3-171 | Data EEPROM readable and writable during normal operation over full VDD range; not directly mapped; accessed via EECON1, EECON2 (not physical), EEDATA, EEADR | §13.0, p91 | memory | todo |
| P3-172 | PIC16F627A/628A: 128 bytes data EEPROM, 0h–7Fh; PIC16F648A: 256 bytes, 0h–FFh | §13.0, p91 | memory | todo |
| P3-173 | Byte write auto-erases location then writes (erase before write) | §13.0, p91 | memory | todo |
| P3-174 | Write time controlled by on-chip timer; varies with voltage, temperature and chip-to-chip; limits in AC specifications | §13.0, p91 | timing | todo |
| P3-175 | Code-protected device: CPU can still read and write data EEPROM; device programmer can no longer access it | §13.0 p91; §13.8 p95 | behaviour | todo |
| P3-176 | No CPD configuration bit is named in this range; data-EEPROM protection is only described as "when the device is code-protected" | §13.0, §13.8 | note | info |
| P3-177 | EEDATA at 9Ah: EEDAT7..0 all R/W-x; reset POR xxxx xxxx, other uuuu uuuu | Register 13-1 p91; Table 13-1 p95 | register | todo |
| P3-178 | EEADR at 9Bh: EADR7..0 all R/W-x; reset POR xxxx xxxx, other uuuu uuuu | Register 13-2 p91; Table 13-1 p95 | register | todo |
| P3-179 | EEADR bit 7: 627A/628A "Unimplemented Address: Must be set to '0'"; 648A selects top 128 locations (128–255); bits 6-0 select one of 128 locations | Register 13-2, p91 | register | todo |
| P3-180 | §13.1: 648A uses all 8 bits; 627A/628A use EEADR<6:0>, "upper bit is address decoded", should always be '0' to stay in 128-byte space | §13.1, p92 | memory | todo |
| P3-181 | AMBIGUITY: behaviour when EEADR<7>=1 on 627A/628A is undefined ("address decoded", "must be set to '0'") — doc does not say whether it wraps, is ignored, or fails | Register 13-2 p91; §13.1 p92 | note | **decide** |
| P3-182 | EECON1 at 9Ch: bits 7-4 unimplemented read '0'; bit3 WRERR R/W-x; bit2 WREN R/W-0; bit1 WR R/S-0; bit0 RD R/S-0 | Register 13-3, p92 | register | todo |
| P3-183 | EECON1 reset: POR ---- x000; other Resets ---- q000 (q = depends on condition) | Table 13-1, p95 | register | todo |
| P3-184 | RD and WR can only be set in software, not cleared; cleared by hardware at completion of read/write; prevents premature termination of a write | §13.2 p92; Register 13-3 | register | todo |
| P3-185 | WRERR = 1: write prematurely terminated; register text: any MCLR Reset, any WDT Reset during normal operation, or BOR Reset; 0 = write completed | Register 13-3 bit 3, p92 | register | todo |
| P3-186 | INCONSISTENCY: §13.2 lists only MCLR Reset or WDT Time-out Reset during normal operation for WRERR; Register 13-3 also lists BOR Reset | §13.2 vs Register 13-3, p92 | note | **decide** |
| P3-187 | After a write interrupted by reset, EEDATA and EEADR are unchanged so the user can check WRERR and rewrite | §13.2, p92 | behaviour | todo |
| P3-188 | WREN: 1 = allows write cycles, 0 = inhibits writes; WREN clear on power-up | Register 13-3 bit 2; §13.2, p92 | register | todo |
| P3-189 | WR: 1 initiates write; 0 = write complete | Register 13-3 bit 1, p92 | register | todo |
| P3-190 | RD: 1 initiates read; read takes one cycle; RD cleared in hardware | Register 13-3 bit 0, p92 | register | todo |
| P3-191 | EEIF (PIR1<7>) set when write complete; must be cleared in software | §13.2 p92; §13.4 p93 | behaviour | todo |
| P3-192 | EECON2 (9Dh) not a physical register; reads all '0's; used only in write sequence; Table 13-1 reset ---- ---- | §13.2 p92; Table 13-1 p95 | register | todo |
| P3-193 | Read: write EEADR, set RD; data available in EEDATA in the very next cycle (readable by next instruction) | §13.3, Example 13-1, p93 | timing | todo |
| P3-194 | EEDATA holds read value until another read or until user writes it (during a write operation) | §13.3, p93 | behaviour | todo |
| P3-195 | Write: load EEADR and EEDATA, then per byte: WREN=1, (disable GIE with BTFSC loop per AN576), MOVLW 55h/MOVWF EECON2, MOVLW AAh/MOVWF EECON2, BSF EECON1,WR, re-enable GIE | §13.4, Example 13-2, p93 | behaviour | todo |
| P3-196 | Write does not initiate unless sequence followed exactly (55h to EECON2, AAh to EECON2, then set WR) for each byte | §13.4, p93 | failure-mode | todo |
| P3-197 | A cycle count is executed during the required sequence; any number of cycles not equal to the required count causes data not to be written (interrupts strongly recommended disabled) | §13.4, p93 | failure-mode | todo |
| P3-198 | WR cannot be set unless WREN is set | §13.4, p93 | failure-mode | todo |
| P3-199 | WREN not cleared by hardware; clearing WREN after write initiated does not affect that write | §13.4, p93 | behaviour | todo |
| P3-200 | Write completion: WR cleared by hardware, EEIF set (enable interrupt or poll) | §13.4, p93 | behaviour | todo |
| P3-201 | Write verify: read back (BSF EECON1,RD) and compare with intended value (SUBWF EEDATA,W; BTFSS STATUS,Z) | §13.5, Example 13-3, p93 | behaviour | todo |
| P3-202 | Spurious-write protection: WREN cleared on power-up; Power-up Timer (72 ms duration), when enabled, prevents EEPROM write; sequence + WREN protect against brown-out/glitch/software malfunction | §13.6, p93 | failure-mode | todo |
| P3-203 | Endurance: per-byte write cycles specs D120 and D120A; total array write cycles D124; exceeding D124 without exceeding D120 requires an array refresh | §13.7, p94 | electrical | todo |
| P3-204 | Note: if data EEPROM stores rarely changed data, refresh likely not required (see D124); infrequently changed variables should be stored in Flash program memory | §13.7 Note, p94 | note | **decide** |
| P3-205 | Example 13-4 refresh routine: per address RD then 55h/AAh/WR, poll WR (BTFSC EECON1,WR / GOTO $-1) until clear; 648A loop ends with INCFSZ EEADR wrap at 256; 627A/628A ends when EEADR bit 7 sets (128) | Example 13-4, p94 | behaviour | todo |
| P3-206 | Data EEPROM register summary: 9Ah EEDATA, 9Bh EEADR, 9Ch EECON1, 9Dh EECON2 (Note 1: not a physical register) | Table 13-1, p95 | register | todo |

## Cross-references
- Table 17-2 (p142): comparator mode-change delay, response time, input offset, Common Mode voltage, comparator current.
- Table 17-3: VREF settling time, absolute accuracy, ladder resistor R value.
- Section 11.0 "Voltage Reference Module": internal comparator reference (CM=010).
- Power-down current specification (Section 17 DC specs): Sleep current baseline vs comparator/VREF adders.
- Schmitt Trigger input specification (DC specs): digital-input conversion of analog levels on comparator pins.
- AC specifications: data EEPROM write time limits.
- Specifications D120, D120A (per-byte endurance) and D124 (total array endurance).
- Power-up Timer (72 ms) — Section 14 special features.
- AN576: why GIE clear is re-checked (BTFSC INTCON,GIE loop).
- PIC Mid-Range Reference Manual DS33023: additional data EEPROM information.
- INTCON / PIR1 / PIE1 / TRISA / TRISB definitions (Sections 4 and 5) for interrupt and pin control.
- Interrupt vector 0004h (Section 14 interrupts) for USART slave Sleep wake-up.

## DS40044G §14–16: configuration, oscillators, resets, interrupts, WDT, Sleep, code protection, ICSP/LVP, instruction set

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P4-001 | Special features list: OSC selection, Reset, POR, PWRT, OST, BOR, Interrupts, WDT, Sleep, Code protection, ID Locations, ICSP | §14.0, p.97 | note | info |
| P4-002 | WDT runs off its own RC oscillator (separate from the main clock), controlled by configuration bits | §14.0, p.97 | behaviour | todo |
| P4-003 | OST keeps the chip in Reset until the crystal oscillator is stable | §14.0, p.97 | behaviour | todo |
| P4-004 | Intro says PWRT gives a fixed 72 ms (nominal) delay "on power-up only"; §14.4.2 and Table 14-3 also apply it after a Brown-out Reset — the intro is narrower than the body | §14.0 p.97 vs §14.4.2 p.103 | note | info |
| P4-005 | Sleep is a very-low-current power-down mode; wake via external Reset, WDT wake-up or interrupt | §14.0, p.97 | behaviour | todo |
| P4-006 | Configuration bits: programmed = reads '0', unprogrammed = reads '1' | §14.1, p.97 | memory | done (SoC) |
| P4-007 | Configuration Word is at program-memory address 2007h, in the configuration space 2000h–3FFFh, which can only be accessed during programming (not by user code) | §14.1, p.97 | memory | todo |
| P4-008 | CONFIG layout (14 bits): bit13 CP, bits12–9 unimplemented (read '0'), bit8 CPD, bit7 LVP, bit6 BOREN, bit5 MCLRE, bit4 FOSC2, bit3 PWRTE, bit2 WDTE, bit1 FOSC1, bit0 FOSC0 | Register 14-1, p.98 | register | done (SoC) |
| P4-009 | CONFIG bit labels print "F0SC1"/"F0SC0" (digit zero) in the bit diagram; the text calls them FOSC1/FOSC0 — typo | Register 14-1, p.98 | note | **decide** |
| P4-010 | CP (bit13) for PIC16F648A: 1 = off; 0 = 0000h–0FFFh code-protected | Register 14-1, p.98 | register | todo |
| P4-011 | CP (bit13) for PIC16F628A: 1 = off; 0 = 0000h–07FFh code-protected | Register 14-1, p.98 | register | todo |
| P4-012 | CP (bit13) for PIC16F627A: 1 = off; 0 = 0000h–03FFh code-protected | Register 14-1, p.98 | register | todo |
| P4-013 | CPD (bit8): 1 = data memory code protection off; 0 = data memory (EEPROM) code-protected | Register 14-1, p.98 | register | todo |
| P4-014 | LVP (bit7): 1 = RB4/PGM pin has PGM function, LVP enabled; 0 = RB4/PGM is digital I/O, HV on MCLR must be used for programming | Register 14-1, p.98 | register | done (SoC) |
| P4-015 | BOREN (bit6): 1 = BOR enabled; 0 = BOR disabled | Register 14-1, p.98 | register | done (SoC) |
| P4-016 | MCLRE (bit5): 1 = RA5/MCLR/VPP pin is MCLR; 0 = pin is digital input and MCLR is internally tied to VDD | Register 14-1, p.98 | pin | done (SoC) |
| P4-017 | PWRTE (bit3): 1 = PWRT disabled; 0 = PWRT enabled (active-low enable) | Register 14-1, p.98 | register | done (SoC) |
| P4-018 | WDTE (bit2): 1 = WDT enabled; 0 = WDT disabled | Register 14-1, p.98 | register | done (SoC) |
| P4-019 | FOSC<2:0> = 111: RC oscillator, CLKOUT on RA6/OSC2/CLKOUT, R and C on RA7/OSC1/CLKIN | Register 14-1, p.98 | pin | todo |
| P4-020 | FOSC<2:0> = 110: RC oscillator, RA6 is I/O, R and C on RA7/OSC1/CLKIN | Register 14-1, p.98 | pin | todo |
| P4-021 | FOSC<2:0> = 101: INTOSC, CLKOUT on RA6/OSC2/CLKOUT, RA7 is I/O | Register 14-1, p.98 | pin | done (SoC) |
| P4-022 | FOSC<2:0> = 100: INTOSC, RA6 is I/O, RA7 is I/O | Register 14-1, p.98 | pin | done (SoC) |
| P4-023 | FOSC<2:0> = 011: EC, RA6 is I/O, CLKIN on RA7/OSC1/CLKIN | Register 14-1, p.98 | pin | done (SoC) |
| P4-024 | FOSC<2:0> = 010: HS, high-speed crystal/resonator on RA6/OSC2 and RA7/OSC1 (both pins taken) | Register 14-1, p.98 | pin | done (SoC) |
| P4-025 | FOSC<2:0> = 001: XT, crystal/resonator on RA6/OSC2 and RA7/OSC1 | Register 14-1, p.98 | pin | done (SoC) |
| P4-026 | FOSC<2:0> = 000: LP, low-power crystal on RA6/OSC2 and RA7/OSC1 | Register 14-1, p.98 | pin | done (SoC) |
| P4-027 | Enabling BOR does NOT automatically enable PWRT (differs from PIC16F627/628) | Register 14-1 Note 1, p.98 | behaviour | todo |
| P4-028 | Setting CP (turning code protection off) requires a bulk erase of the entire Flash program memory (scheme differs from PIC16F627/628) | Register 14-1 Note 2, p.98 | memory | todo |
| P4-029 | Setting CPD (turning data protection off) requires a bulk erase of the entire data EEPROM | Register 14-1 Note 3, p.98 | memory | todo |
| P4-030 | When MCLR is asserted in INTOSC mode, the internal clock oscillator is disabled | Register 14-1 Note 4, p.98 | behaviour | todo |
| P4-031 | Eight oscillator options: LP, XT, HS, RC (2 modes), INTOSC (2 modes), EC | §14.2.1, p.99 | behaviour | todo |
| P4-032 | XT/LP/HS: crystal or ceramic resonator between OSC1 and OSC2; parallel-cut crystal required; series-cut may give out-of-spec frequency | §14.2.2, p.99 | electrical | todo |
| P4-033 | In XT, LP or HS modes the device can instead take an external clock driving OSC1 (Figure 14-4) | §14.2.2, Fig 14-4, p.99–100 | behaviour | todo |
| P4-034 | Figure 14-1: crystal mode has internal feedback resistor RF and a Sleep gate on the oscillator driver; series resistor RS may be required for AT strip-cut crystals | Fig 14-1 + Note 1, p.99 | electrical | todo |
| P4-035 | Table 14-1 ceramic resonator caps: XT 455 kHz C1 = C2 = 22–100 pF; XT 2.0 MHz 15–68 pF; XT 4.0 MHz 15–68 pF | Table 14-1, p.99 | electrical | todo |
| P4-036 | Table 14-1 ceramic resonator caps: HS 8.0 MHz C1 = C2 = 10–68 pF; HS 16.0 MHz 10–22 pF | Table 14-1, p.99 | electrical | todo |
| P4-037 | Higher capacitance increases oscillator stability but also increases start-up time (both tables); values are design guidance only | Table 14-1/14-2 Notes, p.99 | behaviour | todo |
| P4-038 | Table 14-2 crystal caps: LP 32 kHz C1 = C2 = 15–30 pF; LP 200 kHz C1 = C2 = 0–15 pF | Table 14-2, p.99 | electrical | todo |
| P4-039 | Table 14-2 crystal caps: XT 100 kHz C1 = 68–150 pF, C2 = 150–200 pF (asymmetric); XT 2 MHz 15–30 pF; XT 4 MHz 15–30 pF | Table 14-2, p.99 | electrical | todo |
| P4-040 | Table 14-2 crystal caps: HS 8 MHz, 10 MHz, 20 MHz all C1 = C2 = 15–30 pF | Table 14-2, p.99 | electrical | todo |
| P4-041 | A series resistor RS may be required in HS and XT modes to avoid overdriving crystals with a low drive-level specification | Table 14-2 Note, p.99 | failure-mode | todo |
| P4-042 | External crystal oscillator: prepackaged oscillator or TTL-gate circuit; Fig 14-2 parallel-resonant (74AS04, 4.7 kΩ feedback, 10 kΩ bias pots, 180° shift); Fig 14-3 series-resonant (74AS04 x3, 330 kΩ bias resistors, 0.1 pF) driving CLKIN | §14.2.3, Fig 14-2/14-3, p.100 | electrical | todo |
| P4-043 | INTOSC: fixed 4 MHz (nominal) at VDD = 5 V and 25 °C; variation over V/T in §17 | §14.2.4, p.100 | timing | done (SoC) |
| P4-044 | EC: external clock drives OSC1/CLKIN; must meet AC/DC timing of §17.6 | §14.2.5, p.100 | electrical | todo |
| P4-045 | Figure 14-4 (EC, HS, XT or LP) shows OSC2 labelled as RA6 I/O with an external clock on OSC1 — for HS/XT/LP the register says both pins are crystal pins; the figure implies OSC2 behaviour with external clock in crystal modes is not stated in text | Fig 14-4 vs Register 14-1, p.100/98 | note | **decide** |
| P4-046 | RC oscillator frequency depends on supply voltage, REXT, CEXT and operating temperature; varies unit-to-unit (process); lead-frame capacitance differs per package, notably at low CEXT; R/C tolerance adds | §14.2.6, p.101 | behaviour | todo |
| P4-047 | RC recommended values: 3 kΩ ≤ REXT ≤ 100 kΩ (VDD ≥ 3.0 V); 10 kΩ ≤ REXT ≤ 100 kΩ (VDD < 3.0 V); CEXT > 20 pF | Fig 14-5, p.101 | electrical | todo |
| P4-048 | RC topology: REXT from VDD to RA7/OSC1/CLKIN, CEXT from OSC1 to VSS; OSC2 outputs FOSC/4 in CLKOUT variant | Fig 14-5, p.101 | pin | todo |
| P4-049 | RC mode OSC2 options: general-purpose I/O, or output FOSC/4 (internal clock divided by 4) | §14.2.6, p.101 | pin | todo |
| P4-050 | CLKOUT = oscillator frequency / 4, enabled through the Configuration Word | §14.2.7, p.101 | pin | todo |
| P4-051 | Dual-speed oscillator (INTOSC modes only): software toggles between 4 MHz and 48 kHz nominal, controlled by PCON.OSCF | §14.2.8, p.101 | behaviour | done (SoC) |
| P4-052 | Speed transition delay = 2 existing-speed clock pulses + 8 new-speed clock pulses; during it the system clock is halted, CPU frozen, PC and CLKOUT stop | §14.2.8, p.101 | timing | done (SoC) |
| P4-053 | Reset kinds: POR, MCLR during normal operation, MCLR during Sleep, WDT Reset (normal operation), WDT wake-up (Sleep), BOR | §14.3, p.101 | behaviour | done (SoC) |
| P4-054 | Some registers are unaffected by any Reset: unknown on POR, unchanged on other Resets | §14.3, p.101 | behaviour | todo |
| P4-055 | Most registers go to their Reset state on POR, BOR, MCLR Reset, WDT Reset and MCLR-during-Sleep; they are NOT affected by WDT wake-up (resumption of normal operation) | §14.3, p.101 | behaviour | done (SoC) |
| P4-056 | MCLR Reset path has a noise filter that ignores small pulses (pulse width in Table 17-7); MCLR/VPP is a Schmitt-trigger input | §14.3, Fig 14-6, p.101–102 | pin | todo |
| P4-057 | Reset block diagram: Chip_Reset from SR latch set by MCLR (external reset), WDT time-out reset (gated by Sleep: in Sleep a WDT time-out is wake, not reset), POR (VDD rise detect), BOR (gated by BOREN); released by OST/PWRT | Fig 14-6, p.102 | behaviour | todo |
| P4-058 | OST and PWRT are each 10-bit ripple counters; OST clocked from OSC1/CLKIN, PWRT from an on-chip oscillator that is separate from INTOSC/RC | Fig 14-6 + Note 1, p.102 | timing | todo |
| P4-059 | POR holds the part in Reset until a VDD rise is detected in the range 1.2–1.7 V; a maximum VDD rise time is required (§17) | §14.4.1, p.103 | electrical | todo |
| P4-060 | POR does NOT produce an internal Reset when VDD declines | §14.4.1, p.103 | failure-mode | todo |
| P4-061 | After leaving Reset, voltage/frequency/temperature must be in spec; otherwise device must be held in Reset via MCLR, BOR or PWRT | §14.4.1, p.103 | failure-mode | todo |
| P4-062 | PWRT: fixed 72 ms (nominal) time-out on POR, or (if enabled) from BOR; runs on internal RC oscillator; chip held in Reset while active | §14.4.2, p.103 | timing | done (SoC) |
| P4-063 | PWRT enabled when PWRTE cleared (programmed), disabled when set; recommended to enable PWRT when BOR is enabled | §14.4.2, p.103 | register | todo |
| P4-064 | PWRT delay varies chip-to-chip, with VDD, temperature and process (Table 17-7) | §14.4.2, p.103 | timing | todo |
| P4-065 | OST: 1024 oscillator cycles (from OSC1 input) delay after the PWRT delay is over; execution does not start until OST completes | §14.4.3, p.103 | timing | done (SoC) |
| P4-066 | OST is invoked only for XT, LP and HS modes and only on Power-on Reset or wake-up from Sleep | §14.4.3, p.103 | behaviour | done (SoC) |
| P4-067 | Text says OST only on POR or Sleep wake-up, but Table 14-3 lists 72 ms + 1024·TOSC (PWRTE=0) and 1024·TOSC (PWRTE=1) for XT/HS/LP after Brown-out Reset — contradiction | §14.4.3 vs Table 14-3, p.103–104 | note | **decide** |
| P4-068 | BOR: if VDD falls below VBOR for longer than TBOR, chip resets; a Reset is not assured if VDD is below VBOR for shorter than TBOR (VBOR Table 17-2, TBOR Table 17-7) | §14.4.4, p.103 | electrical | todo |
| P4-069 | BOREN clear (programmed) disables BOR circuitry; set enables it | §14.4.4, p.103 | register | todo |
| P4-070 | On any Reset (Power-on, Brown-out, Watchdog, etc.) the chip remains in Reset until VDD rises above VBOR, then PWRT (if enabled) adds 72 ms | §14.4.4, p.103 | behaviour | todo |
| P4-071 | If VDD drops below VBOR while PWRT is running, chip re-enters BOR and PWRT is re-initialized; once VDD > VBOR a fresh 72 ms PWRT runs | §14.4.4, Fig 14-7, p.103 | timing | todo |
| P4-072 | Figure 14-7 brown-out cases: (1) dip ≥ TBOR → Reset, released 72 ms after VDD recovers; (2) second dip during PWRT (<72 ms) → restart full 72 ms; (3) slow recovery → 72 ms after crossing VBOR; 72 ms only if PWRTE = 0 | Fig 14-7 + Note, p.103 | timing | todo |
| P4-073 | Power-up time-out sequence: PWRT starts after POR expires, then OST; total depends on oscillator mode and PWRTE (e.g. RC with PWRTE=1 → no time-out at all) | §14.4.5, p.104 | timing | done (SoC) |
| P4-074 | Time-outs run from the POR pulse: if MCLR held low long enough the time-outs expire and raising MCLR begins execution immediately (useful to sync several devices) | §14.4.5, p.104 | behaviour | done (SoC) |
| P4-075 | §14.4.5 cites "Figure 14-8, Figure 14-11 and Figure 14-12" for time-out sequences and Figure 14-11 for MCLR-held-low case; the time-out figures are actually 14-8/14-9/14-10 (14-11/14-12 are external POR/BOR circuits) — misnumbered references | §14.4.5, p.104 | note | info |
| P4-076 | Figure 14-8 (MCLR not tied to VDD, case 1): MCLR rises after TPWRT+TOST have elapsed → internal Reset releases with MCLR | Fig 14-8, p.107 | timing | todo |
| P4-077 | Figure 14-9 (MCLR not tied to VDD, case 2): MCLR rises during the time-outs → internal Reset releases at end of TPWRT + TOST | Fig 14-9, p.107 | timing | todo |
| P4-078 | Figure 14-10 (MCLR tied to VDD): internal Reset released after TPWRT then TOST from POR | Fig 14-10, p.107 | timing | todo |
| P4-079 | Figure 14-8 title reads "CASE" without number (case 1 implied) | Fig 14-8, p.107 | note | info |
| P4-080 | PCON at address 8Eh; text says it "has two bits" (BOR bit0, POR bit1) but Table 14-5/14-7 also show OSCF at bit3 | §14.4.6 vs Table 14-5, p.104–105 | note | info |
| P4-081 | PCON.BOR (bit0): unknown on POR; user must set it and check later — BOR = 0 means brown-out occurred; don't-care/unpredictable if BOREN = 0 | §14.4.6, p.104 | register | todo |
| P4-082 | PCON.POR (bit1): '0' on Power-on Reset, unaffected otherwise; user must write '1' after POR; later '0' means POR occurred (VDD may have gone too low) | §14.4.6, p.104 | register | todo |
| P4-083 | Table 14-3 XT/HS/LP: POR PWRTE=0 → 72 ms + 1024·TOSC; POR PWRTE=1 → 1024·TOSC; BOR PWRTE=0 → 72 ms + 1024·TOSC; BOR PWRTE=1 → 1024·TOSC; wake from Sleep → 1024·TOSC | Table 14-3, p.104 | timing | done (SoC) |
| P4-084 | Table 14-3 RC, EC: POR PWRTE=0 → 72 ms; PWRTE=1 → —; BOR PWRTE=0 → 72 ms; PWRTE=1 → —; wake from Sleep → — | Table 14-3, p.104 | timing | done (SoC) |
| P4-085 | Table 14-3 INTOSC: POR PWRTE=0 → 72 ms; PWRTE=1 → —; BOR PWRTE=0 → 72 ms; PWRTE=1 → —; wake from Sleep → 6 μs | Table 14-3, p.104 | timing | done (SoC) |
| P4-086 | Table 14-3 shows no wake delay for RC, but Fig 14-17 Note 2 says approximately 1 μs delay for RC oscillator mode — inconsistency | Table 14-3 vs Fig 14-17 Note 2, p.104/113 | note | **decide** |
| P4-087 | Table 14-4: POR=0, BOR=x, TO=1, PD=1 → Power-on Reset | Table 14-4, p.104 | register | done (SoC) |
| P4-088 | Table 14-4: POR=0, TO=0 → illegal (TO is set on POR); POR=0, PD=0 → illegal (PD is set on POR) | Table 14-4, p.104 | register | done (SoC) |
| P4-089 | Table 14-4: POR=1, BOR=0, TO=x, PD=x → Brown-out Reset | Table 14-4, p.104 | register | done (SoC) |
| P4-090 | Table 14-4: POR=1, BOR=1, TO=0, PD=u → WDT Reset; TO=0, PD=0 → WDT Wake-up | Table 14-4, p.104 | register | done (SoC) |
| P4-091 | Table 14-4: POR=1, BOR=1, TO=u, PD=u → MCLR Reset during normal operation; TO=1, PD=0 → MCLR Reset during Sleep | Table 14-4, p.104 | register | done (SoC) |
| P4-092 | Table 14-5 STATUS (03h/83h/103h/183h: IRP RP1 RP0 TO PD Z DC C): POR 0001 1xxx; other Resets 000q quuu | Table 14-5, p.105 | register | done (SoC) |
| P4-093 | Table 14-5 PCON (8Eh: —,—,—,—,OSCF,—,POR,BOR): POR ---- 1-0x; other Resets ---- u-uq; "other Resets" = MCLR, BOR, WDT Reset during normal operation | Table 14-5 + Note 1, p.105 | register | done (SoC) |
| P4-094 | Table 14-5 gives PCON.OSCF = u on other Resets, but Tables 14-6/14-7 give OSCF = 1 on MCLR/WDT/BOR Resets — contradiction; also STATUS bit printed "RPO" (letter O) | Table 14-5 vs 14-6/14-7, p.105–106 | note | **decide** |
| P4-095 | Table 14-6 Power-on Reset: PC 000h, STATUS 0001 1xxx, PCON ---- 1-0x | Table 14-6, p.105 | register | done (SoC) |
| P4-096 | Table 14-6 MCLR Reset during normal operation: PC 000h, STATUS 000u uuuu, PCON ---- 1-uu | Table 14-6, p.105 | register | done (SoC) |
| P4-097 | Table 14-6 MCLR Reset during Sleep: PC 000h, STATUS 0001 0uuu, PCON ---- 1-uu | Table 14-6, p.105 | register | done (SoC) |
| P4-098 | Table 14-6 WDT Reset: PC 000h, STATUS 0000 uuuu, PCON ---- 1-uu | Table 14-6, p.105 | register | done (SoC) |
| P4-099 | Table 14-6 WDT Wake-up: PC = PC + 1, STATUS uuu0 0uuu, PCON ---- u-uu | Table 14-6, p.105 | register | done (SoC) |
| P4-100 | Table 14-6 Brown-out Reset: PC 000h, STATUS 000x xuuu, PCON ---- 1-u0 | Table 14-6, p.105 | register | done (SoC) |
| P4-101 | Table 14-6 Interrupt wake-up from Sleep: PC = PC + 1 (then 0004h if GIE set, Note 1), STATUS uuu1 0uuu, PCON ---- u-uu | Table 14-6 + Note 1, p.105 | register | done (SoC) |
| P4-102 | Table 14-7 W: POR xxxx xxxx; MCLR/WDT/BOR uuuu uuuu; wake (int/WDT) uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-103 | Table 14-7 INDF (00h,80h,100h,180h): — in all columns (not a physical register) | Table 14-7, p.106 | register | done (SoC) |
| P4-104 | Table 14-7 TMR0 (01h,101h): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-105 | Table 14-7 PCL (02h,82h,102h,182h): POR 0000 0000; resets 0000 0000; wake PC + 1 (Note 3: 0004h if wake by interrupt with GIE set) | Table 14-7 + Note 3, p.106 | register | done (SoC) |
| P4-106 | Table 14-7 STATUS (03h,83h,103h,183h): POR 0001 1xxx; resets 000q quuu (Note 4 → Table 14-6); wake uuuq 0uuu | Table 14-7 + Note 4, p.106 | register | done (SoC) |
| P4-107 | Table 14-7 FSR (04h,84h,104h,184h): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-108 | Table 14-7 PORTA (05h): POR xxxx 0000; resets xxxx 0000 (not uuuu — low nibble forced 0, upper unknown even on non-POR resets); wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-109 | Table 14-7 PORTB (06h,106h): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-110 | Table 14-7 PCLATH (0Ah,8Ah,10Ah,18Ah): POR ---0 0000; resets ---0 0000; wake ---u uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-111 | Table 14-7 INTCON (0Bh,8Bh,10Bh,18Bh): POR 0000 000x; resets 0000 000u; wake uuuu uqqq (Note 2: flag bits set to cause wake-up) | Table 14-7 + Note 2, p.106 | register | done (SoC) |
| P4-112 | Table 14-7 PIR1 (0Ch): POR 0000 -000; resets 0000 -000; wake qqqq -qqq (Note 2) | Table 14-7, p.106 | register | done (SoC) |
| P4-113 | Table 14-7 TMR1L (0Eh): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | todo |
| P4-114 | Table 14-7 TMR1H (0Fh): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | todo |
| P4-115 | Table 14-7 T1CON (10h): POR --00 0000; resets --uu uuuu (Note 6: --00 0000 on BOR); wake --uu uuuu | Table 14-7 + Note 6, p.106 | register | todo |
| P4-116 | Table 14-7 TMR2 (11h): POR 0000 0000; resets 0000 0000; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-117 | Table 14-7 T2CON (12h): POR -000 0000; resets -000 0000; wake -uuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-118 | Table 14-7 CCPR1L (15h): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-119 | Table 14-7 CCPR1H (16h): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-120 | Table 14-7 CCP1CON (17h): POR --00 0000; resets --00 0000; wake --uu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-121 | Table 14-7 RCSTA (18h): POR 0000 000x; resets 0000 000x; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-122 | Table 14-7 TXREG (19h): POR 0000 0000; resets 0000 0000; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-123 | Table 14-7 RCREG (1Ah): POR 0000 0000; resets 0000 0000; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-124 | Table 14-7 CMCON (1Fh): POR 0000 0000; resets 0000 0000; wake uu-- uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-125 | CMCON wake column "uu-- uuuu" shows bits 5:4 as unimplemented although POR/reset columns give all 8 bits as 0 — inconsistent within the row | Table 14-7, p.106 | note | **decide** |
| P4-126 | Table 14-7 OPTION (81h,181h): POR 1111 1111; resets 1111 1111; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-127 | Table 14-7 TRISA (85h): POR 1111 1111; resets 1111 1111; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-128 | Table 14-7 TRISB (86h,186h): POR 1111 1111; resets 1111 1111; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-129 | Table 14-7 PIE1 (8Ch): POR 0000 -000; resets 0000 -000; wake uuuu -uuu | Table 14-7, p.106 | register | done (SoC) |
| P4-130 | Table 14-7 PCON (8Eh): POR ---- 1-0x; resets ---- 1-uq (Note 1: if VDD too low a POR happens instead; Note 5: bit0 = 0 if Reset was BOR, otherwise bit0 = u); wake ---- u-uu | Table 14-7 + Notes 1,5, p.106 | register | done (SoC) |
| P4-131 | Table 14-7 PR2 (92h): POR 1111 1111; resets 1111 1111; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-132 | Table 14-7 TXSTA (98h): POR 0000 -010; resets 0000 -010; wake uuuu -uuu | Table 14-7, p.106 | register | done (SoC) |
| P4-133 | Table 14-7 SPBRG (99h): POR 0000 0000; resets 0000 0000; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-134 | Table 14-7 EEDATA (9Ah): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-135 | Table 14-7 EEADR (9Bh): POR xxxx xxxx; resets uuuu uuuu; wake uuuu uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-136 | Table 14-7 EECON1 (9Ch): POR ---- x000; resets ---- q000; wake ---- uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-137 | Table 14-7 EECON2 (9Dh): — in all columns (not a physical register) | Table 14-7, p.106 | register | done (SoC) |
| P4-138 | Table 14-7 VRCON (9Fh): POR 000- 0000; resets 000- 0000; wake uuu- uuuu | Table 14-7, p.106 | register | done (SoC) |
| P4-139 | Table 14-7 Note 7: peripherals generating wake-up interrupts change the resulting bits in their associated registers | Table 14-7 Note 7, p.106 | behaviour | todo |
| P4-140 | Table 14-7 column 2 groups MCLR during normal operation, MCLR during Sleep, WDT Reset, Brown-out Reset; column 3 groups wake from Sleep via interrupt and via WDT time-out | Table 14-7 header, p.106 | note | info |
| P4-141 | External POR circuit for slow VDD ramp (Fig 14-11): diode D across R to discharge C at power-down; R < 40 kΩ recommended (voltage drop on R vs spec); R1 = 100 Ω–1 kΩ limits current from C into MCLR on MCLR/VPP breakdown (ESD/EOS) | Fig 14-11 + Notes 1–3, p.108 | electrical | todo |
| P4-142 | External brown-out circuit 1 (Fig 14-12: Zener, 33k, 10k, 40k): activates Reset when VDD < Vz + 0.7 V; internal BOR should be disabled | Fig 14-12 + Notes, p.108 | electrical | todo |
| P4-143 | External brown-out circuit 2 (Fig 14-13: Q1, R1, R2, 40k): Q1 turns off when VDD·R1/(R1+R2) = 0.7 V; cheaper but less accurate; internal BOR should be disabled; resistors adjusted to transistor | Fig 14-13 + Notes, p.108 | electrical | todo |
| P4-144 | 10 interrupt sources: RB0/INT, TMR0 overflow, PORTB change RB<7:4>, comparator, USART TX, USART RX, CCP, TMR1 overflow, TMR2 match, data EEPROM | §14.5, p.109 | behaviour | done (SoC) |
| P4-145 | GIE (INTCON<7>) enables all un-masked interrupts when set, disables all when clear; GIE cleared on Reset | §14.5, p.109 | register | done (SoC) |
| P4-146 | RETFIE exits the ISR and sets GIE | §14.5, p.109 | behaviour | done (SoC) |
| P4-147 | INT, RB-change and TMR0 overflow flags live in INTCON; peripheral flags in PIR1, enables in PIE1 | §14.5, p.109 | register | done (SoC) |
| P4-148 | Interrupt response: GIE cleared, return address pushed on stack, PC loaded with 0004h | §14.5, p.109 | behaviour | done (SoC) |
| P4-149 | Flag bits must be cleared in software before re-enabling interrupts, else recursive/multiple interrupt requests | §14.5, p.109 | failure-mode | done (SoC) |
| P4-150 | External interrupt (INT pin, PORTB change) latency is 3 or 4 instruction cycles depending on when the event occurs; same for 1- or 2-cycle instructions | §14.5, p.109 | timing | done (SoC) |
| P4-151 | Individual interrupt flag bits are set regardless of their mask bit or GIE | §14.5 Note 1, p.109 | behaviour | done (SoC) |
| P4-152 | When an instruction that clears GIE executes, interrupts pending for the next cycle are ignored; CPU executes a NOP in the cycle after that instruction; ignored interrupts remain pending until GIE is set again | §14.5 Note 2, p.109 | behaviour | done (SoC) |
| P4-153 | Interrupt logic: (TMR1IF·TMR1IE + TMR2IF·TMR2IE + CCP1IF·CCP1IE + CMIF·CMIE + TXIF·TXIE + RCIF·RCIE + EEIF·EEIE)·PEIE + T0IF·T0IE + INTF·INTE + RBIF·RBIE → wake-up (before GIE gate); AND GIE → interrupt to CPU | Fig 14-14, p.109 | behaviour | done (SoC) |
| P4-154 | Only peripherals not dependent on the system clock can wake the part from Sleep (system clock suspended in Sleep) | Fig 14-14 Note 1, p.109 | behaviour | done (SoC) |
| P4-155 | RB0/INT is edge-triggered: rising if INTEDG (OPTION<6>) = 1, falling if 0; valid edge sets INTF (INTCON<1>); INTE (INTCON<4>) enables; INTF must be cleared in software | §14.5.1, p.110 | behaviour | done (SoC) |
| P4-156 | RB0/INT wakes from Sleep if INTE was set before Sleep; GIE decides whether processor branches to vector after wake | §14.5.1, p.110 | behaviour | done (SoC) |
| P4-157 | TMR0 overflow FFh → 00h sets T0IF (INTCON<2>); enabled by T0IE (INTCON<5>) | §14.5.2, p.110 | register | done (SoC) |
| P4-158 | Input change on PORTB<7:4> sets RBIF (INTCON<0>); enabled by RBIE (INTCON<3>) | §14.5.3, p.110 | register | done (SoC) |
| P4-159 | If a PORTB pin changes while a read is executing (starts in Q2, ends before Q3), RBIF may not get set | §14.5.3 Note, p.110 | failure-mode | todo |
| P4-160 | Figure 14-15 INT timing: INTF sampled every Q1; INTF can be set any time during Q4–Q1; flow: Inst(PC) executes, Inst(PC+1) fetched but replaced by dummy cycle, second dummy cycle with fetch of 0004h, then Inst(0004h) executes | Fig 14-15 + Notes 1,5, p.110 | timing | done (SoC) |
| P4-161 | Asynchronous interrupt latency = 3–4 TCY; synchronous latency = 3 TCY; same whether Inst(PC) is 1- or 2-cycle | Fig 14-15 Note 2, p.110 | timing | done (SoC) |
| P4-162 | CLKOUT is available in RC and INTOSC oscillator modes; minimum INT pulse width per AC specs | Fig 14-15 Notes 3,4, p.110 | pin | todo |
| P4-163 | Table 14-8 INTCON bits: GIE PEIE T0IE INTE RBIE T0IF INTF RBIF; POR 0000 000x; other Resets 0000 000u | Table 14-8, p.111 | register | done (SoC) |
| P4-164 | Table 14-8 PIR1 (0Ch) bits: EEIF CMIF RCIF TXIF — CCP1IF TMR2IF TMR1IF; POR/other 0000 -000 | Table 14-8, p.111 | register | done (SoC) |
| P4-165 | Table 14-8 PIE1 (8Ch) bits: EEIE CMIE RCIE TXIE — CCP1IE TMR2IE TMR1IE; POR/other 0000 -000 | Table 14-8, p.111 | register | done (SoC) |
| P4-166 | Only the return PC is saved on interrupt; W and STATUS must be saved in software | §14.6, p.111 | behaviour | todo |
| P4-167 | Example 14-1 context save: MOVWF W_TEMP; SWAPF STATUS,W; BCF STATUS,RP0; MOVWF STATUS_TEMP; …ISR…; SWAPF STATUS_TEMP,W; MOVWF STATUS; SWAPF W_TEMP,F; SWAPF W_TEMP,W | Example 14-1, p.111 | behaviour | todo |
| P4-168 | W_TEMP defined at 0x70 in Bank 0 is accessible at 0xF0, 0x170 and 0x1F0 (common/shared RAM across banks) | §14.6, p.111 | memory | todo |
| P4-169 | Example 14-1 "BCF STATUS,RP0 ;change to bank 0" only clears RP0 (RP1 untouched); comment says "regardless of current bank" | Example 14-1, p.111 | note | info |
| P4-170 | WDT is a free-running on-chip RC oscillator, separate from the CLKIN RC; keeps running when OSC1/OSC2 clock stopped (e.g. SLEEP) | §14.7, p.111 | behaviour | done (SoC) |
| P4-171 | WDT time-out in normal operation → device Reset; in Sleep → wake-up and continue normal operation | §14.7, p.111 | behaviour | done (SoC) |
| P4-172 | WDT permanently disabled by programming WDTE = 0 | §14.7, p.111 | register | done (SoC) |
| P4-173 | WDT nominal time-out 18 ms (no prescaler); varies with temperature, VDD, process (Table 17-7) | §14.7.1, p.111 | timing | done (SoC) |
| P4-174 | Postscaler up to 1:128 assignable to WDT via OPTION → time-outs up to 2.3 s | §14.7.1, p.111 | timing | done (SoC) |
| P4-175 | CLRWDT and SLEEP clear the WDT and the postscaler (if assigned to WDT) | §14.7.1, p.111 | behaviour | done (SoC) |
| P4-176 | TO bit in STATUS cleared upon WDT time-out | §14.7.1, p.111 | register | done (SoC) |
| P4-177 | Worst case (VDD min, temperature max, max prescaler) WDT time-out may take several seconds | §14.7.2, p.111 | timing | todo |
| P4-178 | WDT block: PSA mux selects whether the shared 8-bit prescaler/postscaler serves TMR0 (PSA=0) or WDT (PSA=1); PS<2:0> select via 8-to-1 mux; WDT enable bit gates the WDT | Fig 14-16, p.112 | behaviour | done (SoC) |
| P4-179 | Table 14-9 CONFIG (2007h) row lists LVP BOREN MCLRE FOSC2 PWRTE WDTE FOSC1 FOSC0 in bits 7..0 with values "uuuu uuuu uuuu uuuu" (16 digits for a 14-bit word); OPTION (81h,181h) RBPU INTEDG T0CS T0SE PSA PS2 PS1 PS0 with "1111 1111 1111 1111" (16 digits for 8-bit register) — columns appear merged/misprinted | Table 14-9, p.112 | note | **decide** |
| P4-180 | SLEEP: WDT (if enabled) cleared but keeps running; PD cleared; TO set; oscillator driver turned off | §14.8, p.112 | behaviour | done (SoC) |
| P4-181 | In Sleep I/O ports keep the state they had before SLEEP (driving high, low or high-Z) | §14.8, p.112 | pin | todo |
| P4-182 | Lowest Sleep current: all I/O at VDD or VSS with no external load, comparators and VREF disabled, floating hi-Z inputs pulled externally, T0CKI at VDD or VSS; PORTB pull-ups contribute current | §14.8, p.112 | electrical | todo |
| P4-183 | Floating high-impedance inputs cause switching currents (extra current in Sleep) | §14.8, p.112 | failure-mode | todo |
| P4-184 | In Sleep the MCLR pin must be at logic high (VIHMC) | §14.8, p.112 | pin | todo |
| P4-185 | A Reset generated by WDT time-out does not drive the MCLR pin low | §14.8 Note, p.112 | pin | todo |
| P4-186 | Wake-up sources: (1) external Reset on MCLR → device Reset; (2) WDT wake-up (if enabled) and (3) RB0/INT, RB port change or any peripheral interrupt active in Sleep → continuation of execution | §14.8.1, p.113 | behaviour | done (SoC) |
| P4-187 | PD is set on power-up and cleared when Sleep is invoked; TO is cleared if WDT wake-up occurred | §14.8.1, p.113 | register | done (SoC) |
| P4-188 | During SLEEP execution, PC+1 is pre-fetched; interrupt wake-up requires the interrupt's enable bit set; wake-up is independent of GIE | §14.8.1, p.113 | behaviour | done (SoC) |
| P4-189 | Wake with GIE = 0: continue at instruction after SLEEP; GIE = 1: execute instruction after SLEEP, then branch to 0004h (put a NOP after SLEEP if that is undesirable) | §14.8.1, p.113 | behaviour | done (SoC) |
| P4-190 | If GIE = 0 but any source has both its enable and flag set, the device will not enter Sleep — SLEEP executes as a NOP | §14.8.1 Note, p.113 | behaviour | done (SoC) |
| P4-191 | WDT is cleared when the device wakes from Sleep, regardless of wake source | §14.8.1, p.113 | behaviour | done (SoC) |
| P4-192 | Figure 14-17 wake via interrupt: Inst(PC)=SLEEP executes while Inst(PC+1) fetched; processor in Sleep; on INT, after TOST (1024 TOSC, XT/HS/LP) Inst(PC+1) executes (fetching PC+2), then two dummy cycles, then Inst(0004h) fetched/executed (GIE=1); with GIE=0 continues in-line | Fig 14-17 + Notes 1–3, p.113 | timing | done (SoC) |
| P4-193 | Figure 14-17 Note 4: CLKOUT not available in XT/HS/LP oscillator modes (shown only for timing reference) | Fig 14-17 Note 4, p.113 | pin | todo |
| P4-194 | Code protection: with CP cleared, program memory locations read out as '0' (via programming interface) | §14.9, p.113 | memory | todo |
| P4-195 | Only a Bulk Erase can set CP and CPD (turn protection off); it erases entire data EEPROM and Flash program memory | §14.9 Note, p.113 | memory | todo |
| P4-196 | User ID locations 2000h–2003h (four); not accessible in normal execution; readable/writable during Program/Verify; 14 bits each but only the LS 4 bits used in checksum | §14.10, p.113 | memory | todo |
| P4-197 | ICSP uses clock, data, power, ground and programming voltage lines; devices can be programmed in-circuit | §14.11, p.114 | behaviour | todo |
| P4-198 | High-voltage Program/Verify entry: hold RB6 and RB7 low while raising MCLR/VPP from VIL to VIHH | §14.11, p.114 | pin | done (SoC) |
| P4-199 | In Program/Verify mode RB6 = programming clock (PGC), RB7 = programming data (PGD); both Schmitt-trigger inputs | §14.11, Fig 14-18, p.114 | pin | todo |
| P4-200 | After entering Program/Verify, PC is at 00h; a 6-bit command is supplied, then 14 bits of data to or from the device depending on load vs read | §14.11, p.114 | behaviour | todo |
| P4-201 | Fig 14-18 ICSP connection: +5V→VDD, 0V→VSS, VPP→RA5/MCLR/VPP, CLK→RB6/PGC, Data I/O→RB7/PGD | Fig 14-18, p.114 | pin | todo |
| P4-202 | LVP: programming via ICSP using only a 5 V source, no VIHH on MCLR; LVP bit erased state is '1' (LVP enabled by default) | §14.12, p.114 | behaviour | done (SoC) |
| P4-203 | With LVP = 1, RB4/PGM is dedicated to programming and is not usable as general-purpose I/O | §14.12 + Note 1, p.114 | pin | done (SoC) |
| P4-204 | With LVP = 1, the device enters Programming mode when '1' is placed on RB4/PGM (failure mode for apps that drive RB4 high while LVP left enabled) | §14.12, p.114 | failure-mode | done (SoC) |
| P4-205 | High-voltage programming (VIHH on MCLR) remains available when LVP = 1 | §14.12, p.114 | behaviour | done (SoC) |
| P4-206 | VDD must be 5.0 V +10% during erase operations (LVP mode) | §14.12 Note 2, p.114 | electrical | todo |
| P4-207 | If LVP unused, program LVP = 0 so RB4/PGM becomes digital I/O; then VIHH must be on MCLR to program | §14.12, p.114 | pin | todo |
| P4-208 | LVP bit can only be programmed when programming mode was entered with VIHH on MCLR, not when entered via RB4/PGM; once LVP = 0 only HV programming can be used | §14.12, p.114 | behaviour | todo |
| P4-209 | In-circuit debugging uses a 28-pin PIC16F648A-ICD (MPLAB ICD 2) with separate clock/data/MCLR pins; ICD pin held low enables debugger | §14.13, p.115 | note | info |
| P4-210 | Debugger resources (labelled "Table 14-19", likely misnumbered): I/O pins ICDCLK, ICDDATA; 1 stack level; program memory address 0h must be NOP and 300h–3FEh reserved | Table 14-19, p.115 | memory | todo |
| P4-211 | Instruction word is 14 bits: OPCODE + operands; three categories: byte-oriented, bit-oriented, literal/control | §15.0, p.117 | behaviour | done (core) |
| P4-212 | Byte-oriented format: bits 13–8 opcode, bit 7 d (0 = W, 1 = f), bits 6–0 f (7-bit file address) | Fig 15-1, p.117 | behaviour | done (core) |
| P4-213 | Bit-oriented format: bits 13–10 opcode, bits 9–7 b (3-bit bit number), bits 6–0 f | Fig 15-1, p.117 | behaviour | done (core) |
| P4-214 | Literal format: bits 13–8 opcode, bits 7–0 k (8-bit); CALL/GOTO: bits 13–11 opcode, bits 10–0 k (11-bit) | Fig 15-1, p.117 | behaviour | done (core) |
| P4-215 | Field f range 0x00–0x7F; x = don't care, assembler generates 0; d default = 1 (assembler) | Table 15-1, p.117 | note | done (core) |
| P4-216 | All instructions take 1 instruction cycle unless a conditional test is true or PC changed → 2 cycles, second executed as NOP | §15.0, p.117 | timing | done (core) |
| P4-217 | 1 instruction cycle = 4 oscillator periods; at 4 MHz normal instruction = 1 μs, 2-cycle = 2 μs | §15.0, p.117 | timing | done (core) |
| P4-218 | Any unused opcode is reserved; using one may cause unexpected operation | §15.0 Note 1, p.117 | failure-mode | D1 |
| P4-219 | Do not use OPTION and TRIS instructions (upward compatibility) | §15.0 Note 2, p.117 | note | info |
| P4-220 | Read-Modify-Write: any instruction with a file operand reads the register even if it only writes it; result stored per d | §15.1, p.117 | behaviour | done (core) |
| P4-221 | R-M-W hazard: "CLRF PORTB" reads PORTB, clears, writes back — clears the RBIF mismatch condition for input pins using interrupt-on-change | §15.1, p.117 | failure-mode | done (core) |
| P4-222 | When an I/O register is modified as a function of itself (e.g. MOVF PORTB,1) the value used is the pin value: latch '1' on an input driven low externally is written back as '0' | Table 15-2 Note 1, p.118 | failure-mode | todo |
| P4-223 | If an instruction (with Note 2) targets TMR0 (and d = 1 where applicable), the prescaler is cleared if assigned to Timer0 | Table 15-2 Note 2, p.118 | behaviour | todo |
| P4-224 | Table 15-2 note mapping: ADDWF, ANDWF, COMF, DECF, INCF, IORWF, MOVF, RLF, RRF, SUBWF, SWAPF, XORWF, BCF, BSF → Notes 1,2; CLRF → Note 2; DECFSZ, INCFSZ → Notes 1,2,3; BTFSC, BTFSS → Note 3; MOVWF, CLRW, NOP, literal/control → none | Table 15-2, p.118 | note | info |
| P4-225 | Table 15-2 MOVWF has no Note 2 — the table does not say MOVWF TMR0 clears the prescaler | Table 15-2, p.118 | note | info |
| P4-226 | ADDWF f,d: 00 0111 dfff ffff; (W)+(f)→dest; C, DC, Z; 1 cycle | Table 15-2, §15.2, p.118–119 | behaviour | done (core) |
| P4-227 | ADDWF example: W=0x17, REG1=0xC2, ADDWF REG1,0 → W=0xD9, REG1=0xC2, Z=0, C=0, DC=0 | §15.2 ADDWF, p.119 | behaviour | done (core) |
| P4-228 | ANDWF f,d: 00 0101 dfff ffff; (W).AND.(f)→dest; Z; 1 cycle | Table 15-2, §15.2, p.118–119 | behaviour | done (core) |
| P4-229 | ANDWF example: W=0x17, REG1=0xC2, ANDWF REG1,1 → W=0x17, REG1=0x02 | §15.2 ANDWF, p.119 | behaviour | done (core) |
| P4-230 | CLRF f: 00 0001 1fff ffff; 00h→f, 1→Z; Z; 1 cycle | Table 15-2, §15.2, p.118/121 | behaviour | done (core) |
| P4-231 | CLRF example: REG1=0x5A → REG1=0x00, Z=1 | §15.2 CLRF, p.121 | behaviour | done (core) |
| P4-232 | Table 15-2 prints CLRF/MOVWF encoding as "lfff" (letter l) — means bit 7 = 1 | Table 15-2, p.118 | note | done (core) |
| P4-233 | CLRW: Table 15-2 encoding 00 0001 0xxx xxxx; 00h→W, 1→Z; Z; 1 cycle | Table 15-2, p.118 | behaviour | done (core) |
| P4-234 | CLRW description gives fixed encoding 00 0001 0000 0011 (0x0103) whereas Table 15-2 gives 00 0001 0xxx xxxx — the table implies any low 7 bits decode as CLRW | §15.2 CLRW vs Table 15-2, p.122/118 | note | done (core) |
| P4-235 | CLRW example: W=0x5A → W=0x00, Z=1 | §15.2 CLRW, p.122 | behaviour | done (core) |
| P4-236 | COMF f,d: 00 1001 dfff ffff; complement of (f)→dest; Z; 1 cycle | Table 15-2, §15.2, p.118/122 | behaviour | done (core) |
| P4-237 | COMF example: REG1=0x13, COMF REG1,0 → REG1=0x13, W=0xEC | §15.2 COMF, p.122 | behaviour | done (core) |
| P4-238 | COMF "Operation: (f) → (dest)" in text extraction lacks the complement overbar (extraction artefact; description says complemented) | §15.2 COMF, p.122 | note | done (core) |
| P4-239 | DECF f,d: 00 0011 dfff ffff; (f)−1→dest; Z; 1 cycle | Table 15-2, §15.2, p.118/122 | behaviour | done (core) |
| P4-240 | DECF example: CNT=0x01, Z=0, DECF CNT,1 → CNT=0x00, Z=1 | §15.2 DECF, p.122 | behaviour | done (core) |
| P4-241 | DECFSZ f,d: 00 1011 dfff ffff; (f)−1→dest, skip if result = 0; status None; 1(2) cycles — the already fetched next instruction is discarded and a NOP executed | Table 15-2, §15.2, p.118/123 | behaviour | done (core) |
| P4-242 | DECFSZ example: HERE DECFSZ REG1,1 / GOTO LOOP / CONTINUE: REG1 = REG1−1; if 0 → PC = CONTINUE, else PC = HERE+1 | §15.2 DECFSZ, p.123 | behaviour | done (core) |
| P4-243 | INCF f,d: 00 1010 dfff ffff; (f)+1→dest; Z; 1 cycle | Table 15-2, §15.2, p.118/124 | behaviour | done (core) |
| P4-244 | INCF example: REG1=0xFF, Z=0, INCF REG1,1 → REG1=0x00, Z=1 | §15.2 INCF, p.124 | behaviour | done (core) |
| P4-245 | INCFSZ f,d: 00 1111 dfff ffff; (f)+1→dest, skip if result = 0; status None; 1(2) cycles | Table 15-2, §15.2, p.118/124 | behaviour | done (core) |
| P4-246 | INCFSZ example: HERE INCFSZ REG1,1 / GOTO LOOP / CONTINUE: if result 0 → PC = CONTINUE, else PC = HERE+1 | §15.2 INCFSZ, p.124 | behaviour | done (core) |
| P4-247 | INCFSZ example tests "if CNT = 0" though the register is REG1 — naming typo | §15.2 INCFSZ, p.124 | note | done (core) |
| P4-248 | IORWF f,d: 00 0100 dfff ffff; (W).OR.(f)→dest; Z; 1 cycle | Table 15-2, §15.2, p.118/125 | behaviour | done (core) |
| P4-249 | IORWF example: REG1=0x13, W=0x91, IORWF REG1,0 → REG1=0x13, W=0x93 | §15.2 IORWF, p.125 | behaviour | done (core) |
| P4-250 | IORWF example claims Z = 1 for a non-zero result 0x93 — misprint (Z must be 0) | §15.2 IORWF, p.125 | note | done (core) |
| P4-251 | MOVF f,d: 00 1000 dfff ffff; (f)→dest; Z; 1 cycle; d = 1 is useful to test a register since Z is affected | Table 15-2, §15.2, p.118/125 | behaviour | done (core) |
| P4-252 | MOVF example: MOVF REG1,0 → W = value in REG1, "Z = 1" — shown unconditionally; Z only 1 if the value is zero | §15.2 MOVF, p.125 | note | done (core) |
| P4-253 | MOVWF f: 00 0000 1fff ffff; (W)→f; status None; 1 cycle | Table 15-2, §15.2, p.118/126 | behaviour | done (core) |
| P4-254 | MOVWF example: REG1=0xFF, W=0x4F → REG1=0x4F, W=0x4F | §15.2 MOVWF, p.126 | behaviour | done (core) |
| P4-255 | NOP: 00 0000 0xx0 0000; no operation; None; 1 cycle | Table 15-2, §15.2, p.118/126 | behaviour | done (core) |
| P4-256 | RLF f,d: 00 1101 dfff ffff; rotate left through Carry (C←f<7>, f<0>←C); C only; 1 cycle | Table 15-2, §15.2, p.118/127 | behaviour | done (core) |
| P4-257 | RLF example: REG1=1110 0110, C=0, RLF REG1,0 → REG1=1110 0110, W=1100 1100, C=1 | §15.2 RLF, p.127 | behaviour | done (core) |
| P4-258 | RRF f,d: 00 1100 dfff ffff; rotate right through Carry (C←f<0>, f<7>←C); C only; 1 cycle | Table 15-2, §15.2, p.118/128 | behaviour | done (core) |
| P4-259 | RRF example: REG1=1110 0110, C=0, RRF REG1,0 → REG1=1110 0110, W=0111 0011, C=0 | §15.2 RRF, p.128 | behaviour | done (core) |
| P4-260 | SUBWF f,d: 00 0010 dfff ffff; (f)−(W)→dest (2's complement); C, DC, Z; 1 cycle | Table 15-2, §15.2, p.118/129 | behaviour | done (core) |
| P4-261 | SUBWF example 1: REG1=3, W=2, SUBWF REG1,1 → REG1=1, W=2, C=1 (positive), DC=1, Z=0 | §15.2 SUBWF, p.129 | behaviour | done (core) |
| P4-262 | SUBWF example 2: REG1=2, W=2 → REG1=0, W=2, C=1 (zero), Z=DC=1 | §15.2 SUBWF, p.129 | behaviour | done (core) |
| P4-263 | SUBWF example 3: REG1=1, W=2 → REG1=0xFF, W=2, C=0 (negative), Z=DC=0 | §15.2 SUBWF, p.129 | behaviour | done (core) |
| P4-264 | SWAPF f,d: 00 1110 dfff ffff; f<3:0>→dest<7:4>, f<7:4>→dest<3:0>; status None; 1 cycle | Table 15-2, §15.2, p.118/129 | behaviour | done (core) |
| P4-265 | SWAPF example: REG1=0xA5, SWAPF REG1,0 → REG1=0xA5, W=0x5A | §15.2 SWAPF, p.129 | behaviour | done (core) |
| P4-266 | XORWF f,d: 00 0110 dfff ffff; (W).XOR.(f)→dest; Z; 1 cycle | Table 15-2, §15.2, p.118/130 | behaviour | done (core) |
| P4-267 | XORWF example: REG1=0xAF, W=0xB5, XORWF REG1,1 → REG1=0x1A, W=0xB5 | §15.2 XORWF, p.130 | behaviour | done (core) |
| P4-268 | BCF f,b: 01 00bb bfff ffff; 0→f<b>; None; 1 cycle | Table 15-2, §15.2, p.118/120 | behaviour | done (core) |
| P4-269 | BCF example: REG1=0xC7, BCF REG1,7 → REG1=0x47 | §15.2 BCF, p.120 | behaviour | done (core) |
| P4-270 | BSF f,b: 01 01bb bfff ffff; 1→f<b>; None; 1 cycle | Table 15-2, §15.2, p.118/120 | behaviour | done (core) |
| P4-271 | BSF example: REG1=0x0A, BSF REG1,7 → REG1=0x8A | §15.2 BSF, p.120 | behaviour | done (core) |
| P4-272 | BTFSC f,b: 01 10bb bfff ffff; skip if f<b> = 0; None; 1(2) cycles — fetched next instruction discarded and NOP executed when skipping | Table 15-2, §15.2, p.118/120 | behaviour | done (core) |
| P4-273 | BTFSC example: HERE BTFSC REG1 / FALSE GOTO PROCESS_CODE / TRUE: if REG<1> = 0 → PC = TRUE; if REG<1> = 1 → PC = FALSE | §15.2 BTFSC, p.120 | behaviour | done (core) |
| P4-274 | BTFSC/BTFSS examples omit the bit operand ("BTFSC REG1") while the result text refers to REG<1>/FLAG<1> — incomplete example | §15.2 BTFSC/BTFSS, p.120–121 | note | done (core) |
| P4-275 | BTFSS f,b: 01 11bb bfff ffff; skip if f<b> = 1; None; 1(2) cycles | Table 15-2, §15.2, p.118/121 | behaviour | done (core) |
| P4-276 | BTFSS example: if FLAG<1> = 0 → PC = FALSE; if FLAG<1> = 1 → PC = TRUE | §15.2 BTFSS, p.121 | behaviour | done (core) |
| P4-277 | BTFSS operand range printed "0 ≤ b < 7" (BTFSC/BCF/BSF say 0 ≤ b ≤ 7) — misprint; b is 3-bit so 0–7 | §15.2 BTFSS, p.121 | note | done (core) |
| P4-278 | ADDLW k: 11 111x kkkk kkkk; (W)+k→W; C, DC, Z; 1 cycle | Table 15-2, §15.2, p.118–119 | behaviour | done (core) |
| P4-279 | ADDLW example: W=0x10, ADDLW 0x15 → W=0x25 | §15.2 ADDLW, p.119 | behaviour | done (core) |
| P4-280 | ANDLW k: 11 1001 kkkk kkkk; (W).AND.k→W; Z; 1 cycle | Table 15-2, §15.2, p.118–119 | behaviour | done (core) |
| P4-281 | ANDLW example: W=0xA3, ANDLW 0x5F → W=0x03 | §15.2 ANDLW, p.119 | behaviour | done (core) |
| P4-282 | CALL k: 10 0kkk kkkk kkkk; (PC)+1→TOS, k→PC<10:0>, PCLATH<4:3>→PC<12:11>; None; 2 cycles; 0 ≤ k ≤ 2047 | Table 15-2, §15.2, p.118/121 | behaviour | done (core) |
| P4-283 | CALL example: HERE CALL THERE → PC = THERE, TOS = HERE+1 | §15.2 CALL, p.121 | behaviour | done (core) |
| P4-284 | CLRWDT: 00 0000 0110 0100 (0x0064); 00h→WDT, 0→WDT prescaler, 1→TO, 1→PD; status TO, PD; 1 cycle | Table 15-2, §15.2, p.118/122 | behaviour | done (core) |
| P4-285 | CLRWDT example: WDT counter=? → WDT counter=0x00, WDT prescaler=0, TO=1, PD=1 | §15.2 CLRWDT, p.122 | behaviour | done (core) |
| P4-286 | GOTO k: 10 1kkk kkkk kkkk; k→PC<10:0>, PCLATH<4:3>→PC<12:11>; None; 2 cycles; 0 ≤ k ≤ 2047 | Table 15-2, §15.2, p.118/123 | behaviour | done (core) |
| P4-287 | GOTO example: GOTO THERE → PC = THERE | §15.2 GOTO, p.123 | behaviour | done (core) |
| P4-288 | IORLW k: 11 1000 kkkk kkkk; (W).OR.k→W; Z; 1 cycle | Table 15-2, §15.2, p.118/125 | behaviour | done (core) |
| P4-289 | IORLW example: W=0x9A, IORLW 0x35 → W=0xBF, Z=0 | §15.2 IORLW, p.125 | behaviour | done (core) |
| P4-290 | MOVLW k: 11 00xx kkkk kkkk; k→W; None; 1 cycle; don't-cares assemble as '0' | Table 15-2, §15.2, p.118/125 | behaviour | done (core) |
| P4-291 | MOVLW example: MOVLW 0x5A → W=0x5A | §15.2 MOVLW, p.125 | behaviour | done (core) |
| P4-292 | RETFIE: 00 0000 0000 1001 (0x0009); TOS→PC (stack popped), 1→GIE; None; 2 cycles | Table 15-2, §15.2, p.118/126 | behaviour | done (core) |
| P4-293 | RETFIE example: after → PC = TOS, GIE = 1 | §15.2 RETFIE, p.126 | behaviour | done (core) |
| P4-294 | RETLW k: 11 01xx kkkk kkkk; k→W, TOS→PC; None; 2 cycles | Table 15-2, §15.2, p.118/127 | behaviour | done (core) |
| P4-295 | RETLW table example: CALL TABLE with W = 0x07 offset; TABLE: ADDWF PC; RETLW k1…kn → W = value of k8 (computed-goto table lookup) | §15.2 RETLW, p.127 | behaviour | done (core) |
| P4-296 | RETLW example writes "ADDWF PC" with no d operand (default d = 1 → PC) | §15.2 RETLW, p.127 | note | done (core) |
| P4-297 | RETURN: 00 0000 0000 1000 (0x0008); TOS→PC (stack popped); None; 2 cycles | Table 15-2, §15.2, p.118/127 | behaviour | done (core) |
| P4-298 | RETURN example is labelled "After Interrupt" (copy from RETFIE) — misprint; it is a subroutine return | §15.2 RETURN, p.127 | note | done (core) |
| P4-299 | SLEEP: 00 0000 0110 0011 (0x0063); 00h→WDT, 0→WDT prescaler, 1→TO, 0→PD; status TO, PD; 1 cycle; processor enters Sleep with oscillator stopped | Table 15-2, §15.2, p.118/128 | behaviour | done (core) |
| P4-300 | SUBLW k: 11 110x kkkk kkkk; k−(W)→W (2's complement); C, DC, Z; 1 cycle | Table 15-2, §15.2, p.118/128 | behaviour | done (core) |
| P4-301 | SUBLW 0x02 example 1: W=1 → W=1, C=1 (positive) | §15.2 SUBLW, p.128 | behaviour | done (core) |
| P4-302 | SUBLW 0x02 example 2: W=2 → W=0, C=1 (zero) | §15.2 SUBLW, p.128 | behaviour | done (core) |
| P4-303 | SUBLW 0x02 example 3: W=3 → W=0xFF, C=0 (negative) | §15.2 SUBLW, p.128 | behaviour | done (core) |
| P4-304 | SUBLW examples do not give Z or DC values (only C) | §15.2 SUBLW, p.128 | note | done (core) |
| P4-305 | XORLW k: 11 1010 kkkk kkkk; (W).XOR.k→W; Z; 1 cycle | Table 15-2, §15.2, p.118/130 | behaviour | done (core) |
| P4-306 | XORLW example: W=0xB5, XORLW 0xAF → W=0x1A | §15.2 XORLW, p.130 | behaviour | done (core) |
| P4-307 | OPTION: 00 0000 0110 0010 (0x0062); (W)→OPTION; None; 1 cycle; PIC16C5X compatibility, not in Table 15-2, do not use | §15.2 OPTION, p.126 | behaviour | done (SoC) |
| P4-308 | TRIS f: 00 0000 0110 0fff; 5 ≤ f ≤ 7; (W)→TRIS register f; None; 1 cycle; PIC16C5X compatibility, not in Table 15-2, do not use | §15.2 TRIS, p.129 | behaviour | done (SoC) |
| P4-309 | TRIS operand 5 ≤ f ≤ 7 includes f = 7 although only TRISA/TRISB exist in the reset tables — behaviour for f = 7 not stated | §15.2 TRIS, p.129 | note | D5 |
| P4-310 | Literal opcodes with x don't-care bits (ADDLW 111x, SUBLW 110x, MOVLW 00xx, RETLW 01xx, NOP 0xx0) must decode identically for x = 0 or 1 | Table 15-2, p.118 | behaviour | done (core) |
| P4-311 | Examples use 0xhh hex notation | §15.0, p.117 | note | info |
| P4-312 | §16 (development tools) states no device behaviour; only 16.10 mentions that the debug connector uses two device I/O pins and the reset line for in-circuit debugging/ICSP | §16.10, p.133 | note | info |

## Cross-references
- DS41196 "PIC16F627A/628A/648A EEPROM Memory Programming Specification" — configuration space access, CP/CPD bulk-erase, code-protect read-out, ICSP command set/timing, Program/Verify entry.
- §17.0 Electrical Specifications — INTOSC variation over V/T, VDD rise time for POR, external clock AC/DC timing (§17.6).
- Table 17-2 — VBOR.
- Table 17-7 — TBOR, PWRT period, OST, WDT period, MCLR pulse-width filter.
- AC specs — minimum INT pulse width (Fig 14-15 Note 4).
- §4.2.2.6 / Register 4-6 — PCON register (OSCF).
- §5.2 — PORTB and TRISB (interrupt-on-change).
- §6.0 / Figure 6-1 — Timer0 module and prescaler.
- §10.6 — Comparator interrupts.
- AN607 "Power-up Trouble Shooting" (DS00607) — power-up issues.
- PIC16F627/628 — differences in BOR/PWRT coupling and code-protect scheme.
- PIC16C5X — OPTION/TRIS instruction compatibility.
- PIC16F648A-ICD / MPLAB ICD 2, part AC162053 — in-circuit debugger header.

## DS40044G §17–18: electrical characteristics, timing, graphs

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P5-001 | Absolute max: ambient temperature under bias -40 to +125°C | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-002 | Absolute max: storage temperature -65°C to +150°C | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-003 | Absolute max: voltage on VDD w.r.t. VSS -0.3 to +6.5 V | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-004 | Absolute max: voltage on MCLR and RA4 w.r.t. VSS -0.3 to +14 V | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-005 | Absolute max: voltage on all other pins w.r.t. VSS -0.3 V to VDD + 0.3 V | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-006 | Absolute max: total power dissipation 800 mW (Note 1) | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-007 | Absolute max: maximum current out of VSS pin 300 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-008 | Absolute max: maximum current into VDD pin 250 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-009 | Absolute max: input clamp current IIK (VI < 0 or VI > VDD) ± 20 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-010 | Absolute max: output clamp current IOK (Vo < 0 or Vo > VDD) ± 20 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-011 | Absolute max: maximum output current sunk by any I/O pin 25 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-012 | Absolute max: maximum output current sourced by any I/O pin 25 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-013 | Absolute max: maximum current sunk by PORTA and PORTB (combined) 200 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-014 | Absolute max: maximum current sourced by PORTA and PORTB (combined) 200 mA | §17.0 Absolute Maximum Ratings, p.135 | failure-mode | todo |
| P5-015 | Power dissipation formula (Note 1): PDIS = VDD x {IDD – ∑ IOH} + ∑ {(VDD – VOH) x IOH} + ∑(VOL x IOL) | §17.0 Absolute Maximum Ratings Note 1, p.135 | electrical | todo |
| P5-016 | † Notice: stresses above Absolute Maximum Ratings may cause permanent damage; functional operation at/above those conditions not implied; extended exposure to maximum rating conditions may affect device reliability | §17.0 Absolute Maximum Ratings notice, p.135 | failure-mode | todo |
| P5-017 | Latch-up: voltage spikes below VSS at MCLR pin inducing currents greater than 80 mA may cause latch-up; a series resistor of 50-100 Ω should be used when applying a "low" level to MCLR rather than pulling directly to VSS | §17.0 Absolute Maximum Ratings Note, p.135 | failure-mode | todo |
| P5-018 | Figure 17-1 PIC16F627A/628A/648A voltage-frequency graph, -40°C ≤ TA ≤ +125°C: axes VDD 2.5–6.0 V (gridlines 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0), frequency 0/4/10/20/25 MHz; "shaded region indicates the permissible combinations of voltage and frequency". Shaded region boundaries are not recoverable from the text extraction | §17.0 Figure 17-1, p.136 | note | **check PDF** |
| P5-019 | Figure 17-2 PIC16LF627A/628A/648A voltage-frequency graph, -40°C ≤ TA ≤ +85°C: axes VDD 2.0–6.0 V, frequency 0/4/10/20/25 MHz; shaded region = permissible combinations. Shaded region boundaries not recoverable from the text; LF graph is industrial only (+85°C) | §17.0 Figure 17-2, p.136 | note | **check PDF** |
| P5-020 | V-F region inferred only from tables, not from the graphs: Table 17-4 caps XT/RC at 4 MHz (VDD = 5.0 V), HS/EC at 20 MHz; D013 (20 MHz HS) IDD specified only at VDD 4.5 and 5.0 V; check the graphic in the PDF for exact corner points before modelling an overclock failure | §17.0 Fig 17-1/17-2 vs Table 17-4, Table 17.2 D013 | note | **check PDF** |
| P5-021 | D001 VDD supply voltage PIC16LF627A/628A/648A: min 2.0, max 5.5 V | §17.1, p.137 | electrical | todo |
| P5-022 | D001 VDD supply voltage PIC16F627A/628A/648A: min 3.0, max 5.5 V | §17.1, p.137 | electrical | todo |
| P5-023 | D002 VDR RAM data retention voltage: typ 1.5* V, device in Sleep mode (Note 1: limit to which VDD can be lowered in Sleep without losing RAM data) | §17.1, p.137 | electrical | todo |
| P5-024 | D003 VPOR VDD start voltage to ensure Power-on Reset: typ VSS V (see §14.4) | §17.1, p.137 | electrical | todo |
| P5-025 | D004 SVDD VDD rise rate to ensure Power-on Reset: min 0.05* V/ms (see §14.4) | §17.1, p.137 | electrical | todo |
| P5-026 | D005 VBOR Brown-out Reset voltage: min 3.65, typ 4.0, max 4.35 V, BOREN configuration bit set | §17.1, p.137 | electrical | todo |
| P5-027 | D005 VBOR Brown-out Reset voltage, Extended: min 3.65, typ 4.0, max 4.4 V, BOREN set | §17.1, p.137 | electrical | todo |
| P5-028 | §17.1 legend: Typ column at 5.0 V, 25°C unless otherwise stated; design guidance only, not tested; * = characterized but not tested; rows with standard-voltage-device data only are shaded | §17.1 legend, p.137 | note | info |
| P5-029 | VBOR typ 4.0 V (min 3.65) is above the PIC16LF minimum VDD 2.0 V and PIC16F minimum 3.0 V; BOR at 4.0 V means BOR enabled + VDD below ~4 V holds the part in reset regardless of variant | §17.1 D001 vs D005 | note | info |
| P5-030 | D001 (17.2, industrial) VDD: LF min 2.0, max 5.5 V; LF/F min 3.0, max 5.5 V | §17.2, p.138 | electrical | todo |
| P5-031 | D020 IPD power-down base current LF @ VDD 2.0 V: typ 0.01, max 0.80 μA (WDT, BOR, comparators, VREF and T1OSC disabled) | §17.2, p.138 | electrical | todo |
| P5-032 | D020 IPD LF/F @ VDD 3.0 V: typ 0.01, max 0.85 μA (all disabled) | §17.2, p.138 | electrical | todo |
| P5-033 | D020 IPD LF/F @ VDD 5.0 V: typ 0.02, max 2.7 μA (all disabled) | §17.2, p.138 | electrical | todo |
| P5-034 | D021 ΔIMOD WDT current LF @ 2.0 V: typ 1, max 2.0 μA | §17.2, p.138 | electrical | todo |
| P5-035 | D021 ΔIMOD WDT current LF/F @ 3.0 V: typ 2, max 3.4 μA | §17.2, p.138 | electrical | todo |
| P5-036 | D021 ΔIMOD WDT current LF/F @ 5.0 V: typ 9, max 17.0 μA | §17.2, p.138 | electrical | todo |
| P5-037 | D022 ΔIMOD BOR current LF/F @ 4.5 V: typ 29, max 52 μA | §17.2, p.138 | electrical | todo |
| P5-038 | D022 ΔIMOD BOR current LF/F @ 5.0 V: typ 30, max 55 μA | §17.2, p.138 | electrical | todo |
| P5-039 | D023 ΔIMOD comparator current (both comparators enabled) LF @ 2.0 V: typ 15, max 22 μA | §17.2, p.138 | electrical | todo |
| P5-040 | D023 ΔIMOD comparator current (both enabled) LF/F @ 3.0 V: typ 22, max 37 μA | §17.2, p.138 | electrical | todo |
| P5-041 | D023 ΔIMOD comparator current (both enabled) LF/F @ 5.0 V: typ 44, max 68 μA | §17.2, p.138 | electrical | todo |
| P5-042 | D024 ΔIMOD VREF current LF @ 2.0 V: typ 34, max 55 μA | §17.2, p.138 | electrical | todo |
| P5-043 | D024 ΔIMOD VREF current LF/F @ 3.0 V: typ 50, max 75 μA | §17.2, p.138 | electrical | todo |
| P5-044 | D024 ΔIMOD VREF current LF/F @ 5.0 V: typ 80, max 110 μA | §17.2, p.138 | electrical | todo |
| P5-045 | D025 ΔIMOD T1OSC current LF @ 2.0 V: typ 1.2, max 2.0 μA | §17.2, p.138 | electrical | todo |
| P5-046 | D025 ΔIMOD T1OSC current LF/F @ 3.0 V: typ 1.3, max 2.2 μA | §17.2, p.138 | electrical | todo |
| P5-047 | D025 ΔIMOD T1OSC current LF/F @ 5.0 V: typ 1.8, max 2.9 μA | §17.2, p.138 | electrical | todo |
| P5-048 | D010 IDD LP oscillator, FOSC = 32 kHz, LF @ 2.0 V: typ 10, max 15 μA | §17.2, p.138 | electrical | todo |
| P5-049 | D010 IDD LP, FOSC = 32 kHz, LF/F @ 3.0 V: typ 15, max 25 μA | §17.2, p.138 | electrical | todo |
| P5-050 | D010 IDD LP, FOSC = 32 kHz, LF/F @ 5.0 V: typ 28, max 48 μA | §17.2, p.138 | electrical | todo |
| P5-051 | D011 IDD XT, FOSC = 1 MHz, LF @ 2.0 V: typ 125, max 190 μA | §17.2, p.138 | electrical | todo |
| P5-052 | D011 IDD XT, FOSC = 1 MHz, LF/F @ 3.0 V: typ 175, max 340 μA | §17.2, p.138 | electrical | todo |
| P5-053 | D011 IDD XT, FOSC = 1 MHz, LF/F @ 5.0 V: typ 320, max 520 μA | §17.2, p.138 | electrical | todo |
| P5-054 | D012 IDD XT, FOSC = 4 MHz, LF @ 2.0 V: typ 250, max 350 μA | §17.2, p.138 | electrical | todo |
| P5-055 | D012 IDD XT, FOSC = 4 MHz, LF/F @ 3.0 V: typ 450, max 600 μA | §17.2, p.138 | electrical | todo |
| P5-056 | D012 IDD XT, FOSC = 4 MHz, LF/F @ 5.0 V: typ 710, max 995 μA | §17.2, p.138 | electrical | todo |
| P5-057 | D012A IDD INTOSC, FOSC = 4 MHz, LF @ 2.0 V: typ 395, max 465 μA | §17.2, p.138 | electrical | todo |
| P5-058 | D012A IDD INTOSC, FOSC = 4 MHz, LF/F @ 3.0 V: typ 565, max 785 μA | §17.2, p.138 | electrical | todo |
| P5-059 | D012A IDD INTOSC, FOSC = 4 MHz, LF/F @ 5.0 V: typ 0.895, max 1.3 mA | §17.2, p.138 | electrical | todo |
| P5-060 | D013 IDD HS, FOSC = 20 MHz, LF/F @ 4.5 V: typ 2.5, max 2.9 mA | §17.2, p.138 | electrical | todo |
| P5-061 | D013 IDD HS, FOSC = 20 MHz, LF/F @ 5.0 V: typ 2.75, max 3.3 mA | §17.2, p.138 | electrical | todo |
| P5-062 | §17.2/17.3 Note 1: "Δ" current is additional current consumed when the peripheral is enabled; add to base IDD or IPD; use Max values when calculating total current consumption | §17.2 Note 1, p.138; §17.3 Note 1, p.139 | note | info |
| P5-063 | §17.2/17.3 header puts the dagger on the Min column ("Min†") while the Typ-column legend is not repeated; treat Typ as design guidance as elsewhere in §17 | §17.2 p.138, §17.3 p.139 | note | info |
| P5-064 | No IDD row in 17.2/17.3 for INTOSC slow (48 kHz), EC, RC or 10 MHz HS; only Figures 18-16 (slow INTOSC) give guidance | §17.2/§17.3 | note | info |
| P5-065 | D001 (17.3, extended) VDD: min 3.0, max 5.5 V (F only; no LF extended part) | §17.3, p.139 | electrical | todo |
| P5-066 | D020E IPD extended @ 3.0 V: typ 0.01, max 4 μA (WDT, BOR, comparators, VREF, T1OSC disabled) | §17.3, p.139 | electrical | todo |
| P5-067 | D020E IPD extended @ 5.0 V: typ 0.02, max 8 μA | §17.3, p.139 | electrical | todo |
| P5-068 | D021E ΔIMOD WDT extended @ 3.0 V: typ 2, max 9 μA | §17.3, p.139 | electrical | todo |
| P5-069 | D021E ΔIMOD WDT extended @ 5.0 V: typ 9, max 20 μA | §17.3, p.139 | electrical | todo |
| P5-070 | D022E ΔIMOD BOR extended @ 4.5 V: typ 29, max 52 μA | §17.3, p.139 | electrical | todo |
| P5-071 | D022E ΔIMOD BOR extended @ 5.0 V: typ 30, max 55 μA | §17.3, p.139 | electrical | todo |
| P5-072 | D023E ΔIMOD comparator (both enabled) extended @ 3.0 V: typ 22, max 37 μA | §17.3, p.139 | electrical | todo |
| P5-073 | D023E ΔIMOD comparator (both enabled) extended @ 5.0 V: typ 44, max 68 μA | §17.3, p.139 | electrical | todo |
| P5-074 | D024E ΔIMOD VREF extended @ 3.0 V: typ 50, max 75 μA | §17.3, p.139 | electrical | todo |
| P5-075 | D024E ΔIMOD VREF extended @ 5.0 V: typ 83, max 110 μA | §17.3, p.139 | electrical | todo |
| P5-076 | D025E ΔIMOD T1OSC extended @ 3.0 V: typ 1.3, max 4 μA | §17.3, p.139 | electrical | todo |
| P5-077 | D025E ΔIMOD T1OSC extended @ 5.0 V: typ 1.8, max 6 μA | §17.3, p.139 | electrical | todo |
| P5-078 | D010E IDD LP, FOSC = 32 kHz, extended @ 3.0 V: typ 15, max 28 μA | §17.3, p.139 | electrical | todo |
| P5-079 | D010E IDD LP, FOSC = 32 kHz, extended @ 5.0 V: typ 28, max 54 μA | §17.3, p.139 | electrical | todo |
| P5-080 | D011E IDD XT, FOSC = 1 MHz, extended @ 3.0 V: typ 175, max 340 μA | §17.3, p.139 | electrical | todo |
| P5-081 | D011E IDD XT, FOSC = 1 MHz, extended @ 5.0 V: typ 320, max 520 μA | §17.3, p.139 | electrical | todo |
| P5-082 | D012E IDD XT, FOSC = 4 MHz, extended @ 3.0 V: typ 450, max 650 μA | §17.3, p.139 | electrical | todo |
| P5-083 | D012E IDD XT, FOSC = 4 MHz, extended @ 5.0 V: typ 0.710, max 1.1 mA | §17.3, p.139 | electrical | todo |
| P5-084 | D012AE IDD INTOSC, FOSC = 4 MHz, extended @ 3.0 V: typ 565, max 785 μA | §17.3, p.139 | electrical | todo |
| P5-085 | D012AE IDD INTOSC, FOSC = 4 MHz, extended @ 5.0 V: typ 0.895, max 1.3 mA | §17.3, p.139 | electrical | todo |
| P5-086 | D013E IDD HS, FOSC = 20 MHz, extended @ 4.5 V: typ 2.5, max 2.9 mA | §17.3, p.139 | electrical | todo |
| P5-087 | D013E IDD HS, FOSC = 20 MHz, extended @ 5.0 V: typ 2.75, max 3.5 mA | §17.3, p.139 | electrical | todo |
| P5-088 | Extended vs industrial differences: D024E typ 83 μA @5 V (industrial 80); D020E max 4/8 μA (ind 0.85/2.7); D021E max 9/20 μA (ind 3.4/17.0); D025E max 4/6 μA (ind 2.2/2.9); D010E max 28/54 μA (ind 25/48); D012E max 650 μA/1.1 mA (ind 600/995 μA); D013E max 3.5 mA @5 V (ind 3.3) — model must pick limits by temperature grade | §17.2 vs §17.3 | note | info |
| P5-089 | D030 VIL I/O ports with TTL buffer: min VSS, max 0.8 V, VDD = 4.5 V to 5.5 V | §17.4, p.140 | electrical | todo |
| P5-090 | D030 VIL I/O ports with TTL buffer: min VSS, max 0.15 VDD V, otherwise (VDD outside 4.5–5.5 V) | §17.4, p.140 | electrical | todo |
| P5-091 | D031 VIL I/O ports with Schmitt Trigger input(4): min VSS, max 0.2 VDD V | §17.4, p.140 | electrical | todo |
| P5-092 | D032 VIL MCLR, RA4/T0CKI, OSC1 (in RC mode): min VSS, max 0.2 VDD V (Note 1) | §17.4, p.140 | electrical | todo |
| P5-093 | D033 VIL OSC1 (in HS): min VSS, max 0.3 VDD V | §17.4, p.140 | electrical | todo |
| P5-094 | D033 VIL OSC1 (in LP and XT): min VSS, max 0.6 V | §17.4, p.140 | electrical | todo |
| P5-095 | D040 VIH I/O ports with TTL buffer: min 2.0 V, max VDD, VDD = 4.5 V to 5.5 V | §17.4, p.140 | electrical | todo |
| P5-096 | D040 VIH I/O ports with TTL buffer: min .25 VDD + 0.8 V, max VDD, otherwise | §17.4, p.140 | electrical | todo |
| P5-097 | D041 VIH I/O ports with Schmitt Trigger input(4): min 0.8 VDD, max VDD V | §17.4, p.140 | electrical | todo |
| P5-098 | D042 VIH MCLR, RA4/T0CKI: min 0.8 VDD, max VDD V | §17.4, p.140 | electrical | todo |
| P5-099 | D043 VIH OSC1 (XT and LP): min 1.3, max VDD V | §17.4, p.140 | electrical | todo |
| P5-100 | D043A VIH OSC1 (in RC mode): min 0.9 VDD, max VDD V (Note 1) | §17.4, p.140 | electrical | todo |
| P5-101 | D043B VIH OSC1 (in HS mode): min 0.7 VDD, max VDD V | §17.4, p.140 | electrical | todo |
| P5-102 | Region between VIL max and VIH min (e.g. TTL 0.8–2.0 V at 4.5–5.5 V; ST 0.2–0.8 VDD) is unspecified (no hysteresis values given) — model as indeterminate/hysteresis band | §17.4 D030–D043B | note | info |
| P5-103 | D070 IPURB PORTB weak pull-up current: min 50, typ 200, max 400 μA, VDD = 5.0 V, VPIN = VSS (only specified at 5.0 V) | §17.4, p.140 | electrical | todo |
| P5-104 | D060 IIL input leakage, I/O ports (except PORTA): max ±1.0 μA, VSS ≤ VPIN ≤ VDD, pin at high-impedance (Notes 2, 3) | §17.4, p.140 | electrical | todo |
| P5-105 | D060 IIL input leakage, PORTA(4): max ±0.5 μA, VSS ≤ VPIN ≤ VDD, pin at high-impedance | §17.4, p.140 | electrical | todo |
| P5-106 | D061 IIL RA4/T0CKI: max ±1.0 μA, VSS ≤ VPIN ≤ VDD | §17.4, p.140 | electrical | todo |
| P5-107 | D063 IIL OSC1, MCLR: max ±5.0 μA, VSS ≤ VPIN ≤ VDD, XT, HS and LP oscillator configuration | §17.4, p.140 | electrical | todo |
| P5-108 | Note 2: MCLR leakage is strongly dependent on applied voltage level; higher leakage may be measured at different input voltages (relevant when MCLR is driven to HV programming levels up to 14 V abs max) | §17.4 Note 2, p.140 | note | info |
| P5-109 | D080 VOL I/O ports(4): max 0.6 V, IOL = 8.5 mA, VDD = 4.5 V, -40° to +85°C | §17.4, p.140 | electrical | todo |
| P5-110 | D080 VOL I/O ports(4): max 0.6 V, IOL = 7.0 mA, VDD = 4.5 V, +85° to +125°C | §17.4, p.140 | electrical | todo |
| P5-111 | D090 VOH I/O ports (except RA4(4)): min VDD – 0.7 V, IOH = -3.0 mA, VDD = 4.5 V, -40° to +85°C | §17.4, p.140 | electrical | todo |
| P5-112 | D090 VOH I/O ports (except RA4): min VDD – 0.7 V, IOH = -2.5 mA, VDD = 4.5 V, +85° to +125°C | §17.4, p.140 | electrical | todo |
| P5-113 | VOL/VOH are specified only at VDD = 4.5 V; no low-VDD (2.0/3.0 V) drive spec in §17 — any LF low-voltage drive model is extrapolation (no Section 18 VOH/VOL graphs exist in this data sheet) | §17.4 D080/D090; §18 | note | info |
| P5-114 | D150 VOD open-drain high voltage: max 8.5* V, RA4 pin PIC16F627A/628A/648A, PIC16LF627A/628A/648A | §17.4, p.140 | electrical | todo |
| P5-115 | D150 VOD 8.5 V (RA4 open-drain operating max) vs absolute maximum 14 V on RA4: between 8.5 V and 14 V is outside operation but not damage-rated | §17.4 D150 vs §17.0 abs max | note | info |
| P5-116 | D100* COSC2 OSC2 pin capacitive loading: max 15 pF, in XT, HS and LP modes when external clock used to drive OSC1 | §17.4, p.140 | electrical | todo |
| P5-117 | D101* CIO all I/O pins/OSC2 (in RC mode) capacitive loading: max 50 pF | §17.4, p.140 | electrical | todo |
| P5-118 | §17.4 Note 1: in RC oscillator configuration OSC1 is a Schmitt Trigger input; not recommended to drive with external clock in RC mode | §17.4 Note 1, p.140 | note | info |
| P5-119 | §17.4 Note 3: negative current is defined as coming out of the pin | §17.4 Note 3, p.140 | note | info |
| P5-120 | §17.4 Note 4: "I/O ports"/PORTA rows include OSC1 and OSC2 when configured as I/O pins, CLKIN or CLKOUT | §17.4 Note 4, p.140 | note | info |
| P5-121 | §17.4 header (and Table 17-1 header) say "Operating voltage VDD range as described in DC specification Table 17-2 and Table 17-3", but Tables 17-2/17-3 are Comparator/VREF specs; the VDD range is in §17.2/§17.3 D001 | §17.4 p.140, Table 17-1 p.141 | note | info |
| P5-122 | D120 ED data EEPROM endurance: min 100K, typ 1M E/W, -40°C ≤ TA ≤ 85°C | Table 17-1, p.141 | electrical | todo |
| P5-123 | D120A ED data EEPROM endurance: min 10K, typ 100K E/W, 85°C ≤ TA ≤ 125°C | Table 17-1, p.141 | electrical | todo |
| P5-124 | D121 VDRW VDD for data EEPROM read/write: min VMIN, max 5.5 V (VMIN = minimum operating voltage) | Table 17-1, p.141 | electrical | todo |
| P5-125 | D122 TDEW data EEPROM erase/write cycle time: typ 4, max 8* ms | Table 17-1, p.141 | timing | todo |
| P5-126 | D123 TRETD data EEPROM characteristic retention: min 40 year, provided no other specifications are violated | Table 17-1, p.141 | electrical | todo |
| P5-127 | D124 TREF number of total erase/write cycles before refresh(1): min 1M, typ 10M E/W, -40°C to +85°C (Note 1: see §13.7 "Using the Data EEPROM") | Table 17-1, p.141 | electrical | todo |
| P5-128 | D130 EP program flash endurance: min 10K, typ 100K E/W, -40°C ≤ TA ≤ 85°C | Table 17-1, p.141 | electrical | todo |
| P5-129 | D130A EP program flash endurance: min 1000, typ 10K E/W, 85°C ≤ TA ≤ 125°C | Table 17-1, p.141 | electrical | todo |
| P5-130 | D131 VPR VDD for flash read: min VMIN, max 5.5 V | Table 17-1, p.141 | electrical | todo |
| P5-131 | D132 VIE VDD for flash block erase: min 4.5, max 5.5 V | Table 17-1, p.141 | electrical | todo |
| P5-132 | D132A VPEW VDD for flash write: min VMIN, max 5.5 V | Table 17-1, p.141 | electrical | todo |
| P5-133 | D133 TIE flash block erase cycle time: typ 4, max 8* ms, VDD > 4.5 V | Table 17-1, p.141 | timing | todo |
| P5-134 | D133A TPEW flash write cycle time: typ 2, max 4* ms | Table 17-1, p.141 | timing | todo |
| P5-135 | D134 TRETP flash characteristic retention: min 40 year, provided no other specifications are violated | Table 17-1, p.141 | electrical | todo |
| P5-136 | Endurance exhaustion is a wear-out failure mode: data EEPROM beyond D120/D120A and flash beyond D130/D130A cycles (temperature-dependent); flash block erase below 4.5 V (D132) is outside spec | Table 17-1 | failure-mode | todo |
| P5-137 | Table 17-1 conditions column says "-40°C ≤ TA ≤ 85°C"/"85°C ≤ TA ≤ 125°C" (overlapping at 85°C); D120A max column blank (other rows show "—") | Table 17-1, p.141 | note | info |
| P5-138 | Table 17-2 operating conditions: 2.0 V < VDD < 5.5 V, -40°C < TA < +125°C unless otherwise stated | Table 17-2, p.142 | note | info |
| P5-139 | D300 VIOFF comparator input offset voltage: typ ±5.0, max ±10 mV | Table 17-2, p.142 | electrical | todo |
| P5-140 | D301 VICM comparator input common mode voltage: min 0, max VDD – 1.5* V | Table 17-2, p.142 | electrical | todo |
| P5-141 | D302 CMRR comparator common mode rejection ratio: min 55* db | Table 17-2, p.142 | electrical | todo |
| P5-142 | D303 TRESP comparator response time(1): typ 300, max 400* ns, VDD = 3.0 V to 5.5 V, -40° to +85°C | Table 17-2, p.142 | timing | todo |
| P5-143 | D303 TRESP comparator response time: typ 400, max 600* ns, VDD = 3.0 V to 5.5 V, "-85° to +125°C" (as printed) | Table 17-2, p.142 | timing | todo |
| P5-144 | D303 TRESP comparator response time: typ 400, max 600* ns, VDD = 2.0 V to 3.0 V, -40° to +85°C | Table 17-2, p.142 | timing | todo |
| P5-145 | D303 Note 1: response time measured with one comparator input at (VDD – 1.5)/2 while the other input transitions from VSS to VDD | Table 17-2 Note 1, p.142 | note | info |
| P5-146 | D304 TMC2OV comparator mode change to output valid: typ 300, max 10* μs (as printed) | Table 17-2, p.142 | timing | todo |
| P5-147 | D304 contradiction: typ 300 is larger than max 10* in the same units (μs); typ is presumably in ns but the table does not say — treat max 10 μs as the binding limit | Table 17-2 D304, p.142 | note | **decide** |
| P5-148 | D303 condition "-85° to +125°C" is almost certainly a typo for +85° to +125°C (matches the VOL/VOH temperature split in §17.4) | Table 17-2 D303, p.142 | note | **decide** |
| P5-149 | Comparator inputs above VICM max (VDD – 1.5 V) are outside the specified common-mode range; behaviour not specified | Table 17-2 D301 | failure-mode | todo |
| P5-150 | Table 17-3 operating conditions: 2.0 V < VDD < 5.5 V, -40°C < TA < +125°C unless otherwise stated | Table 17-3, p.142 | note | info |
| P5-151 | D310 VRES VREF resolution: max VDD/24 LSb, low range (VRR = 1) | Table 17-3, p.142 | electrical | todo |
| P5-152 | D310 VRES VREF resolution: max VDD/32 LSb, high range (VRR = 0) | Table 17-3, p.142 | electrical | todo |
| P5-153 | D311 VRAA VREF absolute accuracy: max 1/4(2)* LSb, low range (VRR = 1) | Table 17-3, p.142 | electrical | todo |
| P5-154 | D311 VRAA VREF absolute accuracy: max 1/2(2)* LSb, high range (VRR = 0) | Table 17-3, p.142 | electrical | todo |
| P5-155 | D312 VRUR VREF unit resistor value (R): typ 2k* Ω | Table 17-3, p.142 | electrical | todo |
| P5-156 | D313 TSET VREF settling time(1): max 10* μs (Note 1: measured while VRR = 1 and VR<3:0> transitions from '0000' to '1111') | Table 17-3, p.142 | timing | todo |
| P5-157 | Table 17-3 Note 2: when VDD is between 2.0 V and 3.0 V, the VREF output voltage levels on RA2 described by [VDD/2 ± (3 – VDD)/2] may cause VRAA of the VREF output on RA2 to be greater than the stated max | Table 17-3 Note 2, p.142 | note | info |
| P5-158 | §17.5 timing symbology: TppS2ppS / TppS; F = frequency, T = time; pp: ck CLKOUT, io I/O port, mc MCLR, osc OSC1, t0 T0CKI; S: F fall, H high, I invalid (high-impedance), L low, P period, R rise, V valid, Z high-impedance | §17.5, p.143 | note | info |
| P5-159 | Figure 17-3 load condition 1: RL = 464 Ω to VDD/2, CL to VSS; load condition 2: CL to VSS; CL = 50 pF for all pins except OSC2, 15 pF for OSC2 output | §17.5 Figure 17-3, p.143 | electrical | todo |
| P5-160 | Table 17-4 FOSC external CLKIN frequency(1): min DC, max 4 MHz, XT and RC osc mode, VDD = 5.0 V | Table 17-4, p.144 | timing | todo |
| P5-161 | Table 17-4 FOSC external CLKIN frequency: min DC, max 20 MHz, HS, EC osc mode | Table 17-4, p.144 | timing | todo |
| P5-162 | Table 17-4 FOSC external CLKIN frequency: min DC, max 200 kHz, LP osc mode | Table 17-4, p.144 | timing | todo |
| P5-163 | Table 17-4 oscillator frequency(1): max 4 MHz, RC osc mode, VDD = 5.0 V | Table 17-4, p.144 | timing | todo |
| P5-164 | Table 17-4 oscillator frequency: min 0.1, max 4 MHz, XT osc mode | Table 17-4, p.144 | timing | todo |
| P5-165 | Table 17-4 oscillator frequency: min 1, max 20 MHz, HS osc mode | Table 17-4, p.144 | timing | todo |
| P5-166 | Table 17-4 oscillator frequency: max 200 kHz, LP osc mode | Table 17-4, p.144 | timing | todo |
| P5-167 | Table 17-4 oscillator frequency: typ 4 MHz, INTOSC mode (fast) | Table 17-4, p.144 | timing | todo |
| P5-168 | Table 17-4 oscillator frequency: typ 48 kHz, INTOSC mode (slow) | Table 17-4, p.144 | timing | todo |
| P5-169 | Param 1 TOSC external CLKIN period(1): min 250 ns, XT and RC osc mode | Table 17-4, p.144 | timing | todo |
| P5-170 | Param 1 TOSC external CLKIN period: min 50 ns, HS, EC osc mode | Table 17-4, p.144 | timing | todo |
| P5-171 | Param 1 TOSC external CLKIN period: min 5 μs, LP osc mode | Table 17-4, p.144 | timing | todo |
| P5-172 | Param 1 TOSC oscillator period(1): min 250 ns, RC osc mode | Table 17-4, p.144 | timing | todo |
| P5-173 | Param 1 TOSC oscillator period: min 250, max 10,000 ns, XT osc mode | Table 17-4, p.144 | timing | todo |
| P5-174 | Param 1 TOSC oscillator period: min 50, max 1,000 ns, HS osc mode | Table 17-4, p.144 | timing | todo |
| P5-175 | Param 1 TOSC oscillator period: min 5 μs, LP osc mode | Table 17-4, p.144 | timing | todo |
| P5-176 | Param 1 TOSC oscillator period: typ 250 ns, INTOSC mode (fast) | Table 17-4, p.144 | timing | todo |
| P5-177 | Param 1 TOSC oscillator period: typ 21 μs, INTOSC mode (slow) | Table 17-4, p.144 | timing | todo |
| P5-178 | Param 2 TCY instruction cycle time: min 200 ns, typ TCY, max DC; TCY = 4/FOSC | Table 17-4, p.144 | timing | todo |
| P5-179 | Param 3 TosL, TosH external CLKIN (OSC1) high / low: min 100* ns, XT oscillator, TOSC L/H duty cycle | Table 17-4, p.144 | timing | todo |
| P5-180 | Param 4 RC external biased RC frequency: min 10 kHz*, max 4 MHz, VDD = 5.0 V | Table 17-4, p.144 | timing | todo |
| P5-181 | Table 17-4 Note 1: TCY = 4 × oscillator period; values from characterization with device executing code; exceeding limits may give unstable oscillator operation and/or higher than expected current; all devices tested at "Min" values with external clock on OSC1; with external clock input the "Max" cycle time limit is "DC" (no clock) | Table 17-4 Note 1, p.144 | failure-mode | todo |
| P5-182 | Table 17-4 gives TosL/TosH only for XT; no high/low pulse-width minimum for HS/EC/LP external clocks | Table 17-4 Param 3 | note | info |
| P5-183 | F10 FIOSC internal oscillator center frequency: typ 4 MHz | Table 17-5, p.145 | timing | todo |
| P5-184 | F13 ΔIOSC oscillator accuracy: min 3.96, typ 4, max 4.04 MHz, VDD = 3.5 V, 25°C | Table 17-5, p.145 | timing | todo |
| P5-185 | F13 ΔIOSC oscillator accuracy: min 3.92, typ 4, max 4.08 MHz, 2.0 V ≤ VDD ≤ 5.5 V, 0°C ≤ TA ≤ +85°C | Table 17-5, p.145 | timing | todo |
| P5-186 | F13 ΔIOSC oscillator accuracy: min 3.80, typ 4, max 4.20 MHz, 2.0 V ≤ VDD ≤ 5.5 V, -40°C ≤ TA ≤ +85°C (IND), -40°C ≤ TA ≤ +125°C (EXT) | Table 17-5, p.145 | timing | todo |
| P5-187 | F14* TIOSCST oscillator wake-up from Sleep start-up time: typ 6, max 8 μs, VDD = 2.0 V, -40°C to +85°C | Table 17-5, p.145 | timing | todo |
| P5-188 | F14* TIOSCST wake-up from Sleep: typ 4, max 6 μs, VDD = 3.0 V, -40°C to +85°C | Table 17-5, p.145 | timing | todo |
| P5-189 | F14* TIOSCST wake-up from Sleep: typ 3, max 5 μs, VDD = 5.0 V, -40°C to +85°C | Table 17-5, p.145 | timing | todo |
| P5-190 | INTOSC wake-up inconsistency: Table 14-3 (time-out in various situations) gives a single 6 μs for INTOSC wake-up from Sleep; front-page feature list says "4 μs wake-up from Sleep, 3.0V, typical"; Table 17-5 F14 gives 6/4/3 μs typ (8/6/5 μs max) at 2.0/3.0/5.0 V. No F14 value for +85 to +125°C | Table 17-5 F14 vs Table 14-3 (line ~5600) vs p.1 features | note | **decide** |
| P5-191 | Table 17-5 has no accuracy spec for the slow (48 kHz) INTOSC mode; only Table 17-4 typ 48 kHz / 21 μs and Figure 18-15 (axis 30–60 kHz) | Table 17-5, Table 17-4, Fig 18-15 | note | info |
| P5-192 | Table 17-5 legend defines "TBD = To Be Determined" but no TBD entries appear | Table 17-5 legend, p.145 | note | info |
| P5-193 | Param 10 TOSH2CKL OSC1↑ to CLKOUT↓ PIC16F62XA: typ 75, max 200* ns | Table 17-6, p.146 | timing | todo |
| P5-194 | Param 10A TOSH2CKL OSC1↑ to CLKOUT↓ PIC16LF62XA: max 400* ns | Table 17-6, p.146 | timing | todo |
| P5-195 | Param 11 TOSH2CKH OSC1↑ to CLKOUT↑ PIC16F62XA: typ 75, max 200* ns | Table 17-6, p.146 | timing | todo |
| P5-196 | Param 11A TOSH2CKH OSC1↑ to CLKOUT↑ PIC16LF62XA: max 400* ns | Table 17-6, p.146 | timing | todo |
| P5-197 | Param 12 TCKR CLKOUT rise time PIC16F62XA: typ 35, max 100* ns | Table 17-6, p.146 | timing | todo |
| P5-198 | Param 12A TCKR CLKOUT rise time PIC16LF62XA: max 200* ns | Table 17-6, p.146 | timing | todo |
| P5-199 | Param 13 TCKF CLKOUT fall time PIC16F62XA: typ 35, max 100* ns | Table 17-6, p.146 | timing | todo |
| P5-200 | Param 13A TCKF CLKOUT fall time PIC16LF62XA: max 200* ns | Table 17-6, p.146 | timing | todo |
| P5-201 | Param 14 TCKL2IOV CLKOUT↓ to port out valid: max 20* ns | Table 17-6, p.146 | timing | todo |
| P5-202 | Param 15 TIOV2CKH port in valid before CLKOUT↑ PIC16F62XA: min TOSC+200 ns* | Table 17-6, p.146 | timing | todo |
| P5-203 | Param 15 TIOV2CKH port in valid before CLKOUT↑ PIC16LF62XA: min TOSC+400 ns* | Table 17-6, p.146 | timing | todo |
| P5-204 | Param 16 TCKH2IOI port in hold after CLKOUT↑: min 0 ns | Table 17-6, p.146 | timing | todo |
| P5-205 | Param 17 TOSH2IOV OSC1↑ (Q1 cycle) to port out valid PIC16F62XA: typ 50, max 150* ns | Table 17-6, p.146 | timing | todo |
| P5-206 | Param 17 TOSH2IOV OSC1↑ (Q1 cycle) to port out valid PIC16LF62XA: max 300* ns | Table 17-6, p.146 | timing | todo |
| P5-207 | Param 18 TOSH2IOI OSC1↑ (Q2 cycle) to port input invalid (I/O in hold time): min 100* ns and 200* ns (two values, device not labelled; by pattern presumably F / LF) | Table 17-6, p.146 | timing | todo |
| P5-208 | Figure 17-5 labels parameters 19, 20, 21, 22, 23 (input setup, port output rise/fall, etc.) but Table 17-6 lists only 10–18; no values for 19–23 in this data sheet | Figure 17-5 vs Table 17-6, p.145–146 | note | info |
| P5-209 | Table 17-6 conditions: no VDD stated; Typ at 5.0 V 25°C; F vs LF rows distinguish limits (LF roughly 2× slower) | Table 17-6, p.146 | note | info |
| P5-210 | Param 30 TMCL MCLR pulse width (low): min 2000 ns, VDD = 5 V, -40°C to +85°C | Table 17-7, p.147 | timing | todo |
| P5-211 | Param 31 TWDT watchdog timer time-out period (no prescaler): min 7*, typ 18, max 33* ms, VDD = 5 V, -40°C to +85°C | Table 17-7, p.147 | timing | todo |
| P5-212 | Param 32 TOST oscillation start-up timer period: typ 1024 TOSC (TOSC = OSC1 period) | Table 17-7, p.147 | timing | todo |
| P5-213 | Param 33 TPWRT power-up timer period: min 28*, typ 72, max 132* ms, VDD = 5 V, -40°C to +85°C | Table 17-7, p.147 | timing | todo |
| P5-214 | Param 34 TIOZ I/O high-impedance from MCLR low or watchdog timer reset: max 2.0* μs | Table 17-7, p.147 | timing | todo |
| P5-215 | Param 35 TBOR Brown-out Reset pulse width: min 100* μs, VDD ≤ VBOR (D005); shorter dips not assured to reset (§14.4) | Table 17-7, p.147 | timing | todo |
| P5-216 | Table 17-7 TMCL/TWDT/TPWRT given only at VDD = 5 V, -40..+85°C; no low-VDD or extended-temperature limits (Figure 18-20 shows WDT period vs VDD 2–5.5 V and -40..125°C, axis 0–50 ms) | Table 17-7, Fig 18-20 | note | info |
| P5-217 | §14.4 text says "VBOR and TBOR are defined in Table 17-2 and Table 17-7"; VBOR is actually D005 in §17.1 (Table 17-2 is comparator specs) | §14.4 (line ~5505) vs §17.1 | note | info |
| P5-218 | Figure 17-6 sequence: VDD, MCLR, internal POR, PWRT time-out (33), OST time-out (32), internal reset, WDT reset; params 30 (MCLR low), 31 (WDT), 34 (I/O hi-Z) placement | Figure 17-6, p.146 | note | info |
| P5-219 | Figure 17-7 brown-out reset timing: VDD below VBOR for param 35 | Figure 17-7, p.147 | note | info |
| P5-220 | Param 40 TT0H T0CKI high pulse width, no prescaler: min 0.5TCY + 20* ns | Table 17-8, p.148 | timing | todo |
| P5-221 | Param 40 TT0H T0CKI high pulse width, with prescaler: min 10* ns | Table 17-8, p.148 | timing | todo |
| P5-222 | Param 41 TT0L T0CKI low pulse width, no prescaler: min 0.5TCY + 20* ns | Table 17-8, p.148 | timing | todo |
| P5-223 | Param 41 TT0L T0CKI low pulse width, with prescaler: min 10* ns | Table 17-8, p.148 | timing | todo |
| P5-224 | Param 42 TT0P T0CKI period: min greater of 20 or (TCY + 40)/N * ns, N = prescale value (2, 4, ..., 256) | Table 17-8, p.148 | timing | todo |
| P5-225 | Param 45 TT1H T1CKI high time, synchronous, no prescaler: min 0.5TCY + 20* ns | Table 17-8, p.148 | timing | todo |
| P5-226 | Param 45 TT1H T1CKI high time, synchronous with prescaler, PIC16F62XA: min 15* ns | Table 17-8, p.148 | timing | todo |
| P5-227 | Param 45 TT1H T1CKI high time, synchronous with prescaler, PIC16LF62XA: min 25* ns | Table 17-8, p.148 | timing | todo |
| P5-228 | Param 45 TT1H T1CKI high time, asynchronous, PIC16F62XA: min 30* ns | Table 17-8, p.148 | timing | todo |
| P5-229 | Param 45 TT1H T1CKI high time, asynchronous, PIC16LF62XA: min 50* ns | Table 17-8, p.148 | timing | todo |
| P5-230 | Param 46 TT1L T1CKI low time, synchronous, no prescaler: min 0.5TCY + 20* ns | Table 17-8, p.148 | timing | todo |
| P5-231 | Param 46 TT1L T1CKI low time, synchronous with prescaler, PIC16F62XA: min 15* ns | Table 17-8, p.148 | timing | todo |
| P5-232 | Param 46 TT1L T1CKI low time, synchronous with prescaler, PIC16LF62XA: min 25* ns | Table 17-8, p.148 | timing | todo |
| P5-233 | Param 46 TT1L T1CKI low time, asynchronous, PIC16F62XA: min 30* ns | Table 17-8, p.148 | timing | todo |
| P5-234 | Param 46 TT1L T1CKI low time, asynchronous, PIC16LF62XA: min 50* ns | Table 17-8, p.148 | timing | todo |
| P5-235 | Param 47 TT1P T1CKI input period, synchronous, PIC16F62XA: min greater of 20 or (TCY + 40)/N * ns, N = prescale value (1, 2, 4, 8) | Table 17-8, p.148 | timing | todo |
| P5-236 | Param 47 TT1P T1CKI input period, synchronous, PIC16LF62XA: min greater of 20 or (TCY + 40)/N * (units column "—") | Table 17-8, p.148 | timing | todo |
| P5-237 | Param 47 TT1P T1CKI input period, asynchronous, PIC16F62XA: min 60* ns | Table 17-8, p.148 | timing | todo |
| P5-238 | Param 47 TT1P T1CKI input period, asynchronous, PIC16LF62XA: min 100* ns | Table 17-8, p.148 | timing | todo |
| P5-239 | FT1 Timer1 oscillator input frequency range (T1OSCEN set): typ 32.7(1) kHz (Note 1: intended to work only with 32.768 kHz watch crystals and their tolerances; higher frequencies may not be compatible with this crystal driver) | Table 17-8, p.148 | timing | todo |
| P5-240 | Param 48 TCKEZTMR1 delay from external clock edge to timer increment: min 2TOSC, max 7TOSC | Table 17-8, p.148 | timing | todo |
| P5-241 | Table 17-8 F vs LF: synchronous no-prescaler limits identical; with-prescaler and asynchronous limits differ (F 15/30/60 ns vs LF 25/50/100 ns); Typ at 5 V 25°C | Table 17-8 | note | info |
| P5-242 | Figure 17-8: Timer0 external clock on RA4/T0CKI/CMP2 (params 40, 41, 42); Timer1 external clock on RB6/T1OSO/T1CKI/PGC (params 45, 46, 47, 48) | Figure 17-8, p.147 | note | info |
| P5-243 | Param 50 TCCL CCP input low time, no prescaler: min 0.5TCY + 20* ns | Table 17-9, p.149 | timing | todo |
| P5-244 | Param 50 TCCL CCP input low time, with prescaler, PIC16F62XA: min 10* ns | Table 17-9, p.149 | timing | todo |
| P5-245 | Param 50 TCCL CCP input low time, with prescaler, PIC16LF62XA: min 20* ns | Table 17-9, p.149 | timing | todo |
| P5-246 | Param 51 TCCH CCP input high time, no prescaler: min 0.5TCY + 20* ns | Table 17-9, p.149 | timing | todo |
| P5-247 | Param 51 TCCH CCP input high time, with prescaler, PIC16F62XA: min 10* ns | Table 17-9, p.149 | timing | todo |
| P5-248 | Param 51 TCCH CCP input high time, with prescaler, PIC16LF62XA: min 20* ns | Table 17-9, p.149 | timing | todo |
| P5-249 | Param 52 TCCP CCP input period: min (3TCY + 40)/N * ns, N = prescale value (1, 4 or 16) | Table 17-9, p.149 | timing | todo |
| P5-250 | Param 53 TCCR CCP output rise time PIC16F62XA: typ 10, max 25* ns | Table 17-9, p.149 | timing | todo |
| P5-251 | Param 53 TCCR CCP output rise time PIC16LF62XA: typ 25, max 45* ns | Table 17-9, p.149 | timing | todo |
| P5-252 | Param 54 TCCF CCP output fall time PIC16F62XA: typ 10, max 25* ns | Table 17-9, p.149 | timing | todo |
| P5-253 | Param 54 TCCF CCP output fall time PIC16LF62XA: typ 25, max 45* ns | Table 17-9, p.149 | timing | todo |
| P5-254 | Figure 17-9: CCP pin is RB3/CCP1; capture mode params 50/51/52; compare or PWM mode params 53/54 | Figure 17-9, p.149 | note | info |
| P5-255 | §17 contains no USART synchronous master/slave timing table (no TCKH2DTV/TDTV2CKL-style parameters) and no SSP/I²C table; USART sync timing must come from §12 text or is unspecified | §17.6 (Tables 17-4..17-9) | note | info |
| P5-256 | §18 intro: graphs/tables are design guidance only, not tested; some data outside specified VDD range (information only); "Typical" = mean at 25°C; "Max"/"Min" = mean ± 3σ over the whole temperature range | §18.0, p.151 | note | info |
| P5-257 | Figure 18-1 typical baseline IPD vs VDD (-40°C to 25°C): y IPD 0–160 nA, x VDD 2.0–5.5 V; curves -40°C, 0°C, +25°C (exact values not readable from text) | §18 Figure 18-1, p.151 | electrical | todo |
| P5-258 | Figure 18-2 typical baseline IPD vs VDD (85°C): y IPD 100–300 nA, x VDD 2.0–5.5 V; curve +85°C | §18 Figure 18-2, p.152 | electrical | todo |
| P5-259 | Figure 18-3 typical baseline current IPD vs VDD (125°C): y IPD 1.0–2.4 μA, x VDD 2.0–5.5 V; curve +125°C (125°C baseline IPD is in μA range vs nA at ≤85°C) | §18 Figure 18-3, p.152 | electrical | todo |
| P5-260 | Figure 18-4 typical BOR IPD vs VDD: y IPD 20–40 μA, x VDD 4.5–5.5 V; curves 125°C, 85°C, 25°C, 0°C, -40°C (legend order top to bottom) | §18 Figure 18-4, p.153 | electrical | todo |
| P5-261 | Figure 18-5 typical single comparator IPD vs VDD: y IPD 0–30 μA, x VDD 2–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-5, p.153 | electrical | todo |
| P5-262 | Figure 18-6 typical VREF IPD vs VDD: y IPD 20–100 μA, x VDD 2.0–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-6, p.154 | electrical | todo |
| P5-263 | Figure 18-7 typical WDT IPD vs VDD: y IPD 0–16 μA, x VDD 2.0–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-7, p.154 | electrical | todo |
| P5-264 | Figure 18-8 average IPD_TIMER1: y IPD 0–5 μA, x VDD 2–5.5 V; curves -40C, 0C, 25C, 85C, 125 (legend order) | §18 Figure 18-8, p.155 | electrical | todo |
| P5-265 | Figure 18-9 typical internal oscillator frequency vs temperature, VDD = 5 V: y change from calibration target -5.0% to +5.0%, x temperature -40/25/85/125°C | §18 Figure 18-9, p.155 | timing | todo |
| P5-266 | Figure 18-10 typical internal oscillator frequency vs temperature, VDD = 3 V: y -5.0% to +5.0%, x -40/25/85/125°C | §18 Figure 18-10, p.156 | timing | todo |
| P5-267 | Figure 18-11 typical internal oscillator frequency vs temperature, VDD = 2 V: y -5.0% to +5.0%, x -40/25/85/125°C | §18 Figure 18-11, p.156 | timing | todo |
| P5-268 | Figure 18-12 typical internal oscillator deviation vs VDD at 25°C, 4 MHz mode: y -5.0% to +5.0%, x VDD 2–5.5 V | §18 Figure 18-12, p.157 | timing | todo |
| P5-269 | Figure 18-13 typical internal oscillator frequency vs VDD, temperature -40°C to 85°C: y -5.0% to +5.0%, x VDD 2–5.5 V | §18 Figure 18-13, p.157 | timing | todo |
| P5-270 | Figure 18-14 internal oscillator IDD vs VDD, 4 MHz mode: y IDD 0.00–1.40 mA, x VDD 2–5.5 V; curves 85 C, 25 C Avg, -40 C | §18 Figure 18-14, p.158 | electrical | todo |
| P5-271 | Figure 18-15 typical internal oscillator frequency vs VDD at 25°C, slow mode: y oscillator frequency 30–60 kHz, x VDD 2–5.5 V (slow INTOSC frequency is VDD-dependent; nominal 48 kHz per Table 17-4) | §18 Figure 18-15, p.158 | timing | todo |
| P5-272 | Figure 18-16 internal oscillator IDD vs VDD, slow mode: y axis labelled "IPD (μA)" 0–180, x VDD 2–5.5 V; curves 85 C, 25 C Avg, -40 C | §18 Figure 18-16, p.159 | electrical | todo |
| P5-273 | Figure 18-17 supply current IDD vs VDD, FOSC = 1 MHz (XT): y axis labelled "IPD (μA)" 100–500, x VDD 2.0–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-17, p.159 | electrical | todo |
| P5-274 | Figure 18-18 supply current IDD vs VDD, FOSC = 4 MHz (XT): y axis labelled "IPD (μA)" 200–1000, x VDD 2.0–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-18, p.160 | electrical | todo |
| P5-275 | Figure 18-19 supply current IDD vs VDD, FOSC = 20 MHz (HS): y IDD 2.0–4.0 mA, x VDD 4.5–5.5 V; curves 125/85/25/0/-40°C | §18 Figure 18-19, p.160 | electrical | todo |
| P5-276 | Figure 18-20 typical WDT period vs VDD (-40°C to +125°C), "WDT Time-out": y time 0–50 ms, x VDD 2–5.5 V; curves -40, 0, 25, 85, 125 (legend order) | §18 Figure 18-20, p.161 | timing | todo |
| P5-277 | Figures 18-16/18-17/18-18 titles say IDD/supply current but the y axis is labelled "IPD (μA)" — treat as IDD; Figure 18-8 legend "125" lacks °C | §18 Figs 18-8, 18-16..18-18 | note | info |
| P5-278 | §18 contains no VOH/VOL vs IOH/IOL, no VIL/VIH vs VDD, no pull-up vs VDD and no BOR threshold vs temperature graphs; the electrical pin model has only the §17.4 single-point specs | §18 (Figures 18-1..18-20) | note | info |
| P5-279 | Curve values in all §18 figures are not extractable from the text; only axis ranges and legends are known — read the PDF graphics if typical curves are needed | §18 | note | info |

## Cross-references
- §14.4 (POR/PWRT/OST/BOR) — D003 VPOR, D004 SVDD, D005 VBOR, Table 17-7 params 32/33/35; §14.4 text points to "Table 17-2" for VBOR (wrong table, see note rows).
- Table 14-3 (time-out in various situations) — INTOSC wake-up 6 µs vs Table 17-5 F14 (6/4/3 µs typ by VDD); front-page features "4 µs wake-up from Sleep, 3.0V, typical".
- §14.7.1 WDT period (nominal 18 ms) — Table 17-7 param 31, Figure 18-20.
- §14.2 / §14.2.8 INTOSC dual-speed (4 MHz / 48 kHz) — Table 17-4, Table 17-5, Figures 18-9..18-16.
- §6 Timer0 / §7 Timer1 prescaler and sync text references Table 17-8.
- §9 CCP — Table 17-9 (pin RB3/CCP1).
- §10 Comparator (response time, common mode) — Table 17-2; §11 Voltage Reference (unit resistor R, ranges) — Table 17-3.
- §13 / §13.7 Data EEPROM — Table 17-1 D120–D124.
- §5 I/O ports (RA4 open-drain ST input, PORTB TTL/ST buffers, RB weak pull-ups) — §17.4 D030–D150 buffer-type thresholds.
- §12 USART — no synchronous-mode timing table exists in §17.

## DS40300C: original PIC16F627/628 differences; errata DS80151B

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P6-001 | **Family members.** The original family is only PIC16F627, PIC16F628, PIC16LF627 and PIC16LF628. Their memory matches 627A/628A: 1024 x 14 or 2048 x 14 flash, 224 x 8 RAM and 128 x 8 EEPROM. The original family has no 648-class part. A: it adds PIC16F648A, with 4096 x 14 flash, 256 x 8 RAM, 256 x 8 EEPROM, extra bank-2 RAM and an 8-bit EEADR. A non-A profile must not expose any of the 648A memory. | p.1 memory table; §2 Table 2-1, p.7; Table 4-1, p.27 | memory | todo |
| P6-002 | **Configuration word layout (2007h).** bit13 CP1, bit12 CP0, bit11 CP1, bit10 CP0, bit9 unimplemented (reads '0'), bit8 CPD, bit7 LVP, bit6 BODEN, bit5 MCLRE, bit4 FOSC2, bit3 PWRTE, bit2 WDTE, bit1-0 FOSC1:FOSC0. A: bit13 is a single CP, bits 12-9 are unimplemented, and bit6 is named BOREN. Every other position is the same. | §14.1, Register 14-1, p.92 | register | todo |
| P6-003 | **Code-protect pairs (CP1:CP0, given twice).** For 2K program memory: 11 = off, 10 = 0400h-07FFh protected, 01 = 0200h-07FFh protected, 00 = 0000h-07FFh protected. For 1K program memory: 11 = off, 10 = off, 01 = 0200h-03FFh protected, 00 = 0000h-03FFh protected. Note 2: "All of the CP1:CP0 pairs have to be given the same value to enable the code protection scheme listed." The sheet does not say what happens when the two pairs differ. A: one CP bit protects the whole memory, and protected locations read out as '0'. DS40300C does not give the value a programmer reads back from a protected region. | Register 14-1 bits 13-10 and Note 2, p.92 | register | todo |
| P6-004 | **Turning code protection off.** "The entire data EEPROM and FLASH program memory will be erased when the code protection is turned off. The INTRC calibration data is not erased." Config Note 3 says the same for CPD and the data EEPROM. When protected, "the CPU may continue to read and write the data EEPROM memory. The device programmer can no longer access this memory", and the CPU reads and writes "unscrambled data". A: only a Bulk Erase can set CP/CPD. That rule is in the A errata as well (see E-003). | §14.10 Note, p.105; Register 14-1 Note 3, p.92; §13.0, §13.7, p.87/89 | memory | todo |
| P6-005 | **BODEN forces PWRT on.** Note 1: "Enabling Brown-out Detect Reset automatically enables Power-up Timer (PWRT) regardless of the value of bit PWRTE." In Table 14-4 the Brown-out Detect Reset column has no PWRTE split: XT, HS, LP give "72 ms + 1024 TOSC" and ER, INTRC, EC give "72 ms". §14.5.4: once VDD rises above VBOD, "the Power-up Timer will now be invoked and will keep the chip in RESET an additional 72 ms". §14.0: brown-out circuitry "provides at least a 72 ms RESET". A: BOREN does not enable PWRT (DS40044G Register 14-1 Note 1, Appendix C item 4). With PWRTE = 1 the A part gives 1024 TOSC (XT, HS, LP) and "—" (RC, EC, INTOSC) after a BOR. | Register 14-1 Note 1, p.92; Table 14-4, p.97; §14.5.4, p.96; §14.0, p.91 | behaviour | todo |
| P6-006 | **FOSC2:FOSC0 decode.** 111 = ER, CLKOUT on RA6, resistor on RA7/OSC1/CLKIN. 110 = ER, I/O on RA6, resistor on RA7. 101 = INTRC, CLKOUT on RA6, I/O on RA7. 100 = INTRC, I/O on RA6 and RA7. 011 = EC (RA6 I/O). 010 = HS. 001 = XT. 000 = LP. A: 111/110 are RC modes with REXT and CEXT on RA7, and 101/100 are named INTOSC. In ER modes RA7 is the bias pin and cannot be I/O (Fig. 5-7 shows RA7 as I/O only for FOSC = 100 and 101). | Register 14-1 bits 4,1-0, p.92; Fig. 5-6/5-7, p.31-32 | register | todo |
| P6-007 | **ER oscillator (replaced by RC on the A part).** It uses "only one external component, a resistor to VSS". The resistor's DC bias current sets the frequency, and package or lead frame has no significant effect. REXT below 10k makes the frequency sensitive to temperature. Very high REXT (e.g. 1M) makes it sensitive to leakage, and the oscillator "may stop completely". The recommended range is 10k to 1M. Table 14-3 (resistance, frequency): 0 = 10.4 MHz, 1K = 10 MHz, 10K = 7.4 MHz, 20K = 5.3 MHz, 47K = 3 MHz, 100K = 1.6 MHz, 220K = 800 kHz, 470K = 300 kHz, 1M = 200 kHz. Fig. 18-7 plots typical FOSC against VDD (2.0-5.0 V) for R = 50k, 100k, 200k, 500k and 1M, on a 0-3.50 MHz axis. A: an RC network with REXT to VDD and CEXT to VSS. The A part recommends 3 kΩ ≤ REXT ≤ 100 kΩ (VDD ≥ 3.0 V), 10-100 kΩ (VDD < 3.0 V) and CEXT > 20 pF. | §14.2.5, Fig. 14-5, Table 14-3, p.94; Fig. 18-7, p.146 | behaviour | todo |
| P6-008 | **ER electrical limits.** Table 17-4: ER external biased frequency is 10 kHz min to 8 MHz max at VDD = 5.0 V. "Oscillator Frequency ER Osc mode" is max 4 MHz at VDD = 5.0 V, and external CLKIN in XT and ER modes is DC-4 MHz. IDD Note 5: current through REXT is not included in IDD and "can be estimated by the formula Ir = VDD/2REXT (mA) with REXT in kΩ". In ER mode OSC1 is a Schmitt-trigger input with VIL max 0.2 VDD (D032) and VIH min 0.9 VDD (D043A). Driving it with an external clock in ER mode "is not recommended". A: RC external biased frequency is 10 kHz to 4 MHz. | Table 17-4 params 1, 5, p.136; §17.1 Note 5, p.130; D032/D043A and Note 1, p.132 | electrical | todo |
| P6-009 | **Dual-speed oscillator works in both ER and INTRC modes.** It switches between 4 MHz and 37 kHz under PCON.OSCF. In ER mode "the 4 MHz setting will vary depending on the value of the external resistor", and "the 37 kHz operation is fixed and does not vary with resistor value". PCON Note 1: "When in ER Oscillator mode, setting OSCF = 1 will cause the oscillator frequency to change to the frequency specified by the external resistor." OSCF resets to 1. A: dual speed works only in INTOSC mode, at 4 MHz and 48 kHz (DS40044G §14.2.8, Appendix C item 7). | §14.3, p.95; Register 3-6 bit 3 and Note 1, p.24 | behaviour | todo |
| P6-010 | **Slow internal oscillator is 37 kHz.** OSCF = 0 gives "37 KHz typical". Table 17-4 gives "37 kHz INTRC mode (slow)" with TOSC = "27 µs INTRC mode (slow)" and no min/max. Fig. 18-9 shows the 37 kHz oscillator against VDD from 2.0 to 5.5 V for -40, 25, 85 and 125 °C, on a 0-60 kHz axis. A: 48 kHz typical, TOSC 21 µs. | Register 3-6, p.24; Table 17-4, p.136; Fig. 18-9, p.147 | timing | todo |
| P6-011 | **Fast internal oscillator accuracy.** Table 17-4 gives "3.65 / 4 / 4.28 MHz INTRC mode (fast), VDD = 5.0V" and param 4 "INTRC Internal Calibrated RC 3.65 / 4.00 / 4.28 MHz, VDD = 5.0V". §14.2.6: 4 MHz nominal at VDD = 5 V and 25 °C. Fig. 18-8 shows typical 4 MHz FOSC against VDD (2.0-5.5 V) over -40 to 125 °C, on a 3.5-4.1 MHz axis. A: factory-calibrated "±1%". F13 gives 3.96-4.04 MHz (3.5 V, 25 °C), 3.92-4.08 MHz (2.0-5.5 V, 0-85 °C) and 3.80-4.20 MHz (-40 to +85 °C IND, -40 to +125 °C EXT). | Table 17-4 params 1/4, p.136; §14.2.6, p.95; Fig. 18-8, p.147 | electrical | todo |
| P6-012 | **Speed-switch transition.** DS40300C says nothing about a delay when OSCF toggles. A: the transition takes "two existing clock pulses and eight new speed clock pulses", and the system clock, PC and CLKOUT halt during it. Whether the original part halts is not documented. | §14.3, p.95 (absence) | note | **decide** |
| P6-013 | **Wake-up from SLEEP in the internal and ER oscillator modes.** Table 14-4 gives "—" (no delay) for ER, INTRC and EC wake-up. Fig. 14-17 Note 2: "Approximately 1 µs delay will be there for ER Osc mode." A: INTOSC wake-up is 6 µs (Table 14-3). F14 TIOSCST is 6/8 µs at 2.0 V, 4/6 µs at 3.0 V and 3/5 µs at 5.0 V. | Table 14-4, p.97; Fig. 14-17 Note 2, p.105 | timing | todo |
| P6-014 | **MCLR stops the internal or ER oscillator.** Config Note 4: "When MCLR is asserted in INTRC or ER mode, the internal clock oscillator is disabled." A: INTOSC mode only. | Register 14-1 Note 4, p.92 | behaviour | todo |
| P6-015 | **CLKOUT drive in ER mode.** D083 OSC2/CLKOUT (ER only): VOL max 0.6 V at IOL = 1.6 mA (VDD = 4.5 V, -40 to +85 °C) and at IOL = 1.2 mA (+125 °C). D092: VOH min VDD - 0.7 V at IOH = -1.3 mA (-40 to +85 °C) and at IOH = -1.0 mA (+125 °C). Fig. 14-15 Note 3: "CLKOUT is available in ER and INTRC Oscillator mode." A: has no separate CLKOUT rows. Its Note 4 folds OSC1/OSC2 used as CLKIN/CLKOUT into the normal I/O VOL/VOH (8.5 mA / -3.0 mA). | §17.2 D083/D092, p.132; Fig. 14-15 Note 3, p.102 | electrical | todo |
| P6-016 | **OSC1 thresholds in the crystal modes.** D033 VIL max: OSC1 (XT and HS) 0.3 VDD, OSC1 (LP) 0.6 VDD - 1.0 V. D043 VIH min: OSC1 (XT, HS and LP) 0.7 VDD. A: VIL max is 0.3 VDD for HS and 0.6 V for LP and XT. VIH min is 1.3 V for XT and LP and 0.7 VDD for HS. | §17.2 D033/D043, p.132 | electrical | todo |
| P6-017 | **Timer1 oscillator is rated up to 200 kHz.** "Low power oscillator rated up to 200 kHz ... primarily intended for a 32 kHz crystal", and "the Timer1 oscillator is identical to the LP oscillator". Table 7-1 (LP): 32 kHz 33 pF/33 pF, 100 kHz 15 pF/15 pF, 200 kHz 15 pF/15 pF. Table 17-7 Ft1 is DC-200 kHz. A: designed only for 32.768 kHz; Table 7-1 gives 15 pF/15 pF; Ft1 is 32.7 kHz typ, and "higher value crystal frequencies may not be compatible". On the original, a 100-200 kHz T1 crystal is legal and must run. | §7.4, Table 7-1, p.49; Table 17-7 Ft1, p.140 | behaviour | todo |
| P6-018 | **LP crystal capacitor guidance.** Table 14-2, LP: 32 kHz 68-100 pF on both pins, 200 kHz 15-30 pF on both pins. A: LP 32 kHz 15-30 pF, 200 kHz 0-15 pF. XT, HS and the resonator Table 14-1 are the same. This only matters if oscillator start-up is modelled against load capacitance. | Table 14-2, p.93 | electrical | todo |
| P6-019 | **Comparator mode CM2:CM0 = 001 is defective.** In Fig. 9-1, the panel "Three Inputs Multiplexed to Two Comparators, CM2:CM0 = 001" carries the note: "This mode is disfunctional and has been corrected in the 'A' Revision Devices." The sheet gives no description of the faulty behaviour. Two consequences for the emulator. Selecting 001 on a non-A part must raise a "not modelled / known-defective silicon" warning; it must not silently behave like the A part. The CIS description for CM = 001 (Register 9-1) is otherwise identical on both parts. | Fig. 9-1, p.54; Register 9-1 bit 3, p.53 | failure-mode | todo |
| P6-020 | **Comparator AC/DC limits.** Table 17-1 applies for 3.0 V < VDD < 5.5 V. Param 300 TRESP is 150 ns typ and 400 ns max for 16F62X; param 300A is 600 ns for 16LF62X. Param 301 (mode change to output valid) is 10 µs max. D300, D301 and D302 match the A part. A: the table applies from 2.0 V. TRESP is 300 ns typ and 400 ns max (3.0-5.5 V, -40 to +85 °C), or 400 ns typ and 600 ns max (85-125 °C, or 2.0-3.0 V). | Table 17-1, p.133 | timing | todo |
| P6-021 | **Comparator supply current.** ΔICOMP is 30 µA typ and 50 µA max "for each comparator" at VDD = 3.0 V, and the same at VDD = 4.0 V. A (D023) gives both comparators together: 15/22 µA at 2.0 V, 22/37 µA at 3.0 V, 44/68 µA at 5.0 V. | §17.1 D023, p.131 | electrical | todo |
| P6-022 | **VREF module limits.** Table 17-2 applies for 3.0 V < VDD < 5.5 V. Resolution is given as "VDD/24 min, VDD/32 max" LSb. Accuracy is 1/4 LSb (VRR = 1) and 1/2 LSb (VRR = 0). R is 2k Ω. Settling is 10 µs max. ΔIVREF is 135 µA (one value, column ambiguous) at 3.0 V and at 4.0 V. A: the same ladder figures, but specified from 2.0 V, with a Note 2 that accuracy degrades between 2.0 and 3.0 V. A ΔIVREF (D024) is 34/55 µA at 2.0 V, 50/75 µA at 3.0 V and 80/110 µA at 5.0 V. | Table 17-2, p.133; §17.1 ΔIVREF, p.131 | electrical | todo |
| P6-023 | **Brown-out naming and current.** The feature is called BOD ("Brown-out Detect"): config bit BODEN, PCON bit 0 BOD, and VBOD/TBOD. VBOD is 3.65 / 4.0 / 4.35 V. Extended: 3.65 / — / 4.4 V (no typical given). ΔIBOD is 75 µA typ and 125 µA max at VDD = 5.0 V. A: called BOR / BOREN / VBOR, extended typical 4.0 V, ΔIBOR 29/52 µA at 4.5 V and 30/55 µA at 5.0 V. | D005, p.130; D023 ΔIBOD, p.131; Register 3-6, p.24 | electrical | todo |
| P6-024 | **PCON register.** It sits at 8Eh; the Register 3-6 heading "ADDRESS: 0Ch" is a documentation error, and Table 3-2 says 8Eh. Bits: OSCF R/W-1 ("INTRC/ER oscillator frequency"), POR R/W-q, BOD R/W-q. Reset value is ---- 1-0x. The BOD bit is "unknown on Power-on Reset" and "not necessarily predictable" when BODEN = 0. A: POR R/W-0, BOR R/W-x, same reset value, OSCF is INTOSC-only. | Register 3-6, p.24; Table 3-2, p.16; §14.5.6, p.97 | register | todo |
| P6-025 | **TRISA reset value in Table 14-8.** POR gives 11-1 1111. MCLR, WDT and BOD resets give 11-- 1111. Wake-up gives uu-u uuuu. The bit 5 position (RA5 is input only) is shown as '-'. Tables 3-2, 5-2, 6-1 and 9-1 of the same sheet give 1111 1111 / 1111 1111, and Example 5-1 says "TRISA<5> always read as '1'". A: 1111 1111 everywhere. The original sheet contradicts itself, so the TRISA5 read-back is unresolved. | Table 14-8, p.98 vs Table 3-2, p.16; Example 5-1, p.29 | note | **decide** |
| P6-026 | **PORTA reset value.** Table 14-8 gives POR xxxx 0000, MCLR/WDT/BOD xxxx u000 and wake-up xxxx 0000. Table 5-2 gives "All other RESETS" as xxxu 0000. A: xxxx 0000 / xxxx 0000 / uuuu uuuu. The two tables in DS40300C conflict on which bit is 'u'. | Table 14-8, p.98; Table 5-2, p.34 | note | info |
| P6-027 | **RCSTA reset value.** Every register table and Table 14-8 give POR and other resets as 0000 -00x and wake-up as uuuu -uuu, showing bit 3 (ADEN) as unimplemented. Register 12-2 defines ADEN as R/W-0. A: 0000 000x / uuuu uuuu. The likely model is ADEN = 0 on reset, but the read-back on the original is not stated. | Tables 3-1, 12-2, 12-6..12-12, 14-8; Register 12-2, p.68 | note | **decide** |
| P6-028 | **Wake-up columns of Table 14-8.** STATUS is uuuq quuu (A: uuuq 0uuu). PIR1 is -q-- ---- with Note 5: "If wake-up was due to comparator input changing, then Bit 6 = 1. All other interrupts generating a wake-up will cause Bit 6 = u." A: qqqq -qqq. PCON is ---- --uu (A: ---- u-uu, which leaves OSCF unchanged). CMCON is uu-- uuuu on both. | Table 14-8 and Notes 2, 5, p.98 | note | info |
| P6-029 | **EECON1.RD access type.** Register 13-2 gives RD as "R/S-x". A: R/S-0. Both give the EECON1 reset value as ---- x000, so RD resets to 0 in either case. | Register 13-2, p.88; Table 13-1, p.90 | note | info |
| P6-030 | **Data EEPROM endurance.** D120 ED: 1M min (characterised), 10M typ E/W, "25°C at 5V". D122 TDEW: 4 ms typ, 8 ms max (same as A). There is no D123 retention spec and no D124 refresh spec or refresh procedure. A: 100K min / 1M typ (-40 to 85 °C), 10K / 100K (85 to 125 °C), 40-year retention, and a D124 array refresh after 1M/10M total cycles. Any wear-out model has to use different limits per part. | Table 17-3 D120/D122, p.135 | failure-mode | todo |
| P6-031 | **PWRT blocks EEPROM writes.** "The Power-up Timer (72 ms duration) prevents EEPROM write", with no condition attached. Because of P6-005, PWRT is also active whenever BODEN = 1. A: "when enabled, the Power-up Timer (72 ms duration) prevents EEPROM write." | §13.6, p.89 | behaviour | todo |
| P6-032 | **Program flash electrical limits (programming only).** D130 EP: 1000 min (characterised), 10000 typ E/W. D132 VPEW: VDD 4.5-5.5 V for erase and for write. D133 TPEW: 4 ms typ, 8 ms max. A: endurance 10K/100K (-40 to 85 °C) and 1000/10K (85 to 125 °C). Block erase needs 4.5-5.5 V and takes 4/8 ms. Write works from VMIN to 5.5 V and takes 2/4 ms. The A-part errata restricts the write voltage on early silicon (E-002). | Table 17-3 D130-D133, p.135 | memory | todo |
| P6-033 | **LVP supply.** Note 2: "VDD must be 5.0V +10% during erase/program operations while in low voltage Programming mode." Also: "once the LVP bit is programmed to 0, High voltage Programming mode can be used to program the device." A: "+10% during erase operations", and "only High-Voltage Programming mode can be used". The DS40300C wording does not say "only". | §14.13 and Note 2, p.106 | note | info |
| P6-034 | **Frequency and VDD grades.** PIC16F627/628 runs at 3.0-5.5 V and PIC16LF627/628 at 2.0-5.5 V, the same as the A parts. Table 4-1 gives the maximum frequency as 20 MHz for PIC16F627/628 and 4 MHz for PIC16LF627/628. Ordering grades: -04 = 4 MHz (XT and ER osc) or 200 kHz (LP osc), and -20 = 20 MHz (HS osc). The voltage-frequency graphs are split by temperature: Fig. 17-1/17-2 for 16F62X and Fig. 17-3/17-4 for 16LF62X, at 0 to +70 °C and at -40 to 0 °C / +70 to +85 °C. A: every part, LF included, is 20 MHz, with no frequency grade. An LF non-A profile should reject or flag FOSC > 4 MHz. | Table 4-1, p.27; Product ID, p.167; Fig. 17-1..17-4, p.128-129 | electrical | todo |
| P6-035 | **Temperature grades.** Commercial "-" (0 to +70 °C), I (-40 to +85 °C) and E (-40 to +125 °C). The LF parts come in Commercial and Industrial only. Params 30, 31 and 33 at extended temperature are "TBD". A: Industrial and Extended only, with no commercial grade. | §17.1 header, p.130; Product ID, p.167; Table 17-6, p.138 | electrical | todo |
| P6-036 | **IDD (active supply current).** PIC16LF62X: D010 0.30 mA typ / 0.6 mA max at 4.0 MHz and 2.0 V, 1.10 / 2.0 mA at 4.0 MHz and 5.5 V. D013 4.0 / 7.0 mA at 20 MHz and 5.5 V, 3.80 / 6.0 mA at 20 MHz and 4.5 V, max 2.0 mA at 10 MHz and 3.0 V (commercial only), 20 / 30 µA at 32 kHz and 2.0 V. PIC16F62X: D010 0.60 / 0.7 mA at 4.0 MHz and 3.0 V, 1.10 / 2.0 mA at 4.0 MHz and 5.5 V. D013 4.0 / 7.0 mA at 20 MHz and 5.5 V, 3.80 / 6.0 mA at 20 MHz and 4.5 V, max 2.0 mA at 10 MHz and 3.0 V. D014 20 / 30 µA at 32 kHz and 3.0 V. A: different tables, for example D012 450/600 µA at 4 MHz XT and 3.0 V, D013 2.75/3.3 mA at 20 MHz and 5.0 V. | §17.1 D010/D013/D014, p.130 | electrical | todo |
| P6-037 | **IPD (sleep current).** PIC16LF62X: 0.20 µA typ, 2.0 µA max at 2.0 V; 0.20 / 2.2 µA at 5.5 V. PIC16F62X: 0.20 / 2.2 µA at 3.0 V; 0.20 / 5.0 µA at 4.5 V; 0.20 / 9.0 µA at 5.5 V; 2.70 / 15.0 µA at 5.5 V Extended. A: 0.01 / 0.80 µA at 2.0 V, 0.01 / 0.85 µA at 3.0 V, 0.02 / 2.7 µA at 5.0 V (industrial). | §17.1 D020, p.131 | electrical | todo |
| P6-038 | **WDT current.** ΔIWDT is 6.0 µA typ and 15 µA max at VDD = 3.0 V; 6.0 µA typ and 20 µA max at 4.0 V (commercial, industrial); 25 µA max at 4.0 V (extended). A (D021): 1/2.0 µA at 2.0 V, 2/3.4 µA at 3.0 V, 9/17 µA at 5.0 V. | §17.1 ΔIWDT, p.131 | electrical | todo |
| P6-039 | **Front-page low-power figures.** "< 2.0 mA @ 5.0V, 4.0 MHz", "15 µA typical @ 3.0V, 32 kHz", "< 1.0 µA typical standby current @ 3.0V". A ("nanoWatt"): 100 nA standby at 2.0 V, 12 µA at 32 kHz and 2.0 V, 120 µA at 1 MHz and 2.0 V, WDT 1 µA, T1OSC 1.2 µA. DS40300C has no separate T1OSC current spec, only the Fig. 18-12 graph. | p.1 feature list; Fig. 18-12, p.149 | note | info |
| P6-040 | **External clock timing formulas.** Param 42 Tt0P is "Greater of: (TCY + 40)/N" with no 20 ns term. Param 47 Tt1P (synchronous) is the same. A: "Greater of: 20 or (TCY + 40)/N". Params 40, 41, 45, 46, 48 and 50-54 match. | Table 17-7 params 42/47, p.140; Table 17-9, p.141 | timing | todo |
| P6-041 | **Packages and pinout.** 18-lead PDIP (300 mil), 18-lead SOIC (300 mil) and 20-lead SSOP (209 mil / 5.30 mm). On the SSOP, pins 5 and 6 are VSS and pins 15 and 16 are VDD. There is no 28-pin QFN. A: adds a 28-pin QFN. 18-pin pin functions are identical. | Pin Diagrams, p.2; Table 4-1, p.27; §19, p.157-160 | pin | todo |
| P6-042 | **Process and migration warning.** Device Differences table: process technology 0.7 µm. Note 1: "If you change from this device to another device, please verify oscillator characteristics in your application." The A sheet's Appendix C lists the migration differences: ER became RC, CP0/CP1 became CP, BOD became BOR, BOR no longer forces PWRT, INTRC became INTOSC, the T1 oscillator is 32.768 kHz only, and dual speed is INTOSC-only. Each of those has its own row here. | p.2 Device Differences | note | info |
| P6-043 | **USART receive sampling (documented only in DS40300C).** BRGH = 0: RX is sampled "on the seventh, eighth and ninth falling edges of a x16 clock". BRGH = 1: "on the 3 clock edges preceding the second rising edge after the first falling edge of a x4 clock" (Figs. 12-1 to 12-4). §12.3: "The USART function is similar to that on the PIC16C74B, which includes the BRGH = 1 fix." A: says only that the pin "is sampled three times by a majority detect circuit". It is unclear whether the two parts actually differ. | §12.1, Figs. 12-1..12-4, p.73-74; §12.3, p.80 | note | **decide** |
| P6-044 | **In-circuit debug.** DS40300C describes no debug header or debug resources. A: debugging uses a PIC16F648A-ICD header that takes ICDCLK/ICDDATA, 1 stack level, address 0h (must be NOP) and 300h-3FEh. That is irrelevant for a non-A profile. | §14 (absence) | note | info |
| P6-045 | **Device ID and revision.** DS40300C gives no device-ID word or revision values and refers to the Programming Specification (DS40044G doesn't give them either). An emulator that answers ICSP reads of 2006h needs that external document. | §14.1, §14.12, p.91/106 | note | info |
| P6-046 | **Documentation errors in DS40300C (do not model literally).** (a) Register 7-1 TMR1ON reads "1 = Disables Timer1, 0 = Stops Timer1"; the A sheet has 1 = enables. (b) Table 3-3 row 101h "TMR0" lists the OPTION bit names. (c) The Register 3-6 address is given as 0Ch (see P6-024). (d) The USART baud tables head a column "32.768 MHz" where the A sheet says 32.768 kHz. (e) Table 11-5 gives T2CON other-resets as "uuuu" and Table 12-10 gives PIE1 as "-000 0000". (f) Param 15 for 16LF62X reads "Tosc=400 ns" (A: TOSC+400 ns). (g) Param 2 TCY min is "1.0 TCY" (A: 200 ns). (h) §8.2 mentions a "Synchronous Serial Port", which neither part has; the A sheet repeats this. | Register 7-1, p.46; Table 3-3, p.17; Tables 11-5/12-10; Table 17-4/17-5, p.136-137; §8.2, p.50 | note | info |
| E-001 | **Data EEPROM cannot be reached in LVP mode.** "The data EEPROM memory cannot be accessed when programming in LVP mode." Flash program memory and the configuration bits can be accessed properly in LVP mode. | PIC16F627A/628A Rev. A3 | No. The errata states: "Run-time reading and writing of the data EEPROM memory functions correctly." It only shows up through an emulated LVP (RB4/PGM) programming interface. | todo |
| E-002 | **Flash programming needs VDD 4.5-5.5 V.** "FLASH program memory can only be programmed with a VDD of 4.5V - 5.5V." Future revisions are to allow 2.0-5.5 V. This contradicts DS40044G D132A (write at VMIN-5.5 V) for these revisions. | PIC16F627A/628A Rev. A2, A3 and A4 | No. It concerns ICSP programming only; the parts have no run-time self-write. A programmer model should reject or flag writes below 4.5 V on A2-A4 silicon. | todo |
| E-003 | **Flash erase is Bulk Erase only, at 4.5-5.5 V.** "In all current and future revisions of the PIC16F627A/628A silicon, the FLASH program memory can only be erased using the Bulk Erase command. The Bulk Erase function requires a VDD of 4.5V - 5.5V." | All PIC16F627A/628A revisions, current and future | No. Programming only. It matches DS40044G D132 (block erase 4.5-5.5 V) and the CP rule that only a Bulk Erase can turn protection off. | todo |

## 2. Errata DS80151B (PIC16F627A/628A Rev. A silicon)
DS80151B applies to "all PIC16F627A and PIC16F628A devices", meaning Rev. A silicon checked against data sheet DS40044A. It does not cover PIC16F648A or the original PIC16F627/628. Its "Clarifications/Corrections to the Data Sheet" section says "None". No separate errata for the original PIC16F627/628 was supplied; that part's only documented silicon defect is the CM = 001 comparator mode (P6-019).

## DS41196G: programming specification (high-voltage and low-voltage entry, ICSP protocol)

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P7-001 | Spec covers PIC16F627A, PIC16F628A, PIC16F648A, PIC16LF627A, PIC16LF628A, PIC16LF648A. All references to PIC16F627A/628A/648A also apply to PIC16LF62XA devices. | Front list + Note, p.1 | note | info |
| P7-002 | Device is programmed by a serial method; Serial mode allows programming in the user's system (in-circuit). The spec applies to the devices in all packages. | §1.0, p.1 | behaviour | todo |
| P7-003 | Hardware: one programmable power supply for VDD (2.0V to 5.5V) and a VPP of 12V to 14V, or VPP of 4.5V to 5.5V when using low voltage. Both supplies should have a minimum resolution of 0.25V. | §1.1, p.1 | electrical | todo |
| P7-004 | Programming mode allows programming of user program memory, data memory, special locations used for ID, and the Configuration Word. | §1.2, p.1 | behaviour | todo |
| P7-005 | PDIP/SOIC 18-pin: 1 RA2/AN2/VREF, 2 RA3/AN3/CMP1, 3 RA4/T0CKI/CMP2, 4 RA5/MCLR/VPP, 5 VSS, 6 RB0/INT, 7 RB1/RX/DT, 8 RB2/TX/CK, 9 RB3/CCP1, 10 RB4/PGM, 11 RB5, 12 RB6/CLOCK/T1OSO/T1CKI, 13 RB7/DATA/T1OSI, 14 VDD, 15 RA6/OSC2/CLKOUT, 16 RA7/OSC1/CLKIN, 17 RA0/AN0, 18 RA1/AN1. | Fig 1-1, p.1 | pin | todo |
| P7-006 | SSOP 20-pin: 1 RA2/AN2/VREF, 2 RA3/AN3/CMP1, 3 RA4/T0CKI/CMP2, 4 RA5/MCLR/VPP, 5 VSS, 6 VSS, 7 RB0/INT, 8 RB1/RX/DT, 9 RB2/TX/CK, 10 RB3/CCP1, 11 RB4/PGM, 12 RB5, 13 RB6/CLOCK/T1OSO/T1CKI, 14 RB7/DATA/T1OSI, 15 VDD, 16 VDD, 17 RA6/OSC2/CLKOUT, 18 RA7/OSC1/CLKIN, 19 RA0/AN0, 20 RA1/AN1. | Fig 1-1, p.1 | pin | todo |
| P7-007 | 28-pin QFN (side pins legible): 1 RA5/MCLR/VPP, 2 NC, 3 VSS, 4 NC, 5 VSS, 6 NC, 7 RB0/INT; 15 RB6/CLOCK/T1OSO/T1CKI, 16 RB7/DATA/T1OSI, 17 VDD, 18 NC, 19 VDD, 20 RA6/OSC2/CLKOUT, 21 RA7/OSC1/CLKIN. Pins 8–14 carry RB1/RX/DT, RB2/TX/CK, RB3/CCP1, RB4/PGM, RB5 and NC; pins 22–28 carry RA4/T0CKI/CMP2, RA3/AN3/CMP1, RA2/AN2/VREF, RA1/AN1, RA0/AN0 and NC. | Fig 1-2, p.2 | pin | todo |
| P7-008 | NOTE/ambiguity: the text extraction of Fig 1-2 scrambles the bottom (8–14) and top (22–28) QFN pin numbering; the exact QFN pin numbers for RB1..RB5 (incl. RB4/PGM) and RA0..RA4 cannot be read reliably from this source; check the PDF figure. | Fig 1-2, p.2 | note | **check PDF** |
| P7-009 | Pin RB4 during programming: function PGM, type I — "Low-voltage programming input if Configuration bit equals 1" (LVP bit). | Table 1-1, p.2 | pin | todo |
| P7-010 | Pin RB6 during programming: function CLOCK, type I — clock input. | Table 1-1, p.2 | pin | todo |
| P7-011 | Pin RB7 during programming: function DATA, type I/O — data input/output. | Table 1-1, p.2 | pin | todo |
| P7-012 | Pin MCLR/VPP during programming: function Programming Mode, type P(1) — Program Mode Select. | Table 1-1, p.2 | pin | todo |
| P7-013 | Pins VDD (P, power supply) and VSS (P, ground). Legend: I = Input, O = Output, P = Power. | Table 1-1, p.2 | pin | todo |
| P7-014 | Table 1-1 Note 1: programming high voltage is internally generated; to activate Programming mode, high voltage needs to be applied to MCLR input; MCLR is used as a level source, so MCLR does not draw any significant current (model MCLR/VPP as a high-impedance level sense, no programming current). | Table 1-1 Note 1, p.2 | electrical | todo |
| P7-015 | User memory space 0x0000–0x1FFF. In Programming mode the program memory space is 0x0000–0x3FFF: first half 0x0000–0x1FFF user program memory, second half 0x2000–0x3FFF configuration memory. | §2.1, p.3 | memory | todo |
| P7-016 | PC in user space increments from 0x0000 to the end of implemented user program memory and wraps around to 0x0000 (end = 0x3FF for 1K, 0x7FF for 2K, 0xFFF for 4K per Fig 2-1). | §2.1 + Fig 2-1, p.3–4 | behaviour | todo |
| P7-017 | The high-order PC bit is not affected by Increment Address: in configuration memory the PC increments 0x2000→0x3FFF and wraps to 0x2000 (not 0x0000). | §2.1, p.3 | behaviour | todo |
| P7-018 | The only way to set the PC back to user program memory is to reset the part and re-enter Program/Verify mode. | §2.1 / §2.4.3, p.3, p.8 | behaviour | todo |
| P7-019 | Configuration memory is entered via the Load Configuration command. | §2.1, p.3 | behaviour | todo |
| P7-020 | Only 0x2000–0x200F of configuration memory are physically implemented; only 0x2000–0x2007 are available; other locations are reserved. Locations beyond 0x200F physically access user memory (aliasing). | §2.1, p.3 | memory | todo |
| P7-021 | NOTE/contradiction: Fig 2-1 marks configuration space "Implemented" from 2000 to 2008 and "Not Implemented" above (up to 3FFF), while §2.1 says 0x2000–0x200F are physically implemented and addresses beyond 0x200F alias user memory. | Fig 2-1 vs §2.1, p.3–4 | note | **decide** |
| P7-022 | Program Flash size: PIC16F627A 1K, PIC16F628A 2K, PIC16F648A 4K words (implemented to 0x3FF / 0x7FF / 0xFFF). | Table 2-2 + Fig 2-1, p.3–4 | memory | todo |
| P7-023 | User ID: four user ID locations mapped at [0x2000:0x2003]; they read out normally even after code protection is enabled. | §2.2, p.3 | memory | todo |
| P7-024 | §2.2 Note 1: all other locations in configuration memory are reserved and should not be programmed. | §2.2 Note 1, p.3 | note | info |
| P7-025 | §2.2 Note 2: only the low-order 4 bits of the user ID locations may be included in the device checksum (see §3.10). | §2.2 Note 2, p.3 | note | info |
| P7-026 | Configuration memory map: 2000–2003 User ID Location, 2004 Reserved, 2005 Reserved, 2006 Device ID, 2007 Configuration Word. | Fig 2-1, p.4 | memory | todo |
| P7-027 | EE Data memory space 0x00–0xFF, separate from both program memory space and RAM space. | §2.3, p.3 | memory | todo |
| P7-028 | EE Data implemented: PIC16F627A/628A lower 128 bytes, 7 PC bits decoded; PIC16F648A full 256 bytes, 8 PC bits decoded. | §2.3 + Table 2-1, p.3 | memory | todo |
| P7-029 | Programming the EE Data memory uses the same PC as program memory; only the lower bits are decoded and used (so data-EE address wraps by the decoded width). | §2.3, p.3 | behaviour | todo |
| P7-030 | Programming module operates on serial command sequences; data latched on the falling edge of the clock. | §2.4, p.5 | behaviour | todo |
| P7-031 | CLOCK and DATA are Schmitt Trigger inputs in Program/Verify mode (VIH1 0.8 VDD min, VIL1 0.2 VDD max). | §2.4 + Table 4-1, p.5, p.20 | electrical | todo |
| P7-032 | Command sequence = 6-bit command plus, conditionally, a 16-bit data word; both command and data word are clocked LSb first. | §2.4, p.5 | behaviour | todo |
| P7-033 | DATA must meet minimum setup and hold time with respect to the falling clock edge (TSET1, THLD1). | §2.4, p.5 | timing | todo |
| P7-034 | Commands with data (Read and Load) require a minimum delay of TDLY1 between the command and the data (text). | §2.4, p.5 | timing | todo |
| P7-035 | NOTE/contradiction: §2.4 text says the command→data gap is TDLY1, but Figs 2-4…2-6, 2-9, 2-10 label the command→data gap TDLY2 (clock↓ to next clock↑, 1.0 µs min); TDLY1 appears in Figs 2-8/2-9/2-10 differently. Both minima are 1.0 µs. | §2.4 vs Figs 2-4..2-10 | note | **decide** |
| P7-036 | Command Load Configuration: mapping (MSb…LSb) X X 0 0 0 0 (= xx0000b, 0x00); data: 0, data(14), 0. | Table 2-3, p.5 | behaviour | todo |
| P7-037 | Command Load Data for Program Memory: X X 0 0 1 0 (0x02); data: 0, data(14), 0. | Table 2-3, p.5 | behaviour | todo |
| P7-038 | Command Load Data for Data Memory: X X 0 0 1 1 (0x03); data: 0, data(8), zero(6), 0. | Table 2-3, p.5 | behaviour | todo |
| P7-039 | Command Increment Address: X X 0 1 1 0 (0x06); no data. | Table 2-3, p.5 | behaviour | todo |
| P7-040 | Command Read Data from Program Memory: X X 0 1 0 0 (0x04); data: 0, data(14), 0. | Table 2-3, p.5 | behaviour | todo |
| P7-041 | Command Read Data from Data Memory: X X 0 1 0 1 (0x05); data: 0, data(8), zero(6), 0. | Table 2-3, p.5 | behaviour | todo |
| P7-042 | Command Begin Programming Only Cycle: X 0 1 0 0 0 (0x08; bit 4 must be 0, only bit 5 is don't-care); no data. | Table 2-3, p.5 | behaviour | todo |
| P7-043 | Command Bulk Erase Program Memory: X X 1 0 0 1 (0x09); no data. | Table 2-3, p.5 | behaviour | todo |
| P7-044 | Command Bulk Erase Data Memory: X X 1 0 1 1 (0x0B); no data. | Table 2-3, p.5 | behaviour | todo |
| P7-045 | NOTE: no other 6-bit command codes are defined in Table 2-3 (no End Programming, no Begin Erase/Program cycle, no Chip Erase); behaviour on an undefined code is not specified. | Table 2-3 / §2.4.4, p.5, p.8 | note | **decide** |
| P7-046 | 16-bit data word is an input (Load Data commands) or an output (Read Data commands). It contains 14 data bits centred in 16 bits, padded with a leading and trailing zero (start bit, 14 bits LSb first, stop bit). | §2.4, p.6 + Figs 2-4/2-9 | behaviour | todo |
| P7-047 | High-voltage Program/Verify entry: hold CLOCK and DATA low while raising MCLR first, then VDD (Fig 2-2, timing labels TPPDP, THLD0). | §2.4 + Fig 2-2, p.6 | behaviour | todo |
| P7-048 | Fig 2-2 Note: if the LVP fuse is enabled, PGM should be held low to prevent inadvertent entry into LVP mode (HV flowchart step "Set PGM = VSS", then "Set MCLR = VIHH", then "Set VDD = VDD"). | Fig 2-2 Note + Fig 3-3, p.6, p.13 | note | info |
| P7-049 | NOTE: Fig 2-2 draws a trace labelled "LVP" (not "PGM") among MCLR, VDD, DATA, CLOCK; presumably the PGM pin. | Fig 2-2, p.6 | note | **decide** |
| P7-050 | Low-voltage Program/Verify entry: raise VDD, then MCLR and PGM (Fig 2-3, timing labels THLD0, TLVPP, TPPDP). Flowchart order: Set VDD = VDD, Set PGM = VDD, Set MCLR = VDD. | §2.4 + Fig 2-3 + Fig 3-3, p.6, p.13 | behaviour | todo |
| P7-051 | Fig 2-3 Note: if the device is in LVP mode, raising VPP to VIHH will override LVP mode. | Fig 2-3 Note, p.6 | note | info |
| P7-052 | PC is set to '0' upon entering Program/Verify mode. PC changes only by Increment Address or Load Configuration (sets PC to 0x2000). | §2.4, p.6 | behaviour | todo |
| P7-053 | All other logic is held in Reset while in Program/Verify mode: all I/O are in the Reset state (high-impedance inputs); user code does not run. | §2.4, p.6 | behaviour | todo |
| P7-054 | If LVP is not used but the LVP Configuration bit is set, PGM must not toggle during programming: PGM is edge sensitive and a detected edge may cause the PC to reset. | §2.4, p.6 | failure-mode | todo |
| P7-055 | If the LVP feature is disabled (LVP=0), the PGM pin has no effect on programming. | §2.4, p.6 | behaviour | todo |
| P7-056 | Note: the LVP feature is enabled by default when the LVP bit of the Configuration Word is set (erased value of the bit is 1). | §2.4 Note, p.6 + Reg 3-1 | note | info |
| P7-057 | NOTE: exit from Program/Verify mode is not described explicitly; only "reset the part and re-enter" / "exiting and re-entering" is mentioned; no exit timing given. | §2.1, §2.4.3 | note | **decide** |
| P7-058 | Load Data for Program Memory: receives a 14-bit word and readies it to be programmed at the PC location. Waveform: 6 command clocks (DATA 0,1,0,0,0,0 LSb first), TDLY2, then 16 data clocks: strt_bit, LSb … MSb, stp_bit; TSET1/THLD1 at clock↓. | §2.4.1 + Fig 2-4, p.7 | behaviour | todo |
| P7-059 | Load Data for Data Memory: receives an 8-bit byte, readies it for data memory. Although the byte is 8 bits wide, all 16 clock cycles are required to allow the programming module to reset properly. Waveform command bits 1,1,0,0,0,0. | §2.4.2 + Fig 2-5, p.7 | behaviour | todo |
| P7-060 | Failure mode: a data phase cut short of 16 clocks on Load Data for Data Memory leaves the programming module not reset properly (behaviour undefined by spec). | §2.4.2, p.7 | failure-mode | todo |
| P7-061 | Load Configuration: advances PC to start of configuration memory (0x2000–0x200F) and loads the data for the first ID location (0x2000). Once in the configuration region, only exiting and re-entering Program/Verify mode resets PC to user space. Waveform command bits 0,0,0,0,0,0, TDLY2, "First Data Word" 16 clocks. | §2.4.3 + Fig 2-6, p.8 | behaviour | todo |
| P7-062 | Begin Programming Only Cycle: programs the previously loaded word into the appropriate memory (user program, data, or configuration memory, per PC/last load). Programming begins after the command is received and decoded; an internal timer executes the write. | §2.4.4, p.8 | behaviour | todo |
| P7-063 | A Load command must be given before every Programming command. | §2.4.4, p.8 | behaviour | todo |
| P7-064 | User must allow the program cycle time before issuing the next command: TPROG (program memory) or TDPROG (data memory) after the 6th clock of Begin Programming (Fig 2-7). No "End Programming" command is required. | §2.4.4 + Fig 2-7, p.8 | timing | todo |
| P7-065 | The device must be Bulk Erased before starting a series of Programming Only cycles (programming only, no erase-before-write: model programming as clearing bits on an erased word / failure if not erased). | §2.4.4, p.8 | failure-mode | todo |
| P7-066 | Begin Programming waveform DATA bits 0,0,0,1,0,0 (LSb first). | Fig 2-7, p.8 | behaviour | todo |
| P7-067 | Increment Address: PC incremented when command received. Waveform DATA 0,1,1,0,X,X; then TDLY2 (and TDLY1) to next command. | §2.4.5 + Fig 2-8, p.9 | behaviour | todo |
| P7-068 | Read Data from Program Memory: reads the word addressed by the PC and transmits it on DATA during the data phase; reports words from user or configuration memory depending on PC. Waveform command DATA 0,0,1,0,X,X. | §2.4.6 + Fig 2-9, p.9 | behaviour | todo |
| P7-069 | Read Data: DATA pin goes into Output mode on the second rising clock edge (of the data phase) and reverts to Input mode (high-impedance) after the 16th rising edge. Output: strt_bit, LSb…MSb, stp_bit; data valid TDLY3 (≤80 ns) after clock↑. | §2.4.6 + Fig 2-9, p.9 | behaviour | todo |
| P7-070 | Read Data from Data Memory: reads the byte addressed by the low-order bits of PC; same output window (2nd rising edge to after 16th rising edge); only 8 bits transmitted, last 8 bits zero padded. Waveform command DATA 1,0,1,0,X,X. | §2.4.7 + Fig 2-10, p.10 | behaviour | todo |
| P7-071 | NOTE/ambiguity: §2.4.7 says "last 8 bits are zero padded" while Table 2-3 framing is 0, data(8), zero(6), 0 (i.e. 6 zeros + stop bit = 7 trailing, plus start bit). | §2.4.7 vs Table 2-3 | note | **decide** |
| P7-072 | All Bulk Erase operations must take place with VDD between 4.5–5.5V. | §3.1 Note, §3.2 Note, p.11–12; Table 4-1 | electrical | todo |
| P7-073 | Bulk Erase Program Memory sequence: (1) Load Data for Program Memory with data word all '1's (0x3FFF); (2) Bulk Erase Program Memory command; (3) wait TERA for erase to complete. | §3.1, p.11 | behaviour | todo |
| P7-074 | If the address is pointing to configuration memory (0x2000–0x200F) when Bulk Erase Program Memory is issued, both user ID locations and program memory are erased. | §3.1, p.11 | behaviour | todo |
| P7-075 | Bulk Erase Program Memory waveform DATA 1,0,0,1,0,0 then TERA before next command. | Fig 3-1, p.11 | timing | todo |
| P7-076 | Table 3-1 (CP column "X" in all rows): Bulk Erase Data Memory, CPD OFF, PC any → Program Unaffected, Data EE Erased, Config Word Unaffected, User ID Unaffected. | Table 3-1, p.11 | behaviour | todo |
| P7-077 | Table 3-1: Bulk Erase Data Memory, CPD ON, PC any → Program Unaffected, Data EE Erased, Config Word Unaffected, User ID Unaffected; comment "CPD=ON" (CPD bit itself not cleared by data erase). | Table 3-1, p.11 | behaviour | todo |
| P7-078 | Table 3-1: Bulk Erase Program Memory, CPD ON, PC=Config YES → Program Erased, Data EE Erased, Config Word Erased, User ID Erased. | Table 3-1, p.11 | behaviour | todo |
| P7-079 | Table 3-1: Bulk Erase Program Memory, CPD OFF, PC=Config YES → Program Erased, Data EE Unaffected, Config Word Erased, User ID Erased. | Table 3-1, p.11 | behaviour | todo |
| P7-080 | Table 3-1: Bulk Erase Program Memory, CPD ON, PC=Config NO → Program Erased, Data EE Erased, Config Word Erased, User ID Unaffected. | Table 3-1, p.11 | behaviour | todo |
| P7-081 | Table 3-1: Bulk Erase Program Memory, CPD OFF, PC=Config NO → Program Erased, Data EE Unaffected, Config Word Erased, User ID Unaffected. | Table 3-1, p.11 | behaviour | todo |
| P7-082 | Table 3-1 header "Serial & Parallel Operation"; CP ON=0 / OFF=1, CPD ON=0 / OFF=1; CP state does not change outcome (X). | Table 3-1, p.11 | note | info |
| P7-083 | Bulk Erase Data Memory sequence: (1) Bulk Erase Data Memory command; (2) wait TERA. (No preceding Load required.) Waveform DATA 1,1,0,1,0,0. | §3.2 + Fig 3-2, p.12 | behaviour | todo |
| P7-084 | NOTE: Fig 3-2 shows a TDLY3 label after the next command's clock 2 (no read is involved) — likely drawing artefact. | Fig 3-2, p.12 | note | **decide** |
| P7-085 | Program memory flow (HV): Set PGM = VSS → Set MCLR = VIHH → Set VDD = VDD; (LV): Set VDD = VDD → Set PGM = VDD → Set MCLR = VDD. Per location: Load Data for Program Memory → Begin Programming → Wait TPROG → Read Data from Program Memory → if wrong "Report Programming Failure"; Increment Address until all locations done; then verify all locations; error → "Report Verify Error @ VDDNOM". | Fig 3-3, p.13 | behaviour | todo |
| P7-086 | Configuration memory flow: Load Configuration Data → if Program ID Location: Program Cycle, Read Data, verify (else Report Programming Failure) → Increment Address → loop until Address = 0x2004 → Increment Address ×3 (to 0x2007) → Program Cycle (Config. Word) → Set VDD = VDDNOM → Read Data → if wrong "Report Program Configuration Word Error". | Fig 3-4, p.14 | behaviour | todo |
| P7-087 | Data memory flow: Load Data for Data Memory → Begin Programming → Wait TDPROG → Read Data from Data Memory → verify (Report Programming Failure) → Increment Address until all done → final verify (Report Verify Error). | Fig 3-5, p.15 | behaviour | todo |
| P7-088 | Programming a range: after entry, Increment Address until Address = Start Address, then program cycle per location with Wait TPROG, read-back verify, and final "Verify all Locations @ VDDNOM". | Fig 3-6, p.16 | behaviour | todo |
| P7-089 | NOTE: VDDNOM (nominal VDD for verify) is used in flowcharts but not given a value in this spec. | Figs 3-3,3-4,3-6 | note | info |
| P7-090 | Configuration bits can be set (reads '0') or left unchanged (reads '1'). | §3.6, p.17 | register | todo |
| P7-091 | Device ID word is hard coded at 2006h (read-only). | §3.7, p.17 | memory | todo |
| P7-092 | Device ID values (Dev 9 bits + Rev 5 bits): PIC16F627A 01 0000 010 x xxxx; PIC16F628A 01 0000 011 x xxxx; PIC16F648A 01 0001 000 x xxxx (i.e. 0x1040/0x1060/0x1100 with rev in bits 4:0). Revision value not given. | Table 3-2, p.17 | memory | todo |
| P7-093 | Configuration Word at 2007h, 14 bits, all bits R/P-1 except bits 12–9 U-1. Layout bit13..0: CP, —, —, —, —, CPD, LVP, BOREN, MCLRE, FOSC2, PWRTE, WDTE, FOSC1, FOSC0. Legend: U = unimplemented, read as '1'; -n = value at POR. | Reg 3-1, p.17 | register | todo |
| P7-094 | Bit 13 CP: 1 = code protection off; 0 = protected range PIC16F648A 0000h–0FFFh, PIC16F628A 0000h–07FFh, PIC16F627A 0000h–03FFh. | Reg 3-1, p.17 | register | todo |
| P7-095 | Bits 12–9 unimplemented: read as '1'. | Reg 3-1, p.17 | register | todo |
| P7-096 | Bit 8 CPD (Data Code Protection, footnote 2): 1 = data memory code protection off; 0 = data memory code-protected. | Reg 3-1, p.17 | register | todo |
| P7-097 | Bit 7 LVP: 1 = RB4/PGM pin has PGM function, low-voltage programming enabled; 0 = RB4/PGM is digital I/O, HV on MCLR must be used for programming. | Reg 3-1, p.17 | register | todo |
| P7-098 | Bit 6 BOREN (footnote 1): 1 = BOR enabled; 0 = BOR disabled. | Reg 3-1, p.17 | register | todo |
| P7-099 | Bit 5 MCLRE: 1 = RA5/MCLR pin function is MCLR; 0 = RA5/MCLR is digital I/O, MCLR internally tied to VDD. | Reg 3-1, p.17 | register | todo |
| P7-100 | Bit 3 PWRTE (footnote 1): 1 = PWRT disabled; 0 = PWRT enabled. | Reg 3-1, p.17 | register | todo |
| P7-101 | Bit 2 WDTE: 1 = WDT enabled; 0 = WDT disabled. | Reg 3-1, p.17 | register | todo |
| P7-102 | Bits 4,1-0 FOSC<2:0> (footnote 3): 111 RC, CLKOUT on RA6, R&C on RA7; 110 RC, I/O on RA6, R&C on RA7; 101 INTOSC, CLKOUT on RA6, I/O on RA7; 100 INTOSC, I/O on RA6 and RA7; 011 EXTCLK, I/O on RA6, (text) I/O on RA7/OSC1/CLKIN; 010 HS crystal/resonator on RA6 and RA7; 001 XT crystal/resonator on RA6 and RA7; 000 LP low-power crystal on RA6 and RA7. | Reg 3-1, p.17 | register | todo |
| P7-103 | NOTE/ambiguity: FOSC=011 EXTCLK text says "I/O function on RA7/OSC1/CLKIN", although EXTCLK is clocked through CLKIN; quoted as printed. | Reg 3-1, p.17 | note | **decide** |
| P7-104 | Reg 3-1 Note 1: enabling Brown-out Reset does not automatically enable the Power-up Timer (PWRT). | Reg 3-1 Note 1, p.17 | note | info |
| P7-105 | Reg 3-1 Note 2: only a Bulk Erase will reset the Configuration Word, including the CP bits (bits cannot be returned to '1' by programming). | Reg 3-1 Note 2, p.17 | failure-mode | todo |
| P7-106 | Reg 3-1 Note 3: while MCLR is asserted in INTOSC mode, the internal clock oscillator is disabled. | Reg 3-1 Note 3, p.17 | note | info |
| P7-107 | Hex file: programmer must read the Configuration Word and ID locations from the hex file; if Configuration Word is absent a simple warning may be issued; when saving, Config Word and ID information must be included (option to omit may be provided). EEPROM data memory should also be embedded. | §3.8, p.18 | behaviour | todo |
| P7-108 | Hex file: data EEPROM mapped logically starting at address 0x2100, one data byte per address location, LSB aligned; programmer should read it and optionally write it. | §3.9, p.19 | memory | todo |
| P7-109 | Checksum: sum of all program memory locations up to max user-addressable location (e.g. 0x7FF for PIC16F628A) + Configuration Word (masked) + masked ID locations (when applicable); carries beyond 16 bits neglected; least significant 16 bits is the checksum. | §3.10.1, p.19 | behaviour | todo |
| P7-110 | Checksum note: calculation differs with code-protect setting since program memory reads out differently when protected; when reading a device, entire program memory can simply be read and summed; Configuration Word and ID locations can always be read. | §3.10.1 Note, p.19 | note | info |
| P7-111 | NOTE: the spec does not state what value a code-protected program-memory location reads out as over ICSP (only that it reads "differently"). | §3.10.1 Note, p.19 | note | info |
| P7-112 | Checksum PIC16F627A: CP OFF SUM[0x0000:0x03FF] + CFGW & 0x21FF, blank 1DFF, with 0x25E6 at 0 and max address E9CD; CP ON CFGW & 0x21FF + SUM_ID, blank 1FFE, 0x25E6 case EBCC. | Table 3-3, p.19 | behaviour | todo |
| P7-113 | Checksum PIC16F628A: CP OFF SUM[0x0000:0x7FF] + CFGW & 0x21FF, blank 19FF, 0x25E6 case E5CD; CP ON CFGW & 0x21FF + SUM_ID, blank 1BFE, 0x25E6 case E7CC. | Table 3-3, p.19 | behaviour | todo |
| P7-114 | Checksum PIC16F648A: CP OFF SUM[0x0000:0x0FFF] + CFGW & 0x21FF, blank 11FF, 0x25E6 case DDCD; CP ON CFGW & 0x21FF + SUM_ID, blank 13FE, 0x25E6 case DFCC. | Table 3-3, p.19 | behaviour | todo |
| P7-115 | SUM_ID = ID locations masked by 0xF, assembled into a 16-bit value with ID0 as most significant nibble (example gives SUM_ID = 0x1234 for IDs 1,2,3,4). SUM[a:b] inclusive; + addition; & bitwise AND. | Table 3-3 legend, p.19 | behaviour | todo |
| P7-116 | NOTE/typo: SUM_ID example names the IDs "ID0, ID1, ID3, ID4" (skips ID2). | Table 3-3 legend, p.19 | note | **decide** |
| P7-117 | NOTE/contradiction: footnote says "Checksum = [Sum …] MODULO [0xFFFF]" whereas §3.10.1 says the least significant 16 bits (i.e. modulo 0x10000) is the checksum. | Table 3-3 vs §3.10.1, p.19 | note | **decide** |
| P7-118 | NOTE/contradiction: the CP ON blank and 0x25E6 values differ per device and differ from the CP OFF values by the same program-memory contribution (e.g. E9CD vs EBCC), so the printed CP ON formula "CFGW & 0x21FF + SUM_ID" alone does not reproduce the table values; program memory appears still to contribute. | Table 3-3, p.19 | note | **decide** |
| P7-119 | Table 4-1 standard conditions: 0°C ≤ TA ≤ +70°C; operating voltage 4.5V ≤ VDD ≤ 5.5V (unless otherwise stated). | Table 4-1, p.20 | electrical | todo |
| P7-120 | VDD level for word operations, program memory: min 2.0V, max 5.5V. | Table 4-1, p.20 | electrical | todo |
| P7-121 | VDD level for word operations, data memory: min 2.0V, max 5.5V. | Table 4-1, p.20 | electrical | todo |
| P7-122 | VDD level for Bulk Erase operations (program and data memory): min 4.5V, max 5.5V (failure-mode: bulk erase below 4.5V out of spec). | Table 4-1, p.20 | electrical | todo |
| P7-123 | VIHH, high voltage on MCLR: min 10.0V, max 13.5V. | Table 4-1, p.20 | electrical | todo |
| P7-124 | NOTE/contradiction: §1.1 specifies VPP of 12V to 14V, but Table 4-1 VIHH is 10.0V–13.5V. | §1.1 vs Table 4-1 | note | **decide** |
| P7-125 | TVHHR, MCLR rise time (VSS to VIHH) for Programming mode entry: max 1.0 µs. | Table 4-1, p.20 | timing | todo |
| P7-126 | TPPDP, hold time after MCLR↑: min 5 µs. | Table 4-1, p.20 | timing | todo |
| P7-127 | TLVPP, hold time after LVP↑ (PGM↑): min 5 µs. | Table 4-1, p.20 | timing | todo |
| P7-128 | VIH1, (CLOCK, DATA) input high level: min 0.8 VDD, Schmitt Trigger input. | Table 4-1, p.20 | electrical | todo |
| P7-129 | VIL1, (CLOCK, DATA) input low level: max 0.2 VDD, Schmitt Trigger input. | Table 4-1, p.20 | electrical | todo |
| P7-130 | TSET0, CLOCK, DATA setup time before MCLR↑: min 100 ns. | Table 4-1, p.20 | timing | todo |
| P7-131 | THLD0, hold time after VDD↑: min 5 µs. | Table 4-1, p.20 | timing | todo |
| P7-132 | TSET1, data in setup time before clock↓: min 100 ns. | Table 4-1, p.20 | timing | todo |
| P7-133 | THLD1, data in hold time after clock↓: min 100 ns. | Table 4-1, p.20 | timing | todo |
| P7-134 | TDLY1, data input not driven to next clock input (delay required between command/data or command/command): min 1.0 µs. | Table 4-1, p.20 | timing | todo |
| P7-135 | TDLY2, delay between clock↓ to clock↑ of next command or data: min 1.0 µs. | Table 4-1, p.20 | timing | todo |
| P7-136 | TDLY3, clock↑ to data out valid (during read data): max 80 ns. | Table 4-1, p.20 | timing | todo |
| P7-137 | TPROG, programming cycle time (program memory): max 4 ms. | Table 4-1, p.20 | timing | todo |
| P7-138 | TDPROG, Data EEPROM programming cycle time: max 6 ms. | Table 4-1, p.20 | timing | todo |
| P7-139 | TERA, Bulk Erase cycle time: max 6 ms. | Table 4-1, p.20 | timing | todo |
| P7-140 | NOTE: no typ values are given for any Table 4-1 parameter; no min/max for clock period/frequency, no explicit exit timing, and no spec of what happens if a command arrives before TPROG/TDPROG/TERA elapse. | Table 4-1, p.20 | note | info |
| P7-141 | NOTE: the configuration-word / ID programming cycle wait is not named separately; Fig 3-4 uses a generic "Program Cycle" (by implication TPROG). | Fig 3-4, p.14 | note | info |
| P7-142 | NOTE: the spec's word-operation VDD minimum (2.0V) is below the Table 4-1 standard operating range (4.5V–5.5V) — LV word operations are allowed while the table header states 4.5V min. | Table 4-1, p.20 | note | info |
| P7-143 | Page 21 is the generic Microchip code-protection/legal notice; no modelling content. Document dated 12/08/06, all pages marked "Preliminary". | p.21–22 | note | info |

## DS33023A (reference manual): CPU, memory, EEPROM, interrupts, ports, WDT/Sleep, configuration, ICSP, instruction set

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P8-001 | Four device-clock (OSC1) periods make one instruction cycle TCY; OSC1 is divided by 4 into four non-overlapping quadrature clocks Q1, Q2, Q3, Q4. | §2.1 p. 2-2; §4.2, Fig. 4-3, p. 4-5 | timing | todo |
| P8-002 | Oscillator mode is fixed by configuration bits FOSC2:FOSC0, which are nonvolatile and set at programming time; it cannot be changed at run time by firmware. | §2.1, §2.2.1 p. 2-2 | behaviour | todo |
| P8-003 | The LP, XT and HS modes differ only in the gain of the internal feedback inverter: LP = low gain (least current), XT = medium gain, HS = high gain (most current of the three crystal modes). Any of them may be used outside its nominal range if validated; the manual recommends the lowest gain that still meets spec. | §2.2.1 p. 2-2; Table 2-2 p. 2-3; §2.3.3.1 p. 2-9 | behaviour | todo |
| P8-004 | FOSC2:FOSC0 encoding (Table 2-2): 111 = EXTRC with CLKOUT (device default when erased), 110 = EXTRC with OSC2 as I/O, 101 = INTRC with CLKOUT, 100 = INTRC with I/O, 011 = reserved, 010 = HS, 001 = XT, 000 = LP. | §2.2.1, Table 2-2 p. 2-3 | register | todo |
| P8-005 | Manual Table 2-2 lists FOSC2:FOSC0 = 011 as "Reserved"; DS40044G Register 14-1 defines 011 = EC (external clock on RA7/OSC1/CLKIN, RA6/OSC2 is I/O). Follow DS40044G for the 62xA. | Manual Table 2-2 p. 2-3 vs DS40044G Register 14-1 | note | info |
| P8-006 | Crystal / resonator modes need a parallel-cut crystal on OSC1/OSC2; a series-cut crystal can run outside the maker's frequency spec. The on-chip feedback resistor RF is typically 2-10 MΩ (varies with VDD, temperature, process). A series resistor Rs may be needed for AT strip-cut crystals and in HS/XT modes to avoid overdriving low-drive-level crystals. | §2.3 Fig. 2-1 p. 2-4; §2.3.2 p. 2-6; Table 2-4 note p. 2-7 | electrical | todo |
| P8-007 | Crystal start-up: the oscillator begins as VDD rises from VSS; start-up time depends on crystal frequency, C1/C2, VDD rise time, temperature, Rs, mode gain, crystal quality, layout and noise. The start-up waveform can be well under 50% of VDD peak-to-peak, centred on VDD/2. | §2.3.1, Fig. 2-2 p. 2-5 | timing | todo |
| P8-008 | Typical ceramic-resonator capacitors (C1 = C2): XT 455 kHz 22-100 pF, XT 2.0 MHz 15-68 pF, XT 4.0 MHz 15-68 pF, HS 8.0 MHz 10-68 pF, HS 16.0 MHz 10-22 pF, HS 20 MHz TBD. All resonators tested needed external capacitors. Higher capacitance = more stable but slower start-up. | §2.3.2, Table 2-3 p. 2-6 | electrical | todo |
| P8-009 | Typical crystal capacitors (C1 / C2): LP 32 kHz 68-100 / 68-100 pF; LP 200 kHz 15-30 / 15-30 pF; XT 100 kHz 68-150 / 150-200 pF; XT 2 MHz and 4 MHz 15-30 / 15-30 pF; HS 8, 10, 20 MHz 15-30 / 15-30 pF. | Table 2-4 p. 2-7 | electrical | todo |
| P8-010 | Crystal load capacitance is usually specified as 20-32 pF; making C2 larger than C1 speeds start-up (more phase shift at power-up); a larger C2 lowers loop gain if the crystal is overdriven. High temperature and low VDD reduce loop gain; low temperature and high VDD give the highest gain. | §2.3.3.1 p. 2-9 | electrical | todo |
| P8-011 | Failure mode, overdrive: too much gain clips / squashes the OSC2 sine wave and can make the circuit jump to a higher harmonic (device runs much faster than the crystal's resonant frequency) or damage the crystal; especially likely with low-frequency crystals such as 32.768 kHz. Fix: higher C2, add Rs, or lower-gain mode. Rs above about 20 kΩ isolates input from output and makes the clock noise-sensitive; aim for Rs ≤ about 10 kΩ. | §2.3.3.1 p. 2-9/2-10; §2.8 Q2 p. 2-18 | failure-mode | todo |
| P8-012 | Healthy OSC2 waveform is a clean sine of about 4-5 V peak-to-peak at VDD = 5 V. Probing OSC1 loads it too much; probe OSC2, and count the scope probe capacitance (e.g. 10 pF) as part of C2. | §2.3.3.1 p. 2-9/2-10 | electrical | todo |
| P8-013 | The hardest crystal start-up is waking from SLEEP: load caps sit at a quiescent charge and phase differential is minimal, so stable oscillation takes longer. Low-frequency (low-gain) modes, quiet / shielded environments, low VDD, and high temperature all make start-up worse; noise helps start-up. | §2.3.3.1.1 p. 2-10 | timing | todo |
| P8-014 | External clock input: with an external clock driving OSC1, select LP, XT or HS (not RC), because RC mode fights the injected input; OSC2 is left open (optionally a resistor to ground to reduce noise, at the cost of current). A lower-gain mode than the frequency would need saves power since no crystal loop is driven. | §2.3.4, Fig. 2-3 p. 2-10; §2.3.5 p. 2-11 | pin | todo |
| P8-015 | Manual says an external clock must use LP/XT/HS mode; DS40044G adds a dedicated EC mode (FOSC = 011) with RA6 free as I/O. Model EC as the 62xA external-clock mode; LP/XT/HS with a driven OSC1 is still valid per the manual. | Manual §2.3.4 p. 2-10 vs DS40044G Register 14-1 | note | info |
| P8-016 | External RC oscillator: frequency depends on VDD, REXT, CEXT, temperature, unit-to-unit process variation and package lead-frame capacitance (most for small CEXT). REXT below 2.2 kΩ may be unstable or stop oscillating; very high REXT (e.g. 1 MΩ) is sensitive to noise, humidity and leakage; recommended REXT 3-100 kΩ. CEXT may be 0 pF but > 20 pF is recommended. Variation is larger for larger R and smaller C. | §2.4, Fig. 2-6 p. 2-12 | electrical | todo |
| P8-017 | In RC (and INTRC-with-CLKOUT) modes the OSC2/CLKOUT pin outputs FOSC/4, i.e. the instruction-cycle rate (Fig. 4-3 shows CLKOUT against the Q1-Q4 phases). | §2.4 p. 2-12; §2.5.1 p. 2-16; Fig. 4-3 p. 4-5; Table 4-1 CLKOUT p. 4-7 | pin | todo |
| P8-018 | RC start-up: oscillation starts immediately once the pin voltage meets the input thresholds (D032/D042) as VDD rises; start-up time depends on R, C, VDD rise time and temperature. | §2.4.1 p. 2-12 | timing | todo |
| P8-019 | Internal RC oscillator: 4 MHz nominal at VDD = 5 V, 25°C, with calibrated accuracy shown as 4 MHz ± 1.5% (at 5 V, 25°C). | §2.5 p. 2-13; Fig. 2-8 p. 2-14 | timing | todo |
| P8-020 | Manual's internal RC is trimmed by an OSCCAL register (CAL3:CAL0, CALFST, CALSLW; reset value 0111 00--, calibration fetched by CALL to a RETLW at the last program word). DS40044G has no OSCCAL register; its INTOSC is factory-calibrated and the PCON.OSCF bit switches between 4 MHz and 48 kHz (dual-speed). Do not model OSCCAL or the RETLW calibration word for the 62xA. | Manual §2.5, Register 2-1, Table 2-5 p. 2-13..2-16 vs DS40044G §4.2.2.6 Register 4-6, §14.2.x dual-speed | note | info |
| P8-021 | SLEEP stops the on-chip clocks and the oscillator; the device is held at the beginning of an instruction cycle (Q1 state); OSC1 and OSC2 stop oscillating; only leakage current remains plus any peripheral left running in Sleep. Wake-up sources: external reset (MCLR), WDT, or interrupt. | §2.6 p. 2-17 | behaviour | todo |
| P8-022 | Pin states in Sleep (Table 2-6): EXTRC - OSC1 floating (external resistor should pull it high), OSC2 at logic low; INTRC - N/A; LP/XT/HS - feedback inverter disabled, OSC1 and OSC2 at a quiescent voltage level. | §2.6, Table 2-6 p. 2-17 | pin | todo |
| P8-023 | Device resets do not affect the crystal oscillator: it keeps running during reset. While in reset the logic is held in Q1 so execution starts at the beginning of an instruction cycle when reset exits. | §2.7 p. 2-17; §3.1 note p. 3-2 | behaviour | todo |
| P8-024 | In EXTRC mode with CLKOUT, OSC2 is held low during reset, and the RC starts oscillating as soon as MCLR reaches VIH. | §2.7 p. 2-17 | pin | todo |
| P8-025 | DS40044G adds that when MCLR is asserted in INTOSC mode the internal oscillator is disabled; the manual only says resets do not affect the (crystal) oscillator. Model INTOSC stopping during MCLR reset per DS40044G. | Manual §2.7 p. 2-17 vs DS40044G Register 14-1 note 4 | note | info |
| P8-026 | Design tip: no clock on OSC2 after power-up can be: SLEEP executed with no wake-up source; wrong clock mode (a blank / erased part defaults to EXTRC, which will not start a crystal or resonator); bad power-up (part powered through an I/O pin before VDD: latch-up / improper start-up; slow VDD rise, brown-out, noise); wrong / missing C1, C2. Holding MCLR low at power-up gives a crystal more start time, but the PC does not advance until MCLR is high. | §2.8 Q1 p. 2-18 | failure-mode | todo |
| P8-027 | Design tip: frequency slightly off - changing C1 shifts frequency somewhat; a series-resonant crystal resonates at a different frequency from a parallel-resonant crystal with the same marking. Board that suddenly stops or loses time can be an oscillator amplitude too low to reliably trigger the input. | §2.8 Q3, Q4 p. 2-18 | failure-mode | todo |
| P8-028 | Reset sources distinguished by the manual (applicable to 62xA): Power-on Reset, MCLR reset during normal operation, MCLR reset during SLEEP, WDT reset during normal operation, Brown-out Reset (Parity Error Reset is not on the 62xA). Most registers are unknown on POR and unchanged by other resets; the rest are forced to a reset state on POR, MCLR, WDT, BOR and MCLR-during-SLEEP. WDT wake-up is a resumption of normal operation and leaves most registers unaffected. | §3.1 p. 3-2 | behaviour | todo |
| P8-029 | While the device is held in any reset state, the internal phase clock is held at Q1. Newer devices have a noise filter on the MCLR reset path that ignores short pulses (pulse width = parameter 30). | §3.1 note p. 3-2 | behaviour | todo |
| P8-030 | Reset block diagram: the PWRT runs from its own on-chip RC oscillator (separate from the OSC1 RC and the INTRC), counted by a 10-bit ripple counter; the OST is a separate 10-bit ripple counter clocked from OSC1/CLKIN. Chip_Reset is an S-R latch set by POR / MCLR / WDT time-out / BOR and released when the enabled time-outs expire. | §3.1, Fig. 3-1 p. 3-3 | behaviour | todo |
| P8-031 | POR: an on-chip pulse is generated when a VDD rise is detected; tying MCLR to VDD directly or through a resistor removes the need for an external RC. A minimum VDD rise rate is required (D003/D004). For slow VDD ramps use an external RC on MCLR with a diode to discharge the capacitor at power-down; R < 40 kΩ so the drop across R stays below 0.2 V (a larger drop degrades VIH on MCLR/VPP). | §3.2.1, Fig. 3-2, Fig. 3-3 p. 3-4 | electrical | todo |
| P8-032 | PWRT: nominal 72 ms delay, only on POR and BOR (not on MCLR, WDT or wake-up); runs on a dedicated internal RC oscillator; the device is held in reset while PWRT is active; delay varies with VDD, temperature and process. Newer devices enable PWRT with PWRTE = 0 (early devices used PWRTE = 1). The manual says PWRT should always be enabled when BOR is enabled. | §3.2.2 p. 3-5; §2.7.1 p. 2-17 | timing | todo |
| P8-033 | OST: 1024 OSC1 cycles (TOST = 1024 TOSC) after the PWRT delay ends; only in XT, LP and HS modes and only on POR, BOR or wake-up from SLEEP (not on MCLR or WDT reset). The OST counter starts counting only once the OSC1 signal amplitude reaches the oscillator input thresholds. | §3.2.3, Fig. 3-4 p. 3-5 | timing | todo |
| P8-034 | For low-frequency crystals the crystal may still not oscillate when PWRT ends; the gap from PWRT time-out to oscillation start (TDEADTIME) has no minimum or maximum. TOSC1 = time for the crystal to reach a level the OST can detect. | §3.2.3, Fig. 3-4 p. 3-5 | timing | todo |
| P8-035 | Power-up sequence: internal POR detected -> PWRT time-out (if enabled) -> OST (crystal modes) -> internal reset released. In RC mode with PWRT disabled there is no time-out at all. Time-outs run from the internal POR pulse, so if MCLR is held low long enough the time-outs expire and raising MCLR starts execution immediately (useful to synchronise several devices). If VDD is not in spec by the end of the time-out, MCLR must be held low externally. | §3.2.4, Figs. 3-5..3-8 p. 3-6/3-7 | timing | todo |
| P8-036 | Time-out table (Table 3-1): XT/HS/LP - PWRT enabled 72 ms + 1024 TOSC, PWRT disabled 1024 TOSC, BOR 72 ms + 1024 TOSC, wake from SLEEP 1024 TOSC. RC - PWRT enabled 72 ms, disabled none, BOR 72 ms, wake from SLEEP none (devices with Internal/External RC option: nominal 250 µs). | §3.2.4, Table 3-1 p. 3-6 | timing | todo |
| P8-037 | Manual Table 3-1 gives a nominal 250 µs time-out (power-up with PWRT disabled and wake from SLEEP) for devices with the internal/external RC option, and the BOR time-out as 72 ms + 1024 TOSC regardless of PWRTE. DS40044G Table 14-3: RC/EC no delay on wake; INTOSC wake from Sleep 6 µs; BOR with PWRTE = 1 gives 1024 TOSC (crystal) or no delay (RC/EC/INTOSC). Use DS40044G values. | Manual Table 3-1 p. 3-6 vs DS40044G Table 14-3 | note | info |
| P8-038 | Fig. 3-8 slow-rise case: with MCLR tied to VDD and a slow VDD ramp, the PWRT and OST can expire before VDD reaches its final level, so the device leaves reset at too low a voltage. | §3.2.4, Fig. 3-8 p. 3-7 | failure-mode | todo |
| P8-039 | BOR: when VDD falls below BVDD (typically 4.0 V, D005) for longer than parameter 35, the chip resets; a dip shorter than parameter 35 is not guaranteed to reset. The chip stays in reset until VDD rises above BVDD, then the PWRT holds it a further 72 ms; if VDD dips below BVDD again while PWRT runs, the chip re-enters reset and the PWRT restarts its full 72 ms when VDD recovers. With BOR enabled every voltage below BVDD holds reset, including during power-up. | §3.2.5, Fig. 3-9 p. 3-8 | timing | todo |
| P8-040 | BOR enable polarity in the manual: BODEN = 1 enables, BODEN = 0 (programmed) disables. DS40044G calls the bit BOREN (same polarity) and notes that enabling BOR does not automatically enable PWRT on the 62xA (it did on PIC16F627/628), so BOR delay is only 72 ms if PWRTE = 0. | Manual §3.2.5 p. 3-8 vs DS40044G Register 14-1 note 1, Fig. 14-7 note | note | info |
| P8-041 | External brown-out circuits (when using them, disable the internal BOR): Fig. 3-10 Zener + transistor resets when VDD < VZ + 0.7 V; Fig. 3-11 divider + transistor, Q1 turns off when VDD·R1/(R1+R2) = 0.7 V (cheaper, less accurate). | §3.2.5, Figs. 3-10, 3-11 p. 3-9 | electrical | todo |
| P8-042 | Reset-cause decode (Table 3-2), POR/BOR/TO/PD: 0 x 1 1 = POR; 0 x 0 x illegal (TO set on POR); 0 x x 0 illegal (PD set on POR); 1 0 1 1 = BOR; 1 1 0 1 = WDT reset; 1 1 0 0 = WDT wake-up; 1 1 u u = MCLR during normal operation; 1 1 1 0 = MCLR during SLEEP. POR/BOR bits keep their value on other resets and read 1 once set by software after a POR/BOR. | §3.3, Table 3-2 p. 3-10 | behaviour | todo |
| P8-043 | Manual Table 3-2 shows BOR as TO = 1, PD = 1 and WDT reset as PD = 1; DS40044G Table 14-4 shows BOR as TO = x, PD = x and WDT reset as PD = u. Similarly manual Table 3-3 gives STATUS after WDT reset = 0000 1uuu and after BOR = 0001 1uuu, while DS40044G Table 14-6 gives WDT reset 0000 uuuu and BOR 000x xuuu. Follow DS40044G for the 62xA. | Manual Tables 3-2, 3-3 p. 3-10/3-11 vs DS40044G Tables 14-4, 14-6 | note | info |
| P8-044 | Special-register reset states (Table 3-3): POR - PC 000h, STATUS 0001 1xxx; MCLR in normal operation - 000h, 000u uuuu; MCLR during SLEEP - 000h, 0001 0uuu; WDT wake-up - PC+1, uuu0 0uuu; interrupt wake-up from SLEEP - PC+1, uuu1 0uuu, and if GIE = 1 the PC is loaded with 0004h after executing PC+1. STATUS bits 7:5 (IRP, RP1, RP0) are cleared by every reset, so firmware always starts in bank 0. | §3.3, Table 3-3 p. 3-11 | register | todo |
| P8-045 | Manual PCON (Register 3-1) is MPEEN, -, -, -, -, PER, POR, BOR with POR value u--- -10x. DS40044G PCON (8Eh) is -, -, -, -, OSCF, -, POR, BOR with POR value ---- 1-0x (OSCF = 1 = 4 MHz). The 62xA has no MPEEN / PER. | Manual §3.3.1 Register 3-1, Table 3-3 p. 3-11/3-14 vs DS40044G Register 4-6, Table 14-6 | note | info |
| P8-046 | PCON.POR is cleared by a Power-on Reset and unaffected by other resets; software must set it after a POR so a later 0 means a new POR. PCON.BOR is unknown on POR and must be set by software, then reads 0 after a Brown-out Reset; it is a don't-care and not predictable if BOR is disabled in the configuration word. | §3.3.1 p. 3-14 | register | todo |
| P8-047 | Reset-state table differences for registers the 62xA has (manual Table 3-4 vs DS40044G Table 14-7): PORTA manual --xx xxxx / --uu uuuu vs DS xxxx 0000 on POR and other resets; TRISA manual --11 1111 vs DS 1111 1111; CMCON manual 00-- 0000 vs DS 0000 0000; EECON1 manual ---0 x000 vs DS ---- x000; RCSTA manual 0000 -00x vs DS 0000 000x; INTCON on wake manual uuuu uuuu vs DS uuuu uqqq; STATUS on wake manual uuuq quuu vs DS uuuq 0uuu. Use DS40044G values. | Manual Table 3-4 p. 3-12/3-13 vs DS40044G Table 14-7 | note | info |
| P8-048 | Common reset values from manual Table 3-4 for registers on the 62xA: W, FSR, TMR0, EEDATA, EEADR = xxxx xxxx on POR, unchanged on other resets and wake; PCL = 0000 0000 on all resets, PC+1 on wake; PCLATH = ---0 0000 on all resets, unchanged on wake; OPTION_REG = 1111 1111 on all resets; INTCON = 0000 000x on POR, 0000 000u on other resets; TRISB = 1111 1111; PORTB = xxxx xxxx on POR, unchanged otherwise; VRCON = 000- 0000. On wake-up one or more INTCON/PIR1 bits are set (the cause of the wake). | §3.3, Table 3-4 p. 3-12/3-13 | register | todo |
| P8-049 | STATUS register: IRP (bit 7) selects banks 2/3 (100h-1FFh) vs 0/1 for indirect addressing; RP1:RP0 (bits 6:5) select bank 0-3 for direct addressing, 128 bytes per bank; TO (bit 4) and PD (bit 3) are read-only (R-1); Z, DC, C are R/W-x. TO = 1 after power-up, CLRWDT or SLEEP, 0 after WDT time-out; PD = 1 after power-up or CLRWDT, 0 after SLEEP. | §3.3.1, Register 3-2 p. 3-15 | register | todo |
| P8-050 | Design tip: erratic operation under ESD/EMI - if the device has no MCLR filtering, add external filtering to remove narrow pulses (parameter 35 gives the pulse width needed to reset). Firmware that relies on uninitialised GPR/SFR values behaves differently between windowed and OTP parts. | §3.4 Q1, Q2 p. 3-16 | failure-mode | todo |
| P8-051 | Harvard architecture: 14-bit program bus and 8-bit data bus are separate, so an instruction fetch (all 14 bits in one cycle) overlaps a data-memory read/write. Every program word is a valid instruction. SLEEP and CLRWDT are the only two non-register-oriented core instructions. | §4.1, Fig. 4-1 p. 4-2/4-3 | behaviour | done (core) |
| P8-052 | Q-cycle activity: the PC increments in Q1; the instruction is fetched from program memory and latched into the instruction register in Q4; it is decoded and executed in the following Q1-Q4. In the execute cycle the IR is latched in Q1, data memory is read in Q2 (operand read) and written in Q4 (destination write). | §4.2, Fig. 4-3 p. 4-5; §4.3 p. 4-6 | timing | done (core) |
| P8-053 | Two-stage pipeline: fetch of instruction n+1 overlaps execution of instruction n. Any instruction that changes the PC (GOTO, CALL, RETURN, RETLW, RETFIE, writes to PCL, skips taken) takes two cycles: the already-fetched next instruction is flushed and executed as a NOP while the new target is fetched. Example 4-1: MOVLW 55h; MOVWF PORTB; CALL SUB_1 (TCY3) -> the BSF PORTA,3 fetched in TCY3 is flushed in TCY4 while SUB_1 is fetched; SUB_1 executes in TCY5. The CALL pushes the address of instruction 4 (the return address). | §4.3, Example 4-1 p. 4-6 | timing | done (core) |
| P8-054 | A peripheral's requirements can override a port pin's TRIS setting when a function is multiplexed on the pin. | §4.4 p. 4-7 | pin | todo |
| P8-055 | Pin buffer types in the manual's generic table: OSC1 is ST in RC mode and CMOS otherwise; RA4 is ST input and open-drain as output; RA0-RA3, RA5 TTL; RB0-RB5 TTL; RB6/RB7 TTL as GPIO but ST when used as the serial programming clock/data; INT is ST; MCLR/VPP is ST. DS40044G Table 3-2 gives RA0-RA3, RA5, RA6, RA7 as ST inputs on the 62xA, RB0 TTL (INT ST), and RB6/RB7 TTL with PGC/PGD ST. Use DS40044G for the 62xA buffers. | Manual Table 4-1 p. 4-7..4-9 vs DS40044G Table 3-2 | note | info |
| P8-056 | Instruction encodings (Table 5-1) including don't-care bits a decoder must accept: CLRW = 00 0001 0xxx xxxx; NOP = 00 0000 0xx0 0000; MOVLW = 11 00xx kkkk kkkk; RETLW = 11 01xx kkkk kkkk; ADDLW = 11 111x kkkk kkkk; SUBLW = 11 110x kkkk kkkk; CLRF = 00 0001 1fff ffff; MOVWF = 00 0000 1fff ffff; CLRWDT = 00 0000 0110 0100; SLEEP = 00 0000 0110 0011; RETURN = 00 0000 0000 1000; RETFIE = 00 0000 0000 1001; CALL = 10 0kkk kkkk kkkk; GOTO = 10 1kkk kkkk kkkk. | §5.1 Table 5-1 p. 5-3 | behaviour | done (core) |
| P8-057 | Instruction formats: byte-oriented = 6-bit opcode, d (bit 7: 0 = W, 1 = f), 7-bit f; bit-oriented = 4-bit opcode, 3-bit b (bits 9:7), 7-bit f; literal = 6-bit opcode + 8-bit k; CALL/GOTO = 3-bit opcode + 11-bit k. Opcode width varies from 3 to 6 bits, giving 35 instructions. | §5.2 Fig. 5-1 p. 5-4 | behaviour | done (core) |
| P8-058 | Cycle counts (Table 5-1): all instructions 1 cycle except CALL, GOTO, RETFIE, RETLW, RETURN (2 cycles), and DECFSZ, INCFSZ, BTFSC, BTFSS which take 2 cycles when the skip is taken (second cycle executed as a NOP). Any instruction that modifies the PC (e.g. writes PCL) takes 2 cycles. | §5.1 Table 5-1 note 3 p. 5-3 | timing | done (core) |
| P8-059 | Flags affected (Table 5-1): ADDWF, SUBWF, ADDLW, SUBLW -> C, DC, Z; ANDWF, CLRF, CLRW, COMF, DECF, INCF, IORWF, MOVF, XORWF, ANDLW, IORLW, XORLW -> Z; RLF, RRF -> C; CLRWDT, SLEEP -> TO, PD; DECFSZ, INCFSZ, MOVWF, NOP, SWAPF, BCF, BSF, BTFSC, BTFSS, CALL, GOTO, MOVLW, RETFIE, RETLW, RETURN -> none. | §5.1 Table 5-1 p. 5-3 | behaviour | done (core) |
| P8-060 | RMW on I/O registers (Table 5-1 note 1): when an I/O register is modified as a function of itself (e.g. MOVF PORTB,1), the value used is the value on the pins, not the latch. Example: latch = 1 on a pin configured as input that is driven low externally -> the latch is written back with 0. | §5.1 Table 5-1 note 1 p. 5-3 | failure-mode | todo |
| P8-061 | Any instruction that writes TMR0 (with d = 1 where applicable) clears the prescaler if it is assigned to Timer0 (Table 5-1 note 2: applies to all byte-oriented and bit-oriented f instructions). | §5.1 Table 5-1 note 2 p. 5-3 | behaviour | todo |
| P8-062 | Generalised Q-cycle roles: Q1 = instruction decode or forced NOP; Q2 = instruction read data or NOP; Q3 = process data; Q4 = instruction write data or NOP. One Q cycle = one TOSC. | §5.4, Fig. 5-2 p. 5-4 | timing | done (core) |
| P8-063 | W is an 8-bit working register and is not addressable in the register file. ALU arithmetic is two's complement; in subtraction C and DC act as borrow and digit-borrow with reversed polarity (C = 1 means no borrow); subtraction is done by adding the two's complement of the second operand. RLF/RRF load C with the bit shifted out of the source register. | §5.5 p. 5-5; Register 5-1 note p. 5-7 | behaviour | done (core) |
| P8-064 | STATUS appears at the same offset in every bank. If STATUS is the destination of an instruction that affects Z, DC or C, the write to those three bits is disabled and they take the value from the ALU logic; TO and PD are never writable. Example: CLRF STATUS clears bits 7:5, sets Z, leaving 000u u1uu. Only BCF, BSF, SWAPF and MOVWF should be used to alter STATUS since they do not affect Z, C, DC. | §5.6 p. 5-6; §5.9 Q2 p. 5-10 | register | done (core) |
| P8-065 | CLRF STATUS: manual §5.6 gives 000u u1uu (agrees with DS40044G §4.2.2.1 "000uu1uu"): bits 7:5 cleared, TO/PD unchanged, Z set by the instruction, DC and C unchanged. The manual contradicts itself in §29.3.1 (see P8-167). | §5.6 p. 5-6; DS40044G §4.2.2.1 | register | done (core) |
| P8-066 | STATUS bits IRP and RP1 should be kept clear on devices that do not need them and not used as general-purpose bits (the 62xA has 4 banks, so both are used). | §5.6 note 1 p. 5-6; Register 5-1 p. 5-7 | register | todo |
| P8-067 | OPTION_REG (all bits R/W-1, POR value FFh): bit 7 RBPU (1 = PORTB pull-ups disabled, 0 = enabled per individual port latch values), bit 6 INTEDG (1 = rising edge on INT), bit 5 T0CS (1 = T0CKI pin, 0 = internal instruction clock), bit 4 T0SE (1 = increment on high-to-low T0CKI edge), bit 3 PSA (1 = prescaler to WDT, 0 = to Timer0), bits 2:0 PS2:PS0: TMR0 rate 1:2 .. 1:256 (2^(PS+1)), WDT rate 1:1 .. 1:128 (2^PS). For TMR0 1:1, assign the prescaler to the WDT. | §5.7 Register 5-2 p. 5-8 | register | todo |
| P8-068 | RBPU wording is the same in both documents ("0 = PORTB pull-ups are enabled by individual port latch values"); neither manual §5.7 nor its I/O section contradicts DS40044G §5.2, which adds that each pull-up is automatically turned off when the pin is configured as an output and that pull-ups are disabled on POR. Model the DS40044G rule (pull-up active only when RBPU = 0 and the pin is an input). | Manual Register 5-2 p. 5-8; DS40044G Register 4-2, §5.2 | note | **decide** |
| P8-069 | Manual PCON note 2 (§5.8) recommends the POR bit "be cleared after a power-on reset has been detected", while the PCON register description in the same manual (and DS40044G) says POR must be set in software after a POR so that a later 0 indicates a new POR. Model: POR cleared by hardware on POR, written to 1 by firmware. | Manual §5.8 note 2 vs Register 5-3 p. 5-9; DS40044G Register 4-6 | note | info |
| P8-070 | Design tip: wrong results commonly come from d = 0 (W) instead of d = 1 (f), or bank select bits (RP1:RP0, IRP) not set correctly, including not restored on ISR exit. | §5.9 Q1 p. 5-10 | failure-mode | todo |
| P8-071 | Program memory and data memory have separate buses, so both can be accessed in the same oscillator cycle. | §6.1 p. 6-2 | memory | todo |
| P8-072 | 13-bit PC addresses 8K x 14; program space is split into four 2K-word pages (0000h-07FFh, 0800h-0FFFh, 1000h-17FFh, 1800h-1FFFh). Sequential execution crosses page boundaries without user action. On devices with less than 8K, addresses above the implemented memory wrap around (e.g. on a 4K-word device 17FFh accesses 07FFh). 2K-word or smaller devices need no paging. | §6.2 p. 6-2 | memory | done (core) |
| P8-073 | Reset vector 0000h: any reset forces PC = 0 and clears PCLATH, so a branch at the reset vector goes to page 0. Interrupt vector 0004h: on acknowledge the PC is forced to 0004h and PCLATH is NOT modified, so the ISR must set PCLATH before any write to PC/GOTO/CALL and should save/restore PCLATH. | §6.2.1, §6.2.2 p. 6-4; Fig. 6-1 p. 6-3 | behaviour | done (core) |
| P8-074 | PC is 13 bits: PCL (low byte) is readable and writable; PCH (PC<12:8>) is not directly readable or writable and is only loaded via PCLATH. Four loading cases: (1) instruction with PCL as destination: PCH <- PCLATH<4:0>, PCL <- ALU result; (2) GOTO: PC<10:0> <- opcode<10:0>, PC<12:11> <- PCLATH<4:3>; (3) CALL: same as GOTO plus the return address pushed on the stack; (4) RETURN/RETFIE/RETLW: full 13-bit PC popped from the stack. PCLATH is never updated with the contents of PCH. | §6.2.4, Fig. 6-2 p. 6-5 | register | done (core) |
| P8-075 | Computed GOTO (ADDWF PCL,F): any write to PCL loads PCLATH<4:0> into PCH; a table crossing a 256-word PCL boundary needs PCLATH adjusted (there is no carry from PCL into PCH). | §6.2.4.1 p. 6-6 | failure-mode | done (core) |
| P8-076 | Stack: 8 levels x 13 bits, not part of program or data space; the stack pointer is not readable or writable. Pushed by CALL and by interrupt vectoring, popped by RETURN, RETLW, RETFIE; PCLATH is not changed by push/pop. It is circular: the 9th push overwrites push 1, the 10th overwrites push 2, etc. There are no overflow/underflow status bits and no PUSH/POP instructions. | §6.2.5, Fig. 6-3 p. 6-6 | memory | done (core) |
| P8-077 | Paging: CALL/GOTO carry 11 address bits (2K page); PCLATH<4:3> supply PC<12:11>. Return instructions pop the whole 13-bit PC, so PCLATH need not be fixed for returns. Devices with ≤ 2K words ignore PCLATH<4:3>; devices with 2K-4K ignore PCLATH<4>. (627A = 1K, 628A = 2K, 648A = 4K, so only the 648A uses PCLATH<3>.) | §6.2.6, Example 6-1 p. 6-7 | memory | done (core) |
| P8-078 | Register-to-register moves must go through W, so they take two instruction cycles. | §6.3 p. 6-8 | behaviour | todo |
| P8-079 | GPRs are not initialised by POR and are unchanged by all other resets. SFRs are static RAM; some are initialised by POR and other resets, others are unaffected. Common RAM is a region that maps to the same location regardless of bank. | §6.3.1, §6.3.2 p. 6-8 | memory | D2 |
| P8-080 | Banking: RP1:RP0 select bank 0-3 for direct addressing (7-bit address from opcode); IRP selects banks 0/1 (IRP = 0) or 2/3 (IRP = 1) for indirect addressing, with FSR<7> picking the odd/even bank. Each bank is 128 bytes (00h-7Fh); SFRs at the bottom, GPRs above; some high-use bank-0 SFRs are mirrored in other banks. | §6.3.3, Table 6-1, Fig. 6-4 p. 6-9; Fig. 6-8 p. 6-13 | memory | done (core) |
| P8-081 | Standard map (Fig. 6-5): INDF, PCL, STATUS, FSR, PCLATH, INTCON at the same offset (00h, 02h, 03h, 04h, 0Ah, 0Bh) in all four banks; TMR0 at 01h/101h and OPTION_REG at 81h/181h; PORTB at 06h/106h, TRISB at 86h/186h; PCON at 8Eh; last 16 bytes 70h-7Fh mapped across all banks (F0h-FFh, 170h-17Fh, 1F0h-1FFh access bank 0 70h-7Fh). Unimplemented locations and banks read as 0. | §6.3.3, Fig. 6-5 p. 6-10 | memory | todo |
| P8-082 | Manual Fig. 6-5 shows OSCCAL at 8Fh and some 18-pin maps (Fig. 6-6) put EEDATA/EEADR at 08h/09h and EECON1/EECON2 at 88h/89h with PCON at 87h, and say unimplemented Bank1 locations alias Bank0. DS40044G puts EEDATA/EEADR/EECON1/EECON2 at 9Ah/9Bh/9Ch/9Dh, PCON at 8Eh, has no OSCCAL, and its own GPR map (bank 0 20h-7Fh, bank 1 A0h-FFh, bank 2 120h-14Fh on 627A/628A or 120h-17Fh on 648A, bank 3 only 1F0h-1FFh; F0h-FFh, 170h-17Fh, 1F0h-1FFh are common RAM mapped to 70h-7Fh). Use the DS40044G map. | Manual Figs. 6-5, 6-6 p. 6-10/6-11 vs DS40044G Fig. 4-2..4-4 / Table 4-3 | note | info |
| P8-083 | INDF/FSR: any instruction using INDF accesses the register pointed to by IRP:FSR (9-bit effective address). Reading INDF itself indirectly (FSR = 00h) reads 00h; writing INDF indirectly is a no-operation, although status bits may be affected. | §6.3.4, Figs. 6-7, 6-8 p. 6-12/6-13 | register | done (core) |
| P8-084 | Example 6-2 clears RAM 20h-2Fh with FSR/INDF: BCF STATUS,IRP; MOVLW 0x20; MOVWF FSR; NEXT: CLRF INDF; INCF FSR,F; BTFSS FSR,4; GOTO NEXT (loop ends when FSR reaches 30h). Example 6-4 clears each bank by incrementing FSR until FSR<7> sets (20h..7Fh, 120h..17Fh with IRP = 1) or FSR wraps FFh -> 00h (A0h..FFh, 1A0h..1FFh). | §6.3.4 Example 6-2 p. 6-13; §6.4 Example 6-4 p. 6-15 | behaviour | done (core) |
| P8-085 | Manual Example 6-4 tests "BTFSS STATUS, C ; End of current bank? (FSR = 00h, C = 1)" after INCF FSR, but per the manual's own Table 5-1 INCF affects only Z, never C, so that loop would not terminate on C; the correct end test after FFh -> 00h is Z. The emulator must keep INCF from touching C even though the example implies it. | Manual Example 6-4 p. 6-15 vs Table 5-1 p. 5-3 | note | info |
| P8-086 | Bank switching examples: CLRF STATUS selects bank 0 (and clears IRP); BSF/BCF STATUS,RP0 toggles bank 0/1; MOVLW 0x60 / XORWF STATUS,F sets RP1:RP0 = 11 (bank 3) leaving other bits unchanged (XORWF affects Z only, and Z write to STATUS is from ALU logic). | §6.4 Example 6-3 p. 6-14 | behaviour | done (core) |
| P8-087 | Design tip: on devices with more than 2K words, load PCLATH before CALL/GOTO (MOVLW HIGH(SUB_1); MOVWF PCLATH; CALL SUB_1) or execution "gets lost" in the wrong page. | §6.5 Q1 p. 6-16 | failure-mode | todo |
| P8-088 | Data EEPROM is readable and writable at run time over the full VDD range; it is not mapped into the register file but accessed through EECON1, EECON2 (not a physical register), EEDATA and EEADR. Byte writes auto-erase the location first (erase-before-write). Write time is set by an on-chip timer and varies with voltage, temperature and part. | §7.1 p. 7-2 | memory | todo |
| P8-089 | The manual says only 64-byte data EEPROM parts exist (Table 7-1 note) and that the unused EEADR bits must be 0. DS40044G: 627A/628A have 128 bytes (EEADR<6:0>, bit 7 address-decoded and must be 0), 648A has 256 bytes (all 8 bits). Use DS40044G sizes. | Manual Table 7-1, §7.3 p. 7-2/7-4 vs DS40044G §13.1, Register 13-2 | note | info |
| P8-090 | Manual EECON1 has five bits: EEIF (bit 4, shown R/W-1), WRERR (bit 3), WREN (bit 2), WR (bit 1, set-only), RD (bit 0, set-only). DS40044G EECON1 has only four bits (WRERR, WREN, WR, RD; upper four read 0) and EEIF lives in PIR1<7>. Model EEIF in PIR1. | Manual Register 7-1, §7.4 p. 7-3/7-4 vs DS40044G Register 13-3, §13.2, PIR1 | note | info |
| P8-091 | RD and WR can only be set by software, never cleared by software (writes of 0 are ignored); hardware clears them when the read or write completes. This prevents premature termination of a write. WR cannot be set unless WREN = 1. | §7.2 Register 7-1, §7.4 p. 7-3/7-4; §7.6 p. 7-5 | register | todo |
| P8-092 | WREN is cleared on power-up and is never cleared by hardware (firmware should keep it clear except while writing). Clearing WREN after a write has started does not affect that write. | §7.4 p. 7-4; §7.6 p. 7-5 | register | todo |
| P8-093 | WRERR is set when a write is interrupted by MCLR reset or WDT time-out reset during normal operation; after reset, EEDATA and EEADR still hold the data and address, so firmware can check WRERR and rewrite. | §7.2, §7.4 p. 7-3/7-4 | failure-mode | todo |
| P8-094 | Reading EECON2 returns 00h; EECON2 is used only by the write unlock sequence. | §7.4 p. 7-4 | register | todo |
| P8-095 | EEPROM read: write EEADR, set EECON1.RD; data is in EEDATA in the very next instruction cycle (readable by the next instruction); RD takes one cycle and is cleared in hardware. EEDATA keeps the value until another read or until firmware writes it. | §7.5, Example 7-1 p. 7-5 | timing | todo |
| P8-096 | EEPROM write: load EEADR and EEDATA, set WREN, then exactly: MOVLW 55h; MOVWF EECON2; MOVLW AAh; MOVWF EECON2; BSF EECON1,WR - for every byte. If the sequence is not followed exactly the write does not start. Interrupts should be disabled during the sequence. On completion hardware clears WR and sets EEIF (must be cleared by software; can be polled or used as an interrupt). | §7.6, Example 7-2 p. 7-5 | behaviour | todo |
| P8-097 | DS40044G Example 13-2 adds "BCF INTCON,GIE; BTFSC INTCON,GIE; GOTO $-2" (re-check GIE, see AN576) before the 55h/AAh sequence; the manual's Example 7-2 just does BCF INTCON,GIE. The emulator must model the GIE/interrupt race that makes the re-check necessary (see P8-104). | Manual Example 7-2 p. 7-5 vs DS40044G Example 13-2 | note | info |
| P8-098 | Spurious-write protection: WREN cleared at power-up, the 72 ms Power-up Timer blocks EEPROM writes while it runs, and the unlock sequence + WREN guard against writes during brown-out, glitches or runaway code. | §7.8 p. 7-7 | behaviour | todo |
| P8-099 | With code protection on, the CPU can still read and write data EEPROM; the device programmer can no longer access it. | §7.1 p. 7-2; §7.9 p. 7-7 | behaviour | todo |
| P8-100 | Write verify: read back the location after the write (BSF EECON1,RD then SUBWF EEDATA,W; BTFSS STATUS,Z) when a cell may be stressed near its endurance limit. | §7.7, Example 7-3 p. 7-6 | behaviour | todo |
| P8-101 | Design tips: data not written - most likely the unlock sequence was not followed exactly or an interrupt hit during it. Data corrupted - inadvertent writes can happen during brown-out if the device is not held in reset; enable BOR or an external reset circuit so no EEPROM write occurs out of the operating range. | §7.11 Q1, Q2 p. 7-8 | failure-mode | todo |
| P8-102 | GIE (INTCON<7>) enables all unmasked interrupts and is cleared on reset. On an interrupt response the core clears GIE, pushes the return address, and loads PC = 0004h. RETFIE returns and sets GIE, so any still-pending interrupt is taken immediately. PEIE (INTCON<6>) must be set for any peripheral (PIE/PIR) interrupt to vector. | §8.1 p. 8-3; §8.2.2 p. 8-6 | behaviour | done (SoC) |
| P8-103 | Interrupt flag bits (INTCON T0IF/INTF/RBIF and PIR bits) are set when the condition occurs regardless of their enable bit or GIE, allowing polling. Flags must be cleared in software before re-enabling GIE (and before enabling an interrupt) to avoid recursive interrupts. | §8.1 note 1 p. 8-3; §8.2.1 note p. 8-5; §8.2.3 notes p. 8-8 | behaviour | done (SoC) |
| P8-104 | When an instruction that clears GIE executes, any interrupt that was pending for execution in the next cycle is ignored; the CPU executes a NOP in the cycle immediately after the GIE-clearing instruction. The ignored interrupts stay pending and are serviced when GIE is set again. | §8.1 note 2 p. 8-3 | timing | D3 |
| P8-105 | INTCON (all R/W-0): GIE, PEIE, T0IE, INTE, RBIE, T0IF, INTF, RBIF (bits 7..0). T0IF = TMR0 overflowed; INTF = INT edge occurred; RBIF = at least one of RB7:RB4 changed state; all flags cleared only by software. | §8.2.1 Register 8-1 p. 8-5 | register | done (SoC) |
| P8-106 | Interrupt logic (Fig. 8-1): each source is flag AND enable; peripheral sources are ORed and gated by PEIE; INTCON sources and the PEIE term are ORed. The OR of enabled flags produces "Wake-up (if in SLEEP)" independent of GIE; the same term ANDed with GIE produces "Interrupt to CPU" and clears GIE. | §8.1 Fig. 8-1 p. 8-4 | behaviour | done (SoC) |
| P8-107 | Generic PIR flag semantics relevant to the 62xA: RCIF = RCREG full, cleared when RCREG is read (not by software write); TXIF = TXREG empty, cleared when TXREG is written; TMR1IF, TMR2IF, CCP1IF, EEIF, CMIF must be cleared in software. | §8.2.3 Register 8-3 p. 8-8/8-9 | register | todo |
| P8-108 | Interrupt latency (flag set -> first instruction at 0004h starts): synchronous (internal) interrupts 3 TCY; asynchronous external interrupts (INT, RB change) 3 to 3.75 TCY depending on when the event lands in the cycle. Latency is the same for one- and two-cycle instructions. | §8.3 p. 8-10 | timing | D4 |
| P8-109 | INT timing (Fig. 8-2): INTF can be set any time during Q4-Q1; the interrupt condition is sampled every Q1. After sampling, the instruction in progress (Inst(PC)) completes, then two dummy cycles occur (Inst(PC+1) is fetched but not executed; PC+1 is pushed), then Inst(0004h) is fetched and executes on the next cycle. | §8.4 Fig. 8-2 and notes p. 8-10 | timing | done (SoC) |
| P8-110 | Manual §8.3 text gives asynchronous latency as 3-3.75 TCY, while Fig. 8-2 note 2 in the same manual says 3-4 TCY; DS40044G §14.6 says three or four instruction cycles. Use 3-4 TCY. | Manual §8.3 vs Fig. 8-2 note 2 p. 8-10; DS40044G §14.6 | note | D4 |
| P8-111 | INT pin: edge-triggered, rising if INTEDG = 1, falling if INTEDG = 0; valid edge sets INTF; INTE enables it. INT wakes the device from SLEEP if INTE was set before SLEEP; GIE then decides whether the CPU vectors to 0004h after wake-up. Other externally-caused interrupts (timers, capture, port change) have similar timing. | §8.4 p. 8-10 | behaviour | done (SoC) |
| P8-112 | Only the return PC is saved by hardware on interrupt; W and STATUS (and PCLATH, FSR, etc.) must be saved by software. Canonical save: MOVWF W_TEMP; SWAPF STATUS,W; MOVWF STATUS_TEMP. Restore: SWAPF STATUS_TEMP,W; MOVWF STATUS; SWAPF W_TEMP,F; SWAPF W_TEMP,W (SWAPF/MOVWF do not change STATUS flags). W_TEMP must be at the same offset in every bank (e.g. common RAM 70h-7Fh) because the bank is unknown at ISR entry. | §8.5, Examples 8-1, 8-2 p. 8-11/8-12 | behaviour | todo |
| P8-113 | Design tips: an algorithm gives wrong results when registers shared with the ISR are not saved/restored; the system "locks up" if an interrupt flag is not cleared before RETFIE, because execution immediately re-enters the ISR while an enabled flag is still set. | §8.7 Q1, Q2 p. 8-16 | failure-mode | todo |
| P8-114 | TRIS bit = 1 makes the pin an input (output driver hi-Z); TRIS = 0 drives the PORT latch value onto the pin. Reading PORT returns the pin levels, not the latch; writing PORT writes the latch. When a peripheral is active on a pin it generally cannot be used as GPIO. | §9.1 p. 9-2; §9.2, §9.3 p. 9-4/9-6 | pin | done (SoC) |
| P8-115 | Typical I/O pin structure (Fig. 9-1): D-latch for data and TRIS, P/N CMOS output stage, TTL or Schmitt input buffer feeding a latch enabled by RD PORT; protection diodes to VDD and VSS. | §9.1 Fig. 9-1 p. 9-2 | pin | todo |
| P8-116 | All writes to ports (BSF, BCF, etc.) are read-modify-write: the pins are read, modified, and written to the data latch. With some peripherals the TRIS bit is overridden while the peripheral is enabled, so RMW instructions (BSF, BCF, XORWF) on TRIS should be avoided. | §9.1 p. 9-2/9-3; §9.10.1 p. 9-14 | failure-mode | todo |
| P8-117 | Pins multiplexed with comparator inputs are configured as analog inputs at Power-on Reset (controlled by CMCON); a pin configured as analog reads 0 regardless of its voltage (its digital input buffer is disabled). TRIS still controls direction on analog pins and must be kept set (input) for analog use; an analog-configured pin set as output can still be driven, but always reads 0, so RMW on the port writes 0 into those latches. | §9.1 note 2 p. 9-3; §9.12 Q4.2 p. 9-18 | pin | done (SoC) |
| P8-118 | RA4 is a Schmitt-trigger input and an open-drain output (N-channel only, protection diode to VSS only, no diode to VDD); it can only drive low or float and needs an external pull-up, which may go to a voltage other than VDD. Other RA pins are TTL input / full CMOS output in the manual's generic description. | §9.2 p. 9-4; Fig. 9-3 p. 9-5; §9.12 Q2.3 p. 9-17 | pin | todo |
| P8-119 | Manual Example 9-1 comments "TRISA<7:6> always read as '0'" for a 6-bit PORTA; on the 62xA PORTA is 8 bits (RA6/RA7 shared with OSC2/OSC1), TRISA resets to 1111 1111 and TRISA<7:6> are overridden by the oscillator mode (DS40044G §5.1). Do not force TRISA<7:6> to 0. | Manual §9.2 Example 9-1 p. 9-4 vs DS40044G §5.1, Table 4-3 | note | info |
| P8-120 | PORTB weak pull-ups: one control bit (RBPU = 0, OPTION<7>) turns on all pull-ups; each pull-up is automatically off when its pin is an output; pull-ups are disabled on POR (OPTION = FFh). To enable a pull-up, set the TRIS bit and clear RBPU. | §9.3 p. 9-6; Figs. 9-4, 9-5 notes | pin | done (SoC) |
| P8-121 | RB0/INT: the PORTB data path uses a TTL buffer but the INT path uses a Schmitt trigger. Design tip: an input of e.g. 3 V at VDD = 5 V reads as 1 on PORTB but may not trigger INT, since the Schmitt threshold is higher (deliberately, so noise does not cause interrupts). | §9.3 Fig. 9-4 p. 9-6; §9.12 Q3 p. 9-17 | pin | todo |
| P8-122 | RB7:RB4 interrupt-on-change: only pins configured as inputs take part (outputs are excluded from the compare). Each input is compared with the value latched on the last read of PORTB; the mismatch outputs are ORed to set RBIF (INTCON<0>). Fig. 9-5 shows the two latches in the compare path enabled by RD PORT and by Q1/Q3, and notes that in Sleep the device is held in Q1. | §9.3 p. 9-7; Fig. 9-5 and note 3 p. 9-7 | behaviour | done (SoC) |
| P8-123 | Clearing the RB change interrupt: (a) any read or write of PORTB ends the mismatch condition, then (b) clear RBIF. While the mismatch persists RBIF keeps being set again, so clearing RBIF without reading/writing PORTB does not stick. RB change can wake the device from SLEEP. Polling PORTB while using interrupt-on-change is not recommended (a read clears the mismatch and can lose a change). | §9.3 p. 9-7 | failure-mode | done (SoC) |
| P8-124 | In serial programming mode RB7:RB6 are used as programming data/clock (Fig. 9-5 path "RB7:RB6 in serial programming mode", ST buffer). | §9.3 Fig. 9-5 p. 9-7; Table 4-1 p. 4-9 | pin | todo |
| P8-125 | Peripheral output override (Fig. 9-6 style): a port/peripheral select mux chooses between the port latch and peripheral data-out; peripheral OE overrides the TRIS output enable only when peripheral select is active. Some peripherals force a pin to output, others force input. | §9.4 Fig. 9-6 p. 9-8 | pin | todo |
| P8-126 | RMW example (Example 9-9): PORTB<7:4> inputs with external pull-ups, PORTB<3:0> outputs. BCF PORTB,7 -> latch 01pp pppp (RB6 reads 1 from pin); BCF PORTB,6 -> latch 10pp pppp (RB7 re-latched as pin value 1); after BCF TRISB,7 and BCF TRISB,6 the pins become 10pp pppp, not the expected 00pp pppp. | §9.10.1 Example 9-9 p. 9-14 | failure-mode | done (SoC) |
| P8-127 | An output pin actively driving low or high must not be simultaneously driven by an external device to change its level ("wired-OR / wired-AND"); the resulting high currents may damage the chip. | §9.10.1 p. 9-14 | electrical | todo |
| P8-128 | Successive port operations: the port write happens at the end of the instruction cycle (Q4), while for a read the data must be valid at the beginning of the instruction cycle (Fig. 9-12). For MOVWF PORTB followed by MOVF PORTB,W the data setup time is 0.25 TCY - TPD, so at high clock rates or with large load capacitance the read returns the old pin state. Fix: insert a NOP (or unrelated instruction), or add a series resistor. | §9.10.2 Fig. 9-12 p. 9-15 | timing | done (SoC) |
| P8-129 | Capacitive load RMW (Fig. 9-13): BSF PORTx,PINy then BSF PORTx,PINz - if PINy has not risen above VIL by the read of the second instruction, PINy is read low and the second BSF clears it in the latch. Design-tip example: 20 MHz, LEDs with 100 µF across each, BSF PORTC,0; BSF PORTC,1; ... leaves only the last pin set. | §9.10.2 Fig. 9-13 p. 9-15; §9.12 Q4.1 p. 9-18 | failure-mode | todo |
| P8-130 | Port initialisation should write the PORT data latch first, then TRIS, because the latches power up in a random state and writing TRIS first can glitch the pins. | §9.11 note p. 9-16 | pin | todo |
| P8-131 | A port read always returns the pin, regardless of input or output: an output pin with latch = 1 shorted to ground reads 0 (useful for detecting bus conflicts such as I2C-style open-drain sharing). | §9.12 Q2 p. 9-17 | behaviour | todo |
| P8-132 | Design tip checklist for "ports do not toggle": TRIS written without selecting bank 1 (BSF STATUS,RP0); not returning to bank 0 before writing PORT; a peripheral enabled on the pins; WDT enabled but not cleared at least every 9 ms (more if prescaled); MOVF used instead of MOVWF; interrupts interfering. | §9.12 Q1 p. 9-17 | failure-mode | todo |
| P8-133 | Manual design tip quotes a 9 ms minimum WDT clearing interval; DS40044G gives TWDT = 18 ms nominal (7 ms min, 33 ms max at VDD = 5 V, -40..85°C). Use DS40044G parameter 31. | Manual §9.12 Q1.4 p. 9-17 vs DS40044G §14.7.1, parameter 31 | note | info |
| P8-134 | WDT is a free-running on-chip RC oscillator, separate from the OSC1/CLKIN oscillator, needing no external parts; it keeps running when the main clock stops (e.g. in SLEEP). It is enabled by the WDTE configuration bit, and once enabled firmware cannot disable it. | §26.1 p. 26-2; §26.3 p. 26-4 | behaviour | done (SoC) |
| P8-135 | Prescaler sharing (Fig. 26-1): one 8-bit prescaler is assigned by PSA to either TMR0 (as prescaler) or the WDT (as postscaler); PS2:PS0 drive an 8-to-1 mux. When PSA = 1 the TMR0 clock bypasses the prescaler (1:1), when PSA = 0 the WDT time-out bypasses it. | §26.1 Fig. 26-1 p. 26-2; Register 26-1 p. 26-3 | behaviour | done (SoC) |
| P8-136 | WDT time-out in normal operation causes a device RESET; in SLEEP it causes a WDT wake-up (execution continues after SLEEP). TO is cleared on any WDT time-out (reset or wake-up). | §26.3 p. 26-4; §26.3.1 p. 26-6 | behaviour | done (SoC) |
| P8-137 | Changing the prescaler from Timer0 to the WDT must use Example 26-1 even if the WDT is disabled, because the prescaler count is unknown and an unplanned WDT reset can follow: (optional, only if final ratio is 1:1) write OPTION with a temporary non-1:1 ratio; CLRF TMR0 (clears TMR0 and prescaler); write OPTION with PSA = 1; CLRWDT; write OPTION with final ratio. WDT -> Timer0: CLRWDT, then write OPTION with PSA = 0 and new ratio (Example 26-2). | §26.3, Examples 26-1, 26-2 p. 26-4/26-5 | failure-mode | todo |
| P8-138 | WDT period: nominal 18 ms with no postscaler, varying with temperature, VDD and process; up to 1:128 postscaler gives up to about 2.3 s. Worst case (minimum VDD, maximum temperature, maximum postscaler) may take several seconds. | §26.3.1, §26.3.2 p. 26-6 | timing | done (SoC) |
| P8-139 | CLRWDT and SLEEP both clear the WDT and the postscaler (if assigned to the WDT). With the postscaler assigned to the WDT, always execute CLRWDT before changing the postscale value, otherwise a WDT reset may occur. | §26.3.1, §26.3.2 note p. 26-6 | behaviour | done (SoC) |
| P8-140 | SLEEP entry: WDT (if enabled) is cleared but keeps running, PD is cleared, TO is set, the oscillator driver is turned off (no system clocks). I/O ports keep the state they had before SLEEP (driving high, low, or hi-Z). | §26.4 p. 26-7 | behaviour | done (SoC) |
| P8-141 | Lowest Sleep current: all I/O at VDD or VSS with no external load, hi-Z inputs pulled high or low externally (floating inputs cause switching current), T0CKI at VDD or VSS, account for PORTB pull-up current, peripherals with delta sleep current disabled; MCLR must be at logic high (VIHMC). WDT and BOR add delta sleep current and are set by configuration bits. | §26.4 p. 26-7 | electrical | todo |
| P8-142 | Wake-up sources: any device reset (MCLR, which resets the device), WDT wake-up (if enabled), or any interrupt source that can set its flag in Sleep (on the 62xA: INT pin, PORTB change, comparators, Timer1 async, CCP capture, etc.). WDT and interrupt wake-ups resume execution rather than reset. | §26.4.1 p. 26-7 | behaviour | todo |
| P8-143 | While SLEEP executes, the next instruction (PC+1) is pre-fetched. Interrupt wake-up requires the source's individual enable bit; it happens regardless of GIE. GIE = 0: execution continues at PC+1. GIE = 1: the instruction at PC+1 is executed first, then the CPU branches to 0004h. Put a NOP after SLEEP if executing PC+1 is undesirable. | §26.4.1 p. 26-7 | behaviour | done (SoC) |
| P8-144 | SLEEP with GIE = 0 and a source whose enable and flag are both set: if the interrupt condition arises before SLEEP executes, SLEEP completes as a NOP - the WDT and postscaler are not cleared, TO is not set and PD is not cleared. If it arises during or after SLEEP, the device wakes immediately after SLEEP has fully executed (WDT/postscaler cleared, TO = 1, PD = 0). Firmware detects the NOP case by PD still being 1. Execute CLRWDT before SLEEP to guarantee the WDT is clear. | §26.4.2 p. 26-8 | behaviour | done (SoC) |
| P8-145 | Wake-up through interrupt timing (Fig. 26-2, XT/HS/LP): SLEEP executes in the cycle after its fetch, during which PC+1 is fetched; processor stays in Sleep; the INT edge sets INTF; the oscillator restarts and the OST waits TOST = 1024 TOSC; then Inst(PC+1) executes (Inst(PC+2) fetched), followed by two dummy cycles (with GIE = 1), then Inst(0004h) is fetched and executed. | §26.4.2 Fig. 26-2 p. 26-8 | timing | todo |
| P8-146 | Manual Fig. 26-2 note 2 says the TOST delay "will not be there for RC osc mode"; DS40044G Fig. 14-17 note 2 says approximately 1 µs delay for RC oscillator mode, and DS40044G Table 14-3 gives 6 µs wake-up for INTOSC. Use DS40044G. | Manual Fig. 26-2 note 2 p. 26-8 vs DS40044G Fig. 14-17, Table 14-3 | note | info |
| P8-147 | DS40044G §14.8.1 adds that the WDT is cleared when the device wakes from Sleep regardless of the wake-up source; the manual only states that SLEEP itself clears the WDT. Model both. | Manual §26.3.1, §26.4 vs DS40044G §14.8.1 | note | info |
| P8-148 | Design tips: the WDT is not a brown-out recovery mechanism (use BOR or external circuit); a CLRWDT loop must meet the minimum WDT period, not the typical; on power-up allow for the variable OST time (placing CLRWDT at the start of the loop can help). | §26.6 Q1-Q3 p. 26-10 | failure-mode | todo |
| P8-149 | Configuration word is at program-memory address 2007h, readable/writable only in programming mode (not by firmware); programmed bit = 0, unprogrammed = 1. Flash parts can erase and reprogram it. The device cannot read its own configuration bits at run time. | §27.1 p. 27-2; §27.2 p. 27-4 | memory | todo |
| P8-150 | Configuration bit polarities in the manual: BODEN 1 = BOR on; PWRTE 1 = PWRT off, 0 = on; MCLRE 1 = pin is MCLR, 0 = pin is digital I/O with MCLR internally tied to VDD; WDTE 1 = WDT on; DP 1 = data EEPROM protection off; CP 1 = protection off (one-bit variant). Unimplemented configuration bits read as 1. | §27.2 p. 27-4/27-5 | register | todo |
| P8-151 | Manual §27.2 (BODEN and PWRTE notes) says enabling Brown-out Reset automatically enables the PWRT regardless of PWRTE; DS40044G Register 14-1 note 1 says enabling BOR does NOT automatically enable PWRT on the 62xA (it did on PIC16F627/628). The 62xA BOR delay is 72 ms only when PWRTE = 0. | Manual §27.2 p. 27-4 vs DS40044G Register 14-1 note 1, Fig. 14-7 note | note | info |
| P8-152 | Manual: unimplemented configuration bits read as '1', code protection by CP1:CP0 (or one CP0 bit) plus DP for data EEPROM. DS40044G: bits 12-9 unimplemented read as '0'; single CP (bit 13) and CPD (bit 8); LVP at bit 7; protected program memory reads out as 0; only a bulk erase can clear protection and it erases the whole Flash and data EEPROM. Follow DS40044G. | Manual §27.2, §27.3 vs DS40044G Register 14-1, §14.9 | note | info |
| P8-153 | ID locations 2000h-2003h: four words for checksum or code ID, not accessible at run time, readable/writable during program/verify; only the 4 LSbs of each should be used. | §27.4 p. 27-9 | memory | todo |
| P8-154 | If code protection is on, program memory cannot be read out for verification (design tip: a protected part reads scrambled data or all 0s). | §27.3 p. 27-8; §27.5 Q1 p. 27-10 | behaviour | todo |
| P8-155 | ICSP uses two signal lines (clock, data) plus power, ground and programming voltage. Program/verify mode entry: hold RB6 and RB7 low while raising MCLR/VPP from VIL to VIHH with VDD at the programming voltage. RB6 = programming clock, RB7 = programming data; both are Schmitt-trigger inputs in this mode, and RB7 is a CMOS output when the device drives verify data. | §28.1 p. 28-2; §28.2 p. 28-3 | pin | todo |
| P8-156 | After entering program/verify mode the PC is at 00h; the programmer sends a 6-bit command, and some commands are followed by 14 bits of data written to or read from the device. While in ICSP mode the WDT cannot generate a device reset. | §28.2 p. 28-3 | behaviour | todo |
| P8-157 | During programming MCLR/VPP is driven to about 13 V and also to ground, so the application circuit must be isolated from it; with an RC on MCLR, use a Schottky-diode isolation circuit (Fig. 28-1) because a resistor alone usually cannot isolate VPP. | §28.3 p. 28-4, Fig. 28-1 | electrical | todo |
| P8-158 | RB6 (clock, driven by the programmer) and RB7 (bidirectional: programmer when programming, device when verifying) must be isolated from application loading; programmer output impedance matters (PRO MATE II = 1 kΩ). Preferred use of RB6/RB7: (1) dedicate to ICSP, (2) outputs with minimal load, (3) isolation circuitry. | §28.3 p. 28-4 | pin | todo |
| P8-159 | Programming is specified at VDD = 5 V; verify should be done at the minimum and maximum VDD of the application (e.g. 2.7 V and 4.5 V for 3 x 1.5 V cells). Large VDD capacitance (hundreds of µF) needs a strong driver to meet VDD rise-rate timing. | §28.3 p. 28-5; §28.4 p. 28-6 | electrical | todo |
| P8-160 | Failure mode, slow VPP rise: crystal modes are safe because the OST waits 1024 oscillations before code runs, but RC oscillators have no OST; if the RC oscillator toggles four or more times (one instruction cycle) before MCLR/VPP reaches the program-mode entry voltage, the PC increments to some X and the programmer writes the image at offset X. Fixes: leave the MCLR R unpopulated while programming, or hold OSC1 at ground during programming. | §28.3 p. 28-5; §28.9 Q1 p. 28-12 | failure-mode | todo |
| P8-161 | ICSP signal integrity: long or unshielded cables, application circuitry and large VDD capacitance can violate voltage/timing at the device and cause wrong programming. | §28.5 p. 28-6; §28.9 Q2 p. 28-12 | failure-mode | todo |
| P8-162 | Programming can only change 1 bits to 0 (not 0 to 1) without erase; NOP is the all-zero word 0000h, and an erased location reads 3FFFh. Flash parts can be reprogrammed in the field even when code-protected (after erase). | §28.7, Example 28-2 p. 28-8/28-9; §28.8 p. 28-10 | memory | todo |
| P8-163 | The manual's ICSP section covers only high-voltage entry (VPP on MCLR). DS40044G adds Low-Voltage Programming: with LVP = 1 (erased default) RB4/PGM is dedicated to programming (no GPIO, no RB4 interrupt-on-change or pull-up) and a 1 on RB4/PGM enters programming mode; LVP can only be cleared when entered with VIHH; once LVP = 0 only HV programming works; VDD must be 5.0 V +10% during erase. | Manual §28.2 p. 28-3 vs DS40044G §14.11, §14.12, Table 3-2 | note | info |
| P8-164 | Instruction timing: one instruction cycle = 4 oscillator periods; at 4 MHz a normal instruction takes 1 µs and a taken skip / PC-changing instruction 2 µs. | §29.1 p. 29-2 | timing | done (core) |
| P8-165 | Don't-care (x) bits in encodings: the assembler emits 0, but the decoder must accept either value (CLRW 00 0001 0xxx xxxx, NOP 00 0000 0xx0 0000, MOVLW 11 00xx, RETLW 11 01xx, ADDLW 11 111x, SUBLW 11 110x). Any unused opcode is reserved and "may cause unexpected operation". | §29.2 note 1, Table 29-2 p. 29-4/29-5 | behaviour | D1 |
| P8-166 | OPTION instruction: 00 0000 0110 0010, W -> OPTION register, 1 cycle, no flags; kept for PIC16C5X compatibility (OPTION_REG is directly addressable). TRIS f: 00 0000 0110 0fff with 5 ≤ f ≤ 7, W -> TRIS register f (TRISA/TRISB/TRISC), 1 cycle, no flags; bank-independent (no need to select bank 1). Both are discouraged for upward compatibility but are part of the core. | §29.5 OPTION p. 29-32, TRIS p. 29-42; §29.6 Q2, Q3 p. 29-45 | behaviour | todo |
| P8-167 | Manual §29.3.1 says CLRF STATUS clears STATUS and then sets Z, "leaving 0000 0100b"; the same manual's §5.6 and DS40044G §4.2.2.1 say the result is 000u u1uu (TO, PD, DC, C unchanged - TO/PD are not writable and the C/DC writes are disabled when STATUS is the destination). Model 000u u1uu. | Manual §29.3.1 p. 29-6 vs §5.6 p. 5-6 and DS40044G §4.2.2.1 | note | info |
| P8-168 | Manual §29.3.1 also mentions an "OV" bit being set/cleared when STATUS is the destination; mid-range STATUS has no OV bit (Register 3-2 / 5-1, DS40044G Register 4-1). Ignore OV. | Manual §29.3.1 p. 29-6 vs Register 5-1 p. 5-7 | note | info |
| P8-169 | PCL as source/destination: read PCL -> dest, PCLATH unchanged; write PCL -> PCLATH<4:0> to PCH and the 8-bit value to PCL; read-modify-write PCL (e.g. ADDWF PCL,F) -> PCL is the ALU operand, PCLATH -> PCH, 8-bit result -> PCL. Example ADDWF PCL with W = 10h, PCL = F7h: PCL = 07h, C = 1, PCH is from PCLATH (no carry into PCH). | §29.3.2 p. 29-6; ADDWF Example 3 p. 29-9 | register | done (core) |
| P8-170 | Bit instructions (BCF/BSF) read the whole register, modify one bit, write it back (R-M-W). Status/flag bits that the hardware sets or clears (including interrupt flags) change in Q1, so R-M-W on registers holding them (e.g. BCF INTCON,x; BCF PIR1,x) does not lose a hardware update made during the instruction. | §29.3.3 and note p. 29-6 | timing | todo |
| P8-171 | Q-cycle detail, 1-cycle file ops (ADDWF, ANDWF, COMF, DECF, INCF, IORWF, MOVF, RLF, RRF, SUBWF, SWAPF, XORWF): Q1 decode, Q2 read register f, Q3 process data, Q4 write to destination (W or f). BCF/BSF: Q2 read f, Q4 write f. CLRF and MOVWF also show Q2 "read register f" and Q4 write f. CLRW: Q2 read (shown as register f), Q4 write W. | §29.5 instruction pages p. 29-8..29-44 | timing | done (core) |
| P8-172 | Q-cycle detail, literal ops (ADDLW, ANDLW, IORLW, MOVLW, SUBLW, XORLW): Q1 decode, Q2 read literal k, Q3 process, Q4 write W. RETLW cycle 1: Q2 read k, Q4 write W; cycle 2: all NOP. | §29.5 p. 29-8..29-43; RETLW p. 29-34 | timing | done (core) |
| P8-173 | Q-cycle detail, branches: CALL/GOTO cycle 1 = decode, read literal k, process, Q4 no operation; cycle 2 = four NOPs. CALL pushes PC+1 (13 bits) then loads PC<10:0> = k, PC<12:11> = PCLATH<4:3>. RETURN and RETFIE cycle 1 = decode, Q2 NOP, Q3 process, Q4 NOP; cycle 2 = NOPs. RETFIE loads PC from TOS and sets GIE. | §29.5 CALL p. 29-16, GOTO p. 29-23, RETFIE p. 29-33, RETURN p. 29-35 | timing | done (core) |
| P8-174 | Q-cycle detail, skips: BTFSC/BTFSS cycle 1 = decode, read f, process, Q4 no operation; DECFSZ/INCFSZ cycle 1 = decode, read f, process, write destination (the decremented/incremented value is written even when skipping). When the skip is taken, the already-fetched next instruction is discarded and a second cycle of four NOPs executes. DECFSZ/INCFSZ affect no status bits. | §29.5 BTFSC p. 29-14, BTFSS p. 29-15, DECFSZ p. 29-22, INCFSZ p. 29-25 | timing | done (core) |
| P8-175 | Q-cycle detail, CLRWDT: Q1 decode, Q2 NOP, Q3 process, Q4 clear WDT counter; it clears the WDT, the WDT prescaler count, and sets TO = 1, PD = 1; the prescaler assignment and ratio (e.g. 1:128) are unchanged. | §29.5 CLRWDT p. 29-19 | timing | todo |
| P8-176 | Q-cycle detail, SLEEP: Q1 decode, Q2 NOP, Q3 NOP, Q4 go to sleep. Operation: WDT = 0, WDT prescaler count = 0, TO = 1, PD = 0, oscillator stopped; the prescaler assignment is unchanged. | §29.5 SLEEP p. 29-38 | timing | todo |
| P8-177 | NOP Q-cycles: Q1 decode, Q2-Q4 no operation; PC advances by 1. | §29.5 NOP p. 29-31 | timing | done (core) |
| P8-178 | Flag semantics from the worked examples: SUBLW/SUBWF set C = 1 when the result is positive or zero (no borrow) and C = 0 when negative (e.g. SUBLW 02h with W = 03h -> W = FFh, C = 0, Z = 0; SUBWF REG1 with REG1 = 1, W = 2 -> FFh, C = 0); ADDWF PCL overflow sets C; MOVF f,1 rewrites f with itself and sets Z if f = 0 (used to test a register); COMF FFh -> 00h, Z = 1; DECF 01h -> 00h, Z = 1; INCF FFh -> 00h, Z = 1 (C unchanged). | §29.5 SUBLW p. 29-39, SUBWF p. 29-40, MOVF p. 29-29, COMF p. 29-20, DECF p. 29-21, INCF p. 29-24 | behaviour | done (core) |
| P8-179 | Rotate examples (test vectors): RLF 1110 0110 with C = 0 -> 1100 1100, C = 1; RLF 0011 1010 with C = 1 -> 0111 0101, C = 0; RLF 1011 1001 with C = 0 -> 0111 0010, C = 1; RRF 1110 0110 with C = 0 -> 0111 0011, C = 0; RRF 0011 1010 with C = 1 -> 1001 1101, C = 0; RRF 0011 1001 with C = 0 -> 0001 1100, C = 1. RLF/RRF affect only C (not Z). | §29.5 RLF p. 29-36, RRF p. 29-37 | behaviour | done (core) |
| P8-180 | Indirect examples (test vectors) with FSR = C2h: ADDWF INDF,1 W = 17h, [C2h] = 20h -> 37h; BCF INDF,3 2Fh -> 27h; BSF INDF,3 20h -> 28h; COMF INDF,1 AAh -> 55h; DECF INDF,1 01h -> 00h Z = 1; INCF INDF,1 FFh -> 00h Z = 1; IORWF INDF,1 W = 17h, 30h -> 37h; SWAPF INDF,1 20h -> 02h; XORWF INDF,1 W = B5h, AFh -> 1Ah; MOVWF INDF W = 17h -> 17h; CLRF INDF -> 00h, Z = 1. | §29.5 p. 29-9..29-44 | behaviour | done (core) |
| P8-181 | Manual instruction examples with wrong results (do not use as test vectors): ANDWF INDF,1 with W = 17h and [FSR] = 5Ah shows 15h (correct 17h AND 5Ah = 12h); IORLW MYREG with W = 9Ah, k = 37h shows 9Fh (correct BFh); XORLW MYREG with W = AFh, k = 37h shows 18h (correct 98h); BTFSS lists operand range 0 ≤ b < 7 (b is 0..7 per Table 29-2). | Manual §29.5 ANDWF p. 29-11, IORLW p. 29-26, XORLW p. 29-43, BTFSS p. 29-15 | note | done (core) |
| P8-182 | RETLW table idiom: CALL TABLE with W = offset; TABLE: ADDWF PCL,F; RETLW k1; RETLW k2; ... With W = 07h the call returns with W = k8 and PC = return address. Table must not cross a 256-word boundary unless PCLATH is adjusted. | §29.5 RETLW Example p. 29-34; §6.2.4.1 p. 6-6 | behaviour | done (core) |
| P8-183 | Design tip: W can be decremented with ADDLW 0xFF; DECF f,W decrements and moves to W in one instruction. | §29.6 Q1 p. 29-45 | note | info |
| P8-184 | R-M-W pitfall worked example: TRISB all outputs, PORTB = FFh; switch RB3 to input (pin goes low); BCF PORTB,6 reads the whole port (RB3 = 0) and writes RB3's latch to 0; switching RB3 back to output now drives low although 1 was last written. Any instruction that depends on the register's current value (ADDWF, SUBWF, BCF, BSF, INCF, XORWF, ...) is R-M-W. | §29.6 Q4 p. 29-45 | failure-mode | todo |
| P8-185 | Manual §29.6 Q4 says MOVWF and CLRF are not R-M-W instructions, but its own Q-cycle tables show both reading register f in Q2, and DS40044G §15.1 states every instruction that names a file register performs a read even if it only writes - e.g. CLRF PORTB reads PORTB and so clears the RB4-RB7 change mismatch (losing a pending RBIF condition). Model the read (with read side-effects such as the PORTB mismatch latch update) for CLRF and MOVWF. | Manual §29.6 Q4 p. 29-45 vs §29.5 CLRF p. 29-17, MOVWF p. 29-30; DS40044G §15.1 | note | done (core) |

## DS33023A (reference manual): Timer0/1/2, CCP, USART, voltage reference, comparators

| ID | Item | Source | Kind | Status |
|---|---|---|---|---|
| P9-001 | Timer0: 8-bit timer/counter, readable and writable, 8-bit software-programmable prescaler, internal or external clock, interrupt on overflow FFh→00h, edge select for external clock | §11.1, p.11-2 | behaviour | todo |
| P9-002 | A 1:1 Timer0 rate is obtained only by assigning the prescaler to the WDT (PSA=1); with prescaler on Timer0 the minimum ratio is 1:2 | §11.1 Note, §11.2 Note, pp.11-2/11-3 | behaviour | todo |
| P9-003 | Block diagram (Fig 11-1): source mux FOSC/4 vs T0CKI (XOR'd with T0SE) → prescaler or bypass (PSA) → "Sync with internal clocks (2 cycle delay)" → TMR0 → T0IF on overflow | Fig 11-1, p.11-2 | behaviour | todo |
| P9-004 | OPTION_REG all bits R/W, reset value 1 (RBPU, INTEDG, T0CS, T0SE, PSA, PS2:PS0 = 1111 1111): after reset Timer0 is in counter mode on T0CKI falling edge with prescaler 1:128 assigned to WDT | Reg 11-1, p.11-3 | register | todo |
| P9-005 | T0CS=1: increment on T0CKI transition; T0CS=0: internal instruction cycle clock. T0SE=1 increments on high-to-low, T0SE=0 on low-to-high | Reg 11-1, §11.3, pp.11-3/11-4 | register | todo |
| P9-006 | PS2:PS0 table: TMR0 rates 1:2,1:4,1:8,1:16,1:32,1:64,1:128,1:256; WDT rates 1:1,1:2,1:4,1:8,1:16,1:32,1:64,1:128 for codes 000…111 | Reg 11-1, p.11-3 | register | todo |
| P9-007 | Timer mode without prescaler: TMR0 increments every instruction cycle | §11.3, p.11-4 | behaviour | todo |
| P9-008 | Any write to TMR0 inhibits incrementing for the following 2 instruction cycles (2 TCY); TMR0 does not increment until the third instruction cycle after the write | §11.3, p.11-4 | timing | todo |
| P9-009 | Fig 11-2 (internal clock, no prescale): TMR0 runs T0, T0+1, T0+2; MOVWF TMR0 executes; the next three MOVF TMR0,W (cycles PC+2, PC+3, PC+4) all read NT0; the 4th read after the write reads NT0+1, the 5th NT0+2 | Fig 11-2, p.11-4 | timing | todo |
| P9-010 | With the prescaler assigned to Timer0, a write to TMR0 updates TMR0 immediately and clears the prescaler; incrementing of both TMR0 and prescaler is also inhibited 2 TCY. With 1:2 prescale TMR0 does not increment for 4 Timer0 clocks after the write, then increments every 2 clocks | §11.3, p.11-4 | timing | todo |
| P9-011 | Fig 11-3 (internal clock, prescale 1:2): after MOVWF TMR0, four successive MOVF TMR0,W read NT0 and the fifth reads NT0+1 | Fig 11-3, p.11-4 | timing | todo |
| P9-012 | All instructions writing TMR0 (CLRF, MOVWF, BSF TMR0,x …) clear the prescaler when it is assigned to Timer0; CLRWDT clears the prescaler when it is assigned to the WDT. Prescaler is neither readable nor writable | §11.6, p.11-7 | behaviour | todo |
| P9-013 | One prescaler, mutually exclusively shared: assigned to Timer0 means no WDT postscaler and vice versa | §11.6 Note, p.11-7 | behaviour | todo |
| P9-014 | Overflow FFh→00h sets T0IF (INTCON<2>); maskable by T0IE (INTCON<5>); T0IF must be cleared in software | §11.4, p.11-5 | behaviour | todo |
| P9-015 | TMR0 interrupt cannot wake the processor from SLEEP: the timer is shut off during SLEEP | §11.4, p.11-5 | behaviour | todo |
| P9-016 | Fig 11-4 TMR0 interrupt timing: T0IF sets as Timer0 goes FFh→00h; T0IF is sampled every Q1; GIE clears; after Inst(PC) executes there are two dummy cycles, then Inst(0004h) executes. Interrupt latency = 4 TCY | Fig 11-4 Notes 1-2, p.11-5 | timing | todo |
| P9-017 | Device data sheet gives interrupt latency as 3 TCY synchronous / 3-4 TCY asynchronous (and same for 1- or 2-cycle Inst(PC)); manual Fig 11-4 says 4 TCY for TMR0. Use DS40044G Fig 14-15 Note 2 for the 62xA | DS33023A Fig 11-4 Note 2 p.11-5 vs DS40044G Fig 14-15 Note 2 p.110 | note | info |
| P9-018 | CLKOUT is shown in TMR0 interrupt timing but is available only in RC oscillator mode (manual); 62xA: RC and INTOSC modes | Fig 11-4 Note 3, p.11-5; DS40044G Fig 14-15 Note 3 | note | info |
| P9-019 | External clock, no prescaler: prescaler output (= T0CKI) is sampled on Q2 and Q4 of the internal phase clocks; T0CKI must be high ≥ 2 TOSC + 20 ns and low ≥ 2 TOSC + 20 ns (params 40, 41) | §11.5.1, p.11-6 | timing | todo |
| P9-020 | External clock with prescaler: asynchronous ripple-counter prescaler gives symmetrical output; T0CKI period must be ≥ (4 TOSC + 40 ns)/prescale value; high and low time only need ≥ 10 ns minimum pulse width (param 42) | §11.5.1, p.11-6 | timing | todo |
| P9-021 | Delay from T0CKI (or prescaler output) edge to Timer0 increment is 3 TOSC to 7 TOSC; Timer0 increments on Q4; error in measuring the interval between two edges = ±4 TOSC max | §11.5.2, Fig 11-5 Note 1, p.11-6 | timing | todo |
| P9-022 | A pulse shorter than the Q2/Q4 sampling spacing can miss sampling entirely and produce no increment (Fig 11-5 "small pulse misses sampling") | Fig 11-5, p.11-6 | failure-mode | todo |
| P9-023 | Device data sheet param 48 (TCKEZTMR1, delay from external clock edge to timer increment) is 2 TOSC min … 7 TOSC max; manual states 3 TOSC … 7 TOSC for Timer0 | DS33023A Fig 11-5 Note 1 p.11-6 vs DS40044G Table 17-8 param 48 | note | info |
| P9-024 | Prescaler assignment can be changed on the fly. Changing Timer0→WDT requires a specific sequence (even if the WDT is disabled) or an unintended device reset can occur | §11.6.1 Note, p.11-8 | failure-mode | todo |
| P9-025 | Manual Example 11-1 (Timer0→WDT): optionally set a temporary non-1:1 prescale in OPTION; CLRF TMR0 (clears TMR0 + prescaler); set PSA=1 without changing prescale; CLRWDT; then write final prescale. Temporary step needed only if final value is 1:1 | Ex 11-1, p.11-8 | behaviour | todo |
| P9-026 | Order differs: DS40044G Example 6-1 does CLRWDT, CLRF TMR0, then (only if final PS<2:0> is 000 or 001) writes OPTION '00101111', CLRWDT, then writes final '00101xxx'. Manual Ex 11-1 does CLRF TMR0 before any CLRWDT, and its line 6 sets RP1 instead of RP0 (typo). Emulator must give the same result for both sequences (no spurious WDT reset) | DS33023A Ex 11-1 p.11-8 vs DS40044G Ex 6-1 p.49 | note | **decide** |
| P9-027 | WDT→Timer0: CLRWDT (clears WDT and prescaler), then write OPTION with PSA=0 and new prescale/clock source | Ex 11-2, p.11-8 | behaviour | todo |
| P9-028 | Design tip: polling TMR0 for zero (MOVF/BTFSS Z/GOTO) can miss the rollover when TMR0 runs at instruction rate because overflow can occur during the 2-cycle GOTO; prescale or test "below a nominal value" instead | §11.7 Q1 item 1, p.11-10 | failure-mode | todo |
| P9-029 | Design tip: writing TMR0 loses 2 instruction cycles; to count 100 cycles write 158 (not 156 = 256-100) | §11.7 Q1 item 2, p.11-10 | timing | todo |
| P9-030 | Timer1: 16-bit TMR1H:TMR1L, R/W, counts 0000h→FFFFh and rolls to 0000h; overflow latches TMR1IF; enabled by TMR1IE | §12.1, p.12-2 | behaviour | todo |
| P9-031 | Timer1 modes: synchronous timer, synchronous counter, asynchronous counter — selected by TMR1CS and T1SYNC | §12.1, p.12-2 | behaviour | todo |
| P9-032 | Counter mode increments on every rising edge of the external clock input | §12.1, Reg 12-1, pp.12-2/12-3 | behaviour | todo |
| P9-033 | When T1OSCEN=1 the T1OSI and T1OSO pins become inputs; their TRIS values are ignored | §12.1, p.12-2 | pin | todo |
| P9-034 | Clearing T1OSCEN turns off the T1 oscillator inverter and feedback resistor (no power drain) | Fig 12-1 Note 1, Reg 12-1 bit 3, pp.12-2/12-3 | electrical | todo |
| P9-035 | T1CON: bits 7:6 unimplemented read 0; T1CKPS1:0 = 1:1/1:2/1:4/1:8 (00/01/10/11); T1OSCEN; T1SYNC (1 = do not synchronize; ignored when TMR1CS=0); TMR1CS (1 = external from T1OSO/T1CKI, rising edge; 0 = FOSC/4); TMR1ON | Reg 12-1, p.12-3 | register | todo |
| P9-036 | Fig 12-1 path: T1OSO/T1CKI or T1 oscillator → (TMR1CS) → prescaler 1,2,4,8 → T1SYNC mux (synchronize-detect block has a SLEEP input) → TMR1ON gate → TMR1; CCP special trigger drives TMR1 CLR | Fig 12-1, p.12-2 | behaviour | todo |
| P9-037 | Timer mode: input clock FOSC/4; T1SYNC has no effect | §12.3, p.12-4 | behaviour | todo |
| P9-038 | Synchronized counter: input taken from T1OSI when T1OSCEN=1, from T1OSO/T1CKI when T1OSCEN=0; synchronization happens after the prescaler; prescaler is an asynchronous ripple counter | §12.4, p.12-4 | behaviour | todo |
| P9-039 | Synchronized counter in SLEEP: TMR1 does not increment even with external clock present (sync circuit shut off) but the prescaler keeps counting | §12.4, p.12-4 | behaviour | todo |
| P9-040 | Synchronized counter, prescale 1:1: prescaler output sampled on alternating TOSC clocks; T1CKI high ≥ 2 TOSC + small RC delay, low ≥ 2 TOSC + small RC delay (params 45, 46, 47) | §12.4.1, p.12-4 | timing | todo |
| P9-041 | Synchronized counter, prescale > 1:1: T1CKI period ≥ (4 TOSC + small RC delay)/prescale; high/low must not violate minimum pulse width (params 40, 42, 45, 46, 47) | §12.4.1, p.12-4 | timing | todo |
| P9-042 | Asynchronous counter (T1SYNC=1): increments asynchronously to the phase clocks, keeps running in SLEEP, overflow interrupt can wake the processor; usable as a real-time clock | §12.5, p.12-5 | behaviour | todo |
| P9-043 | Asynchronous counter mode cannot be the time base for capture or compare | §12.5, p.12-5 | behaviour | todo |
| P9-044 | Asynchronous counter: input must meet minimum high/low times (params 45, 46, 47) | §12.5.1, p.12-5 | timing | todo |
| P9-045 | Async mode reads of TMR1H or TMR1L individually are guaranteed valid (hardware), but the 16-bit value can tear because the timer may overflow between the two 8-bit reads | §12.5.2, p.12-5 | behaviour | todo |
| P9-046 | Async mode writes while the register is incrementing can cause write contention and an unpredictable value; recommended: stop the timer, then write | §12.5.2, p.12-5 | failure-mode | todo |
| P9-047 | Example 12-1 tear: TMR1=04FFh, read L (FF), timer→0501h, read H (05) → 05FFh; reading H first at 04FFh then L after rollover → 0401h | Ex 12-1, p.12-5 | failure-mode | todo |
| P9-048 | Example 12-2 safe free-running read: read H, read L, re-read H; if H changed, read H and L again | Ex 12-2, p.12-6 | behaviour | todo |
| P9-049 | Example 12-3 safe write: CLRF TMR1L first (avoid rollover into TMR1H), then write TMR1H, then TMR1L. The listing's last MOVWF targets TMR1H (typo for TMR1L) | Ex 12-3, p.12-6 | note | **decide** |
| P9-050 | T1 oscillator: crystal oscillator between T1OSI (input) and T1OSO (amplifier output), enabled by T1OSCEN; low power, rated up to 200 kHz; runs in SLEEP; intended for 32 kHz; identical to the LP oscillator; software must wait for start-up | §12.6, p.12-7 | electrical | todo |
| P9-051 | Table 12-1 caps: 32 kHz 33 pF/33 pF; 100 kHz 15/15 pF; 200 kHz 15/15 pF. Higher capacitance increases stability and start-up time | Table 12-1, p.12-7 | electrical | todo |
| P9-052 | Device data sheet Table 7-1 gives 15 pF/15 pF for 32.768 kHz (manual: 33 pF) and does not list 100/200 kHz; DS says "primarily intended for 32.768 kHz watch crystal" and does not state the 200 kHz rating | DS33023A Table 12-1 p.12-7 vs DS40044G §7.4/Table 7-1 p.53 | note | info |
| P9-053 | Async Timer1 in SLEEP: TMR1 increments each timer clock (or prescale multiple); overflow sets TMR1IF and, if enabled, wakes the device | §12.7, p.12-9 | behaviour | todo |
| P9-054 | T1 oscillator adds a delta current in SLEEP (power-down current is no longer only leakage) | §12.7, p.12-9 | electrical | todo |
| P9-055 | CCP compare mode 1011 (special event trigger) resets Timer1; it does not set TMR1IF | §12.8 Note, p.12-9 | behaviour | todo |
| P9-056 | Special event reset only valid with Timer1 in timer or synchronized counter mode; in async counter mode it may not work | §12.8, p.12-9 | failure-mode | todo |
| P9-057 | If a write to Timer1 coincides with a special event trigger, the write takes precedence | §12.8, p.12-9 | behaviour | todo |
| P9-058 | With special event trigger, CCPR1H:CCPR1L effectively becomes a 16-bit period register for Timer1 | §12.8, p.12-9 | behaviour | todo |
| P9-059 | Device data sheet adds: special event trigger output occurs immediately on TMR1=CCPR1 match, but TMR1 is not reset until the next rising edge of the TMR1 clock; changing CCPR1H:CCPR1L between those two edges cancels the reset. Manual does not describe this one-clock window | DS40044G §9.2.4 + Note p.59 (not in DS33023A §12.8/§14.4.3) | note | info |
| P9-060 | TMR1H/TMR1L are not reset by POR or any other reset — only by the CCP special event trigger (power-up value unknown xxxx xxxx, other resets unchanged) | §12.9, Table 12-2, p.12-9 | register | todo |
| P9-061 | T1CON resets to 00h only on POR or BOR; unchanged on other resets (--00 0000 / --uu uuuu) | §12.9, Table 12-2, p.12-9 | register | todo |
| P9-062 | Timer1 prescaler counter is cleared on any write to TMR1H or TMR1L | §12.10, p.12-9 | behaviour | todo |
| P9-063 | Design tip: any write to Timer1 can lose time; avoid writing TMR1L; writing TMR1H is acceptable to make the overflow come sooner than the full 16-bit period | §12.12 Q1, p.12-12 | note | info |
| P9-064 | Timer2: 8-bit timer with prescaler, postscaler and period register PR2; PWM time base for CCP; with max prescale and postscale the overflow time equals a 16-bit timer | §13.1, p.13-2 | behaviour | todo |
| P9-065 | Timer2 clock source is only FOSC/4; prescaler 1:1 (00), 1:4 (01), 1:16 (1x) via T2CKPS1:0 | §13.3, Reg 13-1, pp.13-3/13-4 | register | todo |
| P9-066 | T2CON: bit7 unimplemented; TOUTPS3:0 postscale 0000=1:1 … 1111=1:16; TMR2ON; T2CKPS1:0. Reset -000 0000 on all resets | Reg 13-1, Table 13-1, pp.13-3/13-4 | register | todo |
| P9-067 | TMR2 counts from 00h until it equals PR2, then resets to 00h on the next increment cycle (period = PR2+1 counts) | §13.4, p.13-4 | timing | todo |
| P9-068 | TMR2 cleared on WDT, POR, MCLR and BOR resets; PR2 is set (FFh) on these resets | §13.4, Table 13-1, p.13-4 | register | todo |
| P9-069 | TMR2ON=0 stops incrementing (reduces power) | §13.4, p.13-4 | behaviour | todo |
| P9-070 | TMR2=PR2 match output feeds a 4-bit postscaler (1:1 to 1:16 inclusive); TMR2IF is set when the postscaler overflows, i.e. once every N matches | §13.5, p.13-4 | timing | todo |
| P9-071 | Prescaler and postscaler counters are cleared on: any write to TMR2, any write to T2CON, any device reset. Writing T2CON does not clear TMR2 | §13.6 + Note, p.13-4 | behaviour | todo |
| P9-072 | In SLEEP TMR2 does not increment; the prescaler retains its count and resumes after wake | §13.7, p.13-4 | behaviour | todo |
| P9-073 | Design tip: Timer2 resets to zero when it equals PR2 and TMR2IF gets set at that time; PR2=FFh gives an interrupt at FFh rollover like Timer0; PR2 holds its value so no reload is needed | §14.7 Q6, p.14-15 | behaviour | todo |
| P9-074 | T2CON other-reset value: manual Table 13-1 and DS40044G Table 8-1 give -000 0000; DS40044G Table 9-4 gives uuuu uuuu (inconsistent within the device data sheet) | DS33023A Table 13-1 p.13-4 vs DS40044G Table 8-1 p.55 and Table 9-4 p.61 | note | **decide** |
| P9-075 | CCP: 16-bit register usable as 16-bit capture, 16-bit compare, or 10-bit PWM master/slave duty-cycle register | §14.1, p.14-2 | behaviour | todo |
| P9-076 | Timer resources: capture and compare use Timer1 only; PWM uses Timer2 only (only timer with period register) | Table 14-2, §14.7 Q1/Q2, pp.14-2/14-15 | behaviour | todo |
| P9-077 | One CCP module cannot do capture/compare and PWM at the same time (logic is shared); it can switch between modes | §14.7 Q3, p.14-15 | behaviour | todo |
| P9-078 | CCPxCON: bits 7:6 unimplemented; bits 5:4 DCxB1:DCxB0 = PWM duty LSbs (unused in capture/compare); CCPxM3:0: 0000 off (resets module), 0100 capture every falling edge, 0101 every rising edge, 0110 every 4th rising, 0111 every 16th rising, 1000 compare set pin on match, 1001 compare clear pin on match, 1010 compare software interrupt only, 1011 compare special event, 11xx PWM | Reg 14-1, p.14-3 | register | todo |
| P9-079 | Mode codes 0001–0011 are not listed in the manual (only 0000, 01xx, 10xx, 11xx); the device data sheet lists the same set. Behaviour for 0001–0011 is undocumented | Reg 14-1 p.14-3; DS40044G Reg 9-1 p.57 | note | **decide** |
| P9-080 | Device data sheet names CCP1CON<5:4> CCP1X:CCP1Y; manual names them DCxB1:DCxB0 (same function) | DS33023A Reg 14-1 vs DS40044G Reg 9-1 | note | info |
| P9-081 | Capture: on the selected event on CCPx, CCPRxH:L latches the 16-bit TMR1 value and CCPxIF is set (software clears it); a second capture before CCPRx is read overwrites (loses) the previous value | §14.3, p.14-4 | behaviour | todo |
| P9-082 | Capture does not reset TMR1; interval = difference of successive captures; TMR1 overflow sets TMR1IF to extend beyond 16 bits | §14.3, p.14-4 | behaviour | todo |
| P9-083 | Capture requires Timer1 in timer or synchronized counter mode; in async counter mode capture may not work | §14.3 Note, p.14-4 | failure-mode | todo |
| P9-084 | CCPx pin should be input (TRIS=1) in capture mode; if configured as output, a write to the port can cause a capture | §14.3.1 + Note, p.14-4 | pin | todo |
| P9-085 | Capture path (Fig 14-1): pin → prescaler ÷1/4/16 and edge detect (clocked by Q's) → capture enable → copy TMR1H:L to CCPRxH:L and set CCPxIF | Fig 14-1, p.14-4 | behaviour | todo |
| P9-086 | With 1:16 capture prescale on a stable input, total error over 16 periods is 1 TCY → effective resolution TCY/16 (12.5 ns at 20 MHz); 1:1 resolution is TCY | §14.3.1, p.14-4 | timing | todo |
| P9-087 | Changing capture mode may generate a capture interrupt; keep CCPxIE clear and clear CCPxIF after any mode change | §14.3.2, p.14-5 | failure-mode | todo |
| P9-088 | Capture prescaler counter is cleared whenever the CCP is off or not in capture mode (so any reset clears it). Switching between capture prescale settings does not clear it (first capture may come from a non-zero count) and may generate an interrupt. Safe switch: CLRF CCP1CON then write new mode | §14.3.2.1, Ex 14-1, p.14-5 | behaviour | todo |
| P9-089 | Capture in SLEEP: TMR1 (synchronous) stops but the capture prescaler keeps counting unsynchronized events; on a capture event CCPxIF is set but CCPRx is NOT updated; if CCPxIE is set the device wakes — CCP pin works as an extra external interrupt | §14.3.3, p.14-5 | behaviour | todo |
| P9-090 | Any reset: CCP module off, capture prescaler forced to 0 | §14.3.4, §14.7 Q4, pp.14-5/14-15 | register | todo |
| P9-091 | Compare: CCPRx constantly compared with TMR1; on match pin driven high, driven low, or unchanged per mode; CCPxIF set at the same time | §14.4, p.14-6 | behaviour | todo |
| P9-092 | Compare requires Timer1 in timer or synchronized counter mode; may not work in async counter mode | §14.4 Note, p.14-6 | failure-mode | todo |
| P9-093 | Compare output: pin must be output (TRIS=0); output goes through an S/R latch (Fig 14-2) gated by TRIS output enable | §14.4.1, Fig 14-2, pp.14-6/14-7 | pin | todo |
| P9-094 | Clearing CCPxCON forces the compare output latch to its default low (not the PORT data latch) | §14.4.1 Note, p.14-7 | behaviour | todo |
| P9-095 | Selecting a compare-output mode forces the pin to the state opposite the match state (e.g. mode 1001 "low on match" drives the pin high until the match or a mode change) | §14.4.1, p.14-7 | behaviour | todo |
| P9-096 | The device data sheet register text says only "set/clear output on match"; the pre-forcing of the opposite level on mode selection comes from the manual (and the bit description "Initialize CCP pin Low/High") | DS33023A §14.4.1/Reg 14-1 vs DS40044G Reg 9-1 | note | info |
| P9-097 | Software interrupt mode (1010): pin unaffected, only CCPxIF set | §14.4.2, p.14-7 | behaviour | todo |
| P9-098 | Special event mode (1011): CCPxIF set and TMR1 register pair reset; TMR1IF not set by the trigger; the A/D-start part of the trigger does not apply (62xA has no A/D) | §14.4.3 + Note, p.14-7 | behaviour | todo |
| P9-099 | Special event with CCPR1 = FFFFh: TMR1 overflow coincides with the match, so both CCP1IF and TMR1IF get set; otherwise only CCP1IF | §14.7 Q5, p.14-15 | behaviour | todo |
| P9-100 | Compare in SLEEP: TMR1 stops (synchronous), module state does not change, pin keeps driving its value; continues from that state on wake | §14.4.4, p.14-7 | behaviour | todo |
| P9-101 | PWM: up to 10-bit resolution on CCPx; TRIS bit must be cleared for output; clearing CCPxCON forces the PWM output latch low (not the PORT latch) | §14.5 + Note, p.14-8 | pin | todo |
| P9-102 | PWM block (Fig 14-3): CCPRxL (DC9:2) + CCPxCON<5:4> (DC1:0) → slave CCPRxH + 2-bit latch → 10-bit comparator against TMR2 concatenated with 2-bit internal Q clock or 2 prescaler bits (resets latch → pin low); TMR2=PR2 comparator clears timer, sets pin, latches duty | Fig 14-3 + Note 1, p.14-8 | behaviour | todo |
| P9-103 | PWM period = (PR2+1)·4·TOSC·(TMR2 prescale) | §14.5.1, p.14-9 | timing | todo |
| P9-104 | When TMR2 equals PR2, on the next increment cycle: TMR2 cleared, CCPx pin set (not set if duty = 0%), duty latched from CCPRxL(+2 LSbs) into CCPRxH(+2-bit latch) | §14.5.1, p.14-9 | timing | todo |
| P9-105 | Timer2 postscaler does not affect PWM frequency (can give an independent update/servo rate via TMR2IF) | §14.5.1 Note, p.14-9 | behaviour | todo |
| P9-106 | Duty = (DC9:DC0)·TOSC·(TMR2 prescale); DC bits may be written any time but only latched into CCPRxH at the PR2 match (end of current period) — double buffering for glitchless PWM | §14.5.2, p.14-9 | timing | todo |
| P9-107 | In PWM mode CCPRxH is read-only | §14.5.2, p.14-9 | register | todo |
| P9-108 | Pin is cleared when CCPRxH + 2-bit latch equal TMR2 concatenated with the 2-bit Q clock (prescale 1:1) or 2 bits of the TMR2 prescaler (end of duty) | §14.5.2, p.14-9 | timing | todo |
| P9-109 | If the duty value is longer than the period the pin is never cleared → 100% duty | §14.5.2 Note, p.14-9 | behaviour | todo |
| P9-110 | Max resolution = log(FOSC/FPWM)/log(2) bits (manual formula without prescaler term) | §14.5.2, p.14-9 | timing | todo |
| P9-111 | Device data sheet resolution formula is log(FOSC/(FPWM·TMR2 prescale))/log(2), i.e. includes the prescaler; manual's omits it | DS33023A §14.5.2 p.14-9 vs DS40044G §9.3.2 p.61 | note | info |
| P9-112 | Minimum duty bit time: prescale 1 → TOSC; 4 → TCY; 16 → 4 TCY | Table 14-4, p.14-10 | timing | todo |
| P9-113 | Example: 78.125 kHz at 20 MHz, prescale 1 → PR2=63, max 8-bit resolution; DC values > 255 give 100% duty | Ex 14-2, p.14-10 | timing | todo |
| P9-114 | Table 14-5 at 20 MHz: 1.22 kHz (16, FFh, 10 bit); 4.88 kHz (4, FFh, 10); 19.53 kHz (1, FFh, 10); 78.12 kHz (1, 3Fh, 8); 156.3 kHz (1, 1Fh, 7); 208.3 kHz (1, 17h, 5.5) | Table 14-5, p.14-10 | timing | todo |
| P9-115 | 208.3 kHz/PR2=17h max resolution: manual 5.5 bits, device data sheet Table 9-3 6.5 bits | DS33023A Table 14-5 p.14-10 vs DS40044G Table 9-3 p.61 | note | info |
| P9-116 | Fig 14-4 annotates the period end as "TMR2 = PR2 + 1, TMR2 forced to 0h"; DS40044G Fig 9-4 labels it "TMR2 = PR2". Both texts agree the reset happens on the increment after TMR2=PR2 | DS33023A Fig 14-4 p.14-8 vs DS40044G Fig 9-4 p.60 | note | info |
| P9-117 | PWM setup order: PR2, duty bits, TRIS clear, T2CON (prescale + TMR2ON), CCPxCON PWM mode (manual step 5; the DS list shows 4 steps) | §14.5.3, p.14-11 | behaviour | todo |
| P9-118 | PWM in SLEEP: Timer2 stops, module state unchanged, pin keeps driving its current level; resumes from that state on wake | §14.5.4, p.14-11 | behaviour | todo |
| P9-119 | Example 14-5: PR2=7Fh, CCPR1L=1Fh, CCP1CON=2Ch (DC LSbs=10) described as 25% duty | Ex 14-5, p.14-14 | behaviour | todo |
| P9-120 | FAQ: CCPRxL > PR2 (e.g. PR2=7Eh, CCPRxL=7Fh) yields 100% duty | §14.7 Q7 item 1, p.14-16 | failure-mode | todo |
| P9-121 | FAQ: PWM pin with TRIS=input is not driven and floats; observed duty may look 0%, 100% or random | §14.7 Q7 item 2, p.14-16 | failure-mode | todo |
| P9-122 | FAQ: period measurement by subtraction of two captures works across TMR1 wrap (0001h − FFFEh = 3) as long as the timer does not wrap past the previous capture | §14.7 Q8, p.14-16 | behaviour | todo |
| P9-123 | USART modes: asynchronous full duplex; synchronous master half duplex; synchronous slave half duplex. SPEN (RCSTA<7>) and the TRIS bits must be set to configure TX/CK and RX/DT | §18.1, p.18-2 | pin | todo |
| P9-124 | TXSTA: CSRC (sync: 1 master/BRG clock, 0 slave; async don't care), TX9, TXEN, SYNC, bit3 unimplemented, BRGH (async only), TRMT (read-only, 1 = TSR empty, reset 1), TX9D. Reset 0000 -010 | Reg 18-1, Table 18-2, pp.18-3/18-5 | register | todo |
| P9-125 | SREN/CREN override TXEN in synchronous mode | Reg 18-1 Note, p.18-3 | behaviour | todo |
| P9-126 | RCSTA: SPEN, RX9, SREN (sync master single receive, cleared by hardware when reception completes; don't care async and sync slave), CREN (CREN overrides SREN in sync), bit3, FERR (R), OERR (R, cleared by clearing CREN), RX9D (R) | Reg 18-2, p.18-4 | register | todo |
| P9-127 | Manual shows RCSTA<3> unimplemented and RCSTA reset 0000 -00x; the 62xA implements RCSTA<3> = ADEN (address detect, R/W) with reset 0000 000x. Address-detect behaviour (receive/interrupt only when RSR<8>=1 in 9-bit async; data bytes dropped, previous byte lost if another shifts in) is only in DS40044G §12.3 | DS33023A Reg 18-2 p.18-4 vs DS40044G Reg 12-2 p.74, §12.3 p.85 | note | info |
| P9-128 | FERR: set if stop bit is read low; "can be updated by reading RCREG and receiving the next valid byte" | Reg 18-2, §18.4.2, pp.18-4/18-11 | register | todo |
| P9-129 | BRG: dedicated 8-bit free-running timer whose period is set by SPBRG; BRGH used in async only, ignored in sync. Formulas only apply to master (internal clock) | §18.3, p.18-5 | behaviour | todo |
| P9-130 | Baud: async BRGH=0: FOSC/(64(X+1)); async BRGH=1: FOSC/(16(X+1)); sync: FOSC/(4(X+1)); X = SPBRG 0…255 | Table 18-1, p.18-5 | timing | todo |
| P9-131 | Example: FOSC=16 MHz, 9600 baud, BRGH=0 → X=25, actual 9615 baud, error +0.16% | Ex 18-1, p.18-5 | timing | todo |
| P9-132 | Writing SPBRG resets (clears) the BRG timer so the new rate takes effect without waiting for the old period to overflow | §18.3, p.18-5 | timing | todo |
| P9-133 | SPBRG reset 0000 0000 on POR/BOR and all other resets | Table 18-2, p.18-5 | register | todo |
| P9-134 | Sync-mode extremes (Table 18-3): SPBRG=0 gives FOSC/4 (5000 kbps at 20 MHz, 4000 at 16, 1000 at 4 MHz, 8.192 at 32.768 kHz); SPBRG=255 gives FOSC/1024 | Table 18-3, p.18-6 | timing | todo |
| P9-135 | Async BRGH=0 extremes: SPBRG=0 → FOSC/64 (312.5 kbps at 20 MHz), SPBRG=255 → FOSC/16384 (1.221 kbps at 20 MHz); BRGH=1 SPBRG=0 → FOSC/16 (1250 kbps at 20 MHz) | Tables 18-4/18-5, p.18-7 | timing | todo |
| P9-136 | Async format: NRZ, 1 start bit, 8 or 9 data bits, 1 stop bit, LSb first; TX and RX independent but share format and baud rate; BRG clock is x16 or x64 of bit rate per BRGH; no hardware parity (use 9th bit) | §18.4, p.18-8 | behaviour | todo |
| P9-137 | Asynchronous mode is stopped during SLEEP | §18.4, p.18-8 | behaviour | todo |
| P9-138 | Async TX: TSR is loaded from TXREG only after the stop bit of the previous word has been sent; the TXREG→TSR transfer takes one TCY, then TXREG is empty and TXIF sets | §18.4.1, p.18-8 | timing | todo |
| P9-139 | TXIF is set regardless of TXIE, cannot be cleared by software, and clears only when TXREG is written | §18.4.1, p.18-8 | behaviour | todo |
| P9-140 | Setting TXEN sets TXIF (transmit buffer not yet full) | §18.4.1 Note 2, p.18-8 | behaviour | todo |
| P9-141 | TRMT (TXSTA<1>) read-only, set when TSR is empty; no interrupt tied to it (poll only). TSR not mapped in data memory | §18.4.1 + Note 1, p.18-8 | register | todo |
| P9-142 | Transmission starts only when TXREG holds data and the BRG has produced a shift clock; alternatively load TXREG then set TXEN. With TSR empty, a TXREG write transfers immediately to TSR leaving TXREG empty → back-to-back writes possible (two-word buffering: TXREG + TSR) | §18.4.1, Fig 18-3, pp.18-8/18-10 | timing | todo |
| P9-143 | Clearing TXEN during transmission aborts it and resets the transmitter; TX/CK pin reverts to hi-impedance | §18.4.1, p.18-8 | behaviour | todo |
| P9-144 | 9-bit TX: TX9D must be written before TXREG, because a TXREG write may transfer to TSR immediately and the present (old) TX9D would be sent | §18.4.1, §18.5.1, pp.18-8/18-15 | failure-mode | todo |
| P9-145 | Fig 18-2: TXIF drops on the TXREG write and returns high shortly after (TXREG→TSR); TRMT goes low for the whole word (start, data, stop) and returns high after the stop bit | Fig 18-2, p.18-9 | timing | todo |
| P9-146 | Fig 18-3 back-to-back: Word 2 written while Word 1 in TSR keeps TXIF low until Word 1's stop bit ends and Word 2 moves to TSR; Word 2's start bit follows Word 1's stop bit directly; TRMT stays low across both words | Fig 18-3, p.18-10 | timing | todo |
| P9-147 | Async RX: data recovery block is a x16 high-speed shifter; main receive shifter runs at the bit rate or FOSC. Reception enabled by CREN | §18.4.2, p.18-11 | behaviour | todo |
| P9-148 | After the stop bit is sampled, RSR data transfers to RCREG if empty and RCIF sets; RCIF is read-only, cleared by hardware when RCREG has been read and is empty | §18.4.2, p.18-11 | behaviour | todo |
| P9-149 | RCREG is a 2-deep FIFO: two received bytes can sit in the FIFO while a third shifts into RSR; RCREG can be read twice to get both | §18.4.2, p.18-11 | behaviour | todo |
| P9-150 | Overrun: on detection of the third byte's stop bit with RCREG still full, OERR sets and the RSR word is lost. While OERR=1, RSR→RCREG transfers are inhibited (receiver stops delivering data) until OERR is cleared by clearing then setting CREN | §18.4.2, Fig 18-5, pp.18-11/18-12 | failure-mode | todo |
| P9-151 | FERR and RX9D are buffered with each received byte (FIFO); reading RCREG loads the next byte's FERR/RX9D, so RCSTA must be read before RCREG | §18.4.2, p.18-11 | behaviour | todo |
| P9-152 | Fig 18-4: RSR frame = start, bits 0-7, (bit 8 via RX9), stop; x64 baud clock, CREN gates the receiver; SPEN gates the pin buffer | Fig 18-4, p.18-11 | behaviour | todo |
| P9-153 | Fig 18-5: three words received with no RCREG read → OERR sets at the third word; RCIF stays high while data is in the FIFO | Fig 18-5, p.18-12 | timing | todo |
| P9-154 | Async RX steps include "if any error occurred, clear by clearing CREN" (manual says any error; DS40044G says OERR) | §18.4.2 steps, p.18-12; DS40044G §12.2.2 step 10 | note | info |
| P9-155 | RX sampling: each bit is sampled three times by a majority-detect circuit; the scheme is the same for BRGH=0 and BRGH=1, only the x16 clock source differs | §18.4.3, p.18-13 | timing | todo |
| P9-156 | Fig 18-6: the x16 clock runs 1…16 per bit; the three samples are taken around the middle of the bit (≈ x16 clocks 7, 8, 9); the baud clock is aligned to the start bit's falling edge ("baud CLK for all but start bit") | Fig 18-6, p.18-13 | timing | **check PDF** |
| P9-157 | Fig 18-6 is the scheme for all new devices; the older-scheme exceptions (7th/8th/9th falling edges of x16 for BRGH=0; Q2/Q4 samples before the second rising x4 edge for BRGH=1) apply only to PIC16C63/65/65A/73/73A/74/74A — not to the 62xA | §18.4.3.1, Figs 18-7..18-9, pp.18-13/18-14 | note | info |
| P9-158 | Device data sheet only says "sampled three times by a majority detect circuit"; sample positions come from manual Fig 18-6 | DS40044G §12.1 p.75 vs DS33023A Fig 18-6 | note | info |
| P9-159 | Register resets: TXREG and RCREG 0000 0000; TXSTA 0000 -010; RCSTA 0000 -00x (manual) | Tables 18-6/18-7, pp.18-10/18-14 | register | todo |
| P9-160 | Sync master: half duplex (TX and RX never simultaneous); SYNC=1, SPEN=1 make TX/CK = CK and RX/DT = DT; CSRC=1 = master drives CK | §18.5, p.18-15 | behaviour | todo |
| P9-161 | Sync master TX: TSR loaded after the last bit of the previous word; TXREG→TSR in one TCY; TXIF/TRMT behave as in async | §18.5.1, p.18-15 | timing | todo |
| P9-162 | Sync master TX: first data bit shifts out on the next available rising edge of CK; data out is stable at the falling edge of CK | §18.5.1, Fig 18-10, p.18-15 | timing | todo |
| P9-163 | The BRG is held in reset while TXEN, CREN and SREN are all clear; setting TXEN starts the BRG and creates a shift clock immediately (so load TXREG first, then set TXEN, at slow rates) | §18.5.1, Fig 18-11, p.18-15 | timing | todo |
| P9-164 | Sync master TX: clearing TXEN aborts and resets the transmitter; DT and CK revert to hi-impedance | §18.5.1, p.18-15 | behaviour | todo |
| P9-165 | Setting CREN or SREN during a sync transmission aborts the transmission: DT goes hi-Z for reception, CK stays output if CSRC=1, transmitter is not reset (only disconnected); clear TXEN to reset it | §18.5.1, p.18-15 | behaviour | todo |
| P9-166 | If SREN interrupts an ongoing transmission, after the single word is received SREN clears and the port reverts to transmitting (TXEN still 1): DT immediately switches from hi-Z to driving. Clear TXEN to avoid this | §18.5.1, p.18-15 | failure-mode | todo |
| P9-167 | Fig 18-10 (SPBRG=0): continuous transmission of two 8-bit words, back-to-back with no gap; Fig 18-11 shows transmission started by TXEN with TXREG already loaded | Figs 18-10/18-11, p.18-16 | timing | todo |
| P9-168 | Device data sheet says data out is stable "around" the falling edge (manual: "at" the falling edge) | DS33023A §18.5.1 p.18-15 vs DS40044G §12.4.1 p.86 | note | info |
| P9-169 | Sync master RX: enabled by SREN or CREN; data sampled on RX/DT on the falling edge of CK; SREN = single word, CREN = continuous until cleared; CREN takes precedence when both set | §18.5.2, p.18-17 | timing | todo |
| P9-170 | Sync RX: after the last bit is clocked, RSR→RCREG (if empty) and RCIF sets; same 2-deep FIFO; OERR sets on clocking the last bit of a third byte with RCREG still full, RSR word lost; OERR inhibits transfers until CREN cleared | §18.5.2, p.18-17 | failure-mode | todo |
| P9-171 | Sync RX: RX9D buffered with data; read RCSTA before RCREG | §18.5.2, p.18-17 | behaviour | todo |
| P9-172 | Fig 18-12 (SREN, BRG=0): after the SREN write, 8 clocks shift bits 0-7; SREN self-clears at the end of the word, RCIF sets, reading RCREG clears RCIF; CREN stays 0 | Fig 18-12, p.18-18 | timing | todo |
| P9-173 | Sync slave: shift clock supplied externally on TX/CK (CSRC=0); allows transmit or receive during SLEEP | §18.6, p.18-19 | behaviour | todo |
| P9-174 | Sync slave TX in SLEEP with two words written: first word moves to TSR and transmits; second stays in TXREG; TXIF not set; when the first word finishes, the second moves to TSR and TXIF sets; with TXIE=1 this wakes the device (vectors to 0004h if GIE=1) | §18.6.1, p.18-19 | behaviour | todo |
| P9-175 | Sync slave RX: SREN is don't care; with CREN set before SLEEP a word can be received in SLEEP; on completion RSR→RCREG and with RCIE=1 the interrupt wakes the device (vectors to 0004h if GIE) | §18.6.2, p.18-20 | behaviour | todo |
| P9-176 | Design tip: async errors usually come from BRGH errata on PIC16C65/65A/73/73A/74/74A, wrong SPBRG, or summed TX+RX baud error too high | §18.8 Q1, p.18-22 | failure-mode | todo |
| P9-177 | VREF: 16-tap resistor ladder, two ranges, power-down when unused; within each range the 16 steps are monotonic; limited drive capability (intended for comparator inputs) | §19.1, p.19-2 | electrical | todo |
| P9-178 | Ladder (Fig 19-1): VREN switch, 8R top, 16 R stages, 8R bottom switched out by VRR, 16:1 analog mux by VR3:VR0; R = param D312 | Fig 19-1, p.19-2 | electrical | todo |
| P9-179 | VRR=1: VREF = (VR/24)·VDD, range 0…0.625·VDD in VDD/24 steps; VRR=0: VREF = VDD/4 + (VR/32)·VDD, VDD/32 steps | Reg 19-1, §19.3, pp.19-3/19-4 | electrical | todo |
| P9-180 | Table 19-1 typical at VDD=5.0 V: VRR=1 → 0.00, 0.21, 0.42, 0.63, 0.83, 1.04, 1.25, 1.46, 1.67, 1.88, 2.08, 2.29, 2.50, 2.71, 2.92, 3.13 V; VRR=0 → 1.25, 1.41, 1.56, 1.72, 1.88, 2.03, 2.19, 2.34, 2.50, 2.66, 2.81, 2.97, 3.13, 3.28, 3.44, 3.59 V | Table 19-1, p.19-2 | electrical | todo |
| P9-181 | VRCON: VREN (bit7), VROE (bit6), VRR (bit5), bit4 unimplemented, VR3:VR0. Reset 000- 0000 | Reg 19-1, Table 20-1, pp.19-3/20-10 | register | todo |
| P9-182 | Manual Reg 19-1 says VROE=1 connects VREF internally to the comparator module AND outputs it on the VREF pin, VROE=0 disconnects it from both; DS40044G says VROE only switches the output to RA2. Manual §20.5.2 also says the internal reference "may be used in any comparator mode" while both documents say it is applied to VIN+ only in CM=010 | DS33023A Reg 19-1 p.19-3, §20.5.2 p.20-7 vs DS40044G Reg 11-1 p.69, §10.3.2 p.65 | note | info |
| P9-183 | Manual VRR bit text gives low range as "0 V to 0.75 VDD" though the formula maxes at 15/24·VDD = 0.625 VDD | Reg 19-1 bit 5, p.19-3 | note | info |
| P9-184 | Settling time must be allowed after changing VREF; examples use a 10 µs delay (DS40044G D313: 10 µs max) | §19.3, Ex 19-1, pp.19-4/19-7 | timing | todo |
| P9-185 | VR3:VR0 from target: VRR=1: VR = VREF/VDD·24; VRR=0: VR = (VREF − VDD/4)/VDD·32; integer only, must be ≤ 15 | Eq 19-1, p.19-4 | electrical | todo |
| P9-186 | The full VSS…VDD range cannot be reached (top/bottom ladder transistors); VREF tracks VDD fluctuations directly; absolute accuracy = param D311 | §19.4, §19.9 Q1, pp.19-5/19-8 | electrical | todo |
| P9-187 | SLEEP / wake by interrupt or WDT does not change VRCON; disable VREF to minimise sleep current | §19.5, p.19-5 | behaviour | todo |
| P9-188 | Any device reset clears VREN, VROE, VRR (selects high range) and VR3:VR0 | §19.6, p.19-5 | register | todo |
| P9-189 | VREF output reaches the pin only if VROE=1 and the pin's TRIS bit is set; driving the pin with a signal while VREF is output, or configuring it as digital output with VREF enabled, increases current | §19.7, p.19-6 | pin | todo |
| P9-190 | VREF pin has output impedance R that depends on VRCON<3:0> and VRR; a buffer is required for external loads; low-impedance loads pull VREF off its expected level | §19.7, Fig 19-2, §19.9 Q2, pp.19-6/19-8 | electrical | todo |
| P9-191 | Comparator module: two analog comparators, inputs multiplexed with I/O pins; on-chip VREF can be an input; CMCON controls input/output muxes | §20.1, p.20-2 | behaviour | todo |
| P9-192 | CMCON (manual): C2OUT (R), C1OUT (R), bits 5:4 unimplemented, CIS, CM2:CM0; COUT=1 when VIN+ > VIN−. Reset 00-- 0000 | Reg 20-1, Table 20-1, pp.20-3/20-10 | register | todo |
| P9-193 | 62xA CMCON bits 5:4 are C2INV/C1INV (output inversion, R/W, also inverts CnOUT meaning and pin output) and reset value is 0000 0000; manual shows them unimplemented | DS33023A Reg 20-1 p.20-3 vs DS40044G Reg 10-1 p.63, Fig 10-3 p.66 | note | info |
| P9-194 | CIS: in CM=001, CIS=1 → C1 VIN− = AN3, CIS=0 → AN0; in CM=010, CIS=1 → C1 VIN−=AN3 and C2 VIN−=AN2, CIS=0 → AN0 and AN1 | Reg 20-1, p.20-3 | register | todo |
| P9-195 | CM=000 (reset/POR default): RA0-RA3 analog, both comparators off, outputs read 0 | Fig 20-1, p.20-5 | behaviour | todo |
| P9-196 | CM=111: comparators off (read 0), RA0-RA3 digital inputs | Fig 20-1, p.20-5 | behaviour | todo |
| P9-197 | CM=100: two independent comparators: C1 = AN0(−)/AN3(+), C2 = AN1(−)/AN2(+), all analog | Fig 20-1, p.20-5 | behaviour | todo |
| P9-198 | CM=010: four inputs muxed to two comparators: C1 VIN− = AN0/AN3 by CIS, C2 VIN− = AN1/AN2 by CIS, both VIN+ = internal VREF | Fig 20-1, §20.5.2, pp.20-5/20-7 | behaviour | todo |
| P9-199 | CM=011: two common-reference comparators: C1 VIN− AN0, C2 VIN− AN1, shared VIN+ = AN2; RA3 digital | Fig 20-1, p.20-5 | behaviour | **check PDF** |
| P9-200 | CM=110: as 011 but C1/C2 outputs driven onto RA3 and RA4 (RA4 open drain) | Fig 20-1, §20.7, pp.20-5/20-8 | pin | todo |
| P9-201 | CM=101: one independent comparator: C1 off (reads 0) with RA0/RA3 digital, C2 = AN1(−)/AN2(+) | Fig 20-1, p.20-5 | behaviour | todo |
| P9-202 | CM=001: three inputs muxed to two comparators: C1 VIN− = AN0/AN3 by CIS, VIN+ = AN2; C2 = AN1(−)/AN2(+) | Fig 20-1, p.20-5 | behaviour | **check PDF** |
| P9-203 | Pins in analog mode ("A") read as 0 in the PORT register; digital-input pins convert analog levels per Schmitt trigger specification; analog levels on digital inputs can draw more current than specified | Fig 20-1 legend, §20.7 Notes 1-2, pp.20-5/20-8 | pin | todo |
| P9-204 | After a mode change the comparator output may be invalid for the mode-change delay (electrical spec; DS40044G D304 10 µs max); disable comparator interrupts during the change or a false interrupt may occur | §20.3 + Note, p.20-4 | failure-mode | todo |
| P9-205 | Comparator output: digital high when VIN+ > VIN−, low when VIN+ < VIN−; uncertainty band from input offset and response time | §20.4, Fig 20-2, p.20-6 | electrical | todo |
| P9-206 | External reference must be between VSS and VDD and may be applied to either comparator input | §20.5.1, p.20-7 | electrical | todo |
| P9-207 | Response time = minimum time after selecting a new reference or input source before the output is guaranteed valid; if internal VREF changed, use VREF max settling time, else comparator response time (DS40044G D303: 300 ns typ / 400 ns max at 3.0-5.5 V, -40..85 °C) | §20.6, p.20-8 | timing | todo |
| P9-208 | CMCON C1OUT/C2OUT are read-only; with CM=110 the pin output muxes switch and each pin carries the unsynchronized comparator output; TRIS still enables/disables the pin driver | §20.7, p.20-8 | pin | todo |
| P9-209 | DS40044G §10.5 says the pin output muxes switch for CM=110 or 001; manual §20.7 and both Figure 20-1/10-1 show pin outputs only for CM=110 | DS33023A §20.7 p.20-8 vs DS40044G §10.5 p.66 | note | info |
| P9-210 | Fig 20-3 output path: comparator output → D latch loaded on RD CMCON → data bus; a second latch (mismatch) sets CMIF when the live output differs from the last latched value; reset clears it | Fig 20-3, p.20-8 | behaviour | todo |
| P9-211 | CMIF sets whenever a comparator output changes relative to the value last loaded into CMxOUT (by a CMCON read/write); software must keep the previous CMCON<7:6> to know what changed | §20.8, p.20-9 | behaviour | todo |
| P9-212 | CMIF is software-writable (setting it simulates an interrupt); interrupt needs CMIE, PEIE and GIE; CMIF still sets when they are clear | §20.8, p.20-9 | behaviour | todo |
| P9-213 | Clearing the interrupt: (a) read or write CMCON (latches current outputs, ends the mismatch), then (b) clear CMIF. While the mismatch persists CMIF keeps being set | §20.8, p.20-9 | behaviour | todo |
| P9-214 | Design tip: clearing CMIF without first reading CMCON leaves the mismatch → CMIF re-sets immediately → ISR re-entered forever (apparent lock-up) | §20.13 Q1, p.20-12 | failure-mode | todo |
| P9-215 | DS40044G adds: if C1OUT/C2OUT changes while CMCON is being read (start of Q2), CMIF may not get set | DS40044G §10.6 Note p.67 (not in DS33023A §20.8) | note | info |
| P9-216 | Comparators remain active in SLEEP and their interrupt wakes the device if enabled; each active comparator adds current; CM=111 before SLEEP minimises current; CMCON unaffected by wake | §20.9, p.20-9 | behaviour | todo |
| P9-217 | Any reset forces CMCON to reset state, CM=000 (all comparator pins analog); comparators are powered down during the reset interval | §20.10, p.20-9 | register | todo |
| P9-218 | Analog input model: diodes to VDD/VSS (VT 0.6 V); input more than 0.6 V outside VSS..VDD forward-biases a diode and may cause latch-up; source impedance ≤ 10 kΩ recommended; CPIN 5 pF; leakage ±500 nA | §20.11, Fig 20-4, p.20-10 | electrical | todo |
| P9-219 | Manual Example 20-1 omits the MOVF CMCON,W before ANDLW 0xC0 (masks W, not CMCON); DS40044G Example 10-1 includes it. Both read CMCON after a 10 µs delay to end the change condition before clearing CMIF | DS33023A Ex 20-1 p.20-11 vs DS40044G Ex 10-1 p.65 | note | info |
