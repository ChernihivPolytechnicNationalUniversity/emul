/* Data EEPROM: bytes from the image's 2100h block, then byte writes with the unlock sequence of
   DS40044G Example 13-2 (in assembly: the sequence is counted in cycles), each read back. */
#include "test.h"

#define N_BYTES 16

#ifdef HOST
static uint8_t ee[256] = {0x12, 0x34, 0x56, 0x78};
static uint8_t ee_read(uint8_t a) { return ee[a]; }
static void ee_write(uint8_t a, uint8_t d) { ee[a] = d; }
#else
static __code uint8_t __at(0x2100) image[] = {0x12, 0x34, 0x56, 0x78};
static uint8_t ee_read(uint8_t a) {
  EEADR = a;
  RD = 1;
  return EEDATA;
}
static void ee_write(uint8_t a, uint8_t d) {
  EEADR = a;
  EEDATA = d;
  WREN = 1;
  GIE = 0;
  __asm
    BSF     0x03, 5    ; bank 1: EECON1 9Ch, EECON2 9Dh
    BCF     0x03, 6
    MOVLW   0x55
    MOVWF   0x1D
    MOVLW   0xAA
    MOVWF   0x1D
    BSF     0x1C, 1
  __endasm;
  while (WR)
    ;
  WREN = 0;
  EEIF = 0;
}
#endif

uint8_t run_test(volatile uint32_t *out) {
  uint8_t n = 0, i;
  uint32_t acc = 0;
  for (i = 0; i < 4; i++) acc = (acc << 8) | ee_read(i);
  out[++n] = acc;
  for (i = 0; i < N_BYTES; i++) ee_write((uint8_t)(0x40 + i), (uint8_t)(i * 37u + 5u));
  acc = 0;
  for (i = 0; i < N_BYTES; i++) acc = acc * 31u + ee_read((uint8_t)(0x40 + i));
  out[++n] = acc;
  ee_write(0x01, 0xa5);
  out[++n] = ((uint32_t)ee_read(0x00) << 16) | ((uint32_t)ee_read(0x01) << 8) | ee_read(0x02);
  return n;
}
