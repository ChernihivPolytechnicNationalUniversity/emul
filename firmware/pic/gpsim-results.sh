#!/bin/sh
# Run a test image on gpsim (an independent PIC simulator) and print the results it leaves at 0A0h,
# in the host's .expect format: the second opinion where SDCC's code and the C semantics part ways.
# Some cells come out as four digits (gpsim shows more than the byte for them): the byte is the last two.
hex="$1"
printf 'break c 50000000\nrun\ndump r\nquit\n' | gpsim -i -p p16f648a "$hex" 2>&1 | tr -cd '[:print:]\n' |
  awk '/^00a0:|^00b0:/ { for (i = 2; i <= 17; i++) b[n++] = substr($i, length($i) - 1) }
       END {
         hdr = b[3] b[2] b[1] b[0]
         if (substr(hdr, 1, 6) != "c0ffee") { print "no result header" > "/dev/stderr"; exit 1 }
         h = "0123456789abcdef"
         cnt = (index(h, substr(hdr, 7, 1)) - 1) * 16 + index(h, substr(hdr, 8, 1)) - 1
         for (k = 1; k <= cnt; k++) printf "%d %s%s%s%s\n", k, b[4*k+3], b[4*k+2], b[4*k+1], b[4*k]
       }'
