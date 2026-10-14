#!/bin/sh
# Lay the Arduino AVR core and the libraries a sketch may #include out under one root, the way
# build.ts expects them:
#
#   $ARDUINO/core/cores/arduino           Arduino.h, main.cpp, wiring, HardwareSerial…
#   $ARDUINO/core/variants/<variant>      pins_arduino.h (eightanaloginputs for the Nano)
#   $ARDUINO/core/libraries/<lib>/src     Wire, SPI, EEPROM, SoftwareSerial that ship with the core
#   $ARDUINO/libraries/<lib>              the Library Manager's popular ones
#
# Pinned to release tags; a bump here is a bump for every build. Only libraries with a licence
# that lets the image carry them: LiquidCrystal_I2C (no licence) is not here.
set -eu
ARDUINO=${1:-/opt/arduino}
clone() { git clone -q --depth 1 -b "$2" "https://github.com/$1" "$3"; rm -rf "$3/.git"; }
clone arduino/ArduinoCore-avr 1.8.6 "$ARDUINO/core"
clone arduino-libraries/Servo 1.2.2 "$ARDUINO/libraries/Servo"
clone arduino-libraries/LiquidCrystal 1.0.7 "$ARDUINO/libraries/LiquidCrystal"
clone adafruit/Adafruit_NeoPixel 1.15.5 "$ARDUINO/libraries/Adafruit_NeoPixel"
clone adafruit/Adafruit_SSD1306 2.5.17 "$ARDUINO/libraries/Adafruit_SSD1306"
clone adafruit/Adafruit-GFX-Library 1.12.6 "$ARDUINO/libraries/Adafruit_GFX_Library"
clone adafruit/Adafruit_BusIO 1.17.4 "$ARDUINO/libraries/Adafruit_BusIO"
clone Chris--A/Keypad 3.1.1 "$ARDUINO/libraries/Keypad"
# Sources and headers are what a build reads; examples, docs and the bootloaders' binaries go.
rm -rf "$ARDUINO/core/bootloaders" "$ARDUINO/core/firmwares" "$ARDUINO"/libraries/*/examples "$ARDUINO"/core/libraries/*/examples
