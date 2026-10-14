/*
 * ATmega328P on a 16 MHz crystal: the LED on PB5 blinks at 1 Hz from the Timer1 compare
 * interrupt, USART0 prints "tick N" every second at 9600 8N1 and echoes what it receives
 * upper-cased. The core idles in SLEEP between interrupts. The .fuse section selects the
 * full-swing crystal oscillator (low 0xFF), as an Arduino Uno's chip is programmed.
 */
#include <avr/io.h>
#include <avr/interrupt.h>
#include <avr/sleep.h>
#include <stdint.h>

FUSES = { .low = 0xFF, .high = 0xD9, .extended = 0xFD };

volatile uint16_t ticks;
volatile uint8_t second;
volatile uint16_t received;

static void put(char c) {
  while (!(UCSR0A & _BV(UDRE0))) {}
  UDR0 = c;
}
static void puts_(const char *s) {
  while (*s) put(*s++);
}
static void putu(uint16_t v) {
  char b[6];
  uint8_t n = 0;
  do b[n++] = '0' + v % 10; while ((v /= 10) != 0);
  while (n) put(b[--n]);
}

/* 16 MHz / 256 / 31250 = 2 Hz: the LED toggles twice a second. */
ISR(TIMER1_COMPA_vect) {
  PINB = _BV(PINB5);
  if (++ticks % 2 == 0) second = 1;
}

ISR(USART_RX_vect) {
  char c = UDR0;
  if (c >= 'a' && c <= 'z') c -= 32;
  received++;
  UDR0 = c;
}

int main(void) {
  DDRB = _BV(DDB5);
  UBRR0 = 103; /* 9600 baud at 16 MHz, U2X0 = 0 (Table 20-7: 0.2 % error) */
  UCSR0B = _BV(RXEN0) | _BV(TXEN0) | _BV(RXCIE0);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);
  OCR1A = 31249;
  TCCR1B = _BV(WGM12) | _BV(CS12);
  TIMSK1 = _BV(OCIE1A);
  set_sleep_mode(SLEEP_MODE_IDLE);
  sei();
  uint16_t n = 0;
  for (;;) {
    sleep_mode();
    if (second) {
      second = 0;
      puts_("tick ");
      putu(n++);
      puts_("\r\n");
    }
  }
}
