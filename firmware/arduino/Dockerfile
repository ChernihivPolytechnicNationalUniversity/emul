# Popular Arduino Nano sketches built by the build service's own code (backend/worker/src/build.ts)
# with the same avr-gcc, avr-libc and pinned ArduinoCore-avr and libraries as the worker image.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-avr binutils-avr avr-libc git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backend/worker/toolchain/stage-arduino.sh /toolchain/
RUN sh /toolchain/stage-arduino.sh /opt/arduino
