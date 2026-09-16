/* The cube's texture, 256 x 256 RGB565 from gen-texture.py, kept in flash. */
    .section .rodata
    .global TEXTURE
    .balign 4
TEXTURE:
    .incbin "cube/texture.bin"
