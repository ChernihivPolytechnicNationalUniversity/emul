/* PIC16F628A on the internal 4 MHz oscillator: an LED on RB3 toggled every 0.5 s by Timer1
   (1:8 prescaler, reloaded for 62 500 counts), "tick N" a second on the USART at 9600 baud (BRGH = 1,
   SPBRG = 25: 9615 baud, +0.16 %), and every received letter echoed upper-cased.
   SDCC's pic14 start-up does not clear static variables, and RAM powers up random: main sets them. */
#include <pic16f628a.h>
#include <stdint.h>

static __code uint16_t __at(_CONFIG) config = _FOSC_INTOSCIO & _WDT_OFF & _PWRTE_ON & _MCLRE_ON & _BOREN_OFF & _LVP_OFF;

#define RELOAD (65536u - 62500u)

static volatile uint8_t halves;
static volatile uint8_t rx_byte;
static volatile uint8_t rx_ready;

void isr(void) __interrupt {
  if (TMR1IF) {
    TMR1ON = 0;
    TMR1H = RELOAD >> 8;
    TMR1L = RELOAD & 0xff;
    TMR1ON = 1;
    TMR1IF = 0;
    RB3 = !RB3;
    halves++;
  }
  if (RCIF) {
    rx_byte = RCREG;
    rx_ready = 1;
  }
}

static void put(char c) {
  while (!TXIF)
    ;
  TXREG = c;
}
static void put_num(uint16_t n) {
  char digits[5];
  uint8_t i = 0;
  do {
    digits[i++] = (char)('0' + n % 10);
    n /= 10;
  } while (n);
  while (i) put(digits[--i]);
}

void main(void) {
  uint16_t ticks = 0;
  halves = 0;
  rx_ready = 0;
  CMCON = 0x07;      /* comparators off: PORTA digital */
  TRISB = 0xf7;      /* RB3 out; RB1/RB2 inputs for the USART */
  PORTB = 0;
  SPBRG = 25;
  TXSTA = 0x24;      /* TXEN, BRGH */
  RCSTA = 0x90;      /* SPEN, CREN */
  TMR1H = RELOAD >> 8;
  TMR1L = RELOAD & 0xff;
  T1CON = 0x31;      /* 1:8, internal clock, on */
  TMR1IE = 1;
  RCIE = 1;
  PEIE = 1;
  GIE = 1;
  for (;;) {
    if (halves >= 2) {
      halves -= 2;
      put('t'); put('i'); put('c'); put('k'); put(' ');
      put_num(ticks++);
      put('\r'); put('\n');
    }
    if (rx_ready) {
      uint8_t c = rx_byte;
      rx_ready = 0;
      if (c >= 'a' && c <= 'z') c -= 'a' - 'A';
      put((char)c);
    }
  }
}
