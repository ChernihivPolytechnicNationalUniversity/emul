#!/usr/bin/env python3
"""Turn a picture into the cube's texture: 256 x 256 RGB565, little-endian, row major
(texture.bin, pulled into the image by texture.s). Usage: gen-texture.py photo.png"""
import struct, sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB").resize((256, 256), Image.LANCZOS)
out = bytearray()
for r, g, b in im.getdata():
    out += struct.pack("<H", ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3))
open(sys.argv[2] if len(sys.argv) > 2 else "texture.bin", "wb").write(out)
print(len(out), "bytes")
