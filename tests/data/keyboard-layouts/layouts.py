import ctypes
import json
import sys

xkb = ctypes.CDLL("libxkbcommon.so.0")


class RuleNames(ctypes.Structure):
    _fields_ = [("rules", ctypes.c_char_p), ("model", ctypes.c_char_p), ("layout", ctypes.c_char_p), ("variant", ctypes.c_char_p), ("options", ctypes.c_char_p)]


xkb.xkb_context_new.restype = ctypes.c_void_p
xkb.xkb_keymap_new_from_names.restype = ctypes.c_void_p
xkb.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.POINTER(RuleNames), ctypes.c_int]
xkb.xkb_state_new.restype = ctypes.c_void_p
xkb.xkb_state_new.argtypes = [ctypes.c_void_p]
xkb.xkb_state_unref.argtypes = [ctypes.c_void_p]
xkb.xkb_keymap_mod_get_index.restype = ctypes.c_uint
xkb.xkb_keymap_mod_get_index.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
xkb.xkb_state_update_mask.argtypes = [ctypes.c_void_p] + [ctypes.c_uint] * 6
xkb.xkb_state_key_get_utf8.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_char_p, ctypes.c_size_t]
xkb.xkb_state_key_get_one_sym.restype = ctypes.c_uint
xkb.xkb_state_key_get_one_sym.argtypes = [ctypes.c_void_p, ctypes.c_uint]
xkb.xkb_keysym_get_name.argtypes = [ctypes.c_uint, ctypes.c_char_p, ctypes.c_size_t]

CODES = {49: "Backquote", 20: "Minus", 21: "Equal", 34: "BracketLeft", 35: "BracketRight", 47: "Semicolon", 48: "Quote", 51: "Backslash", 59: "Comma", 60: "Period", 61: "Slash", 94: "IntlBackslash"}
for i, d in enumerate("1234567890"):
    CODES[10 + i] = f"Digit{d}"
for start, letters in ((24, "QWERTYUIOP"), (38, "ASDFGHJKL"), (52, "ZXCVBNM")):
    for i, letter in enumerate(letters):
        CODES[start + i] = f"Key{letter}"

ctx = xkb.xkb_context_new(0)
layouts = {}
for spec in sys.argv[1:]:
    layout, _, variant = spec.partition(":")
    names = RuleNames(b"evdev", b"pc105", layout.encode(), variant.encode(), b"")
    keymap = xkb.xkb_keymap_new_from_names(ctx, ctypes.byref(names), 0)
    if not keymap:
        print(f"no keymap for {spec}", file=sys.stderr)
        continue
    shift = 1 << xkb.xkb_keymap_mod_get_index(keymap, b"Shift")
    level3 = 1 << xkb.xkb_keymap_mod_get_index(keymap, b"Mod5")
    keys = {}
    for keycode, code in CODES.items():
        levels = []
        for mods in (0, shift, level3, shift | level3):
            state = xkb.xkb_state_new(keymap)
            xkb.xkb_state_update_mask(state, mods, 0, 0, 0, 0, 0)
            buf = ctypes.create_string_buffer(64)
            xkb.xkb_state_key_get_utf8(state, keycode, buf, 64)
            sym = xkb.xkb_state_key_get_one_sym(state, keycode)
            name = ctypes.create_string_buffer(64)
            xkb.xkb_keysym_get_name(sym, name, 64)
            xkb.xkb_state_unref(state)
            text = buf.value.decode("utf-8", "replace")
            levels.append("Dead" if name.value.startswith(b"dead_") else text)
        keys[code] = levels
    layouts[spec] = keys
json.dump(layouts, sys.stdout, ensure_ascii=False, indent=0)
