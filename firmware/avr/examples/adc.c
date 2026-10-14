/*
 * ATmega328P on a 16 MHz crystal: reads ADC0 and ADC6 (an analog-only pin of the 32-pin
 * packages) against AVCC every 100 ms and prints "A0=n A6=n" at 9600 8N1.
 */
#include <avr/io.h>
#include <util/delay.h>
#include <stdint.h>

FUSES = { .low = 0xFF, .high = 0xD9, .extended = 0xFD };

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
static uint16_t adc(uint8_t ch) {
  ADMUX = _BV(REFS0) | ch; /* AVCC reference */
  ADCSRA |= _BV(ADSC);
  while (ADCSRA & _BV(ADSC)) {}
  return ADC;
}

int main(void) {
  UBRR0 = 103;
  UCSR0B = _BV(TXEN0);
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);
  ADCSRA = _BV(ADEN) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0); /* 125 kHz ADC clock */
  for (;;) {
    puts_("A0=");
    putu(adc(0));
    puts_(" A6=");
    putu(adc(6));
    puts_("\r\n");
    _delay_ms(100);
  }
}
