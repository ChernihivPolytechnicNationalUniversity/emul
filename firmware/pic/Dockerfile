FROM debian:bookworm-slim AS sdcc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 g++ make bison flex libboost-dev zlib1g-dev texinfo gputils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sourceforge.net/projects/sdcc/files/sdcc/4.4.0/sdcc-src-4.4.0.tar.bz2/download | tar xj -C /tmp
WORKDIR /tmp/sdcc-4.4.0
RUN ./configure --prefix=/opt/sdcc --enable-non-free --disable-pic16-port \
      --disable-mcs51-port --disable-z80-port --disable-z180-port --disable-r2k-port --disable-r2ka-port --disable-r3ka-port \
      --disable-r800-port --disable-sm83-port --disable-tlcs90-port --disable-ez80_z80-port --disable-z80n-port --disable-ds390-port \
      --disable-ds400-port --disable-hc08-port --disable-s08-port --disable-stm8-port --disable-pdk13-port --disable-pdk14-port \
      --disable-pdk15-port --disable-mos6502-port --disable-mos65c02-port --disable-f8-port --disable-ucsim --disable-sdcdb \
    && make -j"$(nproc)" && make install

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gputils gpsim gcc libc6-dev make && rm -rf /var/lib/apt/lists/*
COPY --from=sdcc /opt/sdcc /opt/sdcc
ENV PATH=/opt/sdcc/bin:$PATH
