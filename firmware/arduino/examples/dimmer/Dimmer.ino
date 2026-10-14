// Arduino Nano dimmer: the pot on A0 sets the LED's brightness on D9, the USB serial reports both.
//
//   A0            10 kΩ pot between 5V and GND, wiper on A0 (drag its knob in the inspector)
//   D9            220 Ω and an LED to GND; analogWrite runs Timer1's PWM at 490 Hz
//   USB serial    9600 baud: the reading and the duty cycle four times a second

const int POT = A0;
const int LED = 9;

unsigned long last;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Dimmer: turn the pot");
}

void loop() {
  int raw = analogRead(POT);   // 0..1023
  int duty = raw / 4;          // 0..255
  analogWrite(LED, duty);

  if (millis() - last >= 250) {
    last = millis();
    Serial.print("A0 = ");
    Serial.print(raw);
    Serial.print("  duty = ");
    Serial.print(duty * 100L / 255);
    Serial.println(" %");
  }
}
